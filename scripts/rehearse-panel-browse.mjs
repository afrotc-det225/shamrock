// Compare display models against the existing pager on an owner-only SQLite export.
// Only aggregate counts and response sizes may leave this process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

async function run(file, generation) {
  const info = fs.lstatSync(file);
  assert(info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077));
  assert(Number.isSafeInteger(generation) && generation > 0);
  const bundle = await build({
    stdin: {resolveDir:process.cwd(), contents:[
      "export {panelBrowse} from './apps/worker/src/panel-view-as'",
      "export {frontendSnapshotPage} from './apps/worker/src/frontend-transport'",
      "export {panelSnapshotPage,panelReadAuthority} from './apps/worker/src/panel-read'",
      "export {loadSnapshot} from './apps/admin/snapshot-client'",
      "export {hydrateReporting} from './apps/admin/src/reporting'",
      "export {decodeBrowse} from './apps/admin/src/browse'",
    ].join('\n')},
    write:false, bundle:true, platform:'node', format:'esm',
  });
  const runtime = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
  const db = new DatabaseSync(file,{readOnly:true, allowExtension:false});
  const prepare = (sql,args=[]) => ({sql,args,bind:(...values)=>prepare(sql,values)});
  const env = {ENVIRONMENT:'staging', GENERATION:String(generation), DB:{prepare,
    batch: statements => statements.map(({sql,args}) => ({results:db.prepare(sql).all(...args)})),
  }};
  const tested = new Set();
  const pick = (rows, fields) => rows.map(row => fields.split(' ').map(field => row[field]));
  const matrix = reporting => reporting.matrices.map(m => ({
    events:m.eventColumns.map(e=>e.eventId),
    rows:m.rows.map(row=>[row.personId,row.overall,row.llab,pick(row.cells,'effectiveCode needsReview eligible')]),
  }));
  try {
    db.exec('BEGIN');
    const now = Date.now();
    for (const actor of db.prepare('SELECT principal_id FROM principals WHERE active=1').iterate()) {
      const identity = {principalId:actor.principal_id, generation, environment:'staging'};
      let authority;
      try { authority = await runtime.panelReadAuthority(env,identity); }
      catch (error) { if (error.code === 'NOT_AUTHORIZED') continue; throw error; }
      const wing = authority.access.capabilities.fullSnapshot;
      const group = wing ? 'wing' : authority.access.flightIds.length > 1 ? 'multi-flight' : 'flight';
      if (tested.has(group)) continue;
      const manifest = await runtime.panelSnapshotPage(env,{...identity,section:'manifest',offset:0,revision:null});
      const full = await runtime.loadSnapshot({manifest}, (_,page) => {
        const {surface,accessRevision,...input} = page;
        const read = surface === 'full' ? runtime.frontendSnapshotPage : runtime.panelSnapshotPage;
        return read(env,{...input,...identity});
      });
      const {reporting} = runtime.hydrateReporting({snapshot:full,reportingTime:now});
      const active = new Set(full.events.filter(e=>e.status==='active').map(e=>e.eventId));
      const requests = full.requests.filter(r=>active.has(r.eventId));
      for (const profile of wing ? ['cadets','leadership','attendance','excusals','overview'] : ['attendance','excusals']) {
        const browse = await runtime.panelBrowse(env,{...identity,profile});
        const data = await runtime.decodeBrowse({browse,manifest,reportingTime:now});
        if (profile==='cadets' || profile==='leadership') {
          const fields = 'personId lastName firstName version email asYear rank flightId flightPathStatus';
          assert.deepEqual(pick(data.list.people,fields),pick(full.people,fields));
        }
        if (profile==='leadership') {
          const fields = 'contactId firstName lastName role rank email officeLocation';
          assert.deepEqual(pick(data.list.leadership,fields),pick(full.leadership,fields));
        }
        if (profile==='attendance') {
          assert.deepEqual(matrix(data.reporting),matrix(reporting));
          assert.deepEqual(data.list.attendanceVersions,full.attendanceVersions);
        }
        if (profile==='excusals') {
          const fields = 'requestId personId reason status eventId version flightId requestedOutcome' + (wing?'':' canDecide personDisplayName');
          assert.deepEqual(pick(data.list.requests,fields),pick(requests,fields));
        }
        if (profile==='overview') assert.deepEqual(data.overview,{
          term:full.terms.find(t=>t.isCurrent)?.label,activeCadets:reporting.dashboard.totalCadets,
          activeEvents:active.size,pending:requests.filter(r=>r.status==='Submitted').length,
        });
        console.log(group, profile, Buffer.byteLength(JSON.stringify(browse)), 'bytes verified');
      }
      tested.add(group);
    }
    assert(tested.has('wing') && (tested.has('flight') || tested.has('multi-flight')));
  } finally { db.close(); }
}
run(process.argv[2],Number(process.argv[3])).catch(() => {
  console.error('Private staging parity check failed. Verify the source, generation and expected scopes.');
  process.exitCode=1;
});
