import React, {createContext, useContext, useMemo, useRef, useState} from "react";
import {Focus} from "lucide-react";
import {buildWingOrganization, filterWingOrganization} from "./wing-organization";
import {name} from "./api";
import {Drawer} from "./components";
import "./leadership-chart.css";

const SelectContact=createContext(null);

function Occupants({people}) {
  const select=useContext(SelectContact);
  return people.map(p=><button type="button" className="command-occupant" key={p.personId || p.contactId}
    onClick={()=>select(p.personId || p.contactId)} aria-label={"Contact details for "+name(p)}>
    {p.rank && <span>{p.rank} </span>}{name(p)}
  </button>);
}

function Office({node,onFocus}) {
  const deputy=node.deputy;
  return <div className="command-office" data-tone={node.tone} data-office={node.id}>
    <div className="command-primary">
      {node.code && <small className="office-symbol">{node.code}</small>}
      {onFocus ? <button className="office-focus" onClick={onFocus} aria-label={"Focus on "+node.title}>
        {node.title} <Focus aria-hidden="true" size={13}/>
      </button> : <strong>{node.title}</strong>}
      <Occupants people={node.assigned}/>
      {!node.assigned.length && !node.contextOnly && <span className="office-unassigned">No assignment recorded</span>}
    </div>
    {deputy && (deputy.assigned.length>0 || (deputy.code && !node.filtered)) && <div className="command-deputy">
      <b>Deputy</b> <Occupants people={deputy.assigned}/>
      {!deputy.assigned.length && <span className="office-unassigned">No assignment recorded</span>}
      {deputy.code && <small className="office-symbol">{deputy.code}</small>}
    </div>}
    {node.flight && node.team.length>0 ? <details className="flight-members" key={!!node.filtered} open={node.filtered || undefined}>
      <summary>Cadets ({node.team.length})</summary><Occupants people={node.team}/>
    </details> : node.team.length>0 && <div className="command-team"><Occupants people={node.team}/></div>}
  </div>;
}

// The first two tiers fan out horizontally. Lower offices and flights share a
// vertical reporting rail, keeping sibling deputies together at every tier.
function Branches({nodes,depth=1,onFocus}) {
  if(!nodes?.length) return null;
  return <ul className={depth<3 ? "org-fork" : "org-rail"} data-tier={depth}
    style={depth===1 ? {"--branches":nodes.map(n=>`minmax(0,${Math.max(1,n.children?.length || 0)}fr)`).join(" ")} : undefined}>
    {nodes.map(n=><li key={n.id} data-branch={n.id}>
      <div className="org-post"><Office node={n} onFocus={depth===1 && n.children?.length && onFocus ? ()=>onFocus(n.id) : undefined}/></div>
      <Branches nodes={n.children} depth={depth+1}/>
    </li>)}
  </ul>;
}

function CadreCommand({commander,ops,hasWing}) {
  const staff=commander.children?.filter(n=>n.id!=="cadre-operations") || [];
  const middle=Math.ceil(staff.length/2);
  const offices=ops ? [...staff.slice(0,middle),ops,...staff.slice(middle)] : staff;
  if(ops && staff.length%2) offices.push(null);
  return <>
    <div className="org-root"><Office node={commander}/></div>
    {!!offices.length && <ul className="org-fork cadre-fork">{offices.map(node=>{
      if(!node) return <li key="spacer" className="cadre-spacer" aria-hidden="true"/>;
      const main=node===ops;
      return <li key={node.id} className={main && hasWing ? "cadre-main" : undefined}>
        <div className="org-post"><Office node={node}/></div>
        <div className="cadre-reports"><Branches nodes={node.children?.filter(n=>n.id!=="wing")} depth={3}/></div>
      </li>;
    })}</ul>}
  </>;
}

export default function LeadershipChart({roster,query="",onEdit}) {
  const {root,wing,records}=useMemo(()=>buildWingOrganization(roster),[roster]);
  const [branch,setBranch]=useState(""), [contactKey,selectContact]=useState(null);
  const contact=records.get(contactKey);
  const branchPicker=useRef(null);
  function focusBranch(id) {
    setBranch(id);
    branchPicker.current?.focus({preventScroll:true});
    branchPicker.current?.scrollIntoView({block:"nearest"});
  }
  const needle=query.trim().toLowerCase();
  const selected=wing.children.find(n=>n.id===branch);
  const tree=filterWingOrganization(selected || root,needle);
  const ops=tree?.children?.find(n=>n.id==="cadre-operations");
  const wingTree=selected ? tree : ops?.children?.find(n=>n.id==="wing");
  const contactFields=contact && [
    ["Appointment",contact.role],["Flight",roster.flights.find(f=>f.flightId===contact.flightId)?.label],
    ["Email",contact.email,"mailto:"],["Cell phone",contact.cellPhone || contact.phone,"tel:"],
    ["Office phone",contact.officePhone,"tel:"],["Office",contact.officeLocation],["Reports to",contact.reportsTo],
  ].filter(([,value])=>value);
  return <SelectContact.Provider value={selectContact}><section className="wing-organization" aria-label="Cadet Wing organization">
    <header className="org-heading">
      <div><small>Detachment 225</small><h2>Cadet Wing Organization</h2></div>
      <select ref={branchPicker} aria-label="Organization branch" value={branch} onChange={e=>setBranch(e.target.value)}>
        <option value="">Entire Wing</option>
        {wing.children.map(n=><option key={n.id} value={n.id}>{n.title}</option>)}
      </select>
    </header>
    {tree ? <div className="org-canvas" style={{"--operations-columns":(wing.children.find(n=>n.id==="operations").children.length || 1)+"fr"}} data-full={!selected && !needle} aria-label={selected?.title || "Wing chain of command"}>
      {!selected && <CadreCommand commander={tree} ops={ops} hasWing={!!wingTree}/>}
      {wingTree && <><div className="org-root"><Office node={wingTree}/></div>
        <Branches nodes={wingTree.children} depth={selected ? 2 : 1} onFocus={focusBranch}/></>}
    </div> : <p role="status">No matching people or offices.</p>}
  </section>
    {contact && <Drawer title={name(contact)} onClose={()=>selectContact(null)}>
      <div className="fields">{(contact.rank || contact.asYear) && <p>{[contact.rank,contact.asYear].filter(Boolean).join(" · ")}</p>}
        <dl className="org-contact">{contactFields.map(([label,value,protocol])=><div key={label}><dt>{label}</dt>
          <dd>{protocol ? <a href={protocol+value}>{value}</a> : value}</dd></div>)}</dl>
      </div>
      {onEdit && <footer className="actions"><button onClick={()=>{selectContact(null);onEdit(contact);}}>
        {contact.contactId ? "Edit contact" : "Add contact details"}</button></footer>}
    </Drawer>}
  </SelectContact.Provider>;
}
