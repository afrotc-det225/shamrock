# Fictional frontend preview

The preview shows the proposed production-facing spreadsheet presentation using fictional cadets and events. It is separate from both production SHAMROCK and the D1 transport rehearsal. It has no production bindings, installed business triggers or working notification delivery. Editing preview cells does not submit a D1 command or change a real attendance or excusal record.

## Visible workbooks

| Workbook | Visible tabs | Purpose |
|---|---|---|
| Main preview | Dashboard, Leadership, Directory, Attendance | Familiar navigation, contacts and the cadet-by-event attendance matrix |
| Excusals preview | Blue, Gold | Squadron-specific review with native Decision dropdowns |

Data Legend and chart-source helpers may be hidden within their preview workbook. Journals, outbox state, projection checkpoints and version-slot history are not part of either user-facing preview. In the final system, private operations data requires a separately permissioned resource; hiding a tab does not protect its contents.

Use the existing SHAMROCK layout, native Tables, Roboto text, green headers, row banding, semantic attendance colors and frozen navigation as the baseline. The attendance matrix retains familiar identity columns and event columns; it must not become the rehearsal's one-row-per-event/person transport table. Use wing → squadron → flight terminology throughout.

## Build and verification boundary

The reusable fixture generator is `scripts/lib/frontend-preview.mjs`. It describes fictional content and Sheets API requests; it must not discover or mutate production resources. Provision only explicitly identified new preview workbooks under the project account. Keep their actual bindings and execution evidence in ignored local/provider configuration, outside Git. Rebuilding a preview must target its approved preview resources explicitly, preserve any native chip templates, and never reuse a production workbook identifier.

`buildFrontendPreview()` returns `{ main, excusals }`. Each descriptor provides the title, explicit sheet definitions, `requests`, `tables`, `postTableRequests` and `dropdownSeeds`. This JSON builder is the initial fixture/template-authoring path, not the production provisioning path for finished native chips. Apply an initial fixture in this order:

1. Provision the new workbook from its sheet definitions, then apply `requests` for fictional values, layout, charts, filters and protections.
2. Create each native Table minimally, read Google's assigned Table IDs, then apply its column and row properties using those IDs.
3. Apply `postTableRequests` **after Table configuration**. These install the legend-backed validation rules. Live preview provisioning showed that configuring Table columns cleared validation inside the Table body while cells beyond the Table kept it; applying validation before this step is insufficient.

Use `dropdownSeeds` to identify the exact template-authoring ranges, approved legend sources, choices and `nativeChipColors` to finish once in the native editor. Chip colors are a separate palette from conditional cell background/text colors. Do not use the descriptor to overwrite an already finished template blindly: rebuilding validation can erase native presentation properties that are absent from JSON. Verify strict rules both inside the populated Table and in its prepared future rows. Publish the finished result as an approved native template before relying on it for repeatable provisioning.

No paid service, API subscription, production migration or staging command intake is needed to render the preview. A fixture formula or chart demonstrates only the calculation shown by the fictional fixture. It is not evidence that the full D1 business rule, authorization or publishing workflow has been implemented. Do not invent attendance credit policies to populate a dashboard; label fixture-only summaries clearly.

The current fixture has sixteen fictional cadets, four flights in two squadrons, six attendance events and eight excusal requests. Main is read-only; only the excusal Decision ranges are editable for demonstration. Overall and LLAB percentages remain blank, with explanatory notes, because this visual fixture does not implement an approved credit policy. Dashboard charts summarize fixture counts, and preview Form actions remain disabled. Birthday/history reporting, complete production formulas, photos and operational edit delivery remain separate parity work.

## Native dropdown acceptance

Strict Data Legend-backed rules and colored cells are necessary but insufficient. The selected value must render as the intended native colored chip, and opening the dropdown must show correctly colored options. Author and approve that appearance once in a native template, then preserve it programmatically. Current JSON validation read-back does not expose per-option chip colors or display style. See the [presentation runbook](D1_PRESENTATION_RUNBOOK.md#native-colored-dropdowns).

Once verified and frozen as a release, these fictional preview ranges can serve as safe native chip templates. Copy validation within the same workbook so the chip presentation is retained without copying cell values. Google documents that [Paste special works within one spreadsheet](https://support.google.com/docs/answer/161768), not between separately opened workbooks. Use the native-copy APIs below for new workbooks rather than cross-workbook paste special. This preview was built from fictional fixtures and native editor configuration, with no production cell/style copying.

## Programmatic native-template lifecycle

Ordinary provisioning, rebuilds and row/event growth must use public Google APIs. They must not depend on an AI browser session, a color picker or a maintainer manually formatting each new sheet. The production design uses a SHAMROCK-owned native template containing only blank or fictional records. Its approved chip choices, colors, legend, headers, native Tables and layout form a versioned presentation artifact.

Freeze each approved template release: do not edit it in place after publication. Record its logical release name, source file reference, Drive `version`, intended owning account, permitted ACL, schema/legend contract and native visual evidence in private configuration and release records. Google files remain technically editable; the version pin and access checks detect drift rather than making an ordinary file immutable. Keep real resource references and account addresses out of Git. A change to a chip's color or native display style requires a newly authored and approved template release, because the public API cannot read or set arbitrary per-option colors from source-code hex values.

The provisioning sequence is:

1. Authenticate as the intended project account and read the source template's current ownership, ACL and pinned Drive version. Validate expected sheets, headers, legend-backed rules and native Table structure. Reject any mismatch before provisioning; never silently substitute a blank template, plain dropdown or typed Table rule with different validation behavior.
2. Clone the approved workbook with [Drive `files.copy`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/copy), preserving native styles that the JSON cell schema cannot express. A whole-workbook copy is preferred when legends and named ranges span tabs. [Sheets `sheets.copyTo`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.sheets/copyTo) is an alternative for an explicitly reviewed single-sheet template; it requires destination reference/legend repair and verification. Copy only the approved empty/fictional template, never a production workbook containing cadet records.
3. Verify the source version did not change during copying. Verify the new destination is distinct from the template and production resources, is owned by the intended account, and has only the approved ACL. Re-read headers, rules, legend references, native Tables and protected ranges. Do not attach operational bindings or publish a destination that fails these checks.
4. Populate only intended record values through the API. Preserve native validation rather than recreating equivalent JSON rules. For new rows or event columns, use same-workbook `copyPaste` with `PASTE_DATA_VALIDATION` from protected template cells. Extend Table ranges and formatting narrowly; do not reconfigure Table columns in a way that clears validated cells.
5. Verify all affected rules and references, including cells inside and beyond the Table body. Retain native screenshots of the selected chips and expanded option menus for template acceptance and a fresh-copy rehearsal. API read-back proves the accessible rule contract, not opaque option-color metadata.

The reusable [native-template helper](../../scripts/lib/native-dropdown-templates.mjs) implements the copy guards through injected authenticated API calls. Supply actual bindings only from ignored local/provider configuration:

```js
import { cloneNativeTemplate } from './scripts/lib/native-dropdown-templates.mjs';

const previewId = await cloneNativeTemplate(io, {
  binding: 'excusal-native-template',
  role: 'excusal-review',
  sourceFileId: privateBindings.excusalTemplateId,
  driveVersion: privateBindings.excusalTemplateVersion,
  ownerEmail: privateBindings.automationEmail,
}, { title: 'SHAMROCK — Excusals preview' });
```

Here `io` implements `readTemplateMetadata(id)`, `copyFile({ sourceFileId, title })` and `readCopiedMetadata(id)` using the public Drive API. Metadata reads must include all permission pages, owners, native MIME type, `trashed`, version and app properties. The approved source must have owner-only access and `shamrockTemplateBinding` / `shamrockTemplateRole` app properties matching the logical entry. The helper verifies the copy and rechecks the source version before returning its ID; callers still verify the copied Sheets structures before publishing it.

For row growth, `validateNativeDropdownManifest` checks the logical release/version and schema/rule contracts; `nativeDropdownRuleFingerprint` normalizes only an optional leading `=` on an absolute quoted legend reference. `planNativeDropdownCopy` then resolves actual machine-header columns from fresh bounded GridData and returns only same-workbook `PASTE_DATA_VALIDATION` requests for the specified destination rows. It rejects wrong legend sources, weak rules, missing or conflicting seed evidence, schema drift, overlap and out-of-bounds extents. Execute its returned requests through Sheets `batchUpdate`, then read back the affected validation rules. Neither helper recreates chip colors from JSON or substitutes a browser operation for provisioning.

Validation-only copying is not necessarily metadata-neutral: the live staging copy into blank future rows automatically expanded a native Table. After each copy, read back its actual extent. If the Table should end at the populated rows, reconcile only `updateTable.range` to that intended extent, then verify both the Table range and every affected validation rule again, including prepared rows beyond the Table. Preserve Table IDs and avoid rewriting `columnProperties`, which can clear validation. Do not infer unchanged Table boundaries merely because the planned request contains no Table update.

Template drift or a failed copy verification stops provisioning with an actionable error. Existing production sheets continue on their current approved release. This design adds no paid service; native-copy requests remain subject to the existing Google quotas. Successful API-only cloning in staging establishes template reproduction for the tested fixture, not production cutover, business-rule parity or unrestricted future palette changes.

Inspect every populated visible tab at ordinary zoom. Check useful widths, long event/reason wrapping, working Table controls, flight filters, Dashboard chart sources, selected and expanded dropdown colors, and the visible tab bar. Confirm no technical rehearsal sheets appear. Verify the Table ranges, literal fictional data, formula results, strict validation and protected areas through bounded API reads. Separate a successful screenshot review from tests of edit delivery, permissions and concurrency.

Record the source commit, created preview resources privately, native UI evidence, API read-back and any remaining visual gaps. Do not label the preview production-ready or claim full feature parity from appearance alone. Production remains on the existing system until the independent migration and release gates pass.

## Implementation checkpoint

The Google-only staging runtime update from [`a6b7956`](https://github.com/afrotc-det225/shamrock/commit/a6b7956423be5b6adff41ae4c4fa92474eb8323d) was deployed after 237 local tests passed: 31 existing-system tests and 206 D1 prototype tests. It preserves equivalent decision validation rules instead of rewriting them, repairs bounded missing/incorrect rules and reads every configured decision cell for verification. It cannot create or verify unexposed native chip colors through the API.

The separate preview has native colored chips authored through the authenticated Google editor. Final visual/API acceptance and a fresh API-only template-copy rehearsal are still pending at this checkpoint. The runtime release and passing tests do not establish that the unwired preview implements D1 workflows, and no production deployment is part of this work.
