import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {recoverAdminEffect} from '../../.build/v3/apps/worker/src/effect-recovery.js';
import {splitMigrationSql} from '../../scripts/lib/v3-migrations.mjs';
const directory=new URL('../../database/migrations/',import.meta.url);
const statements=(await Promise.all((await readdir(directory)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort().map(n=>readFile(new URL(n,directory),'utf8')))).flatMap(splitMigrationSql);
async function fixture(t){
 const mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'recovery-fixture'},log:new Log(LogLevel.NONE)});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await db.batch(statements.map(s=>db.prepare(s)));
 await db.batch([
  db.prepare("INSERT INTO system_control VALUES(1,'local',1,0)"),db.prepare("INSERT INTO principals VALUES('publisher',NULL,1),('other',NULL,1)"),
  db.prepare("INSERT INTO admin_grants VALUES('publisher','frontend.read','wing','*')"),db.prepare("INSERT INTO command_registry VALUES('cause','admin')"),
  db.prepare("INSERT INTO admin_effects(effect_id,command_id,kind,state,created_at,worker_id,claim_token,lease_expires_at,claim_operations_revision,claim_administration_revision) VALUES('effect','cause','frontend.refresh','leased','2026-01-01T00:00:00.000Z','publisher-worker','original-token','2026-01-01T00:10:00.000Z',7,9)")
 ]);
 const env={DB:db,ENVIRONMENT:'local',GENERATION:'1'}, request={environment:'local',generation:1,principalId:'publisher',recoveryId:'recovery-1',workerId:'publisher-worker',effectId:'effect',claimToken:'original-token',previousExpiry:'2026-01-01T00:10:00.000Z',checkpointSha256:'a'.repeat(64),providerState:'partial',producerFenced:true,exclusiveWriter:true};
 return {db,env,request};
}
test('reviewed expired lease renews same owner/token/floors once while paused and retains immutable evidence',async t=>{
 const f=await fixture(t), first=await recoverAdminEffect(f.env,f.request), row=await f.db.prepare('SELECT * FROM admin_effects').first();
 assert.equal(first.status,'renewed');assert.equal(row.claim_token,'original-token');assert.equal(row.state,'leased');assert.equal(row.worker_id,'publisher-worker');assert.equal(row.claim_operations_revision,7);assert.equal(row.claim_administration_revision,9);assert.equal(row.lease_expires_at,first.leaseExpiresAt);
 assert.deepEqual(await recoverAdminEffect(f.env,f.request),first);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM admin_effect_recoveries').first()).n,1);
 await assert.rejects(recoverAdminEffect(f.env,{...f.request,checkpointSha256:'b'.repeat(64)}),e=>e.code==='RECOVERY_CONFLICT');
 await assert.rejects(recoverAdminEffect(f.env,{...f.request,recoveryId:'different'}),e=>e.code==='RECOVERY_CONFLICT');
});
test('recovery refuses missing proof, wrong owner/token, stale generation and revoked receipt reads',async t=>{
 const f=await fixture(t);
 for(const change of [{producerFenced:false},{exclusiveWriter:false},{checkpointSha256:'bad'},{generation:2},{extra:true}])await assert.rejects(recoverAdminEffect(f.env,{...f.request,...change}),e=>e.code==='INVALID_RECOVERY');
 for(const change of [{workerId:'different-worker'},{claimToken:'different-token'}])await assert.rejects(recoverAdminEffect(f.env,{...f.request,...change}),e=>e.code==='RECOVERY_CONFLICT');
 await assert.rejects(recoverAdminEffect(f.env,{...f.request,principalId:'other'}),e=>e.code==='NOT_AUTHORIZED');
 await recoverAdminEffect(f.env,f.request);await f.db.prepare("DELETE FROM admin_grants WHERE principal_id='publisher'").run();
 await assert.rejects(recoverAdminEffect(f.env,f.request),e=>e.code==='NOT_AUTHORIZED');
});
test('concurrent recovery creates one receipt; a failed transactional proof leaves no renewal or evidence',async t=>{
 const f=await fixture(t), results=await Promise.all([recoverAdminEffect(f.env,f.request),recoverAdminEffect(f.env,f.request)]);assert.deepEqual(results[0],results[1]);
 const g=await fixture(t);await g.db.prepare("UPDATE admin_effects SET state='done'").run();
 await assert.rejects(recoverAdminEffect(g.env,g.request),e=>e.code==='RECOVERY_CONFLICT');
 assert.equal((await g.db.prepare('SELECT COUNT(*) AS n FROM admin_effect_recoveries').first()).n,0);assert.equal((await g.db.prepare('SELECT COUNT(*) AS n FROM command_assertions').first()).n,0);
});
