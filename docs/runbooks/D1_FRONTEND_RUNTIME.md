# Native frontend publication runtime

`apps/google-adapter/src/frontend-runtime.ts` connects the staged administrative effect queue to the keyed Directory, Leadership and Attendance publisher. An explicitly enabled supplemental binding refreshes Dashboard and the Blue/Gold Excusals queues from the same coherent snapshot. It uses the existing adapter HMAC signer, synchronous transport and script lock. It is optional, disabled without explicit configuration, and rejects production configuration. This module creates no workbook, Form, trigger, permission or subscription.

## Configuration and host wiring

Export `createNativeFrontendRuntime` through the isolated staging artifact and provide the ordinary Apps Script `PropertiesService`, `Utilities`, `UrlFetchApp`, `ScriptApp`, `Session` and `LockService` objects. `Utilities.formatDate` supplies the detachment-local date using `America/Indiana/Indianapolis`. The default model builder combines one coherent D1 snapshot with reporting, then supplies actual person/event version tokens to the publisher. The backend contract explicitly defines absent person/event tokens as zero; the adapter never derives them from a displayed code or a request-local version.

Call `refresh()` from the existing staging schedule or an explicit staging maintenance entry point. It processes at most one `frontend.refresh` effect. Forms and the original decision transport may remain paused: this publisher has its own explicit gate. The Worker's current environment, generation, principal grant and command fence are still checked on claim, project and acknowledgement.

The artifact now wires the existing installed `shamrockV3StagingFlush` schedule to run the original intake flush followed by optional frontend refresh. It retains the intake result fields and adds a `frontend` result; an intake result of `paused` does not suppress independently enabled frontend maintenance. `shamrockV3StagingFrontendRefresh`, `shamrockV3StagingFrontendPause` and `shamrockV3StagingFrontendResume` expose explicit maintenance entry points. Ordinary `shamrockV3StagingResume` still resumes only the original intake. `shamrockV3StagingPause` and setup attempt both independent pauses even if one fails, propagate the failure, and verify that the frontend pause property persisted. Setup still installs only the existing reviewed triggers.

The optional `SHAMROCK_V3_FRONTEND_CONFIG` JSON string may be a Script Property. When absent, the runtime reads that exact optional key from the existing automation-owned private configuration file bound by `SHAMROCK_V3_CONFIG_FILE_ID`. This supports programmatic configuration without a new manual Script Properties step. The file must remain private, JSON, at most 64 KiB and owned by the executing staging account. Do not place this configuration or resource IDs in Git.

The configuration importer recognizes this optional key, validates its staging identity and keeps it in the private file rather than copying it into Script Properties. A successful import removes any stale direct-property override and pauses both planes. The bridge secret, outstanding claims and private baseline file are preserved. Subsequent file updates are read by the optional frontend runtime without reimporting the old Form configuration.

The configuration contract is:

```ts
{
  version: 1,
  environment: 'staging',
  generation: /* same as the existing staging host */,
  enabled: false,
  resourceReview: 'EXISTING_FICTIONAL_FRONTEND_REVIEWED_FOR_STAGING',
  workerId: /* stable publisher identity */,
  principalId: /* enrolled principal with Wing frontend.read */,
  stateFileId: /* existing private automation-owned JSON file */,
  main: {
    spreadsheetId: /* reviewed existing staging Main */,
    expectedTitle: /* exact reviewed title containing Staging */,
    sheets: {
      directory: { sheetId: /* existing */, tableId: /* existing native Table */ },
      leadership: { sheetId: /* existing */, tableId: /* existing native Table */ },
      attendance: { sheetId: /* existing */, tableId: /* existing native Table */ }
    }
  },
  allowedFileEditors: /* exact named non-owner Drive writers */,
  access: /* FrontendProtectionAccess, including explicit operational grants */,
  seeds: [{ key, sheetId, rowIndex, columnIndex, nativeStyleVersion, expectedRule }],
  supplemental: {
    enabled: true,
    dashboard: {
      sheetId: /* existing Main Dashboard */,
      dataSheetId: /* existing hidden Dashboard Data */,
      chartIds: /* four existing IDs: AS year, term, flight, roster */,
      actions: /* reviewed resolved Google/sheet links */
    },
    excusals: {
      spreadsheetId: /* existing isolated Excusals workbook */,
      expectedTitle: /* exact reviewed title containing Staging */,
      allowedFileEditors: /* exact named non-owner Drive writers */,
      access: /* its explicit squadron decision access policy */,
      sheets: {
        blue: { sheetId, tableId, squadronId },
        gold: { sheetId, tableId, squadronId }
      },
      seeds: [{ key: 'excusal:decision', sheetId, rowIndex, columnIndex,
        nativeStyleVersion, expectedRule }]
    }
  }
}
```

The owner and automation identity must equal the verified host identity. Main must differ from the private journal and existing decision-input workbook, and its actual title must exactly match the configured staging title. This catches accidentally binding the ordinary production workbook even when it shares the same owner. The private state file must also differ from Main and the configuration file. Whole-workbook sharing must match the exact private owner/writer list; broad, group, domain or unexpected grants prevent publication. All other Main tabs are protected as read-only helper/output surfaces.

Missing supplemental configuration, or `{enabled:false}`, explicitly retains Main-table-only behavior. Full mode requires both reviewed workbooks, distinct Blue/Gold squadron bindings, four exact Dashboard chart IDs, and matching private supplemental baselines. It cannot silently downgrade an existing full-mode state to Main-only. The Excusals workbook must differ from Main, private state/configuration and the older technical decision transport. The approved Dashboard layout must already exist; this runtime does not replace chart identities or rebuild the canvas.

`pause()` sets `SHAMROCK_V3_FRONTEND_PAUSED`. `resume()` clears only this frontend pause override after validating enabled staging configuration. It does not resume Forms, the original adapter intake or the D1 command fence, and does not run publication itself. Changing the private configuration's `enabled` flag takes effect on the next invocation. A running invocation still rechecks the local pause override and backend authority before effect operations.

## Private state and initial binding

The `stateFileId` is an existing owner-only JSON file, bounded to 5 MiB. It contains `version: 1`, `environment: 'staging'`, the generation, a `baselines` entry and a `drafts` array for each of `directory`, `leadership` and `attendance`. Baselines hold the last verified stable-key values and field/domain versions. Frozen drafts retain their original target, value and base version. This information belongs only in private operations storage, never hidden user-facing tabs.

Full mode adds `supplemental: {dashboardRevision, baselines: {blue, gold}, drafts: {blue, gold}}`. Initialize both queue baselines through explicit empty-table or reviewed fictional-reset binding. Decision versions come from the actual request; they are independent of attendance pair versions. The Dashboard revision tracks the coherent reporting snapshot, and current queues use each request's recorded flight/squadron, rather than a cadet's later assignment.

Initialize empty Tables using `planFrontendInitialization`. Replacing the old fictional preview requires its explicit reviewed-reset contract, including exact existing sheet/Table identities and a fresh read fingerprint. Do not attach the publisher to populated tables by matching names or positions. Persist the initial verified baseline before enabling refresh. The runtime fails closed when state or stable identity is missing; it does not guess an initial baseline from arbitrary editable cells. Setup/provisioning owns the one-time initialization, under the same native edit fence.

Private state writes use the Drive media-update API, with a fresh version comparison under the script lock and exact SHA-256 content read-back. This is a single-writer protocol, not a claim of provider-wide compare-and-swap. All cooperating state writers must share this script lock. The owner can bypass spreadsheet protections and edit the private file, so external owner writes during publication are unsupported and detected where fresh versions/read-back permit. No credentials are stored in the state file.

## Publication sequence and recovery

The runtime verifies account ownership, private sharing and state before claiming work. A durable private Script Property retains the exact effect ID, claim token and expiry. It claims only `frontend.refresh`; it cannot take `forms.refresh` jobs. The project response must identify the same effect and staged generation.

Before reading and planning business-cell changes, the runtime replaces operational field grants with strict automation-only native protection and verifies the closed state. This is separate from `ScriptLock`, which cannot prevent a human edit. Table reads are bounded and batched across the three Main surfaces; native validation seeds are read together from their protected hidden sheet. Seeds preserve plain/arrow/chip distinctions through the publisher's validation-copy contract.

The complete frozen publication plan is saved privately before the external write. In full mode this includes all three Main tables, Dashboard and both squadron queues. Strict native protection fences cover both workbooks before planning. One atomic Main batch contains its three tables plus Dashboard; one separate atomic Excusals batch contains Blue and Gold. Each workbook batch is limited to 1,000 requests and 1.8 MB. There is no cross-workbook transaction claim: between those batches one book can display a newer revision, while both remain fenced against user input. The adapter does not split an oversized workbook batch. It rechecks fresh publication preconditions and lease time immediately before writing. Business strings remain literal; Dashboard formulas are restricted to its reviewed action hyperlinks. Publication cannot write arbitrary tabs, change sharing or delete sheets.

Every table is read back against the planned values, stable identities, headers, hidden metadata and native Table range. Every copied validation interval is separately read in bounded chunks of at most 2,000 cells and 12 ranges, with bounded URLs and responses. The verifier checks every destination's rule type, strictness, `showCustomUi` and absolute legend reference; it does not re-read validation for the entire existing attendance matrix. Missing or changed validation retains the fence, including after an ambiguous write. Google does not expose native chip color metadata through this public rule; that styling remains governed by the protected, visually reviewed seed and native-copy contract.

Dashboard read-back verifies literal/action values, hidden source data, managed grid and merges, and the four existing chart identities/specifications. Chart comparison normalizes only the live provider’s inherited font defaults, equivalent deprecated/modern color aliases, omitted white background, and byte-encoded RGB output. Conflicting aliases, changed data sources, axes, labels or other fields still fail verification. New chart palettes use exact byte colors. See the [Sheets chart specification](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/charts) for font inheritance and color fields. Attendance growth accepts only the compact layout's bounded font/alignment/number-format and dimension requests, leaving native color and validation metadata intact.

Only after **both configured books** pass content and validation checks are baselines and retained drafts saved. A completed checkpoint is persisted before restoring both exact operational protection policies. Fresh protection verification precedes effect acknowledgement. The claim is cleared only after confirmed acknowledgement.

Restored cell grants include the baseline's per-row field ownership rules. Directory Squadron is derived from Flight and remains closed. Directory-linked Leadership contacts expose only Reports To and office contact fields; manual contacts retain all supported business inputs. The native host maps each current protected contact/person/request ID to the published baseline, preserving those restrictions after sorting. Missing/duplicate identity or absent Leadership ownership metadata prevents reopening edits. Empty Table rows remain closed. While a whole sheet is fenced with no editable holes, fresh protection verification uses metadata alone instead of redundantly rereading all business cells.

An ambiguous write keeps its frozen plans and human-edit fences. On a deliberate retry, a complete per-workbook match to the planned output confirms that its atomic write happened; a complete match to its original preconditions permits retrying only that workbook's original plan. A verified Main followed by failed Excusals is recovered by completing Excusals, without replaying Main or rebuilding from a newer snapshot. Mixed or unexplained state inside either workbook stays closed for reconciliation. Expired leases are never stolen. An ambiguous acknowledgement retains the claim and completed checkpoint; a later attempt does not replay content over a new human draft. If the Worker already marked the effect done and returns a conflict, use explicit effect reconciliation rather than manufacturing another claim.

Ordinary unsent edits and queued drafts are preserved by the keyed publisher. A projection acknowledgement does not acknowledge those human commands. A verified command receipt must advance the corresponding baseline/version and retire only its exact matching frozen draft. Input capture, authenticated confirmation and receipt reconciliation are separate adapter responsibilities.

## Scope and remaining release checks

Full mode publishes the three Main data tables, Dashboard metrics/charts/birthdays and Blue/Gold recorded requests/decisions. It does not capture or deliver new edits from these sheets, replace the existing technical decision-input transport, or publish Forms or notification effects. Those still need their authenticated input/effect bindings. The existing decision path must remain isolated until its reviewed replacement preserves frozen request/version identity and verified human authority.

Local tests exercise signed requests, independent gates, generation/lease rejection, ownership/isolation ordering, native fencing obligations, per-workbook atomic publication, partial two-book publication, value/validation read-back failures, write/acknowledgement ambiguity, safe retry, restore failures and unsent-draft retention. They do not establish live Google execution, Apps Script runtime budget, non-owner browser sorting, editor identity, complete feature parity or production capacity. Check the private release evidence for actual deployment and fictional rehearsal results; compiled source alone does not establish a connected host.

### Proposed input-capture gate: direct spreadsheet editing

**Proposal, not implemented or proven.** Preserve direct dropdown editing and saved Flight filter views as the goal. Authenticated confirmation is the fallback for missing or ambiguous evidence, not a settled requirement for every edit.

Reading a row's current hidden ID does not prove its identity when an earlier edit occurred. The documented [`onEdit` event](https://developers.google.com/apps-script/guides/triggers/events) supplies coordinates, optional user and single-cell values, but no immutable entity/version snapshot; `triggerUid` identifies the trigger. Capturing the row before a script-lock wait closes only later races. A sort or republication before that first read remains unresolved, even when `e.user` is available.

The publication planner now supports an explicit private baseline `slots` binding containing the exact physical headers and row keys. Once bound, it rejects physical row/column reordering, retains retired identities as read-only tombstones, never reuses them for another record, and restores a returning record only to its own slot. A pending edit prevents retirement. Existing keyed baselines remain unbound until an explicit fenced initialization establishes the layout. This planner capability alone does not enable native input. Keep identity/header cells protected. Ordinary physical Table sorting or row/column moves must be prevented. Saved FilterView sorting may preserve the intended workflow, but its underlying storage and edit-coordinate behavior must be verified with real non-owner accounts before relying on it. Owner bypass and external maintainer writes require separate controls. Fixed geometry alone does not prove the version being edited: preserve published field, command and event versions for dirty cells before trigger capture; never substitute the latest server version.

Release gates are:

- Demonstrate stable targeting through FilterView sorting, denied physical moves, delayed handlers, concurrent publication, identical values on different rows, sort-away-and-back, paste/clear and repeated edits. No waiting period alone establishes that all old events drained.
- Use available `e.user` evidence only after target binding is proven. Never substitute the trigger creator or a typed identity. Missing identity or ambiguous targeting requires an authenticated review of the exact frozen entity, field, value and versions; unresolved targeting requires explicit reselection. [Google's execution identity rules](https://developers.google.com/apps-script/reference/base/session) remain applicable.
- Persist one immutable draft/command before dispatch, recheck D1 authority, retry the same payload, and reconcile only its verified receipt. Keep later cell edits and conflicts intact. API writes do not exercise native triggers, so real user edits must supplement local and API tests. [Installable-trigger restrictions](https://developers.google.com/apps-script/guides/triggers/installable).


## Explicit programmatic recovery

Migration 0007 adds an immutable refresh recovery journal. The signed `POST /v1/admin/effects/recover` operation renews only the exact retained effect, worker, token and prior expiry under current Wing refresh authority and the same environment/generation. It works while commands are paused, records the reviewed private checkpoint digest and observed provider state, and returns an idempotent receipt. It never takes another worker’s lease, resets a queue, acknowledges publication or changes the claim’s snapshot floor.

The owner-private frontend configuration can contain `leaseRecovery: {recoveryId, checkpointSha256, previousExpiry}`. This is an explicit operator instruction, not an automatic timeout retry. The adapter holds its ScriptLock, verifies both native edit fences, and checks each retained workbook against its frozen original or completed plan before requesting renewal. Partial two-workbook completion remains resumable. Mixed content stays fenced. A checkpoint without a pending plan is a pre-write failure under the publisher’s persist-before-write contract. A completed checkpoint can finish acknowledgement without overwriting later human drafts.

To resume without manipulating Script Properties in the editor, write a new owner-private `resumeRequest: {requestId, sequence, stateSha256}` alongside `enabled:true`. The sequence must strictly increase. The adapter verifies the exact private state digest under its script lock and durably consumes that request before clearing the pause override. Reusing it cannot clear a later failure/manual pause; a new reviewed request is required. This does not enable Forms or the D1 command gate, and it cannot grant missing Google OAuth consent. If persistence or pause clearing is interrupted, inspect the retained receipt and use a higher sequence after reviewing the checkpoint.

Recovery must retain the private evidence and use the same frozen request on an ambiguous HTTP response. A new recovery ID is needed only for a later explicitly reviewed expiry. The previous scope-failure rehearsal demonstrated why Google authorization, command fences, native fences, private checkpoint writes and lease state are separate checks.
