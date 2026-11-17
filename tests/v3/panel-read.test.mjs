import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { buildRolePermissionPolicy } from '../../.build/v3/packages/domain/src/permissions.js';
import { PANEL_SECTIONS, resolvePanelAccess, assemblePanelSnapshotPages, panelSnapshotToReportingInput } from '../../.build/v3/packages/domain/src/panel-read.js';
import { buildFrontendReporting } from '../../.build/v3/packages/domain/src/frontend-reporting.js';
import { panelSnapshotPage } from '../../.build/v3/apps/worker/src/panel-read.js';
import { excusalDecisionPermission } from '../../.build/v3/apps/worker/src/excusal-scope.js';

const secret = 'fictional-panel-test-secret-not-for-deployment', keyId = 'fixture';
const directory = new URL('../../database/migrations/', import.meta.url);
const migration = (await Promise.all((await readdir(directory)).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort().map(n => readFile(new URL(n, directory), 'utf8')))).join('\n');
const base = principalId => ({ environment: 'local', generation: 1, principalId, section: 'manifest', offset: 0, revision: null });
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function fixture(t) {
    const mf = new Miniflare({ modules: true, scriptPath: resolve('.build/v3-artifacts/worker.mjs'), compatibilityDate: '2026-07-01', d1Databases: { DB: 'panel' }, bindings: { ENVIRONMENT: 'local', GENERATION: '1', BRIDGE_KEY_ID: keyId, BRIDGE_SECRET: secret }, log: new Log(LogLevel.NONE) });
    t.after(() => mf.dispose()); const db = await mf.getD1Database('DB');
    await db.batch(migration.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    await db.batch([
        db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),
        db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1),('bravo','Bravo',1)"),
        db.prepare("INSERT INTO squadrons VALUES('blue','Blue'),('gold','Gold')"),
        db.prepare("INSERT INTO flight_hierarchy VALUES('alpha','blue'),('bravo','gold')"),
        db.prepare("INSERT INTO terms VALUES('current','Fictional current',1,1)"),
        db.prepare("INSERT INTO principals VALUES('owner',NULL,1),('outsider',NULL,1)"),
        db.prepare("INSERT INTO admin_grants VALUES('owner','frontend.read','wing','*'),('owner','events.manage','wing','*')"),
        db.prepare("INSERT INTO permission_managers VALUES('owner',1)"),
        db.prepare("INSERT INTO command_registry VALUES('binding','admin')"),
        db.prepare("INSERT INTO adapter_sources VALUES('test','console',1)"),
        db.prepare("INSERT INTO events VALUES('event','Fictional training',1),('bravo-event','Unrelated training',1)"),
        db.prepare("INSERT INTO event_details SELECT event_id,1,'current','llab',1,1,label,'ALL','active',NULL,NULL,'Fictional location','Private event notes','2026-01-01','owner','2026-01-01' FROM events"),
        db.prepare("INSERT INTO event_units VALUES('event','alpha'),('event','bravo'),('bravo-event','bravo')"),
    ]);
    for (const [id, flight, role] of [['flight', 'alpha', 'Flight Commander'], ['deputy', 'alpha', 'Deputy Flight Commander'], ['blue', 'alpha', 'Blue Squadron Commander'], ['gold', 'bravo', 'Gold Squadron Commander'], ['cadet', 'alpha', 'Cadet'], ['other', 'bravo', 'Cadet'], ['advisor', 'bravo', 'Senior GMC Advisor']]) {
        await db.batch([
            db.prepare('INSERT INTO people VALUES(?,?)').bind(id, `Example ${id}`),
            db.prepare('INSERT INTO principals VALUES(?,?,1)').bind(id, id),
            db.prepare("INSERT INTO directory_profiles VALUES(?,1,?,'Example',?,'AS200','C/SSgt',?,'Example University',?,'private-phone','private-dorm','private-area','private-code','private-afsc','private-town','private-state','2030','2007-01-01','Active 3/4','https://example.invalid/private-photo','2026-01-01')").bind(id, flight, id, role, `${id}@example.invalid`),
            db.prepare('INSERT INTO memberships VALUES(?,?,1)').bind(id, flight),
            db.prepare("INSERT INTO principal_accounts VALUES(?,?,'authenticated-confirmation','binding')").bind(id, `${id}@example.invalid`),
        ]);
    }
    async function reconcile() {
        const rows = (await db.prepare("SELECT person_id AS personId,version,flight_id AS flightId,email,role,flight_path_status AS flightPathStatus,1 AS active FROM directory_profiles").all()).results;
        const flights = (await db.prepare('SELECT u.unit_id AS flightId,u.label,h.squadron_id AS squadronId FROM organizational_units u JOIN flight_hierarchy h ON h.unit_id=u.unit_id ORDER BY u.unit_id').all()).results;
        const squadrons = (await db.prepare('SELECT squadron_id AS squadronId,label FROM squadrons').all()).results;
        const accounts = rows.map(p => ({ principalId: p.personId, personId: p.personId, email: p.email, active: true }));
        const policy = buildRolePermissionPolicy({ people: rows, contacts: [], flights, squadrons, accounts, operationalSquadronIds: ['blue', 'gold'] });
        const version = (await db.prepare('SELECT version FROM permission_policy_control').first()).version + 1;
        await db.batch([
            db.prepare('DELETE FROM role_admin_grants'), db.prepare('DELETE FROM role_access_grants'), db.prepare('DELETE FROM role_permission_members'),
            db.prepare('UPDATE permission_policy_control SET enabled=1,version=?,policy_json=?,policy_hash=? WHERE singleton=1').bind(version, JSON.stringify(policy), hash(policy)),
            ...policy.members.map(m => db.prepare('INSERT INTO role_permission_members VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(m.principalId, m.sourceKind, m.sourceId, m.sourceVersion, m.linkedContactId, m.linkedContactVersion, version, m.sourceRole, m.sourceFlightId, m.sourceStatus, m.linkedContactActive)),
            ...policy.adminGrants.map(g => db.prepare('INSERT INTO role_admin_grants VALUES(?,?,?,?)').bind(g.principalId, g.capability, g.scopeKind, g.scopeKey)),
            ...policy.accessGrants.map(g => db.prepare('INSERT INTO role_access_grants VALUES(?,?,?,?)').bind(g.principalId, g.capability, g.flightId, g.subjectScope)),
        ]);
    }
    await reconcile();
    async function send(input, path = '/v1/admin/panel/page') {
        const body = JSON.stringify(input), timestamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac('sha256', secret).update(`POST\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
        const r = await mf.dispatchFetch(`https://fixture.invalid${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-shamrock-key-id': keyId, 'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signature } });
        return { status: r.status, body: await r.json() };
    }
    async function read(principal, section, revision) {
        if (!revision) { const manifest = await send(base(principal)); assert.equal(manifest.status, 200, JSON.stringify(manifest)); revision = manifest.body.revision; }
        const result = await send({ ...base(principal), section, revision });
        assert.equal(result.status, 200, JSON.stringify(result)); return result.body;
    }
    const command = (principal, id, operation, payload) => ({ commandId: id, contractVersion: 1, environment: 'local', generation: 1, actor: { principalId: principal, evidence: 'authenticated-confirmation' }, source: { kind: 'test', resourceKey: 'console', submissionId: id, revision: 1 }, operation, payload });
    const roster = await send(command('owner', 'event-roster', 'event.upsert', { eventId: 'event', expectedVersion: 1, termId: 'current', eventType: 'llab', trainingWeek: 1, displayOrder: 1, label: 'Fictional training', columnLabel: 'LLAB 1', expectedGroup: 'All Cadets', flightIds: ['alpha', 'bravo'], eligiblePersonIds: ['flight', 'deputy', 'blue', 'gold', 'cadet', 'other', 'advisor'], status: 'active', startAt: null, endAt: null, location: 'Fictional location', notes: 'Private event notes' }), '/v1/admin/commands');
    assert.equal(roster.status, 200, JSON.stringify(roster));
    async function request(person, id) { const r = await send(command(person, id, 'excusal.submit', { requestId: id, eventId: 'event', personId: person, requestedOutcome: 'E', reason: `Fictional ${person} reason` }), '/v1/commands'); assert.equal(r.status, 200, JSON.stringify(r)); }
    return { db, env: { DB: db, ENVIRONMENT: 'local', GENERATION: '1' }, send, read, reconcile, command, request };
}

test('Flight commander and deputy read only their assigned Flight while existing Sheets authority stays broad', async t => {
    const f = await fixture(t);
    for (const [flight, person] of [['alpha', 'cadet'], ['bravo', 'other']]) {
        const correction = await f.send(f.command('flight', `correct-${flight}`, 'attendance.correct', { personId: person, eventId: 'event', expectedBaseVersion: 0, expectedEventVersion: 2, code: 'T', reason: 'Fictional correction.' }), '/v1/admin/commands');
        assert.equal(correction.status, 200, JSON.stringify(correction));
        const report = await f.send(f.command('flight', `report-${flight}`, 'attendance.report', { reportId: `report-${flight}`, eventId: 'event', unitId: flight, rosterVersion: 1, coveredPersonIds: [person], presentPersonIds: [person], completeness: 'partial' }), '/v1/commands');
        assert.equal(report.status, 200, JSON.stringify(report));
    }
    await f.request('cadet', 'alpha-request'); await f.request('other', 'bravo-request');
    for (const principal of ['flight', 'deputy']) {
        const manifest = (await f.send(base(principal))).body;
        assert.deepEqual(manifest.access.flightIds, ['alpha']); assert.equal(manifest.access.capabilities.fullSnapshot, false);
        assert.deepEqual(manifest.access.capabilities.attendanceReportFlightIds, ['alpha']);
        assert.deepEqual(manifest.access.capabilities.attendanceCorrectionFlightIds, ['alpha']);
        const pages = [];
        for (const section of PANEL_SECTIONS) pages.push(await f.read(principal, section, manifest.revision));
        const people = pages.find(p => p.section === 'people').rows;
        assert.deepEqual(people.map(p => p.personId), ['blue', 'cadet', 'deputy', 'flight']);
        assert.deepEqual(Object.keys(people[0]).sort(), ['asYear', 'firstName', 'flightId', 'flightPathStatus', 'lastName', 'personId', 'rank', 'version']);
        const requests = pages.find(p => p.section === 'requests').rows;
        assert.deepEqual(requests.map(r => [r.requestId, r.canDecide]), [['alpha-request', false]]);
        for (const section of ['observations', 'corrections']) assert.deepEqual(pages.find(p => p.section === section).rows.map(r => r.personId), ['cadet']);
        const wire = JSON.stringify(pages);
        for (const forbidden of ['bravo-request', 'bravo-event', 'private-phone', 'private-dorm', 'private-photo', '2007-01-01', '@example.invalid', 'Private event notes']) assert.equal(wire.includes(forbidden), false, forbidden);
        const verified = await f.read(principal, 'verify', manifest.revision); assert.equal(verified.verified, true);
        const snapshot = assemblePanelSnapshotPages(manifest, pages, verified);
        assert.equal(snapshot.contractVersion, 'panel-snapshot-v1'); assert.equal(snapshot.requests[0].canDecide, false);
        assert.deepEqual(snapshot.events[0].eligiblePersonIds, ['blue', 'cadet', 'deputy', 'flight']);
        assert.equal(Object.hasOwn(snapshot.people[0], 'dateOfBirth'), false);
        const reporting = buildFrontendReporting(panelSnapshotToReportingInput(snapshot, '2026-01-02'));
        const row = reporting.matrices[0].rows.find(r => r.personId === 'cadet');
        assert.equal(row.cells[0].effectiveCode, 'P'); assert.equal(row.overall.percentage, 1);
        for (const change of [p => { p[0].revision.access = '0'.repeat(64); }, p => { p[0].offset = 1; }, p => { p[0].nextOffset = 9; }, p => { p[0].access.flightIds.push('bravo'); }, p => { p[0].scope.termId = 'old'; }, p => { p[0].environment = 'staging'; }, p => { p.pop(); }, p => { p.push(p[0]); }]) {
            const bad = structuredClone(pages); change(bad); assert.throws(() => assemblePanelSnapshotPages(manifest, bad, verified));
        }
        assert.throws(() => assemblePanelSnapshotPages(manifest, pages, { ...verified, verified: false }));
        assert.equal((await f.send({ ...base(principal), revision: null }, '/v1/admin/snapshot/page')).status, 200, 'existing Sheets full read remains unchanged');
    }
    assert.equal((await f.send(base('advisor'))).status, 403, 'broad derived attendance grants do not create panel access');
    assert.equal((await f.send(base('cadet'))).status, 403);
    await f.db.prepare("INSERT INTO access_grants VALUES('outsider','attendance.report','alpha','unit')").run();
    assert.equal((await f.send(base('outsider'))).status, 403, 'attendance submission alone never grants access to reasons');
});

test('Blue/Gold decision visibility uses captured Squadron after Flight reparent and equals mutation authorization', async t => {
    const f = await fixture(t); await f.request('cadet', 'before-reparent');
    await f.db.prepare("UPDATE flight_hierarchy SET squadron_id='gold' WHERE unit_id='alpha'").run(); await f.reconcile();
    await f.request('cadet', 'after-reparent');
    for (const [principal, expected] of [['blue', [['before-reparent', true]]], ['gold', [['after-reparent', true], ['before-reparent', false]]], ['flight', [['after-reparent', false], ['before-reparent', false]]]]) {
        const rows = (await f.read(principal, 'requests')).rows;
        assert.deepEqual(rows.map(r => [r.requestId, r.canDecide]), expected);
        for (const row of rows) {
            const check = excusalDecisionPermission(principal, row.requestId, row.flightId);
            const result = await f.db.prepare(`SELECT ${check.sql} AS allowed`).bind(...check.values).first();
            assert.equal(row.canDecide, result.allowed === 1);
        }
    }
    const blue = (await f.send(base('blue'))).body; assert.deepEqual(blue.access.flightIds, []);
    assert.deepEqual((await f.read('blue', 'people')).rows, [], 'retained requests do not expose the new Squadron roster');
    const pages = []; for (const section of PANEL_SECTIONS) pages.push(await f.read('blue', section, blue.revision));
    const snapshot = assemblePanelSnapshotPages(blue, pages, await f.read('blue', 'verify', blue.revision));
    assert.equal(snapshot.requests.length, 1); assert.equal(snapshot.requests[0].personDisplayName, 'Example cadet');
    const reporting = buildFrontendReporting(panelSnapshotToReportingInput(snapshot, '2026-01-02'));
    assert.deepEqual(reporting.matrices[0].rows, [], 'request-only people are not fabricated as current cadets');
});

test('explicit owner and manager full reads survive; explicit decision grants never arise from Flight command', async t => {
    const f = await fixture(t); await f.request('cadet', 'request');
    const owner = (await f.send(base('owner'))).body;
    assert.equal(owner.access.mode, 'wing'); assert.equal(owner.access.capabilities.fullSnapshot, true); assert.deepEqual(owner.access.flightIds, ['alpha', 'bravo']);
    assert.equal((await f.read('owner', 'requests')).rows[0].canDecide, false, 'read authority is not decision authority');
    await f.db.prepare("INSERT INTO permission_managers VALUES('flight',1)").run();
    assert.equal((await f.send(base('flight'))).body.access.capabilities.fullSnapshot, true);
    await f.db.prepare("INSERT INTO access_grants VALUES('outsider','excusal.decide','alpha','unit')").run();
    assert.equal((await f.read('outsider', 'requests')).rows[0].canDecide, true);
    assert.deepEqual((await f.read('outsider', 'people')).rows, []);
});

test('missing, inactive, source-drifted or stale-bound identities fail closed and role changes invalidate page revisions', async t => {
    const f = await fixture(t);
    assert.equal((await f.send(base('missing'))).status, 403);
    const original = (await f.send(base('flight'))).body.revision;
    await f.db.prepare("UPDATE directory_profiles SET flight_id='bravo',version=2 WHERE person_id='flight'").run();
    await f.db.prepare("UPDATE memberships SET unit_id='bravo' WHERE person_id='flight'").run();
    assert.equal((await f.send(base('flight'))).status, 403, 'unreconciled source drift revokes access');
    await f.reconcile();
    assert.deepEqual((await f.send(base('flight'))).body.access.flightIds, ['bravo']);
    assert.equal((await f.send({ ...base('flight'), section: 'people', revision: original })).body.error.code, 'SNAPSHOT_CHANGED');
    const latest = (await f.send(base('flight'))).body.revision;
    await f.db.prepare("UPDATE principals SET active=0 WHERE principal_id='flight'").run();
    assert.equal((await f.send({ ...base('flight'), section: 'people', revision: latest })).status, 403);
    await f.db.prepare("UPDATE principals SET active=1 WHERE principal_id='flight'").run();
    await f.db.prepare("UPDATE principal_accounts SET email='changed@example.invalid' WHERE principal_id='flight'").run();
    assert.equal((await f.send(base('flight'))).status, 403);
});

test('scope changes between authority resolution and data read discard rows; bounded local reads stay below 50 queries', async t => {
    const f = await fixture(t); let batches = 0, queries = 0;
    const DB = { prepare: sql => { queries++; return f.db.prepare(sql); }, batch: async stmts => { if (++batches === 2) await f.db.prepare("UPDATE principals SET active=0 WHERE principal_id='flight'").run(); return f.db.batch(stmts); } };
    await assert.rejects(panelSnapshotPage({ ...f.env, DB }, base('flight')), { code: 'SNAPSHOT_CHANGED' });
    assert.ok(queries < 50, `${queries} prepared queries`);
});

test('invalid fields, forged scope selection, wrong generation and unsupported historical reads are rejected', async t => {
    const f = await fixture(t), manifest = (await f.send(base('flight'))).body;
    for (const extra of [{ flightIds: ['bravo'] }, { termId: 'other' }, { section: 'contacts' }, { offset: -1 }, { offset: 1 }, { revision: {} }]) assert.equal((await f.send({ ...base('flight'), ...extra })).status, 400);
    assert.equal((await f.send({ ...base('flight'), generation: 2 })).status, 409);
    assert.equal((await f.send({ ...base('flight'), section: 'people', revision: { ...manifest.revision, access: '0'.repeat(64) } })).body.error.code, 'SNAPSHOT_CHANGED');
});

test('scope resolver rejects mismatched or ambiguous Flight roles and does not infer authority from broad derived grants', () => {
    const a = { active: true, permissionManager: false, explicitAdminGrants: [], effectiveAdminGrants: [{ capability: 'frontend.read', kind: 'wing', scope: '*' }], explicitAccessGrants: [], effectiveAccessGrants: [{ capability: 'attendance.report', flightId: 'a', subjectScope: 'unit' }], member: { sourceKind: 'directory', sourceRole: 'Bravo Flight Commander', sourceFlightId: 'a', linkedContactActive: null }, commanderSquadronIds: [], flights: [{ flightId: 'a', label: 'Alpha', squadronId: 'blue' }, { flightId: 'b', label: 'Bravo', squadronId: 'gold' }], squadrons: [{ squadronId: 'blue', label: 'Blue' }, { squadronId: 'gold', label: 'Gold' }] };
    assert.equal(resolvePanelAccess(a), null);
    a.member.sourceRole = 'Flight Commander'; assert.deepEqual(resolvePanelAccess(a).flightIds, ['a']);
    a.flights[1].label = 'Alpha'; assert.equal(resolvePanelAccess(a), null);
    a.flights[1].label = 'Bravo'; a.member.sourceKind = 'leadership'; a.member.sourceRole = 'Bravo Deputy Flight Commander'; a.member.sourceFlightId = null;
    assert.deepEqual(resolvePanelAccess(a).flightIds, ['b']);
});

test('duplicate Squadron commanders lose decisions; inactive linked Leadership does not retain panel scope', async t => {
    const f = await fixture(t); await f.request('cadet', 'request');
    await f.db.prepare("UPDATE directory_profiles SET role='Blue Squadron Commander',version=2 WHERE person_id='cadet'").run(); await f.reconcile();
    assert.equal((await f.send(base('blue'))).status, 403);
    const policy = resolvePanelAccess({ active: true, permissionManager: false, explicitAdminGrants: [], effectiveAdminGrants: [], explicitAccessGrants: [], effectiveAccessGrants: [], member: { sourceKind: 'directory', sourceRole: 'Flight Commander', sourceFlightId: 'alpha', linkedContactActive: 0 }, commanderSquadronIds: [], flights: [{ flightId: 'alpha', label: 'Alpha', squadronId: 'blue' }], squadrons: [{ squadronId: 'blue', label: 'Blue' }] });
    assert.equal(policy, null);
});

test('panel pages preserve deterministic offsets and access changes invalidate an unfinished read', async t => {
    const f = await fixture(t);
    for (let i = 0; i < 65; i++) {
        const id = `paged-${String(i).padStart(3, '0')}`;
        await f.db.batch([
            f.db.prepare('INSERT INTO people VALUES(?,?)').bind(id, 'Example paged cadet'),
            f.db.prepare("INSERT INTO directory_profiles SELECT ?,1,'alpha',last_name,first_name,as_year,rank,'Cadet',university,?,'',dorm,cip_broad_area,cip_code,afsc,home_town,home_state,class_year,date_of_birth,flight_path_status,photo_link,updated_at FROM directory_profiles WHERE person_id='cadet'").bind(id, `${id}@example.invalid`),
            f.db.prepare("INSERT INTO memberships VALUES(?,'alpha',1)").bind(id),
        ]);
    }
    const manifest = (await f.send(base('flight'))).body;
    assert.equal(manifest.sections.find(s => s.section === 'people').count, 69);
    const first = await f.read('flight', 'people', manifest.revision); assert.equal(first.rows.length, 64); assert.equal(first.nextOffset, 64);
    const second = await f.send({ ...base('flight'), section: 'people', offset: first.nextOffset, revision: manifest.revision });
    assert.equal(second.status, 200); assert.equal(second.body.rows.length, 5); assert.equal(second.body.nextOffset, null);
    assert.equal(new Set([...first.rows, ...second.body.rows].map(r => r.personId)).size, 69);
    await f.db.prepare("INSERT INTO admin_grants VALUES('flight','frontend.read','flight','bravo')").run();
    assert.equal((await f.send({ ...base('flight'), section: 'verify', revision: manifest.revision })).body.error.code, 'SNAPSHOT_CHANGED');
});
