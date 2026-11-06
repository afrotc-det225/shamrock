# D1 keyed frontend publication

Status: local pure planner and fictional provider-shape tests. `apps/google-adapter/src/frontend-publication.ts` makes no Google or D1 calls and does not authorize production cutover. Live ownership, edit fencing, authenticated snapshot retrieval, signed command receipts and publication recovery belong to the host runtime.

## Inputs and normal refresh

`snapshotToFrontendReportingInput(snapshot, asOfDate)` converts a coherent D1 frontend snapshot into the [reporting input](D1_REPORTING_RULES.md). It preserves exact event eligibility and term roster snapshots when supplied; absent event eligibility remains unknown. It does not infer historical eligibility from current flight membership. Flights require explicit squadron mappings.

`buildFrontendPublicationModel({snapshot, reporting: {revision, result}, attendanceVersions})` creates Directory, Leadership and Attendance table descriptors. Reporting and profile revisions must match. The model preserves the normal 20 Directory fields, nine Leadership fields and seven fixed Attendance columns plus events. It adds one hidden `person_id` column to Directory and Attendance and one hidden `contact_id` column to Leadership. Those identities stay inside the native Table so a complete Table sort moves them with the visible row.

Attendance inputs carry both the actual pair base version and the event catalog version. The base version changes for attendance, correction and excusal-state commands affecting that pair; it is not inferred from the displayed code. The D1 snapshot contract defines a missing pair as authoritative version zero. The model requires that sparse contract to be expanded explicitly for each matrix cell. Directory/Leadership cells carry their record versions. Birthdays and other date-only data do not use host-local date parsing; Directory DOB is encoded as a Sheets date serial while Class/CIP/phone values remain strings. Google file links use real file-chip CellData; other supported photo links remain literal source links.

Directory is authoritative for linked cadet contact details. **Update cadet contact details in Directory.** Linked name, rank, role, email and phone fields are read-only in Leadership; its Reports To and office fields remain editable. Manual contacts retain all nine business-field edits. Row-specific restrictions follow the hidden stable key after sorting. Squadron is derived from the selected Flight and is read-only in Directory; changing Flight updates Squadron automatically.

Leadership has separate `publicationVersion`, `contactVersion` and `profileVersion` values. Baselines use the publication version to detect display changes, while frozen `commandBindings` identify the actual operation, entity, field and command version. A linked office edit uses `leadership.upsert` and `contactVersion`, never the Directory version or the combined publication token. An unrelated Directory update can refresh linked names without falsely conflicting with an unchanged office field. Restrictions are unioned with the prior verified baseline so a refresh cannot silently weaken a row's protections.

Normal `planFrontendPublication` requires:

- An explicit current native Table binding, bounded CellData, headers, labels and Table extent.
- The private last-verified keyed baseline and its per-cell versions.
- Frozen pending drafts, protected native validation seed metadata and a host-verified edit/sort fence.
- The same deployment generation and a nondecreasing coherent snapshot revision.

Existing row positions and column order are preserved. New rows reuse clean blank slots or append. New event columns append after existing columns, so the hidden identity may be inside the Table rather than at its right edge. Retiring a clean row clears its values and file chips inside the verified Table extent; a row containing an unsent edit remains and requires review. The planner does not delete sheets, sort, guess identity from names, or silently remove old columns. Table compaction and schema removal are separate reviewed maintenance operations.

## Edits, conflicts and receipts

An editable cell differing from the last verified baseline is an unsent edit even if its edit trigger has not run. Publication preserves the cell, freezes its baseline version and returns an `unsent-edit` diagnostic. A queued draft is also preserved when its visible value happens to equal the server's value. If the server attendance/record version or event catalog version changed, the result is a visible `version-conflict`. A second local change after a draft was frozen is retained separately as `draft-cell-changed`; the original draft is not rewritten.

Reporting holds preserve the existing affected event cell and percentage cells. New unresolved cells cannot be initialized with fabricated authoritative values. Changed protected identities, unexpected formulas, untracked rows, duplicate keys, missing baseline rows, or changed automation-only values fail before requests are returned.

`applyFrontendReceipt` advances one private baseline field and removes only its exact frozen draft after the host authenticates a committed receipt with the matching target, value, base version and event version. The committed version must advance. Merely observing equality between server and sheet values is not an acknowledgement. If a user has edited again, the next comparison against the acknowledged baseline preserves that newer local edit.

## Native presentation and literal writes

Changed adjacent cells are coalesced into rectangles without spanning dirty gaps. Normal writes use only `userEnteredValue`; file-chip changes use only `userEnteredValue,chipRuns`. Strings beginning `=`, `+` or an apostrophe are encoded as literal `stringValue`, never interpreted as formulas. File chips compare by their actual URI, so Sheets normalizing `@` into a visible filename does not trigger destructive rewrites.

Existing formatting, notes, native validation and file chips are not cleared during normal refresh. Row/event growth copies `PASTE_DATA_VALIDATION` from protected hidden seeds, including Plain and Arrow cells whose option colors are also opaque. A public validation rule is checked against the expected bounded legend reference; its native style version comes from a separately reviewed seed registry. Public metadata cannot prove native option colors or Chip-versus-Arrow appearance.

New Attendance rows and event columns receive the shared compact layout: 23-pixel body rows, 9-point body text and 75–95-pixel event columns sized for their labels. Only new rows/columns are formatted; adding an event may increase the display-header height to fit its label. Existing user widths, hidden columns, colors, values and validations remain unchanged by the growth layout.

Native Table updates change only `range`, never `columnProperties`. After validation copying, the planner reasserts the intended Table range because Google may expand it. Identity columns and the machine-header row are hidden. The host must additionally verify native Table column names/types, filter views, formatting, protections and visual presentation; the value read-back helper does not claim those checks.

Every copied validation interval is listed in `validationExpectations`. `verifyFrontendValidationReadback` requires an exact bounded read of every destination cell, checking the strict range rule, dropdown affordance and normalized absolute legend reference. Missing rules cannot be treated as a successful refresh. Existing untouched validations are preserved by the write masks. Native appearance still requires the separately reviewed seed and visual evidence.

## Fencing, durability and bounds

Sheets has no conditional cell-value write tied to a previously read value. ScriptLock does not prevent human edits or sorts. Before planning, the host must fence human edits/sorts, verify ownership and protections, and keep the fence through publication and read-back. `assertFrontendPublicationPreconditions` compares a fresh read against the exact private planning read immediately before mutation. If it differs, discard and rebuild the plan. The read fingerprint contains private data; it is not an authorization token and must never be logged or published.

The planner supports at most 500 body rows, 128 event columns and 160 total columns. It emits at most 1,000 requests and 8 MB of request content, grouped into batches of at most 100 requests and under 900 KB. Grid growth uses absolute dimensions, and every request is deterministic and replayable while the same verified fence and frozen plan remain valid. There are no append-row/dimension operations that would duplicate content on retry.

Multiple batches are not one atomic Google transaction. A host may combine the plan into one request within its own smaller budget, or it must persist a durable frozen plan and recovery state before the first batch. Partial or ambiguous publication must keep editing fenced and prevent the new baseline/cursor from being treated as verified. A restart must inspect the actual state and the retained claim, not blindly begin a different plan. `verifyFrontendPublicationReadback` checks literal values, stable identities, chip URIs, Table extents and hidden identity/header metadata; only a successful read-back permits baseline persistence. An incomplete result with drafts/holds remains explicitly incomplete.

Baselines and frozen plans can exceed Script Properties' practical size. Store them in bounded private runtime storage, with explicit retention and recovery. The planner's 500-by-128 test demonstrates bounded request planning, not hosted CPU, Google quota headroom, runtime storage capacity or full end-to-end capacity. The host must reject oversized state before any cloud write.

## Initialization boundary

`planFrontendInitialization` accepts an empty native Table by default. A populated Table requires an explicit reviewed fictional reset binding naming the local/staging environment, generation, exact sheet/Table identifiers and exact fresh read. It clears only values and file chips in that bounded target rectangle, rewrites the approved schema and stable IDs, and applies normal keyed publication. It does not interpret old names as identity evidence. A fictional-reset flag is host configuration, never an untrusted spreadsheet cell or a user-submitted command.

There is no production adoption shortcut. Migrating a populated operational Table requires a separate reviewed stable-ID mapping and preserved source evidence.

## Dashboard and Blue/Gold supplemental plans

`frontend-supplemental.ts` supplies pure plans, with no provider access or deployment. Dashboard refresh reuses the existing native Dashboard planner's anchors and chart styling. It keeps the compact six-card/four-chart layout, chart IDs and positions, publishes real report-derived chart sources to the hidden Dashboard Data sheet, and adds the birthday calendar below the existing layout. It does not recreate Tables or validations. Empty birthdays display “No birthdays recorded.” Empty group averages remain blank, and no-counted-attendance/review notes explain the numerical reporting state. Birthday dates display month/day in the compact calendar; no date of birth is fabricated.

The Dashboard plan requires the approved existing canvas, explicit chart identities, a coherent reporting revision and a verified edit fence. Its private read fingerprint and `expectedAfter` data support read-back/recovery. Chart IDs/specifications, merges, visible values, hidden source state and source values are checked. Live rendering remains a separate check; the pure tests are not provider visual evidence.

Blue and Gold use the existing ten columns and a hidden stable request ID inside each native Table. The recorded request flight determines the squadron queue. Current-term requests include their original reason, requested outcome, person details and submission timestamp converted in the explicitly configured detachment time zone. Pending Decision cells are blank; recorded terminal decisions remain explicit. Only Decision is editable, with an `excusal.decide` binding and the request's version. Queues reject ambiguous/missing targets and more than 500 requests per squadron rather than silently dropping rows.

The native Apps Script host supplies a `timestampSerial` conversion using `Utilities.formatDate`; it does not require the browser/Node `Intl` implementation. The pure planner validates the canonical timestamp and rejects a non-finite conversion result.

`planExcusalPublication` uses the same keyed baseline, unsent-edit detection, frozen decision drafts, request-version conflict checks, native validation seeds and targeted validation read-back as the Main tables. Existing sorts, opaque native arrow styling and unsent decisions are preserved. Empty/unsupported frozen decision commands are rejected; withdrawing a request is an explicit Withdrawn decision, not a cell clear.

Dashboard and Main can share one workbook transaction; Blue/Gold require their own workbook transaction and recovery checkpoint. There is no atomic transaction spanning the two spreadsheets. A full host integration must retain the original coherent snapshot and both edit fences through all required writes and read-backs, or explicitly report partial publication and hold the affected workflow closed. These pure plans do not add automatic multi-workbook acknowledgement or new edit-command submission by themselves.

## Checks

```sh
npm run build
npm run build:v3
node --test tests/v3/frontend-publication.test.mjs tests/v3/frontend-supplemental.test.mjs
```

Tests cover sorted identities, literal strings, dirty cells before trigger capture, version conflicts, frozen drafts and acknowledgement, file-chip normalization, retirement, growth/seeds, event versions, reporting holds, fencing/preconditions, reset guards, read-back failure and a 500-by-128 coalesced update. The provider-shape simulator deliberately does not claim live Google validation behavior or concurrent user interaction evidence.
