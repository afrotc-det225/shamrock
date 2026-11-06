# Native spreadsheet input in staging

The optional input runtime connects the existing Main Directory, Leadership and Attendance Tables and the Blue/Gold excusal decision Tables to validated D1 commands. It retains their native styling, validation and spreadsheet workflow. It changes only private checkpoints, installed staging triggers and input-cell notes; publication remains responsible for recorded business values. This implementation has local provider-port coverage. It does not establish live Google editor identity, FilterView coordinate behavior, complete feature parity or permission to change production.

## Edit evidence and stable targets

Setup closes both workbooks with the publisher's exact native protection fence, compares every current Table value with its verified published baseline, and binds immutable physical headers and row keys in the private checkpoint. All published records must be present and no draft or active publication may remain. Setup never rearranges cells. The publisher thereafter appends identities and retains read-only tombstones; it cannot reuse a row or column for another identity. An existing completed publication marker is historical evidence, not an active lease.

Google returns an empty native cell for a published empty string. Input setup and edit comparison treat those two blank representations alike while preserving the original baseline. Whitespace, nonblank values, formulas and native chips retain their distinct checks; this normalization does not discard an unsent change.

The native handler captures `e.user`, coordinates, `value` and `oldValue` before obtaining the shared ScriptLock. It never substitutes the automation account or a typed email for the human editor. Under that lock it checks the entire immutable physical map and current field grants, then freezes the edited entity, field, entered value, original publication/domain/event versions and exact command. Reading the current row's hidden ID alone is not sufficient.

A single-cell edit can use direct `google-edit` evidence only when its event values match the observed native cell and published old value, its editor maps to one registered principal, the editor is not the automation owner, and the binding has a recorded live provider review. That review must prove non-owner FilterView edit coordinates and denied physical sorting. A config attestation is not proof by itself. Missing user evidence, owner bypass, missing single-cell evidence, paste or a multi-cell range requires verified confirmation. Structural mismatch stops capture; confirmation cannot fix an unknown target.

Google documents that edit user identity is conditional and old/new values are only available for single-cell edits. `triggerUid` identifies the installed trigger, not one edit. See [event objects](https://developers.google.com/apps-script/guides/triggers/events). Thus duplicate delivery uses frozen command identity, not a newly generated command ID or a current server version.

## Commands and retries

Directory and Leadership changes use their existing versioned commands. A full profile payload is frozen only from a coherent snapshot whose domain version equals the original published field binding. Linked Leadership profile fields remain read-only; Reports To and office contact fields use the contact version, separate from the combined publication token. Directory Squadron remains derived from Flight. Attendance corrections retain both the original pair and event versions. Blue/Gold edits retain request identity and version. The Worker rechecks current capabilities and scope for every command; a cell grant or confirmation link grants no backend authority.

The input journal is saved before the corresponding publisher draft hold and before signed dispatch. Each delivery marks itself attempted before the network request. An ambiguous delivery retries its exact command even if the visible cell subsequently changes. Only a matching committed receipt advances the exact baseline field and removes that matching draft. A receipt marker saved with the frontend checkpoint makes interruption between that save and the journal acknowledgement recoverable. An acknowledgement of publication never acknowledges a human command.

A later native edit can supersede an earlier draft only if all its cells are covered by the new edit and none of its commands was ever attempted. Supersession is journaled before removing exact old holds. Clearing back to the published value abandons that unsent change; entering another value freezes a new capture identity. An old confirmation cannot revive it. A partly dispatched group, conflict or ambiguous command is retained for Wing review; it is never silently canceled or rebased. Formula inputs and ambiguous native chips are rejected. Actual file chips retain their Drive URI.

A missed or paused-period handler leaves visible values in the sheet. A later publisher can freeze those dirty cells with their original baseline. Scheduled input recovery recognizes those unclaimed drafts and offers confirmation without inventing an editor. It cannot reconstruct edits already overwritten outside the protected workflow. Raw failure evidence stays in the owner-private journal; it is not treated as a successful command.

## Private configuration and setup

The existing owner-private root configuration may contain `SHAMROCK_V3_INPUT_CONFIG` as a JSON string with `{ "version": 1, "configFileId": "PRIVATE_INPUT_CONFIG" }`. The referenced owner-only JSON file uses:

```json
{
  "version": 1,
  "environment": "staging",
  "generation": 1,
  "enabled": false,
  "resourceReview": "EXISTING_INPUT_SURFACES_REVIEWED_FOR_STAGING",
  "journalFileId": "PRIVATE_INPUT_JOURNAL",
  "principals": [{ "email": "reviewer@example.invalid", "principalId": "REGISTERED_PRINCIPAL" }],
  "surfaces": [
    { "surface": "directory", "spreadsheetId": "MAIN", "sheetId": 1, "tableId": "DIRECTORY_TABLE", "resourceKey": "REGISTERED_DIRECTORY_SOURCE" },
    { "surface": "leadership", "spreadsheetId": "MAIN", "sheetId": 2, "tableId": "LEADERSHIP_TABLE", "resourceKey": "REGISTERED_LEADERSHIP_SOURCE" },
    { "surface": "attendance", "spreadsheetId": "MAIN", "sheetId": 3, "tableId": "ATTENDANCE_TABLE", "resourceKey": "REGISTERED_ATTENDANCE_SOURCE" },
    { "surface": "blue", "spreadsheetId": "EXCUSALS", "sheetId": 4, "tableId": "BLUE_TABLE", "resourceKey": "REGISTERED_BLUE_SOURCE" },
    { "surface": "gold", "spreadsheetId": "EXCUSALS", "sheetId": 5, "tableId": "GOLD_TABLE", "resourceKey": "REGISTERED_GOLD_SOURCE" }
  ],
  "confirmation": {
    "formId": "CONFIRMATION_FORM",
    "expectedTitle": "SHAMROCK — Staging — Confirm spreadsheet changes",
    "allowedEditors": [],
    "reference": { "itemId": "REFERENCE_ITEM", "questionId": "REFERENCE_QUESTION" },
    "summary": { "itemId": "SUMMARY_ITEM", "questionId": "SUMMARY_QUESTION" },
    "action": { "itemId": "ACTION_ITEM", "questionId": "ACTION_QUESTION" }
  }
}
```

Use the actual generation, reviewed publisher bindings and enrolled logical source keys. Exactly five surfaces are required. Source registration is separate from cell protection. Start the separate owner-private journal as `{ "version": 1, "environment": "staging", "generation": 1, "entries": {} }`. Neither secrets nor environment files move through Git.

Create the fourth Form closed, with VERIFIED email collection and three required questions:

| Label | Native type | Purpose |
| --- | --- | --- |
| Change reference | Short text | Prefilled immutable private edit reference |
| Changes to confirm | Paragraph | Prefilled exact frozen record/field/value summary |
| Confirm changes | Multiple choice or dropdown | Sole exact choice: `Confirm these changes` |

The user selects the action; it is not prefilled. An edited reference, summary, action or unregistered verified account is rejected. The Form's native response is fetched by bound Form/response ID; its [verified respondent and answers](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses) supply the confirmation. REST item IDs and Apps Script numeric item IDs are explicitly mapped by verified index/title during setup, not assumed equal. The bound item/settings shape must remain unchanged afterward.

The owner-private input config can request setup without opening the Script editor:

```json
{
  "controlRequest": {
    "requestId": "REVIEWED_SETUP_REQUEST",
    "sequence": 1,
    "action": "setup",
    "frontendSha256": "SHA256_OF_CANONICAL_CURRENT_FRONTEND_STATE",
    "journalSha256": "SHA256_OF_CANONICAL_CURRENT_INPUT_JOURNAL"
  }
}
```

Canonical JSON recursively sorts object keys and preserves array order. The existing scheduled flush consumes this request before input dispatch, including while the input gate is paused. It verifies both private checkpoint digests under the publisher's ScriptLock, pauses input and durably consumes the monotonically increasing request before acting. A consumed request cannot undo a later pause. If setup/resume is interrupted after consumption, inspect the state and submit a new reviewed higher sequence; do not delete its receipt.

Explicit input setup/control may inspect a configured but disabled frontend under its shared lock; this does not enable ordinary publication or input. Setup binds physical slots under both fences, restores the exact operational policy, then verifies/installs one edit trigger for each workbook and one confirmation trigger. It stays paused. It is safe to repeat with unchanged Tables and no drafts. A binding failure retains the fence and pauses publication. API control `resume` requires `enabled:true`, a verified setup receipt and an available unpaused frontend; input, Forms, frontend publication and D1 command gates remain separate. Setup, resume and pause do not publish or open the confirmation Form. Open it explicitly only for the approved rehearsal, and close it at its end.

Optional `providerReview` is `{ "reviewId": "PRIVATE_EVIDENCE_REFERENCE", "bindingsSha256": "SHA256_OF_CANONICAL_SURFACES", "filterViewCoordinatesVerified": true, "protectedSortDenied": true }`. Omit it until actual native tests pass. Ordinary direct dropdown editing remains the goal, not universal confirmation.

Operator entry points are `shamrockV3NativeInputSetup`, `shamrockV3NativeInputResume`, `shamrockV3NativeInputPause`, `shamrockV3NativeInputFlush`, `shamrockV3NativeInputStatus`, `shamrockV3NativeInputReviewQueue`, and `shamrockV3NativeConfirmationReplay(responseId)`. The installed handlers are `shamrockV3NativeFrontendEdit` and `shamrockV3NativeFrontendConfirm`. The review queue requires an authenticated active user mapped to current Wing frontend authority. Global staging pause attempts this gate as well as existing gates. Config import pauses input and leaves the optional config file-owned.

## Capacity and release evidence

Each captured range is bounded to 250 cells and a 16,000-character confirmation summary. Signed payloads are bounded to 65,536 bytes. Dispatch is at most ten commands per scheduled pass; private JSON responses/journals are at most 5 MiB and the publisher checkpoint allows at most 10,000 applied input receipt markers. Notes update only when status changes. No paid service or AI request is used. Completed evidence is not automatically deleted: an operator-reviewed durable archival/retention procedure and measured Apps Script/Sheets/Forms quotas are required before sustained production use.

Local tests cover pure target/version binding, complete-map reorder rejection, owner/unknown-user fallback, clear/paste behavior, exact receipts, unattempted supersession, interrupted journal/hold/receipt writes, native setup and private control request replay, REST/FormApp ID mapping, signed delivery and note-update bounds. They use injected Google ports; they are not native interaction evidence.

Before enabling direct edits, record real non-owner ordinary-sort denial, FilterView sorted editing with identical adjacent values, delayed trigger/publication overlap, paste/clear, changed authority, unknown-user confirmation, duplicate confirmation, ambiguous network recovery and all five surfaces. Verify original colors, native chip/arrow/plain controls, row heights, filters and photos remain unchanged. Keep production triggers/resources untouched until the separate cutover review passes.
