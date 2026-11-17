# D1 successor rehearsal and readiness

This is a staging handoff exercise, not a production cutover procedure. The current production system and its account transfer are covered by [Account handoff](ACCOUNT_HANDOFF_RUNBOOK.md). A successor must be able to understand, pause, diagnose, change and recover the replacement using organizational access and these runbooks. An AI client is optional; ordinary attendance and spreadsheet use must work without one.

## Evidence checked on November 6, 2026

Keep underlying files in restricted operational storage. These aggregate findings contain no account names, resource bindings or cadet records.

| Evidence | What was actually demonstrated | What it does not establish |
| --- | --- | --- |
| Native recovery checkpoint | Both staging workbooks completed their retained publication; exact Main and Excusals field policies verified; no pending plan; publication disabled afterward. Independent preflight recorded 142 completed frontend effects and none pending or leased. | New native human edits, Form submission branching, production readiness or sustained quota headroom |
| Non-owner permission proof | 26 real API write probes: four allowed and 22 denied; changed values restored; values, styles, validation and protections preserved; private frontend checkpoint unchanged | `e.user`, onEdit delivery, FilterView event coordinates or native ordinary-sort denial. The artifact explicitly marks native identity and FilterView evidence false. |
| Real-data hosted import readback | 326 checked steps and 23,633 exact rows across 22 tables; zero operational side effects; recorded import writes 61,621 rows | Approval to change production, subsequent operational adoption, interpreting unresolved historical evidence, or successful adoption of every preserved historical record |
| Real-data schema-8 restore | A separate local SQLite restore passed integrity and foreign-key checks; 113 profiles and 4,230 attendance baseline cells verified; paused | Hosted recovery of that real-data release, new writes after the export, secret recovery or a successor's ability to restore |
| Real-data hosted Time Travel restore | Schema 9 restored on the isolated hosted real-data database; 65 tables and 24,303 rows matched exact schema/content hashes and SQL export hash; disposable marker absent; paused, integrity passed, no foreign-key violations | A clean-checkout successor performed it, later writes are covered, or a production restore is authorized |
| Hosted report reads | Actual snapshot read returned 113 profiles, 47 events, 4,230 baselines and no diagnostics. Six historical reports checked 1,020 preserved formula results with no mismatch; unresolved historical rows remain explicit. | Whole responses satisfy Free CPU limits: observed snapshot/history CPU exceeded the 10 ms budget and needs bounded transport |
| Earlier hosted restore | Private earlier-schema artifacts show actual hosted restore/readback, separate from the local real-data restore | A newer schema/data release inherits that result automatically |
| Release manifests | Source commit, environment, generation, migration ledger and artifact hashes are recorded per release | A manifest on disk proves which artifact is currently deployed. Match fresh provider readback to its exact manifest. |
| Native input implementation | Local provider-port tests cover frozen identity/version evidence, confirmation, retries, receipts and paused setup controls | Live input triggers, non-owner sorted edits or a successor rehearsal. Deployment/activation must be recorded separately. |

The private inventory contains multiple historical manifests and backups. Do not select the newest-looking filename or assume an old successful artifact covers later code. The live source pin, migration ledger, state digests and gate settings must agree for the rehearsal.

The November 6 credential audit found the bridge items in a vault named **Private**. Their contents and storage were verified, but successor access to that vault was not demonstrated. The November 17 setup copied and verified the two staging bridge credentials and administrator OAuth credentials in the project vault, preserving the earlier items. That still does not establish a second custodian's access or recovery. The user reports account passwords are also in 1Password; a saved password does not prove another custodian can retrieve or recover it. No paid plan change is authorized. A free provider-level handoff can instead grant and verify successor organizational access, create replacement scoped provider credentials, update the corresponding private runtime settings, rehearse both identities, and revoke the departing credential only after validation. Keep secrets out of repositories and chat; record the actual custody/rotation exercise privately.

## Additional evidence — November 17, 2026 UTC

The [schema 15 hosted restore](D1_HOSTED_RESTORE.md#completed-schema-15-rehearsal--november-17-2026-utc) replaced an existing disposable staging database from the retained real-data export. All 94 tables including sequence state and 25,547 rows matched exactly; schema/ledger/control matched, integrity passed, foreign keys were clean and commands remained paused. Source exports before and after the exercise matched. Owner-private Drive custody then passed ACL and downloaded-content verification. This supersedes the older local-only recovery limitation for that exact export; it does not establish another custodian's access or restore Google configuration and publications.

The separate hosted administrator session database was installed from committed schema through the guarded setup helper. All six tables and six indexes matched independent schema readback, with a matching installation marker, clean integrity and foreign keys. The existing active fictional operator retained its grants; a distinct test adapter source and one verified Google-subject binding were added. Backend commands remained paused. These are installation/bootstrap results. Live browser OAuth sign-in, hosted administrator mutation/receipt tests and native spreadsheet propagation are separate acceptance checks.

Subsequent hosted testing verified Google sign-in and sign-out, a fictional event
rename and audited restoration, exact retry without a duplicate write, and stale
version rejection. Fictional administrator commands were then left enabled for
the user's panel review; its Google consumers and Forms remained paused/closed.
The real-data database remained fenced. These are distinct gates: the dashboard
being usable does not establish that a Google publication occurred. Authenticated
administrator CPU remained above the Free target in the measured release and is
an open acceptance item.

## Successor exercise

Use a clean checkout on a separate machine or clean worktree, plus approved organizational credential access. Do not copy the prior maintainer's home directory, hidden CLI credentials or `.env` files. The participant should perform these steps from the written instructions while the departing maintainer observes and records any missing information.

1. **Establish access.** Independently reach the GitHub organization and public/private operations repositories, the project Google account and its recovery factors, Cloudflare account, and shared password vault. Confirm a second authorized custodian can recover access. Account membership and a saved password alone do not establish recovery custody.
2. **Rebuild without credentials.** Read `AGENTS.md`, install the pinned dependencies with `npm ci`, run `npm run check`, `npm run demo:v3` and `npm run capacity:v3`, then perform the separate administrator build below. Explain which artifacts belong to current production versus isolated staging. No provider login is needed for these fictional tests. Never use `npm run push` for the D1 prototype.
3. **Identify the deployment.** Locate provider-owned private configuration, state/journals, expected owners, triggers, migration ledger, deployed artifact manifest and last backup. Match them using read-only checks. Record logical resource names in the public handoff; retain actual IDs, account addresses and hashes privately. Verify that Apps Script authorization is under the project automation account and that the actual Cloud project/API scopes match the release.
4. **Explain and verify all gates.** Identify D1 accepting-commands, native frontend publication, managed Form publication, Form intake, native input, maintenance planning and mail delivery controls. Confirm production bindings are excluded. Pause staging using supported controls and verify native Form open states, pending leases, both workbook protection policies and private checkpoints. A boolean return is not enough; pause does not automatically mean every Form was closed or every running execution drained.
5. **Perform one fictional workflow.** In a separate approved staging fixture, submit attendance, submit an excusal, decide it from the correct Squadron sheet, change a permitted Directory/Leadership field and observe the matching recorded outcome. Use a non-owner account. Verify no extra backend result on duplicate delivery. Exercise a missing-editor confirmation without supplying a typed email as identity. Restore approved intake gates afterward.
6. **Diagnose a retained failure.** Use an injected test or deliberately isolated rehearsal to interrupt after a saved draft or publication checkpoint. Identify the exact retained command/claim, distinguish a committed command from a failed projection, and recover the same payload or plan. Never delete a claim, invent a newer version, reset a journal or reinstall all production triggers to clear an error.
7. **Restore independently.** Use the [staging backup runner](D1_STAGING_BACKUP.md) to capture and locally prove an approved paused staging export, verify owner-private Drive custody, and produce a sanitized support report. For the separate hosted recovery gate, restore into a distinct empty test database, compare table counts and canonical contents, integrity, foreign keys, environment/generation and command fences. Restore private adapter baselines/catalogs and configuration from the corresponding checkpoint too. Record hosted evidence for the release being rehearsed; a local SQLite check alone is insufficient. Never bind the restored copy to production resources.
8. **Make a small change.** On a branch, implement an innocuous fictional feature or fix with focused tests and operator notes. Run the required checks; produce a reviewable commit and manifest. Have another authorized reviewer identify the deployment target and rollback plan before an isolated staging release. No paid GitHub feature or AI subscription is required.
9. **Measure and close.** Run the [free-tier forecast](D1_FREE_TIER_FORECAST.md) against observed usage. Review recipient counts and mail suppression without sending test messages to operational recipients. Return staging to its documented pause/closed state, retain the evidence and list any unresolved discrepancy.

## Passing record and remaining gates

### Administrator build from a clean checkout

The root checks do not install or build the administrator package. After the root
steps above, run its separate pinned installation and checks:

```sh
npm ci --prefix apps/admin
node apps/admin/build-domain.mjs
npm run build --prefix apps/admin
npm test --prefix apps/admin
node apps/admin/build-hosted.mjs --release
```

The domain build uses the root dependencies and tracked migrations. The frontend
build produces the static assets; the hosted build creates the Worker and a
source/schema/assets manifest, rejecting dirty relevant source. Generate these
artifacts on the clean checkout instead of copying a previous maintainer's
`.build` or `dist` directory. These commands do not deploy.

For rendered fictional validation, install the matching test browser or use the
documented existing Chromium executable override:

```sh
npm exec --prefix apps/admin -- playwright install chromium
npm run test:browser --prefix apps/admin
```

The browser test starts its own disposable local backend. Interactive review uses
`npm start --prefix apps/admin`, bound to loopback only. Hosted Google sign-in,
actual roles and Google Sheets convergence remain separate provider checks; do
not publish the automatically authenticated local server. See the
[hosted administrator runbook](../../apps/admin/hosted/README.md).

### Recorded acceptance

The private exercise record should name the participant/reviewer, dates, source and artifact pins, actual access checks, commands run, results, failures, recovery evidence and final gates. Record a task as **performed**, **simulated locally**, **read-only reviewed**, or **not yet demonstrated**. Do not turn a prepared checklist into a completed rehearsal.

The independent successor exercise remains pending. The schema 15 database recovery and owner-private backup custody above have been demonstrated for that retained export. Native FilterView coordinates, ordinary physical-sort denial, full managed Form branching/submissions, cross-domain editor evidence, sustained provider quotas, authoritative permission changes/revocation, notification delivery and complete transition recovery need their release-specific evidence. The preserved import and local code can be correct while one of those integration gates remains open.

Production cutover requires the full [feature parity matrix](../plans/D1_FEATURE_PARITY_MATRIX.md), actual frontend quality and workflow comparison, reviewed import dispositions, release-specific hosted recovery, verified recipient/access policies, quota headroom and successful successor rehearsal. Leave the existing production system operating until those results are concrete and approved.
