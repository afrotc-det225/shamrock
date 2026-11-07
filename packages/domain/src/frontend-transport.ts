import { directoryLeadershipRole, operationallyActive, type DirectoryRecord, type FrontendSnapshot, type LeadershipRecord, type SnapshotRevision } from './admin.js';

/** Internal bounded transport. It reconstructs the existing snapshot before any publication. */
export const FRONTEND_PAGE_VERSION = 'frontend-pages-v1' as const;
export const FRONTEND_SECTIONS = ['people','contacts','flights','squadrons','terms','events','eventRosters','eventFlights','observations','requests','corrections','termRosters','legacyBaselines'] as const;
export type FrontendSection = typeof FRONTEND_SECTIONS[number];
export const FRONTEND_SECTION_BOUNDS: Record<FrontendSection,number> = {people:500,contacts:200,flights:50,squadrons:20,terms:20,events:200,eventRosters:100000,eventFlights:10000,observations:10000,requests:5000,corrections:10000,termRosters:10000,legacyBaselines:25000};
export const FRONTEND_PAGE_MAX_BYTES = 128000;
export interface FrontendPageManifest {
  contractVersion:typeof FRONTEND_PAGE_VERSION;section:'manifest';environment:'local'|'staging';generation:number;revision:SnapshotRevision;
  sections:{section:FrontendSection;count:number}[];diagnostics:{code:string;count:number}[];
  effect?:{effectId:string;kind:string};
}
export interface FrontendDataPage {contractVersion:typeof FRONTEND_PAGE_VERSION;section:FrontendSection;offset:number;nextOffset:number|null;revision:SnapshotRevision;rows:Record<string,unknown>[];}
export interface FrontendVerifyPage {contractVersion:typeof FRONTEND_PAGE_VERSION;section:'verify';revision:SnapshotRevision;verified:true;effect?:{effectId:string;kind:string};}
export type FrontendPage = FrontendPageManifest|FrontendDataPage|FrontendVerifyPage;
const check=(condition:unknown):void=>{if(!condition)throw new Error('INVALID_FRONTEND_PAGE_SEQUENCE');};
const sameRevision=(a:SnapshotRevision,b:SnapshotRevision)=>a?.operations===b?.operations&&a?.administration===b?.administration;
/** Reject missing/duplicate/torn pages. Version zero is derived only from actual imported facts, never guessed. */
export function assembleFrontendSnapshotPages(manifest:FrontendPageManifest,pages:FrontendDataPage[],verified:FrontendVerifyPage):FrontendSnapshot {
  check(manifest?.contractVersion===FRONTEND_PAGE_VERSION&&manifest.section==='manifest'&&verified?.contractVersion===FRONTEND_PAGE_VERSION&&verified.section==='verify'&&verified.verified===true&&sameRevision(manifest.revision,verified.revision));
  check(['local','staging'].includes(manifest.environment)&&Number.isSafeInteger(manifest.generation)&&manifest.generation>0);
  check(Number.isSafeInteger(manifest.revision.operations)&&manifest.revision.operations>=0&&Number.isSafeInteger(manifest.revision.administration)&&manifest.revision.administration>=0);
  check(JSON.stringify(manifest.effect??null)===JSON.stringify(verified.effect??null));
  check(manifest.sections.length===FRONTEND_SECTIONS.length&&manifest.sections.every((s,i)=>s.section===FRONTEND_SECTIONS[i]&&Number.isSafeInteger(s.count)&&s.count>=0&&s.count<=FRONTEND_SECTION_BOUNDS[s.section]));
  const data={} as Record<FrontendSection,Record<string,unknown>[]>;let pageIndex=0;
  for(const entry of manifest.sections){
    const rows:Record<string,unknown>[]=[];let offset=0;
    do {const page=pages[pageIndex++];check(page?.contractVersion===FRONTEND_PAGE_VERSION&&page.section===entry.section&&page.offset===offset&&sameRevision(page.revision,manifest.revision)&&Array.isArray(page.rows));
      check(page.rows.length<=512&&rows.length+page.rows.length<=entry.count);rows.push(...page.rows);offset+=page.rows.length;
      check(page.nextOffset===(offset<entry.count?offset:null));check(page.rows.length>0||entry.count===0);
    }while(offset<entry.count);
    check(rows.length===entry.count);data[entry.section]=rows;
  }
  check(pageIndex===pages.length);
  const people=data.people.map(({virtualContactId,...person})=>({...person,active:operationallyActive(person as unknown as DirectoryRecord)})) as FrontendSnapshot['people'];
  const contacts=data.contacts as unknown as (Omit<LeadershipRecord,'active'|'contactVersion'|'profileVersion'|'publicationVersion'>&{version:number;active:number})[];
  const flights=data.flights as unknown as FrontendSnapshot['flights'],squadrons=data.squadrons as unknown as FrontendSnapshot['squadrons'];
  const leadership:LeadershipRecord[]=contacts.filter(c=>c.personId===null).map(({version,...c})=>({...c,active:!!c.active,contactVersion:version,profileVersion:null,publicationVersion:version}));
  const contactsByPerson=new Map(contacts.filter(c=>c.personId!==null).map(c=>[c.personId,c])),flightsById=new Map(flights.map(f=>[f.flightId,f])),squadsById=new Map(squadrons.map(s=>[s.squadronId,s]));
  for(const [index,p]of people.entries()){
    if(!p.active)continue;const f=p.flightId?flightsById.get(p.flightId):undefined,role=directoryLeadershipRole(p.role,f?.label??'',f?.squadronId?squadsById.get(f.squadronId)?.label??'':'');if(!role)continue;
    const contact=contactsByPerson.get(p.personId),contactVersion=contact?.version??0,publicationVersion=p.version+contactVersion,virtualContactId=data.people[index].virtualContactId;
    check(Number.isSafeInteger(publicationVersion)&&typeof virtualContactId==='string'&&/^cadet:[a-f0-9]{64}$/.test(virtualContactId));
    leadership.push({contactId:contact?.contactId??String(virtualContactId),contactVersion,profileVersion:p.version,publicationVersion,personId:p.personId,lastName:p.lastName,firstName:p.firstName,rank:p.rank,role,email:p.email,cellPhone:p.phone,reportsTo:contact?.reportsTo??'',officePhone:contact?.officePhone??'',officeLocation:contact?.officeLocation??'',active:contact?!!contact.active:true});
  }
  const rosters=new Map<string,NonNullable<FrontendSnapshot['terms'][number]['roster']>>();for(const {termId,...person}of data.termRosters){const roster=rosters.get(String(termId))??[];roster.push(person as NonNullable<FrontendSnapshot['terms'][number]['roster']>[number]);rosters.set(String(termId),roster);}
  const eligible=new Map<string,string[]>();for(const r of data.eventRosters){const ids=eligible.get(String(r.eventId))??[];ids.push(String(r.personId));eligible.set(String(r.eventId),ids);}
  const events=data.events.map(({hasRoster,...event})=>({...event,eligiblePersonIds:hasRoster===1?eligible.get(String(event.eventId))??[]:null})) as FrontendSnapshot['events'];
  const requests=data.requests.map(r=>({...r,legacyStateOnly:r.legacyStateOnly===1})) as unknown as FrontendSnapshot['requests'];
  const versions=new Map<string,{personId:string;eventId:string;version:number}>();
  for(const row of [...data.observations,...data.requests,...data.corrections,...data.legacyBaselines]){
    const personId=String(row.personId),eventId=String(row.eventId),version=typeof row.order==='number'?row.order:0,key=JSON.stringify([personId,eventId]);
    check(Number.isSafeInteger(version)&&version>=0);const previous=versions.get(key);if(!previous||previous.version<version)versions.set(key,{personId,eventId,version});
  }
  check(versions.size<=25000);const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
  const attendanceVersions=[...versions.values()].sort((a,b)=>compare(a.personId,b.personId)||compare(a.eventId,b.eventId));
  const diagnostics=[...manifest.diagnostics,{code:'FLIGHTS_MISSING_SQUADRON',count:flights.filter(f=>f.squadronId===null).length},{code:'EVENTS_MISSING_ROSTER',count:events.filter(e=>e.eligiblePersonIds===null).length}].filter(d=>d.count>0);
  return {contractVersion:1,environment:manifest.environment,generation:manifest.generation,revision:manifest.revision,people,leadership,flights,squadrons,
    terms:data.terms.map(t=>({...t,isCurrent:!!t.isCurrent,...(rosters.has(String(t.termId))?{roster:rosters.get(String(t.termId))}:{})})) as FrontendSnapshot['terms'],events,eventFlights:data.eventFlights as FrontendSnapshot['eventFlights'],observations:data.observations as FrontendSnapshot['observations'],requests,corrections:data.corrections as FrontendSnapshot['corrections'],legacyBaselines:data.legacyBaselines as NonNullable<FrontendSnapshot['legacyBaselines']>,attendanceVersions,diagnostics};
}
