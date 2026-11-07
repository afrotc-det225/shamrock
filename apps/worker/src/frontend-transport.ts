import { effectiveAdminGrants } from './permission-grants.js';
import { DIRECTORY_FIELDS, type SnapshotRevision } from '../../../packages/domain/src/admin.js';
import { FRONTEND_PAGE_MAX_BYTES, FRONTEND_PAGE_VERSION, FRONTEND_SECTIONS, FRONTEND_SECTION_BOUNDS, type FrontendPage, type FrontendPageManifest, type FrontendSection } from '../../../packages/domain/src/frontend-transport.js';
import { HttpError } from './http-error.js';
interface Env {DB:D1Database;ENVIRONMENT:string;GENERATION:string}
type Value=string|number|null;
const stmt=(db:D1Database,sql:string,...values:Value[])=>db.prepare(sql).bind(...values);
const fail=(status:number,code:string):never=>{throw new HttpError(status,code,'The coherent frontend read must be retried before publication.');};
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const revisionSql=`SELECT (SELECT COALESCE(MAX(audit_id),0) FROM audit_events) AS operations,(SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events) AS administration`;
const contactsFrom=`FROM leadership_contacts c WHERE NOT EXISTS(SELECT 1 FROM legacy_operational_adoption_rows r JOIN legacy_operational_adoptions a ON a.adoption_id=r.adoption_id WHERE r.kind='leadership' AND r.target_id=c.contact_id AND a.state<>'complete')`;
const requestsFrom=`FROM excusal_records r LEFT JOIN audit_events a ON a.command_id=r.last_command_id WHERE r.origin='native' OR EXISTS(SELECT 1 FROM legacy_operational_adoptions l WHERE l.adoption_id=r.legacy_adoption_id AND l.state='complete')`;
const baselineFrom=`FROM legacy_attendance_baselines b JOIN legacy_import_runs i ON i.import_run_id=b.import_run_id AND i.state='complete'`;
const eventRosterFrom=`FROM event_roster_members m JOIN event_details d ON d.event_id=m.event_id AND d.version=m.version JOIN event_roster_versions v ON v.event_id=m.event_id AND v.version=m.version`;
const profileColumns=['last_name','first_name','as_year','rank','role','university','email','phone','dorm','cip_broad_area','cip_code','afsc','home_town','home_state','class_year','date_of_birth','flight_path_status','photo_link'];
const queries:Record<FrontendSection,{select:string;from:string;order:string;limit:number}>={
  people:{select:`d.person_id AS personId,d.version,d.flight_id AS flightId,${profileColumns.map((c,i)=>`d.${c} AS ${DIRECTORY_FIELDS[i]}`).join(',')}`,from:'FROM directory_profiles d',order:'d.person_id',limit:32},
  contacts:{select:'contact_id AS contactId,version,person_id AS personId,last_name AS lastName,first_name AS firstName,rank,role,email,cell_phone AS cellPhone,reports_to AS reportsTo,office_phone AS officePhone,office_location AS officeLocation,active',from:contactsFrom,order:'contact_id',limit:32},
  flights:{select:'u.unit_id AS flightId,u.label,h.squadron_id AS squadronId,u.roster_version AS rosterVersion',from:'FROM organizational_units u LEFT JOIN flight_hierarchy h ON h.unit_id=u.unit_id',order:'u.unit_id',limit:50},
  squadrons:{select:'squadron_id AS squadronId,label',from:'FROM squadrons',order:'squadron_id',limit:20},
  terms:{select:'term_id AS termId,label,sort_order AS sortOrder,is_current AS isCurrent',from:'FROM terms',order:'sort_order,term_id',limit:20},
  events:{select:`e.event_id AS eventId,d.version,d.term_id AS termId,d.event_type AS eventType,d.training_week AS trainingWeek,d.display_order AS displayOrder,e.label,d.column_label AS columnLabel,d.expected_group AS expectedGroup,d.status,d.start_at AS startAt,d.end_at AS endAt,d.location,d.notes,EXISTS(SELECT 1 FROM event_roster_versions v WHERE v.event_id=e.event_id AND v.version=d.version) AS hasRoster`,from:'FROM events e JOIN event_details d ON d.event_id=e.event_id',order:'d.display_order,e.event_id',limit:32},
  eventRosters:{select:'m.event_id AS eventId,m.person_id AS personId',from:eventRosterFrom,order:'m.event_id,m.person_id',limit:512},
  eventFlights:{select:'event_id AS eventId,unit_id AS flightId',from:'FROM event_units',order:'event_id,unit_id',limit:512},
  observations:{select:`'observation:'||o.observation_id AS factId,o.person_id AS personId,o.event_id AS eventId,a.audit_id AS 'order',o.code`,from:'FROM attendance_observations o JOIN attendance_reports r ON r.report_id=o.report_id JOIN audit_events a ON a.command_id=r.command_id',order:'o.observation_id',limit:256},
  requests:{select:`r.request_id AS requestId,r.person_id AS personId,r.event_id AS eventId,r.unit_id AS flightId,COALESCE(a.audit_id,0) AS 'order',(r.origin='legacy' AND r.last_command_id IS NULL) AS legacyStateOnly,r.status,r.requested_outcome AS requestedOutcome,r.version,r.reason,r.submitted_at AS submittedAt,r.submitted_by AS submittedBy,r.updated_at AS updatedAt,r.decided_at AS decidedAt,r.decided_by AS decidedBy,r.decision_reason AS decisionReason`,from:requestsFrom,order:'r.request_id',limit:32},
  corrections:{select:`'correction:'||c.correction_id AS factId,c.person_id AS personId,c.event_id AS eventId,a.audit_id AS 'order',c.code`,from:'FROM attendance_corrections c JOIN audit_events a ON a.command_id=c.command_id',order:'a.audit_id',limit:256},
  termRosters:{select:'term_id AS termId,person_id AS personId,last_name AS lastName,first_name AS firstName,as_year AS asYear,flight_id AS flightId,flight_path_status AS flightPathStatus,date_of_birth AS dateOfBirth',from:'FROM term_roster_snapshots',order:'term_id,person_id',limit:128},
  legacyBaselines:{select:'b.baseline_id AS baselineId,b.person_id AS personId,b.event_id AS eventId,b.code',from:baselineFrom,order:'b.person_id,b.event_id',limit:256},
};
/** Every page uses one D1 transaction for authorization, revision and bounded rows. No provider writes. */
export async function frontendSnapshotPage(env:Env,input:unknown,forEffect=false):Promise<FrontendPage>{
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'INVALID_PAGE_REQUEST');const req=input as Record<string,unknown>;
  const keys=['environment','generation','principalId','section','offset','revision',...(forEffect?['workerId','effectId','claimToken']:[])];
  if(Object.keys(req).length!==keys.length||keys.some(k=>!Object.hasOwn(req,k))||!identifier(req.principalId)||forEffect&&['workerId','effectId','claimToken'].some(k=>!identifier(req[k])))fail(400,'INVALID_PAGE_REQUEST');
  if(req.environment!==env.ENVIRONMENT||req.generation!==Number(env.GENERATION))fail(409,'WRONG_GENERATION');
  const section=req.section;if(typeof section!=='string'||!['manifest','verify',...FRONTEND_SECTIONS].includes(section)||!Number.isSafeInteger(req.offset)||Number(req.offset)<0)fail(400,'INVALID_PAGE_REQUEST');
  if(section==='manifest'?req.revision!==null||req.offset!==0:!req.revision||typeof req.revision!=='object'||Array.isArray(req.revision)||Object.keys(req.revision).sort().join(',')!=='administration,operations'||Object.values(req.revision).some(v=>!Number.isSafeInteger(v)||Number(v)<0))fail(400,'INVALID_PAGE_REQUEST');
  if(section==='verify'&&req.offset!==0||section!=='manifest'&&section!=='verify'&&Number(req.offset)>FRONTEND_SECTION_BOUNDS[section as FrontendSection])fail(400,'INVALID_PAGE_REQUEST');
  const guard=`EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?${forEffect?' AND accepting_commands=1':''}) AND EXISTS(SELECT 1 FROM principals p JOIN ${effectiveAdminGrants} g ON g.principal_id=p.principal_id WHERE p.principal_id=? AND p.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')`;
  const statements=[stmt(env.DB,`SELECT (${guard}) AS allowed,NOT EXISTS(SELECT 1 FROM legacy_import_runs WHERE state<>'complete') AND NOT EXISTS(SELECT 1 FROM legacy_operational_adoptions WHERE state<>'complete') AS ready`,env.ENVIRONMENT,Number(env.GENERATION),String(req.principalId)),stmt(env.DB,revisionSql)];
  if(forEffect)statements.push(stmt(env.DB,`SELECT effect_id AS effectId,kind,claim_operations_revision AS operationsFloor,claim_administration_revision AS administrationFloor FROM admin_effects WHERE effect_id=? AND worker_id=? AND claim_token=? AND state='leased' AND lease_expires_at>?`,String(req.effectId),String(req.workerId),String(req.claimToken),new Date().toISOString()));
  const resultIndex=statements.length;
  if(section==='manifest'){
    statements.push(stmt(env.DB,`SELECT ${FRONTEND_SECTIONS.map(s=>`(SELECT COUNT(*) ${queries[s].from}) AS ${s}`).join(',')}`));
    statements.push(stmt(env.DB,`SELECT (SELECT COUNT(*) FROM people p WHERE NOT EXISTS(SELECT 1 FROM directory_profiles d WHERE d.person_id=p.person_id)) AS peopleMissingProfiles,(SELECT COUNT(*) FROM events e WHERE NOT EXISTS(SELECT 1 FROM event_details d WHERE d.event_id=e.event_id)) AS eventsMissingDetails`));
  }else if(section!=='verify'){const q=queries[section as FrontendSection];statements.push(stmt(env.DB,`SELECT ${q.select} ${q.from} ORDER BY ${q.order} LIMIT ? OFFSET ?`,q.limit+1,Number(req.offset)));}
  const results=await env.DB.batch<Record<string,unknown>>(statements);
  if(results[0].results[0]?.allowed!==1)fail(403,'NOT_AUTHORIZED');if(results[0].results[0]?.ready!==1)fail(409,'SNAPSHOT_IMPORT_ACTIVE');
  const revision=results[1].results[0] as unknown as SnapshotRevision,expected=req.revision as SnapshotRevision|null;
  if(expected&&(expected.operations!==revision.operations||expected.administration!==revision.administration))fail(409,'SNAPSHOT_CHANGED');
  let effect:FrontendPageManifest['effect'];
  if(forEffect){const lease=results[2].results[0];if(!lease)fail(409,'LEASE_CONFLICT');if(lease.kind==='frontend.refresh'&&(lease.operationsFloor===null||lease.administrationFloor===null||revision.operations<Number(lease.operationsFloor)||revision.administration<Number(lease.administrationFloor)))fail(409,'SNAPSHOT_BEHIND_CLAIM');effect={effectId:String(lease.effectId),kind:String(lease.kind)};}
  if(section==='manifest'){
    const counts=results[resultIndex].results[0],diagnostics=results[resultIndex+1].results[0];
    const sections=FRONTEND_SECTIONS.map(section=>({section,count:Number(counts[section])}));if(sections.some(s=>s.count>FRONTEND_SECTION_BOUNDS[s.section]))fail(409,'SNAPSHOT_TOO_LARGE');
    return {contractVersion:FRONTEND_PAGE_VERSION,section:'manifest',environment:req.environment as 'local'|'staging',generation:Number(req.generation),revision,sections,diagnostics:[{code:'PEOPLE_MISSING_PROFILES',count:Number(diagnostics.peopleMissingProfiles)},{code:'EVENTS_MISSING_DETAILS',count:Number(diagnostics.eventsMissingDetails)}].filter(d=>d.count>0),...(effect?{effect}:{})};
  }
  if(section==='verify')return {contractVersion:FRONTEND_PAGE_VERSION,section:'verify',revision,verified:true,...(effect?{effect}:{})};
  const q=queries[section as FrontendSection],sourceRows=results[resultIndex].results;let bytes=1000;const rows:Record<string,unknown>[]=[];
  for(const source of sourceRows.slice(0,q.limit)){
    const row=section==='people'?{...source,virtualContactId:`cadet:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(source.personId)))),b=>b.toString(16).padStart(2,'0')).join('')}`}:source;
    const size=new TextEncoder().encode(JSON.stringify(row)).length+1;if(bytes+size>FRONTEND_PAGE_MAX_BYTES){if(!rows.length)fail(409,'SNAPSHOT_ROW_TOO_LARGE');break;}bytes+=size;rows.push(row);
  }
  return {contractVersion:FRONTEND_PAGE_VERSION,section:section as FrontendSection,offset:Number(req.offset),nextOffset:sourceRows.length>rows.length?Number(req.offset)+rows.length:null,revision,rows};
}
