import {mergeCatalogs} from "../snapshot-client";
import {operationallyActive} from "../../../packages/domain/src/admin";
import {frontendAttendanceVersions} from "../../../packages/domain/src/frontend-transport";
import {hydrateReporting} from "./reporting";

// Command payloads retain optimistic version checks.
export async function decodeBrowse(data) {
  const {tables:t, profile} = data.browse, access=data.manifest.access;
  const rows=(table,names)=>JSON.parse(t[table]).map(values=>{
    if (profile==="leadership" && table==="contacts" && values.length!==names.length)
      throw Error("Reload Leadership to get current contact details.");
    return Object.fromEntries(names.map((name,i)=>[name,values[i]]));
  });
  const columns=(table,names)=>rows(table,names.split(" "));
  if(profile==="event-list") return {...data,eventsList:{
    terms:columns("terms","termId label sortOrder isCurrent"),events:columns("events","eventId termId eventType displayOrder label status startAt endAt location notes"),
  }};
  if(profile==="overview") return {...data,birthdayFlights:t.flights ? columns("flights","flightId label squadronId") : [], birthdaySquadrons:t.squadrons ? columns("squadrons","squadronId label") : [],birthdayCalendar:JSON.parse(t.birthdays || "[]"),overview:{term:JSON.parse(t.terms)[0]?.[1],
    activeCadets:t.activeCadets,activeEvents:t.activeEvents,pending:t.pending}};
  if(profile==='semester') return {...data,list:{
    terms:columns('terms','termId label sortOrder isCurrent').map(t=>({...t,isCurrent:!!t.isCurrent})),
    people:columns('people','personId version firstName lastName rank asYear role flightId flightPathStatus'),
    events:columns('events','termId eventType trainingWeek status startAt endAt'),
    flights:columns('flights','flightId label'),
  }};
  const flights=columns("flights","flightId label squadronId");
  if(profile==="cadets" || profile==="cadet-details" || profile==="leadership"){
    const people=columns("people","personId version flightId lastName firstName rank asYear flightPathStatus email role"+(profile!=="leadership"?" afsc university classYear cipCode cipBroadArea":"")+(profile==="cadet-details"?" phone dorm homeTown homeState dateOfBirth photoLink":""))
      .map(p=>({...p,active:operationallyActive(p)}));
    if(profile!=="leadership") return {...data,list:{flights,people,squadrons:t.squadrons ? columns("squadrons","squadronId label") : []}};
    const contacts=columns("contacts","contactId version personId lastName firstName rank role email officeLocation active reportsTo officePhone cellPhone")
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
    list.requests=columns("requests","requestId personId eventId flightId status requestedOutcome reason version personDisplayName canDecide submittedAt capturedSquadronLabel capturedFlightLabel decisionReason")
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


export function eventEditorData({tables}) {
  const rows=(key,names)=>JSON.parse(tables[key]).map(values=>Object.fromEntries(names.split(" ").map((n,i)=>[n,values[i]])));
  const events=rows("events","eventId version termId eventType trainingWeek displayOrder label columnLabel expectedGroup status startAt endAt location notes hasRoster");
  const byId=new Map(events.map(e=>[e.eventId,e]));
  for(const event of events) event.eligiblePersonIds=event.hasRoster ? [] : null;
  for(const [event,person] of JSON.parse(tables.eligible)) byId.get(event).eligiblePersonIds.push(person);
  return {events,people:rows("people","personId lastName firstName"),flights:rows("flights","flightId label"),
    terms:rows("terms","termId label sortOrder isCurrent"),eventFlights:rows("eventFlights","eventId flightId")};
}
