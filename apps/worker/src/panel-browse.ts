// Read models for the browser. Commands and native publication retain their own contracts.
import {readPanelContext, authorityStatements, panelSectionQueries, scopedPanelSource} from './panel-read.js';
import {scopeCte, semesterQueries, directoryCatalogQuery, leadershipCatalogQuery} from './frontend-transport.js';
import {HttpError} from './http-error.js';
type Env = {DB:D1Database;ENVIRONMENT:string;GENERATION:string};
type Query = {select:string;from:string;order:string};
export const profiles = ['cadets','leadership','attendance','excusals','overview'] as const;
export type Profile = typeof profiles[number];
const error = (code:string,status=409) => new HttpError(status,code,'Reload the page to read current records.');

export async function browsePanel(env:Env, identity:{environment:string;generation:number;principalId:string}, profile:Profile) {
  if (!profiles.includes(profile)) throw error('INVALID_PANEL_REQUEST',400);
  if (env.ENVIRONMENT!==identity.environment || Number(env.GENERATION)!==identity.generation) throw error('WRONG_GENERATION');
  const {first,access,control,revision} = await readPanelContext(env,identity.principalId);
  const wing = access.capabilities.fullSnapshot;
  if (!wing && profile !== 'attendance' && profile !== 'excusals') throw error('NOT_AUTHORIZED',403);
  const source = wing ? {cte:scopeCte,bind:[null]} : scopedPanelSource(identity.principalId,access.flightIds,true);
  const q = wing ? semesterQueries : panelSectionQueries();
  const people = wing ? directoryCatalogQuery : q.people;
  const limits:Record<string,number>={people:2000,contacts:2000,flights:50,squadrons:20,terms:20,events:200,eligible:100000,baselines:25000,observations:10000,corrections:10000,requests:5000};
  const names:string[]=[], statements:D1PreparedStatement[]=[];
  // Aggregate in SQLite. Large roster/fact sections use small numeric event and person
  // references; JSON parsing and reporting work belongs to the browser.
  function table(name:string, query:Query, fields:string, where='') {
    names.push(name);
    const sql = source.cte+' SELECT CASE WHEN COUNT(*)<= '+limits[name]+
      ' AND COALESCE(SUM(length(CAST(item AS BLOB))),0)<=900000 THEN json_group_array(json(item)) END AS payload FROM ('+
      'SELECT json_array('+fields+') AS item FROM (SELECT '+query.select+' '+query.from+' ORDER BY '+query.order+') x '+where+
      ' LIMIT '+(limits[name]+1)+')';
    statements.push(env.DB.prepare(sql).bind(...source.bind));
  }
  const personRef='(SELECT rowid FROM people p WHERE p.person_id=x.personId)';
  const eventRef='(SELECT rowid FROM events e WHERE e.event_id=x.eventId)';
  const activeEvents="eventId IN (SELECT event_id FROM event_details WHERE term_id=(SELECT term_id FROM terms WHERE is_current=1) AND status='active')";
  const activePeople="flightPathStatus NOT IN ('Inactive','Commissioned','Dropped')";
  if(profile==='cadets'||profile==='leadership') {
    table('people',people,'personId,version,flightId,lastName,firstName,rank,asYear,flightPathStatus,email,role');
    table('flights',q.flights,'flightId,label,squadronId');
    if(profile==='leadership'){
      table('squadrons',q.squadrons,'squadronId,label');
      table('contacts',leadershipCatalogQuery,'contactId,version,personId,lastName,firstName,rank,role,email,officeLocation,active');
    }
  } else if(profile==='overview') {
    const count=(name:string, query:Query, where:string)=>{
      names.push(name);
      statements.push(env.DB.prepare(source.cte+' SELECT count(*) AS payload FROM (SELECT '+query.select+' '+query.from+') WHERE '+where).bind(...source.bind));
    };
    count('activeCadets',people,activePeople);count('activeEvents',q.events,"status='active'");
    count('pending',q.requests,"status='Submitted' AND "+activeEvents);
    table('terms',q.terms,'termId,label');
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
      table('eligible',q.eventRosters,eventRef+','+personRef);
      table('baselines',q.legacyBaselines,personRef+','+eventRef+',code,baselineRevision');
      for (const section of ['observations','corrections'] as const)
        table(section,q[section],personRef+','+eventRef+',factId,"order",code');
      table('requests',q.requests,'requestId,'+personRef+','+eventRef+',"order",status,requestedOutcome,legacyStateOnly');
    }
  }
  const fence=authorityStatements(env,identity.principalId);
  const results=await env.DB.batch<Record<string,unknown>>([...fence,...statements]);
  if (JSON.stringify(first)!==JSON.stringify(results.slice(0,fence.length).map(r=>r.results))) throw error('SNAPSHOT_CHANGED');
  const tables=Object.fromEntries(results.slice(fence.length).map((r,i)=>[names[i],r.results[0].payload as string|number|null]));
  if (Object.values(tables).some(s=>s===null) || Object.values(tables).reduce<number>((n,s)=>n+String(s).length,0)>900000) throw error('BROWSE_TOO_LARGE');
  return {profile,scope:{termId:control.termId,currentTermId:control.termId},revision,tables};
}
