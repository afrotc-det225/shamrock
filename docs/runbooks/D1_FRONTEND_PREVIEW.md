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

The reusable fixture generator is `scripts/lib/frontend-preview.mjs`. It describes fictional content and Sheets API requests; it must not discover or mutate production resources. Provision only explicitly identified new preview workbooks under the project account. Keep their actual bindings and execution evidence in ignored local/provider configuration, outside Git. Rebuilding a preview must target its approved preview resources explicitly, preserve the native dropdown seed cells, and never reuse a production workbook identifier.

`buildFrontendPreview()` returns `{ main, excusals }`. Each descriptor provides the title, explicit sheet definitions, `requests`, `tables`, `postTableRequests`, `cellPresentation`, `dropdownSeeds` and `photoChipTargets`. This JSON builder creates the initial fictional fixture; it must not be rerun over existing native dropdown styling. Apply an initial fixture in this order:

1. Provision the new workbook from its sheet definitions, then apply `requests` for fictional values, layout, charts, filters and protections.
2. Create each native Table minimally, read Google's assigned Table IDs, then apply its column and row properties using those IDs.
3. Apply `postTableRequests` **after Table configuration**. These install the legend-backed validation rules. Live preview provisioning showed that configuring Table columns cleared validation inside the Table body while cells beyond the Table kept it; applying validation before this step is insufficient.

Use `cellPresentation` and the field contract below to select each control; the descriptors identify ranges, legend sources and choices. `preserveNativeValidation` identifies existing native rules that must be copied from a seed rather than recreated. This applies to Year, Flight, Squadron, Attendance and Decision even though they use different display styles: native option-color metadata can remain opaque for chip, arrow and plain controls. `dropdownSeeds` identifies the Year chip, while `photoChipTargets` requires an actual private fictional asset binding. Fresh JSON rules are bootstrap fallbacks, not proof that a native rule was reproduced. Verify rules both inside and beyond the populated Table.

No paid service, API subscription, production migration or staging command intake is needed to render the preview. A fixture formula or chart demonstrates only the calculation shown by the fictional fixture. It is not evidence that the full D1 business rule, authorization or publishing workflow has been implemented. Do not invent attendance credit policies to populate a dashboard; label fixture-only summaries clearly.

The current fixture has sixteen fictional cadets, four flights in two squadrons, six attendance events and eight excusal requests. Main is read-only; only the excusal Decision ranges are editable for demonstration. Overall and LLAB percentages remain blank, with explanatory notes, because this visual fixture does not implement an approved credit policy. Dashboard charts summarize fixture counts, and preview Form actions remain disabled. Sixteen native photo-file chips use the same private fictional portrait asset; this demonstrates file-chip structure, not per-cadet photo synchronization. Year, Flight and Squadron choices are representative canonical subsets of four, four and two options respectively. Seven additional Directory validation fields use their complete canonical source lists. Birthday/history reporting, complete production formulas, full option coverage, real photo synchronization and operational edit delivery remain separate parity work.

## Field presentation contract

Read-only inspection of the current production sheets established the following baseline. Different fields intentionally use different controls; converting every validated cell to a colored chip is not parity.

| Surface | Field | Required presentation |
|---|---|---|
| Directory | AS Year | Native colored dropdown chip |
| Directory | Flight, Squadron, Dorm, AFSC, Flight Path | Arrow dropdown with meaningful cell colors |
| Directory | Rank, University, CIP Broad Area, Home State | Plain validated cell without a visible dropdown arrow |
| Directory | Photo Link | Native file chip pointing to the actual photo file |
| Attendance | Event attendance code | Plain validated cell without a visible dropdown arrow; preserve native option colors, ordinary row banding and dark bold code text |
| Leadership | Rank | Plain validated cell without a visible dropdown arrow |
| Excusals — Blue and Gold | Decision | Arrow dropdown with decision cell colors |

Keep strict Data Legend-backed choices for validated fields, independent of their presentation. A field that uses a plain validated cell must not gain an arrow or chip merely because a generic dropdown builder defaults to one. A file chip is a different structure from a dropdown chip; preserve and verify its real file URI rather than substituting display text or a fabricated link. Missing fictional photo examples should be reported as a preview gap, not treated as proof of photo parity.

Seed copying preserves opaque native properties where needed, including option colors in plain/arrow controls; it is not limited to chip-style cells. Current validation JSON does not expose those option colors. Rules with no required opaque styling and ordinary cell formatting can be created directly from their legend and formatting definitions. Attendance should not gain invented conditional background rules to imitate native option colors. Removing the preview's old conditional rules did not remove its retained native palette; white/banded legend or cell-format metadata cannot reconstruct that opaque styling. Check the actual selected-cell appearance and relevant expanded control against this table. See the [presentation runbook](D1_PRESENTATION_RUNBOOK.md#field-specific-native-controls).

## Programmatic dropdown maintenance

Use the existing [frontend-formatting implementation](../../src/services/frontend-formatting.ts): `applyDirectoryValidations` and `applyAttendanceValidations` copy known-good native validation from an archived sheet with `PASTE_DATA_VALIDATION`. Where a field needs opaque native styling, the new presentation keeps its known-good seed cells in the existing hidden Data Legend instead. This adds no visible tab, external template catalog, Drive-version manifest or mandatory workbook-cloning step.

Routine validation, value publication and formatting are programmatic. For any control whose native properties need preservation, configure and visually check its seed once; subsequent refresh, repair and row/event growth are API-only:

1. Read the intended workbook's machine headers and the protected seed's actual validation rule. Confirm the seed uses the expected legend range and strict choices. Missing, mismatched or ambiguous seed evidence stops the operation; do not silently substitute a plain dropdown or a typed Table rule with different choices.
2. Copy validation from the seed to the required destination rows or event column with same-workbook `copyPaste` / `PASTE_DATA_VALIDATION`. Preserve operational values and existing valid rules; the copy does not require a browser or color picker.
3. Publish intended values and adjust existing Table ranges narrowly. Read back affected rules, Table extents and protected ranges. Ordinary updates must not rewrite Table column properties or reconstruct equivalent JSON validation, either of which can disturb native styling.

The [dropdown helper](../../scripts/lib/native-dropdown-templates.mjs) takes fresh bounded Sheets metadata and explicit seed/target descriptions:

```js
import { planNativeDropdownCopy } from './scripts/lib/native-dropdown-templates.mjs';

const { requests } = planNativeDropdownCopy({
  spreadsheet: freshMetadata,
  source: yearChipSeed,
  target: yearRows,
});
// Apply requests through Sheets batchUpdate, then read back the affected rules.
```

`yearChipSeed` supplies `sheetId`, `headers`, `field`, `headerRowIndex`, `seedRowIndex` and the expected `rule`. `yearRows` supplies its own `sheetId`, `headers`, `field`, `headerRowIndex`, `startRowIndex` and `endRowIndex`. Rows are zero-based and the end is exclusive. Actual resource bindings remain in ignored/provider configuration. The caller verifies seed protection separately. The helper resolves the fields from machine headers, checks the seed rule and bounds, and emits only validation-copy requests. `nativeDropdownRuleFingerprint` compares the exposed rule contract; it cannot inspect the opaque option colors.

Validation-only copying is not necessarily metadata-neutral: a live copy into blank future rows automatically expanded a native Table. After each copy, read back its actual extent. If the Table should end at the populated rows, reconcile only `updateTable.range` to that intended extent, then verify every affected validation rule again, including prepared rows beyond the Table. Preserve Table IDs and avoid rewriting `columnProperties`, which can clear validation.

A brand-new workbook can optionally bootstrap from a known-good empty/fictional native workbook using [Drive `files.copy`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/copy), or a sheet using [Sheets `sheets.copyTo`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.sheets/copyTo). Check destination legend references, permissions and Tables afterward. This is a one-time bootstrap option, not a dependency of routine maintenance. Google [Paste special is limited to the same spreadsheet](https://support.google.com/docs/answer/161768), so it is not a cross-workbook transfer mechanism. No production cadet records or production cell styles were copied to create this preview.

The public API still cannot read or assign arbitrary new native per-option colors, including colors retained in plain/arrow rules. A new palette needs a one-time native seed update and visual check; routine propagation then uses the same API copy path. Ordinary cell formatting and exposed validation properties remain programmable. Keep seed cells protected so ordinary editors cannot alter the source. Do not claim that API read-back verifies chip colors: inspect selected chips and expanded menus after seed setup and a representative growth/repair rehearsal. This work adds no paid service and does not change production.

Inspect every populated visible tab at ordinary zoom. Check useful widths, long event/reason wrapping, working Table controls, flight filters, Dashboard chart sources, field-specific chip/arrow/plain/file-chip appearance, and the visible tab bar. Confirm no technical rehearsal sheets appear. Verify the Table ranges, literal fictional data, formula results, strict validation and protected areas through bounded API reads. Separate a successful screenshot review from tests of edit delivery, permissions and concurrency.

Record the source commit, created preview resources privately, native UI evidence, API read-back and any remaining visual gaps. Do not label the preview production-ready or claim full feature parity from appearance alone. Production remains on the existing system until the independent migration and release gates pass.

## Implementation checkpoint

The Google-only staging runtime update from [`a6b7956`](https://github.com/afrotc-det225/shamrock/commit/a6b7956423be5b6adff41ae4c4fa92474eb8323d) was deployed after 237 local tests passed: 31 existing-system tests and 206 D1 prototype tests. It preserves equivalent decision validation rules instead of rewriting them, repairs bounded missing/incorrect rules and reads every configured decision cell for verification. It cannot create or verify unexposed native chip colors through the API.

The final local `npm run check` passed 244 tests: 31 existing-system tests and 213 prototype tests. The field-refined preview API check verified 570 of 570 validation cells, sixteen native file chips referencing the private fictional portrait, five native Tables, nine strict protected areas, four nonempty charts and exactly four Main plus two Excusals visible tabs. No unexpected cell values changed; the intended exceptions were the canonical CIP label and photo-file-chip values.

Five protected seed cells in the existing hidden legends were recaptured with the chosen Year, Flight, Squadron, Attendance and Decision presentation and propagated by API to 330 cells. An earlier growth rehearsal copied validation into ten new attendance rows, ten new decision rows and sixteen new event cells, with colored menus visually checked; that rehearsal preceded the final field-style refinement, and all temporary rows/columns were removed. It does not by itself prove the final field-specific presentation under every future growth case.

Native inspection reviewed all six visible tabs and confirmed the Year chip with expanded choices, Flight/Squadron arrows, plain Attendance and Leadership fields, Blue and Gold Decision arrows, and photo-file chips. Saved screenshots record the chosen control types and native-style preservation, not exact production-palette parity. The existing Google integration read-back remained ready across 500 configured decision rows with values unchanged. D1 remained fenced with all thirteen jobs done, and all 27 production source files were unchanged.

This is a bounded fictional preview and programmatic preservation demonstration. Selected palettes are representative, not a claim of pixel-perfect production color parity; full palette, choice and operational feature parity remain open. The preview is unwired, and no production deployment occurred.
