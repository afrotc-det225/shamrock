# Isolated Google adapter prototype

This module is part of the local/staging D1 experiment. It does not replace the current Apps Script runtime, send email or deploy itself. The core `src/apps-script.ts` exports injected Google ports; `src/staging-host.ts` adds an explicitly configured, paused-by-default standalone host. `src/native-runtime.ts` supplies the real Google IO and protection checks. Importing these modules opens no files and installs no triggers. Their ES-module sources remain independently testable in Node.

Implemented boundaries:

- Native Form response and item identities, enrolled verified responder lookup, immutable `[sr:reference]` person/event/scope choices, and explicit partial/complete attendance reports. Old choice references retain their exact roster snapshot; label text is not identity. Repeated native delivery produces the same command ID.
- Single-cell decision drafts with stable slot/request identity and base version. `e.user` evidence is read when Google supplies it; no effective-user substitution occurs. Missing/unmapped identity leaves a confirmation-required draft. Multi-cell paste requires an explicit frozen review workflow.
- Native excusal checkbox selections produce one atomic `excusal.submitMany` command for 1–25 reviewed events. Child request IDs derive from the native response and event ID, so reordering choices preserves identity. A scalar event response keeps the deployed single-event contract. Empty, duplicate, unmapped and oversized selections fail before delivery; changed response content cannot reuse the original command identity.
- Signed commands matching the Worker's raw-body SHA-256/HMAC protocol. The Google host uses `Utilities`, with negative-byte encoding normalized correctly. Signed HTTP requests do not follow redirects.
- A bounded private Sheets journal, addressed by headers and serialized under a script lock. Enqueue before delivery; retry the exact payload/ID with a fresh signature. Timeouts and ambiguous responses stay pending; conflicts/rejections/authorization failures remain visible for intervention. Capacity exhaustion never deletes unsent input. The prototype retains terminal rows until an operator archives them under an approved retention procedure.
- Recorded-decision publication writes only output cells, checks stable target identity and current recorded version, and leaves draft values/base versions untouched. Job request signing supports claim/project/ack; lease management remains the Worker's responsibility.
- Optional projection-driven decision slots append one protected, immutable row per recorded request/version before the job is acknowledged. Delivery states are reconciled from the private journal, including committed, conflict, rejected and unresolved outcomes. The multi-event staging rehearsal verified publication and receipt-driven status with the owner account; intended non-owner access remains a separate release gate.

## Standalone staging host

`createStagingHost(runtime)` exposes `setup`, `pause`, `resume`, `flush`, `onAttendanceSubmit`, `onExcusalSubmit`, `onDecisionEdit`, `replayAttendanceResponse` and `replayExcusalResponse`. Supply native Apps Script services through the typed runtime ports. The bundle must include real top-level function declarations for installable triggers; exporting methods from an IIFE alone does not make them trigger entry points:

| Top-level function | Host method |
| --- | --- |
| `shamrockV3StagingAttendanceSubmit(e)` | `onAttendanceSubmit(e)` |
| `shamrockV3StagingExcusalSubmit(e)` | `onExcusalSubmit(e)` |
| `shamrockV3StagingDecisionEdit(e)` | `onDecisionEdit(e)` |
| `shamrockV3StagingFlush()` | `flush()` |

Setup and every enabled invocation require `Session.getEffectiveUser().getEmail()` to match the configured automation account. This proves the executing account, **not** the person editing a sheet. Edit actor evidence comes exclusively from `e.user` and the enrolled-principal registry. Use an isolated standalone script owned/maintained by the project account, never a spreadsheet-bound script whose editors can read its signing secret.

Keep these values in Script Properties, outside source control:

| Property | Contents |
| --- | --- |
| `SHAMROCK_V3_HOST_CONFIG` | The versioned JSON configuration below |
| `SHAMROCK_V3_PRINCIPALS` | `{ "entries": [{ "email": "cadet@example.invalid", "principalId": "principal.one", "personId": "person.one" }] }`; `personId` is required for self-service excusal submission |
| `SHAMROCK_V3_ATTENDANCE_CATALOG` | `{ "references": { ... } }`, using the core event/person/scope choice types |
| `SHAMROCK_V3_EXCUSAL_CATALOG` | `{ "references": { ... } }`, including immutable event choice references; required when an excusal Form is configured |
| `SHAMROCK_V3_BRIDGE_SECRET` | Scoped HMAC key, at least 32 characters; never put it in any Sheet |
| `SHAMROCK_V3_ENABLED` | Only the exact value `true` enables intake; missing/other values are paused |
| `SHAMROCK_V3_SETUP_RECEIPT` | Host-owned configuration fingerprint, execution identity, trigger manifest and verified-response time boundary |

Configuration shape (all resource values here are placeholders):

```json
{
  "version": 1,
  "environment": "staging",
  "resourceReview": "EXISTING_RESOURCES_REVIEWED_FOR_STAGING",
  "workerOrigin": "https://worker.example.invalid",
  "keyId": "staging-key",
  "generation": 1,
  "expectedAutomationEmail": "automation@example.invalid",
  "journal": { "spreadsheetId": "EXISTING_PRIVATE_WORKBOOK", "sheetId": 11 },
  "attendance": {
    "formId": "EXISTING_ATTENDANCE_FORM",
    "resourceKey": "attendance-form",
    "itemRoles": { "event": "10", "scope": "20", "present": ["30"], "completeness": "40" }
  },
  "excusal": {
    "formId": "EXISTING_EXCUSAL_FORM",
    "resourceKey": "excusal-form",
    "itemRoles": { "event": "50", "outcome": "60", "reason": "70" }
  },
  "decisionInput": {
    "spreadsheetId": "EXISTING_REVIEW_WORKBOOK",
    "sheetId": 22,
    "resourceKey": "decision-input",
    "mode": "projection",
    "maxSlots": 200
  }
}
```

For initial setup, the optional `shamrockV3StagingImportConfig` function imports the reviewed configuration properties from an explicitly selected private JSON file. Set `SHAMROCK_V3_CONFIG_FILE_ID` to that file's ID and set the HMAC secret separately. The file contains a map from property names to JSON **strings**, including the `entries`/`references` envelopes above. Only host, principal, attendance catalog, excusal catalog, projection and optional presentation configuration are accepted. Secret, enablement, receipt and arbitrary property keys are rejected. The importer verifies file ownership and every sharing page, validates all content before applying configuration, invalidates old setup receipts and leaves the host paused. It preserves the signing key, unrelated properties and any unresolved projection claim. Never include signing material in that file. Provider write failure leaves staging paused and requires inspection; this is not a cross-service transaction. Pause and wait for active executions before changing bindings.

`excusal` and `decisionInput` are optional. Staging requires explicit review of the exact existing resources; a marker alone is not proof of correct bindings. No host method creates a workbook, tab or Form, replaces a missing resource, changes choices, or changes an existing resource ID. The private journal must use a different workbook from the decision inputs. Missing configured files/tabs stop setup. The small staging configuration bounds are 8,000 UTF-8 bytes per JSON property, 50 enrolled identities, 30 attendance checkbox items and 1–500 dynamic decision slots. The earlier deployed configuration with `slots: [{row, slotId, requestId, baseVersion}]` remains supported, with at most 25 reviewed fixed rows; omit `mode` or use `mode: "fixed"`. Do not combine fixed bindings with projection mode.

For a custom injected host, implement the required `assertJournalPrivate(reference)` and `assertDecisionProtection(reference, protectedHeaders)` ports against current Google sharing/protection state. The supplied native factory implements these checks. Its first-stage trust policy requires automation ownership, an owner-only journal and no other Form editors. It permits read-only Form respondents. It rejects broad journal access and warning-only/missing protections; all fixed identity and metadata columns are protected from ordinary reviewers. These checks run at setup/resume and again during relevant access. A saved flag is not an adequate implementation.

Run `setup()` under the configured account. It pauses first, verifies resources/settings/protections, initializes only an already configured empty journal tab, and reconciles its four versioned handlers. It preserves unrelated handlers, removes only its mismatched/duplicate handlers, and installs a five-minute flush trigger. A failed deletion stops before replacement creation. Re-running setup preserves matching trigger IDs and returns `ready-paused`; it refreshes the verified-response time boundary. Only `resume()` enables processing, after the same checks and exact trigger-manifest validation. Changed configuration/catalog/principal JSON requires setup again. `pause()` stops new intake/dispatch while preserving saved commands and native Form responses.

Installable triggers are owned by the account that creates them, and Google only lists the executing account's triggers. Moving automation ownership therefore requires explicit old-owner trigger retirement as part of handoff; this host cannot discover another account's triggers. The source Form and spreadsheet handlers also require their recorded native trigger UID and exact source binding.

For responder identity, the host calls the [Forms API metadata endpoint](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/get) with `ScriptApp.getOAuthToken()` and requires `settings.emailCollectionType === "VERIFIED"` at setup and at each intake. [Google distinguishes `VERIFIED` from `RESPONDER_INPUT`](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms#EmailCollectionType); `getCollectEmail()` alone cannot prove verification. Authorize the Forms metadata scope (`forms.body.readonly` or an accepted broader scope), native Forms response access, spreadsheets, external requests, trigger management and current-user email in the standalone manifest. An API denial or unknown setting fails closed; the host does not silently change Form settings.

The [native response timestamp](https://developers.google.com/apps-script/reference/forms/form-response#getTimestamp()) must be at or after the most recent setup receipt. Current verified settings cannot establish how an older response collected its email. Explicit replay retrieves the response by its original native ID and uses the same command identity; pre-setup responses remain in the Form for a separate reviewed migration. Keep Form configuration editors restricted to trusted maintainers, pause before changing collection settings, and rerun setup afterward. Response edits with changed content under an existing ID become a visible command collision; a response-revision workflow remains to be implemented.

The excusal host accepts one scalar event or 1–25 checkbox events per native response, with person identity derived from the enrolled verified responder and an explicit outcome/reason answer. Multi-event requests share one atomic parent command and have immutable event-specific child identities. It never trusts an Email or person-ID answer supplied by a respondent.

The fixed decision-input tab uses row 1 machine headers `slot_id`, `request_id`, `base_version`, `draft_decision`, `draft_id`, `draft_state`, `draft_json` and row 2 display headers. Projection mode appends protected context columns `event_id`, `unit_id`, `person_id`, `event_label`, `display_name`, `requested_outcome`, `recorded_status`, `slot_origin_row` and `slot_context_hash`. The native initializer creates this schema in the explicitly configured **empty** existing tab. While paused, it can also upgrade the deployed 14-column dynamic schema by validating every original slot and appending only the two protected metadata columns; existing IDs, inputs and saved payloads remain unchanged. Existing grid capacity must accommodate 16 columns. A populated fixed table is never converted or cleared. A live mode change requires a paused, reviewed preservation/migration of existing drafts and deliberate replay/requeue of current projections for backfill; no such live migration has occurred.

Only `draft_decision` is user-editable. Projection mode requires a strict whole-tab protection with exceptions covering that column from row 3 through `maxSlots + 2`, and no other cells. Slots retain their original allocation identity and a protected hash of immutable request and displayed context. Complete-row table sorts move these fields together and preserve slot identity; partial sorts that detach identity or visible context fail closed. Deleting or manually rebinding rows is unsupported. A later request version gets a fresh row with current context. Old draft text, JSON, base versions and states travel with their complete row; recorded context on each slot describes its captured version, while the separate results tab shows the latest state. Capacity exhaustion retains all drafts and the projection claim and stops ACK with `decision_slots_full`. Pause and review retention/capacity; raising the bound also requires reviewed protection changes and setup. Never delete pending rows to free space.

The host freezes `e.value`, rejects stale delayed edits and rectangular pastes touching the decision column, and never writes the input cell. Once captured, a row keeps its original payload even if someone changes its dropdown afterward. The status then explicitly says `Input changed; saved ...`; it does not claim that the new selection was sent. Use the fresh recorded-version row for a subsequent decision. The host records a fixed staging audit reason instead of attributing a mutable reason cell to the editor. Missing/unmapped `e.user` saves a confirmation-required draft without dispatch; an authenticated confirmation UI is still required before ordinary cross-domain reviewers can use that path. Another person's edit cannot silently upgrade or replace that saved draft.

Decision edit capture waits up to **25 seconds** for the shared ScriptLock, allowing an ordinary scheduled flush to finish. Original event value, editor identity, physical position and validated slot identity are frozen before waiting; current target, input, pause state and reviewed configuration are checked again after acquisition. A same-value row swap during the wait is rejected. Google does not supply an immutable slot ID from the instant the edit occurred: a sort between the edit and the handler’s first read remains an unresolved event-evidence gap and a production release blocker. Other journal/network lock waits remain 100 milliseconds. The extra wait consumes trigger execution time and does not guarantee success under longer or sustained contention. On timeout, the input and protected draft/journal cells remain unchanged. The native event range receives a neutral retry **note** only while both its slot identity and selected value still match that event: check delivery state, then clear and reselect the intended decision if it remains unrecorded. The note describes the unsuccessful attempt, not a later edit; existing reviewer notes are preserved. If a note cannot be written, the handler returns `attention-required` with `notice: unavailable`, so execution-level review is still needed. A successful retry removes only the adapter note. Notes are presentation only and do not establish editor identity or change decision state.

Once capture has entered the private journal, its state is reconciled under that same lock. If another dispatcher wins the next lock, the handler returns `captured` with deferred delivery; the scheduled flush retries the durable original payload. It does not tell the reviewer that a successfully captured edit was lost.

After every dispatch, the host matches saved draft command ID, complete payload and hash against bounded private journal outcomes. `Committed` means D1 accepted that exact decision; it does not prove the separate output publication succeeded. Conflicts, rejected requests, authorization failures and retry-pending deliveries have distinct states. The status is reconciled before projection so a projection failure cannot leave a successful decision labelled `Queued`. A captured draft missing its journal entry remains `Not queued`; repeating the same verified decision safely retries the saved identity. Partial metadata writes or lost protection require paused review and retain original data/claims rather than inventing a replacement target.

## Core ports and projection hookup

The release bundle now includes `createNativeStagingHost` and actual top-level functions in `staging-globals.js`. `shamrockV3StagingSetup` pauses, initializes the existing protected projection tabs, repairs optional presentation, then validates the host and installs its triggers. `shamrockV3StagingResume` is a separate action. These functions do not replace production menu entries.

The native runtime also requires `SHAMROCK_V3_PROJECTION_CONFIG`:

```json
{
  "version": 1,
  "environment": "staging",
  "generation": 1,
  "workerId": "google-staging-adapter",
  "attendance": { "spreadsheetId": "EXISTING_REVIEW_WORKBOOK", "sheetId": 20 },
  "decisions": { "spreadsheetId": "EXISTING_REVIEW_WORKBOOK", "sheetId": 21 },
  "cursors": { "spreadsheetId": "EXISTING_PRIVATE_WORKBOOK", "sheetId": 12 }
}
```

Recorded-excusal output appends visible `event_label` and `unit_label` context after its original eleven columns. Their display headers are **Event** and **Flight**. Cadet-facing terminology follows **Wing → Squadron → Flight**; use the specific echelon rather than “Unit.” Existing `unit_id`, `unit_label`, `unitId` and related wire/schema keys remain internal compatibility identifiers for the currently flight-scoped prototype. A future hierarchy migration must model wing and squadron explicitly, not treat those memberships as additional flight memberships. Paused setup can derive those labels from consistent same-generation attendance/cursor rows, preserving the original eleven cells; missing or conflicting context requires review. Future snapshots publish labels directly. This is a Google output schema change, not a D1 migration.

Each output requires one whole-sheet protection with no editable exceptions, groups, domain editors or other users. The cursor tab may share the private journal workbook, on a different tab. Output tabs never share the decision-input tab. The new native schema contract invalidates earlier host/projection setup receipts even when bindings are unchanged. Resolve any outstanding old-contract claim under its compatible release before upgrading; it is retained and fails closed under the new contract. `SHAMROCK_V3_PROJECTION_SETUP` and `SHAMROCK_V3_PROJECTION_CLAIM` are runtime-owned receipt/claim properties. Do not edit or clear an uncertain claim to bypass recovery.

Sheets reads use caches limited to one successful ScriptLock acquisition. Every new acquisition/release clears them; literal writes invalidate cell/formula reads, and publication reads back actual Google values before acknowledging D1. The earlier publication fixture without presentation is capped at 20 Sheets GET requests. The presentation-enabled fixture currently measures 16 GET/3 POST for initial repair, 12 GET/2 POST for repeat repair, and 29 GET/6 POST for a two-person/two-request publication including output and slot writes. Schema initialization and host intake/journal work are additional. These are local fixture counts, not a production burst-capacity guarantee. Measure quotas, concurrent submissions and retry/lease behavior with the actual account before rollout.

Supply a dedicated standalone script with a configured staging Worker origin, environment/generation and signing key from Script Properties; never place the signing key in a spreadsheet-bound launcher. The injected signer keeps its key in a closure. Configure logical source bindings and enrolled principals rather than trusting respondent-supplied IDs or email questions.

Explicitly bind an existing private journal workbook with access limited to trusted maintainers. `enqueueGoogleCommand` and `flushGoogleCommands` operate on the explicitly supplied sheet and ScriptLock. The journal starts with seven machine headers; their physical order can change. Default bounds are 1,000 retained commands, 1,000,000 payload characters total and 45,000 per payload. Oversized inputs need a reviewed chunking workflow; never silently truncate them. The script lock is held through the small dispatch batch, serializing participating adapter executions, not human edits.

An actual Form trigger must bind `e.source` to the configured Form, verify its collected-email mode and applicable sharing policy, read the native `FormResponse`, and resolve the respondent through the enrolled identity registry. `snapshotGoogleForm` accepts a verified-settings flag from trusted configuration; it does **not** prove the flag or respondent policy itself. The decision trigger must freeze `e.value` and stable protected slot identity, persist/retain the draft, and use `e.user` when present. A separate authenticated confirmation flow remains to be built; an unknown actor cannot be upgraded by supplying a text email.

Keep decision drafts in the protected keyed input table. Sort complete rows including hidden identity and context hashes; never move only the visible context cells or rebind a pending draft. Serialize output publishers per resource and write only recorded-result columns. A script lock cannot stop a person changing cells; input/output separation and protected immutable targets are essential. The optional presentation layer below covers the three current staging tables, not the full Main workbook replacement.

The host's optional `consumeProjection` callback runs after its journal lock is released. Bind the separate projection consumer with its own lock, output-only configured tables, current protection verifier and private durable claim store. It must load the current D1 projection, publish with literal `RAW` writes and read back before acknowledging its claim. The optional `publishDecisionSlots(snapshot)` hook runs under that same projection lock after recorded output verification and before ACK; the native runtime supplies it for projection mode. It only appends protected slot metadata, never editable draft cells or existing rows. A hook failure retains the claim. If publication is uncertain or the lease expires, retain the claim for review instead of assuming a new lease can cancel the old API request. API writes do not fire downstream user-edit triggers; orchestration must schedule its own dependent work. A callback that is absent reports `not-configured` and does not imply Google publication succeeded.

Google API failures retain the existing read/write error codes and report only a fixed service label, operation, HTTP status and category. Provider response bodies, URLs, identifiers and credentials are excluded from diagnostics. A reported `429` identifies rate limiting; a historical generic failure does not. This diagnostic does not add retries or change journal/claim recovery. A saved command may already be committed when its separate publication fails; check the receipt and retry the retained publication before its lease expires.

## Optional spreadsheet presentation

`SHAMROCK_V3_PRESENTATION_CONFIG` binds an existing hidden, fully protected legend tab in the same operator workbook as the attendance output, excusal output and dynamic decision input:

```json
{
  "version": 1,
  "environment": "staging",
  "generation": 1,
  "legend": { "spreadsheetId": "EXISTING_REVIEW_WORKBOOK", "sheetId": 23 }
}
```

`shamrockV3StagingRepairPresentation` requires paused staging, initialized schemas and no outstanding projection claim. It validates ownership, whole-tab protection, headers and bounded metadata before writing. It creates real native Tables, preserves their generated IDs, applies SHAMROCK’s green headers/white-gray banding, readable widths and wrapping, frozen display headers, hidden technical fields, status colors and strict legend-backed decision dropdowns. Table columns remain untyped so cell validation works. Managed views provide all-record/current-roster/pending/ready choices; unrelated views, rules, protections and saved drafts are preserved. The legend may be empty or exactly the supported values; unrelated content causes refusal. Hidden columns are presentation, not a confidentiality boundary.

Full repair explicitly reapplies managed formatting and reads back native metadata and cell samples before storing `SHAMROCK_V3_PRESENTATION_SETUP`. Ordinary publication extends existing Table/view ranges after value and slot publication, before ACK, without a full restyle. Styles and validation are prepared within the existing reviewed grid capacity. Missing metadata, changed configuration, an exhausted grid or an uncertain write stops publication with its durable claim retained. An absent optional configuration preserves the previous unstyled staging path. No production menus, resources, paid services or new OAuth scopes are added.

See the [presentation runbook](../../docs/runbooks/D1_PRESENTATION_RUNBOOK.md) for staging setup, recovery and acceptance checks. The full attendance matrix, Directory/Leadership photos, Dashboard/charts, term transitions, cross-domain reviewers and production capacity remain open release gates.

## Validation boundary

The Google test files cover source mapping, duplicate names, delayed catalogs, native identity, HMAC encoding, redirect handling, journal retry/capacity/integrity, setup gating, historical-response rejection, native replay and lock separation. Dynamic-slot tests additionally cover immutable versions, complete-row sorting, partial-sort rejection, legacy metadata upgrade, capacity exhaustion, concurrent input, literal context, claim retention before ACK, native protection bounds and RAW writes. Host tests cover committed/conflict/rejected/authorization/retry status reconciliation, journal-write failure, changed captured input, projection failure after commit, and multi-event choice reordering. These are local injected-port tests, not proof of live Google behavior. Real Form settings, cross-domain actor visibility, physical Sheet protections/sorting, OAuth and publication must pass an isolated account rehearsal before integration with production.
