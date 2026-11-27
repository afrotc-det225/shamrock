import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogKey, fileKey, hash, semesterHistory } from '../hosted/semester-history.mjs';
import { compactReport } from '../history-table.mjs';
import { chooseSemesters } from '../../../scripts/prepare-history-files.mjs';

test('three semesters, newest main capture, separate corroborating and older sources', () => {
  const s = (resource,periodLabel,importedAt,layout) => ({resource,periodLabel,importedAt,layout});
  const rows = [s('main','2026-Fall','2','active'),s('main','2026-Fall','1','old'),
    s('backend','2026-Fall','2','active'),s('main','Spring 2026','1','spring'),
    s('external',null,'1','spring'),s('main','Fall 2025','1','fall'),s('external','Fall 2025','1','fall')];
  const sorted = chooseSemesters(rows.reverse());
  assert.deepEqual(sorted.map(([name]) => name), ['2025 Fall','2026 Spring','2026 Fall']);
  assert.equal(sorted[2][1].layout,'active');
  assert.throws(() => chooseSemesters([...rows,s('main','2026-Fall','2','duplicate')]));
  assert.throws(() => chooseSemesters([...rows,s('external',null,'2','unknown')]));
});

test('projection keeps source column order, saved percentages and intentional blanks', () => {
  const row = {overall:{stored:0},llab:{stored:null},cells:[{eventId:'b',code:''},{eventId:'a',code:'UR'}]};
  const archive = {eventColumns:[{snapshotEventId:'a',header:'LLAB'},{snapshotEventId:'b',header:'Secondary'}],
    rows:[row],summary:{unresolvedRows:1,formulaMismatches:1},sourceRoster:[{private:true}]};
  const table = compactReport(archive);
  assert.deepEqual(table.rows[0].codes,['UR','']);assert.equal(table.rows[0].overall,0);
  assert.equal(table.rows[0].llab,null);assert.equal(table.sourceRoster,undefined);
  row.cells.pop();assert.throws(()=>compactReport(archive));
});

test('versioned download checks live scope and source, detects corrupt files and revocation during KV read', async () => {
  const bytes = new TextEncoder().encode('{"rows":[]}'), version = hash(bytes);
  const snapshots=[{snapshotId:'one',sourceSnapshotSha256:'a'.repeat(64)}];
  const key=catalogKey(1,snapshots), semesters=[{label:'2026 Fall',version}];
  const items=new Map([[key,{semesters}],[fileKey(version),bytes.buffer]]);
  const reads=[];
  const store={get:async k=>{reads.push(k);return items.get(k);}};
  let allowed=true;
  const backend={generation:1,historyPage:async()=>{if(!allowed)throw Error('denied');return {snapshots};},
    panelAuthority:async()=>({access:{capabilities:{fullSnapshot:allowed}}})};
  assert.deepEqual(await (await semesterHistory(backend,store,null)).json(),{semesters});
  assert.deepEqual(await (await semesterHistory(backend,store,{version})).json(),{rows:[]});
  assert.deepEqual(reads,[key,key,fileKey(version)]);
  allowed=false;
  await assert.rejects(()=>semesterHistory(backend,store,{version}),/denied/);assert.equal(reads.length,3);
  allowed=true;
  assert.deepEqual(await (await semesterHistory(backend,store,null,true)).json(),{semesters,latest:{version,report:{rows:[]}}});
  await assert.rejects(()=>semesterHistory(backend,store,{version:'b'.repeat(64)}),e=>e.status===409);
  await assert.rejects(()=>semesterHistory(backend,{get:k=>{if(k===fileKey(version))allowed=false;return items.get(k);}},
    {version}),e=>e.status===409);
  allowed=true;items.set(fileKey(version),new ArrayBuffer(1));
  await assert.rejects(()=>semesterHistory(backend,store,{version}),e=>e.status===503);
  snapshots[0].sourceSnapshotSha256='c'.repeat(64);
  await assert.rejects(()=>semesterHistory(backend,store,null),e=>e.status===503);
});

test('semester chart averages retain zero credit and omit missing scores and identities', async () => {
  const { semesterAverages } = await import('../history-table.mjs');
  const rows = [{asYear:'AS 300', overall:0, llab:null, firstName:'Private'},
    {asYear:'AS300', overall:1, llab:1}, {asYear:'AS100', overall:null, llab:0}];
  assert.deepEqual(semesterAverages('2025 Fall', rows), {
    label:'2025 Fall', byYear:{AS300:.5, AS100:null}, overall:.5, llab:.5});
});
