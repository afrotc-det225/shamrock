import React,{useRef,useState} from "react";
import {api} from "./api";
import {eventEditorData} from "../event-editor.mjs";

export function EventApproval({action}) {
  const [state,setState]=useState("ready"),[error,setError]=useState("");
  const pending=useRef(false);
  async function approve(){
    if(pending.current)return;
    pending.current=true;setState("saving");setError("");
    try {
      const receipt=await api("/proposals/"+action.id+"/apply",{approved:true});
      if(receipt.state!=="complete")throw Error("The change has not completed. Check its receipt before trying again.");
      const source=eventEditorData(await api("/events/editor?id="+encodeURIComponent(action.eventId)));
      if(!source.events.some(e=>e.eventId===action.eventId && e.status==="cancelled"))throw Error("The change has a receipt, but the event could not be verified as cancelled.");
      setState("complete");
    } catch(e){setError(e.message);setState("ready");}
    finally{pending.current=false;}
  }
  return <div>{state==="complete" ? <p role="status">{action.label} is cancelled.</p> :
    <button disabled={state==="saving"} onClick={approve}>{state==="saving" ? "Checking event…" : "Approve cancellation"}</button>}
    {error && <p role="alert">{error}</p>}</div>;
}
