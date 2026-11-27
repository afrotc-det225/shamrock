import React, {useMemo, useRef, useState} from "react";
import {Focus} from "lucide-react";
import {buildWingOrganization, filterWingOrganization} from "./wing-organization";
import {name} from "./api";
import "./leadership-chart.css";

function Occupants({people}) {
  return people.map(p=><span className="command-occupant" key={p.personId ?? p.contactId}>
    {p.rank && <span>{p.rank} </span>}{name(p)}
    {p.reportsTo && <small>Reports to {p.reportsTo}</small>}
  </span>);
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
    {node.team.length>0 && <div className="command-team"><Occupants people={node.team}/></div>}
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

export default function LeadershipChart({roster,query=""}) {
  const {root,other}=useMemo(()=>buildWingOrganization(roster),[roster]);
  const [branch,setBranch]=useState("");
  const branchPicker=useRef(null);
  function focusBranch(id) {
    setBranch(id);
    branchPicker.current?.focus({preventScroll:true});
    branchPicker.current?.scrollIntoView({block:"nearest"});
  }
  const needle=query.trim().toLowerCase();
  const selected=root.children.find(n=>n.id===branch);
  const tree=filterWingOrganization(selected || root,needle);
  const additional=selected ? [] : other.filter(p=>
    [p.role,name(p),p.rank,p.email,p.reportsTo].some(v=>String(v || "").toLowerCase().includes(needle)));
  return <section className="wing-organization" aria-label="Cadet Wing organization">
    <header className="org-heading">
      <div><small>Detachment 225</small><h2>Cadet Wing Organization</h2></div>
      <select ref={branchPicker} aria-label="Organization branch" value={branch} onChange={e=>setBranch(e.target.value)}>
        <option value="">Entire Wing</option>
        {root.children.map(n=><option key={n.id} value={n.id}>{n.title}</option>)}
      </select>
    </header>
    {tree && <div className="org-canvas" style={{"--operations-columns":(root.children.find(n=>n.id==="operations").children.length || 1)+"fr"}} data-full={!selected && !needle} aria-label={selected?.title || "Wing chain of command"}>
      <div className="org-root"><Office node={tree}/></div>
      <Branches nodes={tree.children} depth={selected ? 2 : 1} onFocus={focusBranch}/>
    </div>}
    {!tree && !additional.length && <p role="status">No matching appointments.</p>}
    {additional.length>0 && <details className="org-additional" key={needle ? "search" : "all"} open={needle ? true : undefined}>
      <summary>Additional appointments ({additional.length})</summary>
      <dl>{additional.map(p=><div key={p.personId ?? p.contactId}>
        <dt>{p.role || "Leadership contact"}</dt><dd><Occupants people={[p]}/></dd>
      </div>)}</dl>
    </details>}
  </section>;
}
