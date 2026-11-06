# Current Leadership and Excusals adoption

This is a separate reviewed extension of a completed initial import. It operates only in a paused isolated staging database with notifications suppressed. It does not rewrite the completed occurrence ledger, infer a verified historical actor, recreate retired events or replay old submissions, decisions or email jobs.

Migration 10 establishes `excusal_records`, `excusal_record_decisions` and `excusal_notification_tasks` as the runtime tables. Existing genuine records, actors, command references, decisions and pending tasks are copied unchanged from the earlier tables. The earlier tables remain retained migration sources and are no longer written by the current runtime. Rolling back Worker code alone is unsafe after this upgrade. Use the existing backed-up schema upgrade procedure and a compatible forward fix or reviewed isolated restore.

The canonical record distinguishes native and legacy origins. Native requests still require real submission actor/command references. Imported originals have null authenticated actor and command references; their original responder/decider strings, dates and source state remain in immutable evidence. A legacy request begins at version 1 and causal order 0. Its `legacyStateOnly` flag exposes its recorded status and makes the decision editable, while preventing that old status from replaying an attendance effect over the independently imported effective matrix. A genuine new decision increments the request version, records the current authorized human, advances the normal audit order and queues one normal notification task. Original submission provenance stays intact. Direct notification planning refuses a legacy state that has not received a new action. Closeout does not reinterpret an old denied-request state over a preserved baseline; explicit baseline D still follows the approved D-to-U policy.

Leadership links use unique exact Directory email anchors. Linked cadet identity/contact fields remain Directory-owned; the retained Leadership office and reporting fields become the contact record. Manual contacts require explicit review and must not ambiguously match a Directory identity. The normal role derivation includes the established operational Blue/Gold Squadron commanders; an arbitrary role containing “Squadron Commander” does not create a contact or grant authority.

For alternate responder emails, the legacy handler first resolved the Directory record and wrote its canonical name, Flight and Squadron into the request. A reviewed subject crosswalk may use the complete unique retained tuple, handler evidence and exact native-response association where available. This reconstructs the request's intended subject, not the respondent's authenticated identity. A name-only match, incomplete tuple or ambiguous candidate remains quarantined. The review file is bound to the complete evidence hash and explicitly approves the chosen subject-resolution method. No account binding or access grant is created from those emails.

Every source Leadership/request occurrence receives exactly one disposition: adopted, retired or quarantined. Explicitly reviewed retired event labels retain their original status, reason and source identity in request history, including a source status of Submitted. They do not become actionable current requests. Unresolved current subjects remain review records; do not manufacture cadets, clear requests or hide them from accounting.

The signed read-only `/v1/admin/history/requests` endpoint accepts `{environment,generation,principalId}` and requires current wing `frontend.read` authority. It lists completed adoption dispositions with source request IDs, labels, status, reasons and explicit unresolved/retired explanations. It exposes neither historical actor email strings nor an invented verified actor. Current operational requests are also present in the normal frontend snapshot and Blue/Gold spreadsheet models.

Prepare private evidence with `reconcileOperationalAdoption`, review its hash and dispositions, then create the committed plan:

```sh
node scripts/import-parity.mjs prepare-operational \
  --snapshot .build/d1-real-parity/capture-run/snapshot.json \
  --plan .build/d1-real-parity/initial-plan/import-plan.json \
  --current-model .build/d1-real-parity/reviewed-staging-plan/model.json \
  --base-execution .build/d1-real-parity/reviewed-staging-plan/execution.json \
  --reconciliation .build/d1-real-parity/source-comparison/reconciliation.json \
  --review .build/d1-real-parity/operational-review.json \
  --generation 1 \
  --private-dir .build/d1-real-parity/reviewed-operational-plan
```

The review includes `formatVersion:1`, `snapshotSha256`, `evidenceSha256`, `reviewReference`, explicit true approvals for `adoptLinkedLeadership`, `adoptManualLeadership`, `adoptExactEmailSubjects`, `adoptCanonicalSubjectTuples` and `preserveUnresolved`, and an exact `retiredEvents` array of `{label,reason,sourceReference}`. Do not put these private artifacts in Git.

The CLI verifies committed owning source and emits evidence, model, execution and count/write summaries. A provider runner must verify the exact account/database/title/generation, schema 10 and approved execution hash with `assertOperationalAdoptionTarget`. Revalidate the original stored data using `verifyStagingImportReadback` with `expectedRunState:'complete'` before extending it. The load is one atomic bounded batch, followed by `verifyOperationalAdoption` comparing actual stored values and exact coverage, then a separate audited completion batch. Only completed adoption records are visible to normal reads. The completion records one present-day administrative adoption action; it creates no historical operational actions, grants, jobs or notifications.

Use the existing fresh account-wide quota check before load and completion. The plan reports conservative indexed write estimates; actual D1 usage remains authoritative. After an ambiguous response or quota pause, retain the same execution file and call `inspectOperationalAdoptionResume`: `load` permits the initial transaction, `verify-before-finish` requires exact readback, and `complete` is read-only. Never replay initialization or completion blindly.

Run the repository checks and `tests/v3/import-operational.test.mjs`. Validate the real source separately in restricted evidence: source/disposition totals, current Leadership, both squadron queues and pending counts, unchanged baseline cells/percentages, role-derived recipients, null historical actors, and zero generated operational/effect ledgers. Hosted decision and native spreadsheet tests remain separate release gates.
