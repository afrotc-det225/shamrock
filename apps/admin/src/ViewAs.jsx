import React, { useState, useRef, useEffect } from "react";
import { Eye } from "lucide-react";
import { Drawer, SearchBox, Empty } from "./components";
import { name,api } from "./api";
import { compareCadetsForDisplay } from "../../../packages/domain/src/cadet-display-order";
export function ViewAsSelector({ people, onSelect, busy }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [loaded,setLoaded]=useState(null),[error,setError]=useState(""),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if (!open || people) return;
    const controller=new AbortController();
    setLoaded(null);setError("");
    api("/view-as/people",undefined,{signal:controller.signal}).then(view=>{
      if(!controller.signal.aborted) setLoaded(JSON.parse(view.tables.people).map(([personId,lastName,firstName,asYear,role])=>({personId,lastName,firstName,asYear,role})));
    }).catch(()=>{if(!controller.signal.aborted)setError("The cadet list could not be loaded.");});
    return ()=>controller.abort();
  },[open,people,retry]);
  const rows = (people || loaded || []).filter(person => name(person).toLowerCase().includes(query.toLowerCase())).sort(compareCadetsForDisplay);
  return <>
    <button disabled={busy} onClick={() => { setQuery(""); setLoaded(null);setError("");setOpen(true); }}><Eye size={18} /> View as</button>
    {open && <Drawer title="View as" onClose={() => setOpen(false)}>
      <div className="fields">
        <SearchBox placeholder="Find a person to view" value={query} onChange={setQuery} />
        <p className="history-caption">Read-only view of their SHAMROCK access.</p>
        <div className="view-as-people">{rows.map(person => <button key={person.personId} disabled={busy}
          onClick={() => { setOpen(false); onSelect(person); }}>{name(person)}<small>{person.role || person.asYear}</small></button>)}</div>
        {error && <p role="alert">{error} <button onClick={()=>setRetry(n=>n+1)}>Retry</button></p>}
        {!people && !loaded && !error && <p role="status">Loading cadets…</p>}
        {(people || loaded) && !rows.length && <Empty>No matching cadets.</Empty>}
      </div>
    </Drawer>}
  </>;
}
export const viewAsStatus = {
  "starting": "The preview was interrupted before it finished. Retry or exit this view.",
  "no-active-principal": "This person does not have an active SHAMROCK account.",
  "ambiguous-principal": "More than one account is linked to this person. Their access cannot be previewed until the link is corrected.",
  "no-verified-login": "This person does not have a verified sign-in linked to SHAMROCK.",
  "no-panel-access": "This person does not currently have access to the panel.",
};
export function ViewAsBanner({ label, onExit, busy }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current, workspace = element.closest(".workspace");
    const measure = () => workspace.style.setProperty("--topbar-height", `${element.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => { observer.disconnect(); workspace.style.removeProperty("--topbar-height"); };
  }, []);
  return <div ref={ref} className="view-as-banner" role="status">
    <span><strong>Viewing as {label}</strong><small>Read-only · Your administrator account is unchanged</small></span>
    <button disabled={busy} onClick={onExit}>Exit view</button>
  </div>;
}
