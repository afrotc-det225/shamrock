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

No paid service, API subscription, production migration or staging command intake is needed to render the preview. A fixture formula or chart demonstrates only the calculation shown by the fictional fixture. It is not evidence that the full D1 business rule, authorization or publishing workflow has been implemented. Do not invent attendance credit policies to populate a dashboard; label fixture-only summaries clearly.

## Native dropdown acceptance

Strict Data Legend-backed rules and colored cells are necessary but insufficient. The selected value must render as the intended native colored chip, and opening the dropdown must show correctly colored options. Preserve a known-good native template with `PASTE_DATA_VALIDATION` or configure the native editor, then verify the rule through the API and the appearance in Google Sheets. Current JSON validation read-back does not expose per-option chip colors or display style. See the [presentation runbook](D1_PRESENTATION_RUNBOOK.md#native-colored-dropdowns).

Inspect every populated visible tab at ordinary zoom. Check useful widths, long event/reason wrapping, working Table controls, flight filters, Dashboard chart sources, selected and expanded dropdown colors, and the visible tab bar. Confirm no technical rehearsal sheets appear. Verify the Table ranges, literal fictional data, formula results, strict validation and protected areas through bounded API reads. Separate a successful screenshot review from tests of edit delivery, permissions and concurrency.

Record the source commit, created preview resources privately, native UI evidence, API read-back and any remaining visual gaps. Do not label the preview production-ready or claim full feature parity from appearance alone. Production remains on the existing system until the independent migration and release gates pass.
