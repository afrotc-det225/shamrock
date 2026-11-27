# Adopt the original Google files for D1

Cadets keep their existing Attendance, Excusals and Directory Form bookmarks. Operators keep the Main and Excusals Management links, including links to individual tabs. Use the original files as D1 publication targets. Keep the Backend as the original Forms response destination and retain its tabs, the Archive, and the historical tabs in Main. Staging is the reference for the desired presentation. Its file IDs, sharing, checkpoints and trigger IDs belong to staging.

## Prepare privately

Use the same coherent source capture and reviewed operational adoption model as the final D1 import. See [import parity](D1_IMPORT_PARITY.md) and [operational adoption](D1_OPERATIONAL_ADOPTION.md). Build with `npm run build:v3` first. All paths below denote restricted local files. Outputs contain private data, use owner-only permissions and require a new filename.

| Input | Contents |
| --- | --- |
| Original manifest | The reviewed legacy capture manifest, including Main, Management, Backend, archives and the three Forms. |
| Reference bindings | JSON with `books.main`, `books.management`, and `forms.attendance`, `forms.excusals`, `forms.directory`. Each value is a staging file ID. |
| Inventory | Original and reference Google metadata. The collector uses Sheets and Forms GET requests. Supply a short-lived reader access token on stdin through the existing custodian credential helper. Set `GOOGLE_CLOUD_QUOTA_PROJECT` if user credentials require the project quota header. |
| Capture | Complete typed `captureLegacySources` result, including native Form responses. |
| Projection | Verified `plans.directory/leadership/attendance` and `queuePlans.blue/gold`, including native `expectedAfter`, `nextBaseline` and the common D1 `revision`. Use the projection for the D1 snapshot being adopted. |
| Operational | Reviewed dispositions and their source snapshot hash. |
| Events | Array of `{eventId, label}` for the active events in the current term, from the same D1 snapshot. |
| Reporting | `{revision, result}` from `buildCoherentFrontendReporting` for the same Wing snapshot and effective date. |

From the repository root, with the corresponding paths in shell variables, run:

```sh
node scripts/prepare-native-cutover.mjs collect "$manifest" "$reference" "$inventory" < "$private_token_stream"
node scripts/prepare-native-cutover.mjs prepare "$manifest" "$inventory" "$capture" "$projection" "$operational" "$events" "$packet"
node scripts/prepare-native-cutover.mjs rehearse "$packet" "$inventory" "$capture"
node scripts/prepare-native-cutover.mjs dashboard "$packet" "$capture" "$reporting" "$dashboard_packet"
```

The rehearsal replays the Table and Form updates in memory. It checks original positions, question identity, choices, branching destinations encoded by the REST API, verified-email settings, and previously recorded answers. Dashboard preparation generates a separate original-workbook batch. The Sheets API keeps the file and tab identifiers when editing in place. The Forms API exposes the responder URL, linked response spreadsheet and revision on the original Form. [Sheets identifiers](https://developers.google.com/workspace/sheets/api/guides/concepts) · [Forms resource](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms)

### What to review in the packets

- Main’s identity batch adds hidden stable keys to the existing Tables and changes the Attendance machine headers to event keys. Directory rows are matched by school email and name, then Attendance is resolved through the Directory identity and original cohort/flight fields. Leadership matches the reviewed original contact fields to the published D1 contact key. Original row order is retained. Canceled, absent event columns stay absent.
- The first publication batches use those keys to place D1’s values in the original coordinates. They check attendance marks, percentage equivalence, photo file identity and retained Drive resource keys before converting cells. A different decision, reason or requested outcome blocks the plan. Review timestamp conversions, event display labels and canonical email differences in the private packet. Active queue timestamps and alternating backgrounds use the native queue formatter.
- Reviewed retired requests stay in their existing Blue or Gold slots. Their baseline entries keep the original values, mark every field read-only, and carry no decision command. Ordinary refresh preserves them and refuses a changed or reactivated historical slot. Apply native protection to those rows before enabling human input.
- The baseline templates include the original row/column order and matching D1 field versions. Install them only after Google readback and matching the final production authority revision. Bind the actual production generation. Rebuild validation seed references, field protections, role permissions, Forms intake descriptors and private state for the original resources.
- The Dashboard batch rebuilds the two generated reporting tabs in place, preserves the four chart IDs, and uses the original links for every quick action. Verify chart titles, positions, source ranges, size, dates, number formats, native Table appearance, filter views and dropdown chips in Google.
- Each Form batch targets its original `formId` with `requiredRevisionId`. Existing questions keep their original IDs and order. Only reviewed option lists, additive Attendance sections/checkboxes and the verified-email setting may change. Preserve original permissions and the original linked response workbook. Keep the private confirmation workflow separately bound. Test any distributed prefilled links whose selected option text changed.

## Authorized maintenance window

1. Record the original links, native question IDs, page-break continuations, permissions, responder audiences, trigger owners, trigger IDs, script versions and D1 generation. Back up the original files, private edit journals, raw Form responses and D1. Verify that the backup can be read. Keep the legacy rollback code and its bindings available.
2. Close intake, fence human edits and sorts, stop the legacy writer triggers, drain in-flight work, and record the last processed response IDs for each Form. Pause D1 commands and suppress operational mail. Keep historical responses out of new-submission intake. Compare response IDs and timestamps across the boundary so a late submission is reconciled once.
3. Under that fence, run the final capture/import and regenerate both packets. Recapture the same source files and run `verify-frozen "$packet" "$fresh_inventory" "$fresh_capture"` through the same CLI. It checks original metadata, resource digests and Form revisions. A Sheets batch has no equivalent Form revision precondition. Retain the edit fence across Sheets writes. Regenerate a Form plan with the same authenticated account when its revision expires.
4. With both input paths still closed, use the reviewed production publisher to apply the Main identity batch, the Main and Management first-publication batches, and the Dashboard batch to their respective original workbooks. Record a receipt and read back each batch before continuing. Apply each Form batch to its bound original. Compare original native page-break continuations in FormApp, set and verify the new Attendance submit continuations listed in the packet, then verify every event-to-section destination. A successful Forms REST response does not prove section-end navigation.
5. Run `verify-published "$packet" "$new_inventory"`, `verify-tables "$packet" "$new_capture"`, and `verify-responses "$packet" "$new_capture"` through the CLI. The last check accepts additional responses while requiring every earlier response and answer to match. Reconcile any additional response with the maintenance boundary. Run `verify-dashboard "$dashboard_packet" "$new_capture"` for the Dashboard. Check effective file sharing, existing bookmarks, native validation and protections as a non-owner, especially the retired queue rows. Run two ordinary refreshes against the adopted baselines and compare the full matrix and both queues.
6. Before opening to the wing, exercise one controlled submission, one scoped decision and one Directory update through the **original** URLs with operational mail suppressed. Verify exactly one D1 receipt per operation, the intended attendance result and no changes to unrelated records. Restore the approved responder audience and enable only the D1-backed writers. Enable operational mail separately after the test receipts and suppression boundary have been reviewed.

## Interruption or rollback

Stop further publication and keep intake closed. Read the affected original, compare it with the before/after evidence and resume only the missing phase. Google provides per-file batch boundaries. A successful update to Main does not establish success on Management or any Form. Never blindly resend a batch after an ambiguous response.

If reverting, restore the old runtime and original content **into the same files**. Restore the original machine headers, percentage formulas, Dashboard, native continuations, protection policies and prior respondent settings. Keep added Form questions and their answers as evidence if a response has used them. Reconcile any D1-era receipts and native responses created during the window before enabling the legacy writer. Recheck bookmarks and test the old entry points.

## Release boundary

The planner and rehearsal have no Google write transport. The existing isolated Google host enforces staging resource names and ownership, while the original Main and Archive are in a Shared Drive. An explicitly bound production host, its Shared Drive permission checks, fresh private state, a production D1 generation and single-writer trigger handoff are required to execute this procedure. A staging deploy or rerun of fictional Table initialization is unsuitable for a populated original. See [native bootstrap](D1_NATIVE_BOOTSTRAP.md), [protection model](D1_PROTECTION_MODEL.md) and [operator deployment gates](../plans/D1_REDESIGN_AND_MIGRATION.md).
