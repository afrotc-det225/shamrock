import React, {createContext, useContext, useLayoutEffect, useMemo, useRef, useState} from "react";
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

function Office({node,onFocus,focused=false}) {
  const deputy=node.deputy;
  return <div className="command-office" data-tone={node.tone} data-office={node.id}>
    <div className="command-primary">
      {node.code && <small className="office-symbol">{node.code}</small>}
      {onFocus ? <button className="office-focus" onClick={onFocus} aria-label={"Focus on "+node.title}>
        {node.title}
      </button> : <strong>{node.title}</strong>}
      <Occupants people={node.assigned}/>
      {!node.assigned.length && !node.contextOnly && <span className="office-unassigned">No assignment recorded</span>}
    </div>
    {deputy && (deputy.assigned.length>0 || (deputy.code && !node.filtered)) && <div className="command-deputy">
      <b>Deputy</b> <Occupants people={deputy.assigned}/>
      {!deputy.assigned.length && <span className="office-unassigned">No assignment recorded</span>}
      {deputy.code && <small className="office-symbol">{deputy.code}</small>}
    </div>}
    {focused && node.flight ? null : node.flight && node.team.length>0 ? <details className="flight-members" key={!!node.filtered} open={node.filtered || undefined}>
      <summary>Cadets ({node.team.length})</summary><Occupants people={node.team}/>
    </details> : node.team.length>0 && <div className="command-team"><Occupants people={node.team}/></div>}
  </div>;
}

// A fork can use one column per office while each label has room. Larger
// sibling sets share reporting rails, with the same order and parentage.
function OfficeFork({depth, weights, children}) {
  const ref=useRef(null);
  const [capacity,setCapacity]=useState(children.length);
  useLayoutEffect(()=>{
    const list=ref.current;
    const measure=()=>{
      const rem=parseFloat(getComputedStyle(document.documentElement).fontSize);
      // On phones CSS already draws a single vertical reporting rail.
      const stacked=getComputedStyle(list).display==="block";
      setCapacity(stacked ? Infinity : Math.max(1,Math.floor(list.clientWidth/(9*rem))));
    };
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(list);
    return ()=>observer.disconnect();
  },[]);
  const columns=Math.min(capacity,children.length);
  const grouped=columns<children.length;
  const tracks=grouped ? `repeat(${columns},minmax(0,1fr))` :
    weights.map(weight=>`minmax(min(9rem,100%),${weight}fr)`).join(" ");
  return <ul ref={ref} className="org-fork" data-tier={depth} style={{"--branches":tracks}}>
    {grouped ? Array.from({length:columns},(_,i)=>{
      const start=Math.floor(i*children.length/columns);
      const end=Math.floor((i+1)*children.length/columns);
      return <li key={children[start].key} className="org-column">
        <ul className="org-rail sibling-rail">{children.slice(start,end)}</ul>
      </li>;
    }) : children}
  </ul>;
}

function Branches({nodes=[],depth=1,onFocus,flightRoster=[]}) {
  if(!nodes.length && !flightRoster.length) return null;
  const offices=nodes.map(n=><li key={n.id} data-branch={n.id}>
    <div className="org-post"><Office node={n} onFocus={onFocus(n)}/></div>
    <Branches nodes={n.children} depth={depth+1} onFocus={onFocus}/>
  </li>);
  if(flightRoster.length) offices.push(<li key=":roster" className="org-roster-branch">
    <div className="command-office"><div className="command-primary"><strong>Flight roster</strong></div>
      <div className="command-team"><Occupants people={flightRoster}/></div>
    </div>
  </li>);
  if(depth>2) return <ul className="org-rail" data-tier={depth}>{offices}</ul>;
  const weights=nodes.map(n=>depth===1 ? Math.max(1,n.children?.length || 0) : 1);
  if(flightRoster.length) weights.push(1);
  return <OfficeFork depth={depth} weights={weights}>{offices}</OfficeFork>;
}

function CadreCommand({commander,ops,hasWing,onFocus}) {
  const staff=commander.children?.filter(n=>n.id!=="cadre-operations") || [];
  const middle=Math.ceil(staff.length/2);
  function cadreOffice(node) {
    return <li key={node.id} className={node===ops && hasWing ? "cadre-main" : undefined}>
      <div className="org-post"><Office node={node} onFocus={onFocus(node)}/></div>
      <div className="cadre-reports"><Branches nodes={node.children?.filter(n=>n.id!=="wing")} depth={3} onFocus={onFocus}/></div>
    </li>;
  }
  function staffColumn(nodes) {
    if(nodes.length===1) return cadreOffice(nodes[0]);
    if(!nodes.length) return <li className="cadre-spacer" aria-hidden="true"/>;
    return <li className="org-column"><ul className="org-rail sibling-rail">{nodes.map(cadreOffice)}</ul></li>;
  }
  return <>
    <div className="org-root"><Office node={commander}/></div>
    {(ops || staff.length>0) && <ul className="org-fork cadre-fork">
      {staff.length>0 && staffColumn(staff.slice(0,middle))}
      {ops && cadreOffice(ops)}
      {staff.length>0 && (ops || staff.length>1) && staffColumn(staff.slice(middle))}
    </ul>}
  </>;
}

export default function LeadershipChart({roster,query="",onEdit}) {
  const {root,records}=useMemo(()=>buildWingOrganization(roster),[roster]);
  const branches=useMemo(()=>{
    const index=new Map();
    function visit(node,parent) {
      if (node.flight || node.children?.length || node.deputy || node.team.length) {
        index.set(node.id,{node,parent});
        node.children?.forEach(child=>visit(child,node));
      }
    }
    visit(root,null);
    return index;
  },[root]);
  const [branch,setBranch]=useState(""), [contactKey,selectContact]=useState(null);
  const contact=records.get(contactKey);
  const branchPicker=useRef(null);
  function focusBranch(id) {
    setBranch(id);
    branchPicker.current?.focus({preventScroll:true});
    branchPicker.current?.scrollIntoView({block:"nearest"});
  }
  const needle=query.trim().toLowerCase();
  const selected=branches.get(branch)?.node;
  const parent=branches.get(branch)?.parent;
  const onFocus=node=>node.id!==selected?.id && node.id!==root.id && branches.has(node.id) ? ()=>focusBranch(node.id) : undefined;
  const tree=filterWingOrganization(selected || root,needle);
  const ops=tree?.children?.find(n=>n.id==="cadre-operations");
  const wingTree=selected ? tree : ops?.children?.find(n=>n.id==="wing");
  const contactFields=contact && [
    ["Appointment",contact.role],["Flight",roster.flights.find(f=>f.flightId===contact.flightId)?.label],
    ["Email",contact.email,"mailto:"],["Cell phone",contact.personId ? contact.phone : contact.cellPhone,"tel:"],
    ["Office phone",contact.officePhone,"tel:"],["Office",contact.officeLocation],["Reports to",contact.reportsTo],
  ].filter(([,value])=>value);
  return <SelectContact.Provider value={selectContact}><section className="wing-organization" aria-label="Cadet Wing organization">
    <header className="org-heading">
      <div><small>Detachment 225</small><h2>Cadet Wing Organization</h2></div>
      <div className="org-navigation">
      {parent && <button type="button" className="office-parent" onClick={()=>focusBranch(parent===root ? "" : parent.id)} aria-label={"Back to "+(parent===root ? "Entire Wing" : parent.title)}>← Back</button>}
      <select ref={branchPicker} aria-label="Organization branch" value={selected?.id || ""} onChange={e=>setBranch(e.target.value)}>
        <option value="">Entire Wing</option>
        {Array.from(branches.values(),({node,parent})=>parent && <option key={node.id} value={node.id}>{node.title}</option>)}
      </select>
      </div>
    </header>
    {tree ? <div className="org-canvas" data-full={!selected && !needle} aria-label={selected?.title || "Wing chain of command"}>
      {!selected && <CadreCommand commander={tree} ops={ops} hasWing={!!wingTree} onFocus={onFocus}/>}
      {wingTree && <><div className="org-root"><Office node={wingTree} onFocus={selected ? undefined : onFocus(wingTree)} focused={!!selected}/></div>
        <Branches nodes={wingTree.children} depth={selected ? 2 : 1} onFocus={onFocus} flightRoster={selected?.flight ? wingTree.team : undefined}/></>}
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
