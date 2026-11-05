# Isolated Google adapter prototype

This module is part of the local/staging D1 experiment. It does not replace the current Apps Script runtime, send email or deploy itself. The core `src/apps-script.ts` exports injected Google ports; `src/staging-host.ts` adds an explicitly configured, paused-by-default standalone host. `src/native-runtime.ts` supplies the real Google IO and protection checks. Importing these modules opens no files and installs no triggers. Their ES-module sources remain independently testable in Node.

Implemented boundaries:

- Native Form response and item identities, enrolled verified responder lookup, immutable `[sr:reference]` person/event/scope choices, and explicit partial/complete attendance reports. Old choice references retain their exact roster snapshot; label text is not identity. Repeated native delivery produces the same command ID.
- Single-cell decision drafts with stable slot/request identity and base version. `e.user` evidence is read when Google supplies it; no effective-user substitution occurs. Missing/unmapped identity leaves a confirmation-required draft. Multi-cell paste requires an explicit frozen review workflow.
- Signed commands matching the Worker's raw-body SHA-256/HMAC protocol. The Google host uses `Utilities`, with negative-byte encoding normalized correctly. Signed HTTP requests do not follow redirects.
- A bounded private Sheets journal, addressed by headers and serialized under a script lock. Enqueue before delivery; retry the exact payload/ID with a fresh signature. Timeouts and ambiguous responses stay pending; conflicts/rejections/authorization failures remain visible for intervention. Capacity exhaustion never deletes unsent input. The prototype retains terminal rows until an operator archives them under an approved retention procedure.
- Recorded-decision publication writes only output cells, checks stable target identity and current recorded version, and leaves draft values/base versions untouched. Job request signing supports claim/project/ack; lease management remains the Worker's responsibility.

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
    "slots": [{ "row": 3, "slotId": "slot.one", "requestId": "request.one", "baseVersion": 1 }]
  }
}
```

For initial setup, the optional `shamrockV3StagingImportConfig` function imports the five configuration properties from an explicitly selected private JSON file. Set `SHAMROCK_V3_CONFIG_FILE_ID` to that file's ID and set the HMAC secret separately. The file contains a map from property names to JSON **strings**, including the `entries`/`references` envelopes above. Only host, principal, attendance catalog, excusal catalog and projection configuration are accepted. Secret, enablement, receipt and arbitrary property keys are rejected. The importer verifies file ownership and every sharing page, validates all content before applying configuration, invalidates old setup receipts and leaves the host paused. It preserves the signing key, unrelated properties and any unresolved projection claim. Never include signing material in that file. Provider write failure leaves staging paused and requires inspection; this is not a cross-service transaction. Pause and wait for active executions before changing bindings.

`excusal` and `decisionInput` are optional. Staging requires explicit review of the exact existing resources; a marker alone is not proof of correct bindings. No host method creates a workbook, tab or Form, replaces a missing resource, changes choices, or changes an existing resource ID. The private journal must use a different workbook from the decision inputs. Missing configured files/tabs stop setup. The small staging configuration bounds are 8,000 UTF-8 bytes per JSON property, 50 enrolled identities, 30 attendance checkbox items and 25 fixed decision slots; scaling these catalogs is future work.

For a custom injected host, implement the required `assertJournalPrivate(reference)` and `assertDecisionProtection(reference, protectedHeaders)` ports against current Google sharing/protection state. The supplied native factory implements these checks. Its first-stage trust policy requires automation ownership, an owner-only journal and no other Form editors. It permits read-only Form respondents. It rejects broad journal access and warning-only/missing protections; all fixed identity and metadata columns are protected from ordinary reviewers. These checks run at setup/resume and again during relevant access. A saved flag is not an adequate implementation.

Run `setup()` under the configured account. It pauses first, verifies resources/settings/protections, initializes only an already configured empty journal tab, and reconciles its four versioned handlers. It preserves unrelated handlers, removes only its mismatched/duplicate handlers, and installs a five-minute flush trigger. A failed deletion stops before replacement creation. Re-running setup preserves matching trigger IDs and returns `ready-paused`; it refreshes the verified-response time boundary. Only `resume()` enables processing, after the same checks and exact trigger-manifest validation. Changed configuration/catalog/principal JSON requires setup again. `pause()` stops new intake/dispatch while preserving saved commands and native Form responses.

Installable triggers are owned by the account that creates them, and Google only lists the executing account's triggers. Moving automation ownership therefore requires explicit old-owner trigger retirement as part of handoff; this host cannot discover another account's triggers. The source Form and spreadsheet handlers also require their recorded native trigger UID and exact source binding.

For responder identity, the host calls the [Forms API metadata endpoint](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/get) with `ScriptApp.getOAuthToken()` and requires `settings.emailCollectionType === "VERIFIED"` at setup and at each intake. [Google distinguishes `VERIFIED` from `RESPONDER_INPUT`](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms#EmailCollectionType); `getCollectEmail()` alone cannot prove verification. Authorize the Forms metadata scope (`forms.body.readonly` or an accepted broader scope), native Forms response access, spreadsheets, external requests, trigger management and current-user email in the standalone manifest. An API denial or unknown setting fails closed; the host does not silently change Form settings.

The [native response timestamp](https://developers.google.com/apps-script/reference/forms/form-response#getTimestamp()) must be at or after the most recent setup receipt. Current verified settings cannot establish how an older response collected its email. Explicit replay retrieves the response by its original native ID and uses the same command identity; pre-setup responses remain in the Form for a separate reviewed migration. Keep Form configuration editors restricted to trusted maintainers, pause before changing collection settings, and rerun setup afterward. Response edits with changed content under an existing ID become a visible command collision; a response-revision workflow remains to be implemented.

The excusal host currently accepts one event per native response, with person identity derived from the enrolled verified responder and an explicit outcome/reason answer. Multi-event excusal fan-out and immutable child identities remain future work. It never trusts an Email or person-ID answer supplied by a respondent.

The decision-input tab must already contain row 1 machine headers `slot_id`, `request_id`, `base_version`, `draft_decision`, `draft_id`, `draft_state`, `draft_json` and row 2 display headers. Only `draft_decision` is user-editable. Each configured fixed row must match its protected slot/request/base version before a command is captured. The host freezes `e.value`, rejects stale delayed edits and rectangular pastes touching the decision column, writes only draft metadata, and retains input text and base version. It records a fixed staging audit reason instead of attributing another mutable reason cell to the editor. Missing/unmapped `e.user` saves a confirmation-required draft without dispatch; an authenticated confirmation UI is still required before ordinary cross-domain reviewers can use that path. The host does not promote the automation owner into that role.

## Core ports and projection hookup

The release bundle now includes `createNativeStagingHost` and actual top-level functions in `staging-globals.js`. `shamrockV3StagingSetup` pauses, initializes the existing protected projection tabs, then validates the host and installs its triggers. `shamrockV3StagingResume` is a separate action. These functions do not replace production menu entries.

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

Each output requires one whole-sheet protection with no editable exceptions, groups, domain editors or other users. The cursor tab may share the private journal workbook, on a different tab. Output tabs never share the decision-input tab. `SHAMROCK_V3_PROJECTION_SETUP` and `SHAMROCK_V3_PROJECTION_CLAIM` are runtime-owned receipt/claim properties. Do not edit or clear an uncertain claim to bypass recovery.

Sheets reads use caches limited to one successful ScriptLock acquisition. Every new acquisition/release clears them; literal writes invalidate cell/formula reads, and publication reads back actual Google values before acknowledging D1. The bounded native test caps a changed three-tab publication at 20 Sheets GET requests. This is an improvement, not a production burst-capacity guarantee. Measure quotas, concurrent submissions and retry/lease behavior with the actual account before rollout.

Supply a dedicated standalone script with a configured staging Worker origin, environment/generation and signing key from Script Properties; never place the signing key in a spreadsheet-bound launcher. The injected signer keeps its key in a closure. Configure logical source bindings and enrolled principals rather than trusting respondent-supplied IDs or email questions.

Explicitly bind an existing private journal workbook with access limited to trusted maintainers. `enqueueGoogleCommand` and `flushGoogleCommands` operate on the explicitly supplied sheet and ScriptLock. The journal starts with seven machine headers; their physical order can change. Default bounds are 1,000 retained commands, 1,000,000 payload characters total and 45,000 per payload. Oversized inputs need a reviewed chunking workflow; never silently truncate them. The script lock is held through the small dispatch batch, serializing participating adapter executions, not human edits.

An actual Form trigger must bind `e.source` to the configured Form, verify its collected-email mode and applicable sharing policy, read the native `FormResponse`, and resolve the respondent through the enrolled identity registry. `snapshotGoogleForm` accepts a verified-settings flag from trusted configuration; it does **not** prove the flag or respondent policy itself. The decision trigger must freeze `e.value` and stable protected slot identity, persist/retain the draft, and use `e.user` when present. A separate authenticated confirmation flow remains to be built; an unknown actor cannot be upgraded by supplying a text email.

Keep decision draft rows in stable protected slots or a dedicated keyed input table. Never sort/rebind their neighboring identity while input is pending. Serialize output publishers per resource and write only recorded-result columns. A script lock cannot stop a person changing cells; input/output separation and protected immutable targets are essential. Complete Google Tables/filter/format rendering is still future work.

The host's optional `consumeProjection` callback runs after its journal lock is released. Bind the separate projection consumer with its own lock, output-only configured tables, current protection verifier and private durable claim store. It must load the current D1 projection, publish with literal `RAW` writes and read back before acknowledging its claim. Draft inputs remain separate. If publication is uncertain or the lease expires, retain the claim for review instead of assuming a new lease can cancel the old API request. API writes do not fire downstream user-edit triggers; orchestration must schedule its own dependent work. A callback that is absent reports `not-configured` and does not imply Google publication succeeded.

## Validation boundary

`tests/v3/google-adapter.test.mjs` covers source mapping, duplicate names, delayed catalog responses, zero-attendee completeness, native identity, Apps Script HMAC encoding, redirect handling, journal retry/capacity/integrity, unknown editors, bulk-review rejection and pending-draft preservation. `tests/v3/google-host.test.mjs` additionally exercises paused defaults, executor gating, Forms API verification, historical-response rejection, exact/idempotent trigger setup, protection ports, unchanged resource bindings, native response replay, signed dispatch and lock separation. These are local injected-port tests, not proof of live Google behavior. Real Form settings, cross-domain actor visibility, physical Sheet protections/sorting, OAuth and publication must pass an isolated account rehearsal before integration with production.
