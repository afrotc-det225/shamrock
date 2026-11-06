# D1 staging spreadsheet presentation

This procedure updates only the isolated fictional staging workbook and standalone adapter. Production SHAMROCK remains the supported operational system. It covers the three current projection surfaces: attendance observations, recorded excusals and dynamic decision review. It does not claim parity for the final attendance matrix, Directory, Leadership, Dashboard/charts or term transitions.

These projection tabs are engineering rehearsal surfaces. The production-facing Main workbook must expose **Dashboard, Leadership, Directory and Attendance**; the separate Excusals Management workbook exposes **Blue and Gold**. Data Legend and chart helpers remain out of normal navigation. Private journals, outbox state, projection checkpoints, version-slot history and delivery diagnostics belong in separately permissioned operations storage, not extra tabs for cadets or excusal reviewers. Hiding a tab is not an access-control boundary. A [fictional frontend preview](D1_FRONTEND_PREVIEW.md) demonstrates the intended navigation and layout separately from the transport rehearsal.

## Baseline and managed changes

Use current SHAMROCK as the visual baseline. The read-only production metadata inventory confirmed native Tables with `#356854` headers, white/`#F6F8F9` banding, unspecified column types and frozen display headers. No saved `filterViews` were returned for the current Main/Blue/Gold tabs; that does not establish the absence of temporary or other native table views. Preserve useful custom views during eventual migration rather than assuming a specific saved view exists.

Use **Flight** for the current reporting scope. The detachment hierarchy is **wing → squadron → flight**; future squadron/wing summaries must name their own echelon. Operator-facing headers and instructions must not expose the generic “Unit” wording. Existing internal `unit_id` and `unit_label` keys stay stable so this label correction does not change saved identities, commands or projection cursors.

The shared `apps/google-adapter/src/presentation.ts` planner manages:

- Real native Tables, created minimally and then configured after reading Google's generated IDs. Subsequent repairs retain those IDs.
- Roboto text, wrapped headers and long labels, deliberate column widths, hidden machine-header row/technical columns, frozen display headers and semantic status colors.
- A separate hidden, fully protected Data Legend and strict cell-level decision dropdowns. Typed table columns are left unspecified for compatibility with legend-backed validation. The validation rule and conditional cell fills alone do not establish native colored-chip presentation.
- Saved views for all records, current roster, pending requests and ready decision inputs. Complete rows include hidden identity/context fields in their sort boundary.
- Bounded formatting/validation for future rows, then inexpensive Table/view range growth during publication. Repair does not overwrite operational values or pending draft cells, change ACLs or replace workbook/tab bindings.

Only managed rules/views/formatting are repaired. Existing nonmanaged views, rules, notes, protections and data remain. Full repair deliberately reapplies managed fonts, widths and colors; it is not a mechanism for preserving conflicting custom formatting on those managed fields. Conflicting tables, merges, unknown legend content or ambiguous metadata stop before a new plan is applied.

### Native colored dropdowns

Match the selected chip, per-option colors and expanded dropdown menu against the current SHAMROCK baseline. A colored cell with a plain arrow is not proof that this requirement passed. The current [Sheets API validation rule](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/cells#DataValidationRule) exposes the allowed values/range, rejection behavior and dropdown visibility, but not per-option colors or the native Chip/Arrow display style.

Author and approve each palette once in a SHAMROCK-owned native template containing only empty or fictional records, then freeze that template release and pin its Drive version, owning account, ACL and schema contract. Ordinary provisioning/rebuilds must clone the approved native artifact through Drive `files.copy` or an explicitly reviewed Sheets `sheets.copyTo` flow. Row/event growth uses `PASTE_DATA_VALIDATION` within the destination workbook, as the existing `FrontendFormattingService` does for archived Directory and Attendance styles. These operations must work through public APIs without a browser or color picker in the runtime path. Never copy production cadet records into staging.

Google documents that [Paste special does not work across separate spreadsheets](https://support.google.com/docs/answer/161768); copying the native file/sheet is a separate API operation. Validate account/ACL, source version, headers, rules, legend references and native Tables before accepting the copy. Stop on drift or failure rather than replacing chips with plain controls or changing the validation contract to typed Table dropdowns. New custom chip colors/display styles require a newly approved native template version; code cannot currently set arbitrary per-option colors through the public validation API. Follow the [programmatic template lifecycle](D1_FRONTEND_PREVIEW.md#programmatic-native-template-lifecycle).

An equivalent validation rule should survive routine publication and presentation repair without being reconstructed. When a rule actually changes, recheck both strict choices and native chip appearance. For new rows/events, copy validation from the approved native template and verify the new cells. API metadata equality cannot certify unexposed chip colors.

The bounded decision-column check reads all configured input rows and leaves matching rules untouched; it repairs only missing/incorrect intervals. If repair has to replace a rule, inspect that interval's native chip style afterward. The preview builder separately applies validation last, after native Table column configuration, because live provisioning showed that Table configuration could clear rules within its body. Check inside and beyond the Table boundary; a valid last-row sample alone is not proof that the body is validated.

## Configure and deploy while paused

1. Verify the intended staging script/workbook/account, Google pause, closed staging Forms, D1 fence and zero unfinished jobs. Save source, configuration, bounded values/drafts and metadata in restricted ignored storage. Capture production formatting read-only; never copy real cadet records into staging.
2. Run the standard checks, commit/push the isolated adapter changes and prepare the reviewed release using the [staging runbook](D1_STAGING_RUNBOOK.md). Never deploy uncommitted code or use the root production `.clasp.json`.
3. In the existing staging operator workbook, explicitly create one empty hidden legend tab, with strict whole-tab protection for the automation owner. Keep the current decision input protection and editable column intact. Ensure the recorded-excusals output has at least 13 grid columns and expand the dynamic input grid to at least 16 columns if needed; do not replace its tab or clear its data.
4. Add `SHAMROCK_V3_PRESENTATION_CONFIG` to the existing private configuration JSON using the [adapter configuration shape](../../apps/google-adapter/README.md#optional-spreadsheet-presentation). Do not add secrets to that file. Upload the committed Google artifact only to the staging script and verify both source files exactly.
5. Run `shamrockV3StagingImportConfig`, then `shamrockV3StagingSetup` as the project account. Setup remains paused. It validates and upgrades a deployed 14-column dynamic input by appending `slot_origin_row` and `slot_context_hash`, preserving all original IDs/cells/payloads. Recorded-excusal output also gains Event and Flight labels in columns 12–13, derived from consistent same-generation attendance output and its published cursor; all original eleven columns remain intact. It then repairs presentation and validates the existing trigger manifest. A populated historical fixed-input tab is retained and not restyled or converted.
6. Run `shamrockV3StagingRepairPresentation` twice. Compare values/draft hashes, protected ranges, native Table IDs, managed-view identities and rule counts after each run. Inspect Google-rendered Sheets at ordinary zoom; styling alone is not proof that native Tables exist.

Resource creation is an explicit reviewed provisioning step, not runtime discovery or fallback. The runtime never creates a workbook, tab or Form. There are no new scopes, dependencies, paid services or subscription changes.

### Repair labels on existing staging Tables

For the terminology-only correction, keep staging paused and repair the affected display headers and native Table column names through the Sheets API: **Unit → Flight** and **Unit ID → Flight ID**. Retain existing Table IDs, complete row values, hidden machine headers, protections, validation and saved views. Read back both display cells and native Table metadata, and compare data/protection snapshots before considering the repair complete. Deploy the matching committed adapter bundle so future presentation repairs preserve the new labels; no SQL/API key rename is needed.

## Verify interaction and publication

Check all three rehearsal surfaces with fictional records. Confirm native table controls, readable headers/long labels, editable-versus-recorded fields, visible version and delivery status, strict dropdown choices and useful filter views. Inspect the selected colored chip and the expanded option menu; compare these with the production baseline. Verify the hidden legend and the entire output/metadata protection through the API. A hidden field is not a security control. Separately inspect the frontend preview's four Main tabs and two Excusals tabs; the engineering rehearsal navigation is not the production-facing acceptance target.

Sort a complete native table and confirm its slot/request/context hashes and saved payloads travel together. A partial sort of visible context must fail identity verification. Test a decision only against a reviewed current request/version, with Forms remaining closed; temporarily enable the isolated Worker and host only for that rehearsal. Verify the exact command receipt, human `google-edit` evidence, output revision, newly appended protected version slot, Table/view growth and completion before ACK. Check that existing drafts survive. Then pause the host, restore the Worker fence and verify closed Forms and zero unfinished jobs.

Owner-account tests do not establish ordinary reviewer access. Intended non-owner filtering/sorting, cross-domain actor evidence, concurrent edits, full presentation parity, term transition and measured provider capacity remain production release gates. In particular, Apps Script supplies a physical edit range but no immutable slot token from the instant of the edit. The handler freezes identity before its lock wait and rejects a target swap during that wait; a sort occurring before its first read remains unresolved. Do not treat this staging improvement as production-ready concurrency evidence.

## Recovery and quota behavior

Full repair requires paused intake, the current projection setup receipt and no outstanding claim. It reads back native objects and sampled header/body/validation metadata before saving its presentation receipt. Missing native Table objects never pass as a colored-range fallback. Do not delete/recreate a Table to repair formatting: Google's `deleteTable` can delete its data.

Google can inherit header colors from the native Table after a range update and omit redundant `TEXT/@` formats after RAW literal writes. Verification reads effective header styling and the explicit base body style, accepting omitted text formats only for literal or blank cells. Explicit incorrect formats, formulas, missing numeric version formats and weakened validation still fail. This normalization check adds no formatting writes or API requests.

Routine publication preserves existing Table IDs and expands ranges within the preformatted grid. It checks presentation configuration/readback before acknowledging a projection. Missing metadata, invalid protection, exceeded capacity or an ambiguous API failure retains the durable claim for review. Do not clear the claim, silently enable processing, overwrite drafts or repeatedly run full repair around an unresolved publication.

The updated native contract invalidates old host/projection setup evidence. Resolve outstanding old-contract claims with the compatible release before upgrading; the new release retains and refuses them. After additive sheet schema upgrades, do not reopen processing with an older incompatible bundle or erase the added columns/drafts as a rollback shortcut. Keep staging fenced and use a reviewed forward repair or restore a complete compatible snapshot with no accepted work omitted.

A failed repair may have applied earlier atomic request batches. Keep staging paused, inspect fresh metadata and rerun the bounded plan after resolving the failure; do not blindly replay stale requests. A table ownership marker and minimal table creation are issued together. Unknown or conflicting objects require review rather than automatic adoption/deletion.

Presentation shares the existing Google Sheets API and Apps Script quotas and adds no Cloudflare query to formatting. Routine growth avoids full-table restyling, but API calls and execution time still need actual load measurement before cutover. The existing free-tier deployment plan remains in effect; do not solve quota problems by silently enabling billing.

## Evidence record

Record the deployed commit, local test count, actual API read-back, repeated-repair preservation, native interactions, publication results, final pause/fence and unchanged production source in the staging checkpoint and private operations handoff. Separate successful checks from remaining release gates.
