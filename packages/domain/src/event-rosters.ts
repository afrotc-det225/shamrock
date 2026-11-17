/** Future operational eligibility follows the existing Attendance Form's Flight rules. */
import {adminIdentifier,type EventUpsert,type FrontendSnapshot} from './admin.js';
import {DomainError} from './index.js';
export const EVENT_ROSTER_POLICY='current-active-flight-v1' as const;
export interface EventRosterPreviewReference{contractVersion:1;eventId:string;mode:'enable'|'refresh'|'disable';basisAt:string;previewHash:string;}
/** Turn a saved server preview into one reviewable command; no caller-supplied membership list. */
export function eventRosterPreviewCommand(preview:EventRosterPreviewReference,identity:{commandId:string;environment:string;generation:number;principalId:string;source:{kind:'sheet'|'test';resourceKey:string;submissionId:string;revision:number}}){
  [preview.eventId,identity.commandId,identity.principalId,identity.source.resourceKey,identity.source.submissionId].forEach(id=>adminIdentifier(id));
  if(preview.contractVersion!==1||!['enable','refresh','disable'].includes(preview.mode)||!Number.isFinite(Date.parse(preview.basisAt))||!/^[a-f0-9]{64}$/.test(preview.previewHash)||!Number.isSafeInteger(identity.generation)||identity.generation<1||!Number.isSafeInteger(identity.source.revision)||identity.source.revision<1)throw new DomainError('INVALID_COMMAND','Use the saved preview and exact authenticated operator identity.','preview');
  return {commandId:identity.commandId,contractVersion:1 as const,environment:identity.environment,generation:identity.generation,actor:{principalId:identity.principalId,evidence:'authenticated-confirmation' as const},source:{...identity.source},operation:'event.roster.apply' as const,payload:{eventId:preview.eventId,mode:preview.mode,basisAt:preview.basisAt,previewHash:preview.previewHash}};
}
export function operationalFlight(label:string):boolean{return label.trim().toLowerCase()!=='abroad';}
/** Mando crosstown branches change who submits, not which active cadets are eligible. */
export function deriveEventRoster(snapshot:Pick<FrontendSnapshot,'people'|'flights'>,eventType:EventUpsert['eventType'],requestedFlightIds:readonly string[]):{flightIds:string[];eligiblePersonIds:string[]}{
  if(!['mando','secondary','llab','other'].includes(eventType)||requestedFlightIds.length>50||new Set(requestedFlightIds).size!==requestedFlightIds.length||snapshot.people.length>500)throw new DomainError('INVALID_COMMAND','Use a bounded explicit Flight scope.','flightIds');
  requestedFlightIds.forEach(id=>{adminIdentifier(id);if(!snapshot.flights.some(f=>f.flightId===id))throw new DomainError('INVALID_COMMAND','A selected Flight is not in the current catalog.','flightIds');});
  const flightIds=snapshot.flights.filter(f=>requestedFlightIds.includes(f.flightId)&&(eventType==='other'||operationalFlight(f.label))).map(f=>f.flightId).sort();
  const eligiblePersonIds=snapshot.people.filter(p=>p.active&&p.flightId&&flightIds.includes(p.flightId)).map(p=>p.personId).sort();
  return {flightIds,eligiblePersonIds};
}
/** Operator-facing event drafting needs selected Flights, never a hand-maintained list of cadet IDs. */
export function prepareEventUpsert(snapshot:FrontendSnapshot,event:Omit<EventUpsert,'flightIds'|'eligiblePersonIds'>,selection:{flightIds:string[]},now:string):EventUpsert{
  if(!Number.isFinite(Date.parse(now)))throw new DomainError('INVALID_COMMAND','Use an explicit current timestamp.','now');
  const existing=snapshot.events.find(e=>e.eventId===event.eventId);
  if(existing&&existing.version!==event.expectedVersion||!existing&&event.expectedVersion!==0)throw new DomainError('INVALID_COMMAND','Reload the current event before preparing this change.','expectedVersion');
  const future=event.startAt!==null&&Date.parse(event.startAt)>Date.parse(now);
  if(existing&&(!future||existing.startAt===null||Date.parse(existing.startAt)<=Date.parse(now))){
    deriveEventRoster(snapshot,event.eventType,selection.flightIds);if(existing.eligiblePersonIds===null)throw new DomainError('INVALID_COMMAND','Review the missing historical event roster separately.','eligiblePersonIds');return {...event,flightIds:[...selection.flightIds],eligiblePersonIds:[...existing.eligiblePersonIds]};}
  if(!future)throw new DomainError('INVALID_COMMAND','New events need an explicit future start before automatic roster capture.','startAt');
  return {...event,...deriveEventRoster(snapshot,event.eventType,selection.flightIds)};
}
