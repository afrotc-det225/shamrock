import type {WingTableCache} from './panel-cache.js';
// Read models for the browser. Commands and native publication retain their own contracts.
import {readPanelContext, authorityStatements, panelSectionQueries, scopedPanelSource} from './panel-read.js';
import {scopeCte, semesterQueries, directoryCatalogQuery, leadershipCatalogQuery} from './frontend-transport.js';
import {baselineRevisionSql} from './corrections.js';
import {HttpError} from './http-error.js';
type Env = {DB:D1Database;ENVIRONMENT:string;GENERATION:string};
type Query = {select:string;from:string;order:string};
export const profiles = ['cadets','cadet-details','leadership','attendance','excusals','overview','semester','diagnostics'] as const;
export type Profile = typeof profiles[number];
const error = (code:string,status=409) => new HttpError(status,code,'Reload the page to read current records.');

export async function browsePanel(env:Env, identity:{environment:string;generation:number;principalId:string}, profile:Profile, wingCache?:WingTableCache) {
  if (!profiles.includes(profile)) throw error('INVALID_PANEL_REQUEST',400);
  if (env.ENVIRONMENT!==identity.environment || Number(env.GENERATION)!==identity.generation) throw error('WRONG_GENERATION');
  const authority = await readPanelContext(env,identity.principalId);
  const {first,access,control,revision} = authority;
  const wing = access.capabilities.fullSnapshot;
  if (!wing && profile !== 'attendance' && profile !== 'excusals') throw error('NOT_AUTHORIZED',403);
  const source = wing ? {cte:scopeCte,bind:[null]} : scopedPanelSource(identity.principalId,access.flightIds,'browse');
  const q = wing ? semesterQueries : panelSectionQueries();
  const people = wing ? directoryCatalogQuery : q.people;
  const limits:Record<string,number>={people:2000,contacts:2000,birthdays:2000,flights:50,squadrons:20,terms:20,events:200,eligible:100000,baselines:25000,observations:10000,corrections:10000,requests:5000};
  const selects:string[]=[];
  // Aggregate in SQLite. Large roster/fact sections use small numeric event and person
  // references; JSON parsing and reporting work belongs to the browser.
  function table(name:string, query:Query, fields:string, where='') {
    const sql = `SELECT '${name}' AS name, CASE WHEN COUNT(*)<= `+limits[name]+
      ' AND COALESCE(SUM(length(CAST(item AS BLOB))),0)<=900000 THEN json_group_array(json(item)) END AS payload FROM ('+
      'SELECT json_array('+fields+') AS item FROM (SELECT '+query.select+' '+query.from+' ORDER BY '+query.order+') x '+where+
      ' LIMIT '+(limits[name]+1)+')';
    selects.push(sql);
  }
  // One dictionary per statement avoids two index probes per attendance cell.
  // Leave the direct indexed path for the small list and excusal profiles.
  function reference(table:'people'|'events',column:'person_id'|'event_id',field:'personId'|'eventId') {
    const lookup = `(SELECT rowid FROM ${table} WHERE ${column}=x.${field})`;
    if (profile!=='attendance') return lookup;
    const dictionary = `(SELECT json_group_object(${column},rowid) FROM ${table})`;
    return `coalesce(json_extract(${dictionary}, '$.'||json_quote(x.${field})),${lookup})`;
  }
  const personRef=reference('people','person_id','personId');
  const eventRef=reference('events','event_id','eventId');
  const activeEvents="eventId IN (SELECT event_id FROM event_details WHERE term_id=(SELECT term_id FROM terms WHERE is_current=1) AND status='active')";
  const activePeople="flightPathStatus NOT IN ('Inactive','Commissioned','Dropped')";
  if(profile==='cadets'||profile==='cadet-details'||profile==='leadership') {
    table('people',people,'personId,version,flightId,lastName,firstName,rank,asYear,flightPathStatus,email,role'+(profile!=='leadership'?',afsc,university,classYear,cipCode,cipBroadArea':'')+
      (profile==='cadet-details'?',phone,dorm,homeTown,homeState,dateOfBirth,photoLink':''));
    table('flights',q.flights,'flightId,label,squadronId');
    table('squadrons',q.squadrons,'squadronId,label');
    if(profile==='leadership'){
      table('contacts',leadershipCatalogQuery,'contactId,version,personId,lastName,firstName,rank,role,email,officeLocation,active,reportsTo');
    }
  } else if(profile==='diagnostics') {
    const counts:Record<string,string>={
      PEOPLE_MISSING_PROFILES:"SELECT count(*) FROM people p WHERE NOT EXISTS(SELECT 1 FROM directory_profiles d WHERE d.person_id=p.person_id) AND p.person_id IN(SELECT person_id FROM scoped_people)",
      EVENTS_MISSING_DETAILS:"SELECT count(*) FROM events e WHERE e.active=1 AND NOT EXISTS(SELECT 1 FROM event_details d WHERE d.event_id=e.event_id)",
      FLIGHTS_MISSING_SQUADRON:"SELECT count(*) FROM ("+q.flights.select+" "+q.flights.from+") WHERE squadronId IS NULL",
      EVENTS_MISSING_ROSTER:"SELECT count(*) FROM ("+q.events.select+" "+q.events.from+") WHERE hasRoster=0",
    };
    for(const [code,sql] of Object.entries(counts)) selects.push("SELECT '"+code+"' AS name, ("+sql+") AS payload");
  } else if(profile==='semester') {
    table('people',directoryCatalogQuery,'personId,version,firstName,lastName,rank,asYear,role,flightId,flightPathStatus');
    table('terms',q.terms,'termId,label,sortOrder,isCurrent');
    table('flights',q.flights,'flightId,label');
    table('events',q.events,'termId,eventType,trainingWeek,status,startAt,endAt');
  } else if(profile==='overview') {
    const count=(name:string, query:Query, where:string)=>{
      selects.push(`SELECT '${name}' AS name, count(*) AS payload FROM (SELECT `+query.select+' '+query.from+') WHERE '+where);
    };
    count('activeCadets',people,activePeople);count('activeEvents',q.events,"status='active'");
    count('pending',q.requests,"status='Submitted' AND "+activeEvents);
    table('terms',q.terms,'termId,label');
    table('flights',q.flights,'flightId,label,squadronId');
    table('squadrons',q.squadrons,'squadronId,label');
    table('birthdays',people,"firstName,lastName,substr(dateOfBirth,6,5),flightId",'WHERE '+activePeople+' AND dateOfBirth IS NOT NULL');
  } else {
    table('flights',q.flights,'flightId,label,squadronId');
    table('terms',q.terms,'termId,label,sortOrder,isCurrent');
    table('people',people,personRef+',personId,lastName,firstName,asYear,flightId,flightPathStatus');
    table('events',q.events,eventRef+',eventId,termId,label,columnLabel,eventType,status,trainingWeek,displayOrder,hasRoster,version');
    if(profile==='excusals') {
      table('requests',q.requests,"requestId,personId,eventId,flightId,status,requestedOutcome,reason,version,"+
        (wing?'NULL,1':'personDisplayName,canDecide'),'WHERE '+activeEvents);
    } else {
      table('squadrons',q.squadrons,'squadronId,label');
      const visiblePeople = wing ? '' : ' AND person_id IN(SELECT person_id FROM scoped_people)';
      // Drive the versioned roster by event; its composite FK already requires
      // a matching roster version. Only current event versions are visible.
      table('eligible',{
        select:'d.event_id AS eventId,m.person_id AS personId',
        from:'FROM event_details d CROSS JOIN event_roster_members m ON m.event_id=d.event_id AND m.version=d.version WHERE d.event_id IN(SELECT event_id FROM scoped_events)'+visiblePeople,
        order:'d.event_id,m.person_id',
      },eventRef+','+personRef);
      table('baselines',{
        select:`b.person_id AS personId,b.event_id AS eventId,b.code,json_extract((SELECT json_group_object(i.import_run_id,${baselineRevisionSql}) FROM legacy_import_runs i WHERE i.state='complete'),'$.'||json_quote(b.import_run_id)) AS baselineRevision`,
        from:"FROM legacy_attendance_baselines b WHERE b.import_run_id IN(SELECT import_run_id FROM legacy_import_runs WHERE state='complete') AND b.event_id IN(SELECT event_id FROM scoped_events)"+visiblePeople,
        // Match the event/person index. Consumers resolve these facts by pair.
        order:wing ? 'b.event_id,b.person_id' : 'b.person_id,b.event_id',
      },personRef+','+eventRef+',code,baselineRevision');
      for (const section of ['observations','corrections'] as const)
        table(section,q[section],personRef+','+eventRef+',factId,"order",code');
      table('requests',q.requests,'requestId,'+personRef+','+eventRef+',"order",status,requestedOutcome,legacyStateOnly');
    }
  }
  const fence=authorityStatements(env,identity.principalId);
  // Each compound query lets scoped views reuse materialized Flight membership,
  // visible requests and event scope across tables within the authorization fence.
  const payload:D1PreparedStatement[]=[];
  for(let start=0; start<selects.length; start+=5) {
    payload.push(env.DB.prepare(source.cte+selects.slice(start,start+5).join(' UNION ALL ')).bind(...source.bind));
  }
  const load = async () => {
    const results=await env.DB.batch<Record<string,unknown>>([...fence,...payload]);
    if (JSON.stringify(first)!==JSON.stringify(results.slice(0,fence.length).map(r=>r.results))) throw error('SNAPSHOT_CHANGED');
    const tables=Object.fromEntries(results.slice(fence.length).flatMap(r=>r.results).map(r=>[String(r.name),r.payload as string|number|null]));
    if (Object.values(tables).some(s=>s===null) || Object.values(tables).reduce<number>((n,s)=>n+String(s).length,0)>900000) throw error('BROWSE_TOO_LARGE');
    return tables;
  };
  const tables = wing && (profile === 'attendance' || profile === 'semester') && wingCache ? await wingCache({profile,termId:String(control.termId),principalId:identity.principalId,revision,authority},load) : await load();
  return {profile,scope:{termId:control.termId,currentTermId:control.termId},revision,tables};
}
