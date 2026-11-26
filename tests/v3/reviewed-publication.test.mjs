import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { Miniflare,Log,LogLevel } from 'miniflare';
import { initializeLocalDatabase } from '../../scripts/lib/v3-local-database.mjs';

async function fixture(t) {
  const secret='fictional-secret-for-reviewed-staging-publication', keyId='fixture';
  const mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',
    d1Databases:{DB:'reviewed-publication'},bindings:{ENVIRONMENT:'staging',GENERATION:'1',BRIDGE_KEY_ID:keyId,BRIDGE_SECRET:secret},log:new Log(LogLevel.NONE)});
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  await initializeLocalDatabase(db);
  const sql=q=>db.prepare(q);
  const revision={operations:0,administration:2};
  await db.batch([
    sql("INSERT INTO system_control VALUES(1,'staging',1,0)"),
    sql("INSERT INTO terms VALUES('term','Fictional current term',1,1)"),
    sql("INSERT INTO principals VALUES('owner',NULL,1),('other-owner',NULL,1),('service:legacy-import',NULL,0)"),
    sql("INSERT INTO admin_grants VALUES('owner','frontend.read','wing','*'),('other-owner','frontend.read','wing','*')"),
    sql("UPDATE permission_policy_control SET enabled=1,version=1,policy_hash='fixture-policy'"),
    sql(`INSERT INTO legacy_import_runs VALUES('import','snapshot','plan','reconciliation','fixture','staging',1,'complete',1,1,1,1,1,?,'2026-01-01','2026-01-01')`)
      .bind(JSON.stringify({kind:'reviewed-incremental-staging-refresh',administrationRevision:1,administrationDelta:1,permissionPolicyVersion:1,permissionPolicyHash:'fixture-policy'})),
  ]);
  for (const [command,operation,target] of [['old','directory.upsert','cadet'],['review','legacy.incremental-refresh','import']]) {
    await db.batch([sql("INSERT INTO command_registry VALUES(?,'admin')").bind(command),
      sql("INSERT INTO admin_commands VALUES(?,'hash','service:legacy-import',?,?,'frontend.read','[]','legacy-snapshot',?,?,1,'2026-01-01','{}')").bind(command,operation,target,target,target),
      sql("INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) VALUES(?,'service:legacy-import','fixture',?,?,'2026-01-01','{}','{}')").bind(command,operation,target)]);
  }
  for (const [id,command,kind] of [['old-sheet','old','frontend.refresh'],['review-sheet','review','frontend.refresh'],['review-forms','review','forms.refresh']]) {
    await sql("INSERT INTO admin_effects(effect_id,command_id,kind,state,created_at) VALUES(?,?,?,'pending','2026-01-01')").bind(id,command,kind).run();
  }
  async function send(action,fields) {
    const url='/v1/admin/effects/'+action, payload=JSON.stringify({environment:'staging',generation:1,workerId:'private-publisher',principalId:'owner',...fields});
    const time=String(Math.floor(Date.now()/1000)), hash=createHash('sha256').update(payload).digest('hex');
    const signature=createHmac('sha256',secret).update('POST\n'+url+'\n'+time+'\n'+hash).digest('hex');
    const response=await mf.dispatchFetch('https://example.invalid'+url,{method:'POST',headers:{'content-type':'application/json','x-shamrock-key-id':keyId,'x-shamrock-timestamp':time,'x-shamrock-signature':signature},body:payload});
    return {status:response.status,body:await response.json()};
  }
  return {db,send,revision,claim:{kind:'frontend.refresh',expectedEffectId:'review-sheet',expectedRevision:revision}};
}

test('a paused import publishes only the requested Sheet or Forms effect and leaves older jobs, ACLs and business commands alone',async t=>{
  const {db,send,revision,claim}=await fixture(t);
  assert.deepEqual((await send('claim',{kind:'frontend.refresh'})).body,{effect:null});
  for(const input of [{...claim,expectedEffectId:'old-sheet'},{...claim,kind:'forms.refresh'},{...claim,expectedRevision:{...revision,operations:1}},{...claim,expectedRevision:{...revision,administration:1}},{...claim,principalId:'outsider'}]) assert.equal((await send('claim',input)).status,409);
  assert.equal((await send('claim',{...claim,expectedRevision:null})).status,400);
  for(const [kind,id] of [['frontend.refresh','review-sheet'],['forms.refresh','review-forms']]) {
    const named={...claim,kind,expectedEffectId:id};
    const result=await send('claim',named);
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.effect.effectId,id);
    assert.deepEqual(await send('claim',named),result,'lost claim response');
    assert.equal((await send('claim',{...named,workerId:'other-worker'})).status,409);
    const lease={effectId:id,claimToken:result.body.effect.claimToken};
    assert.equal((await send('project',{...lease,principalId:'other-owner'})).status,403);
    assert.equal((await send('project/page',{...lease,section:'manifest',revision:null,offset:0,principalId:'other-owner'})).status,403);
    assert.equal((await send('project',lease)).body.snapshot.revision.administration,2);
    assert.equal((await send('project/page',{...lease,section:'manifest',revision:null,offset:0})).body.effect.effectId,id);
    assert.equal((await send('project/page',{...lease,section:'verify',revision,offset:0})).body.verified,true);
    assert.equal((await send('ack',{...lease,effectId:'old-sheet'})).status,409);
    assert.equal((await send('ack',lease)).status,200);
    const completion=await db.prepare('SELECT completed_at FROM admin_effects WHERE effect_id=?').bind(id).first();
    assert.equal((await send('project/page',{...lease,section:'verify',revision,offset:0})).status,200,'resume after lost ACK');
    assert.equal((await send('project',lease)).status,200);
    assert.equal((await send('ack',lease)).status,200);
    assert.deepEqual(await db.prepare('SELECT completed_at FROM admin_effects WHERE effect_id=?').bind(id).first(),completion);
    await db.prepare("UPDATE admin_effects SET lease_expires_at='2026-01-01' WHERE effect_id=?").bind(id).run();
    assert.deepEqual(await send('claim',named),{status:200,body:{effect:null}},'the next scheduler invocation may advance past this exact terminal receipt');
    assert.equal((await send('claim',{...named,workerId:'other-worker'})).status,409);
    assert.equal((await send('claim',{...named,principalId:'other-owner'})).status,409);
    assert.equal((await send('claim',{...named,expectedRevision:{...revision,operations:1}})).status,409);
    assert.equal((await send('claim',{...named,expectedEffectId:'missing'})).status,409);
    await db.prepare("UPDATE admin_effects SET completed_by_effect_id='old-sheet' WHERE effect_id=?").bind(id).run();
    assert.equal((await send('claim',named)).status,409,'a coalesced receipt cannot stand in for the named publication');
    await db.prepare('UPDATE admin_effects SET completed_by_effect_id=effect_id WHERE effect_id=?').bind(id).run();
  }
  assert.deepEqual((await db.prepare('SELECT effect_id,state FROM admin_effects ORDER BY effect_id').all()).results,[
    {effect_id:'old-sheet',state:'pending'},{effect_id:'review-forms',state:'done'},{effect_id:'review-sheet',state:'done'}]);
  assert.deepEqual(await db.prepare('SELECT accepting_commands,(SELECT COUNT(*) FROM operation_commands) AS writes,(SELECT COUNT(*) FROM notification_intents) AS notices,(SELECT version FROM permission_policy_control) AS policy FROM system_control').first(),{accepting_commands:0,writes:0,notices:0,policy:1});
});

test('each targeted page, recovery and ACK rechecks the staged revision, active grant, mail suppression and global pause',async t=>{
  const {db,send,revision,claim}=await fixture(t),leased=(await send('claim',claim)).body.effect;
  const lease={effectId:leased.effectId,claimToken:leased.claimToken};
  const changes=[
    ["UPDATE permission_policy_control SET policy_hash='changed'","UPDATE permission_policy_control SET policy_hash='fixture-policy'"],
    ["UPDATE notification_delivery_control SET mode='local-test'","UPDATE notification_delivery_control SET mode='suppressed'"],
    ["UPDATE system_control SET accepting_commands=1","UPDATE system_control SET accepting_commands=0"],
    ["DELETE FROM admin_grants WHERE principal_id='owner'","INSERT INTO admin_grants VALUES('owner','frontend.read','wing','*')"],
    ["UPDATE legacy_import_runs SET state='loading'","UPDATE legacy_import_runs SET state='complete'"],
    ["UPDATE admin_audit_events SET audit_id=3 WHERE command_id='review'","UPDATE admin_audit_events SET audit_id=2 WHERE command_id='review'"],
  ];
  for(const [change,restore] of changes) {
    await db.prepare(change).run();
    assert.notEqual((await send('project',lease)).status,200,change);
    assert.notEqual((await send('project/page',{...lease,section:'verify',revision,offset:0})).status,200,change);
    assert.notEqual((await send('ack',lease)).status,200,change);
    await db.prepare(restore).run();
  }
  const previousExpiry='2026-01-01T00:10:00.000Z';
  await db.prepare('UPDATE admin_effects SET lease_expires_at=? WHERE effect_id=?').bind(previousExpiry,lease.effectId).run();
  assert.equal((await send('claim',claim)).status,409,'an expired unfinished receipt cannot be mistaken for completed publication');
  const recovery={...lease,recoveryId:'restore-test',previousExpiry,checkpointSha256:'a'.repeat(64),providerState:'partial',producerFenced:true,exclusiveWriter:true};
  assert.equal((await send('recover',{...recovery,principalId:'other-owner'})).status,403);
  const renewed=await send('recover',recovery);assert.equal(renewed.status,200,JSON.stringify(renewed.body));
  assert.deepEqual(await send('recover',recovery),renewed);
  await db.prepare("UPDATE permission_policy_control SET version=2").run();
  assert.notEqual((await send('recover',recovery)).status,200,'old receipt must not bypass revocation');
  assert.equal((await db.prepare("SELECT state FROM admin_effects WHERE effect_id='review-sheet'").first()).state,'leased');
});
