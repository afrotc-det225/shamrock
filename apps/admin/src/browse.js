import {mergeCatalogs} from "../snapshot-client";
import {operationallyActive} from "../../../packages/domain/src/admin";
import {frontendAttendanceVersions} from "../../../packages/domain/src/frontend-transport";
import {hydrateReporting} from "./reporting";

// These compact tables are display models, never inputs to a write or a native snapshot.
export async function decodeBrowse(data) {
  const {tables:t, profile} = data.browse, access=data.manifest.access;
  const rows=(table,names)=>JSON.parse(t[table]).map(values=>Object.fromEntries(names.map((name,i)=>[name,values[i]])));
  const columns=(table,names)=>rows(table,names.split(" "));
  if(profile==="overview") return {...data,birthdayCalendar:JSON.parse(t.birthdays || "[]"),overview:{term:JSON.parse(t.terms)[0]?.[1],
    activeCadets:t.activeCadets,activeEvents:t.activeEvents,pending:t.pending}};
  const flights=columns("flights","flightId label squadronId");
  if(profile==="cadets" || profile==="cadet-details" || profile==="leadership"){
    const people=columns("people","personId version flightId lastName firstName rank asYear flightPathStatus email role"+(profile!=="leadership"?" afsc university classYear cipCode cipBroadArea":"")+(profile==="cadet-details"?" phone dorm homeTown homeState dateOfBirth photoLink":""))
      .map(p=>({...p,active:operationallyActive(p)}));
    if(profile!=="leadership") return {...data,list:{flights,people,squadrons:t.squadrons ? columns("squadrons","squadronId label") : []}};
    const contacts=columns("contacts","contactId version personId lastName firstName rank role email officeLocation active reportsTo")
      .map(c=>({...c,active:!!c.active}));
    const list=await mergeCatalogs({flights,squadrons:columns("squadrons","squadronId label"),people:[]},people,contacts);
    return {...data,list};
  }
  const people=columns("people","wireId personId lastName firstName asYear flightId flightPathStatus")
    .map(p=>({...p,active:operationallyActive(p),dateOfBirth:null}));
  const events=columns("events","wireId eventId termId label columnLabel eventType status trainingWeek displayOrder hasRoster version");
  const terms=columns("terms","termId label sortOrder isCurrent").map(v=>({...v,isCurrent:!!v.isCurrent}));
  const list={people,events,terms,flights,access,scope:data.browse.scope};
  if(profile==="excusals"){
    list.requests=columns("requests","requestId personId eventId flightId status requestedOutcome reason version personDisplayName canDecide")
      .map(r=>({...r,canDecide:!!r.canDecide}));
    return {...data,list};
  }
  const persons=new Map(people.map(p=>[p.wireId,p.personId])), byEvent=new Map(events.map(e=>[e.wireId,e]));
  const id=(map,key)=>{if(!map.has(key))throw Error("The attendance data changed. Reload the page.");return map.get(key);};
  events.forEach(e=>{e.eligiblePersonIds=e.hasRoster ? [] : null;});
  for(const [event,person] of JSON.parse(t.eligible)) id(byEvent,event).eligiblePersonIds.push(id(persons,person));
  list.squadrons=columns("squadrons","squadronId label");
  for(const section of ["observations","corrections"])
    list[section]=JSON.parse(t[section]).map(([p,e,factId,order,code])=>({personId:id(persons,p),eventId:id(byEvent,e).eventId,factId,order,code}));
  list.legacyBaselines=JSON.parse(t.baselines).map(([p,e,code,baselineRevision])=>({personId:id(persons,p),eventId:id(byEvent,e).eventId,baselineRevision,baselineId:`baseline:${p}:${e}`,code}));
  list.requests=JSON.parse(t.requests).map(([requestId,p,e,order,status,requestedOutcome,legacy])=>({
    requestId,personId:persons.get(p),eventId:id(byEvent,e).eventId,order,status,requestedOutcome,legacyStateOnly:!!legacy}));
  list.attendanceVersions=frontendAttendanceVersions([...list.observations,...list.corrections,...list.legacyBaselines,...list.requests.filter(r=>r.personId)]);
  list.contractVersion=access.capabilities.fullSnapshot ? 1 : "panel-snapshot-v1";
  const {reporting}=hydrateReporting({snapshot:list,reportingTime:data.reportingTime});
  return {...data,list,reporting};
}
