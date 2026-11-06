# Private source capture and D1 import parity

This tooling rehearses a real-data import without writing to Google, D1, production, or a notification queue. The operator has authorized private production reads and real-data staging comparison. Production remains the supported system; a source snapshot or successful comparison is not a cutover.

Run `scripts/import-parity.mjs` with Node. It uses only Node built-ins and the existing development environment; it adds no service, paid dependency or subscription. A later hosted import must use a separate, explicitly bound staging dataset, suppress notifications, and verify every imported occurrence before enabling any consumer. The tools in this runbook do **not** execute SQL or operational commands.

## Capture the evidence

Keep provider bindings, credentials, source records, crosswalks and output under an ignored private directory such as `.build/d1-real-parity`. Use directory mode `0700` and file mode `0600`. Do not put these files in either public Git history or a shared chat. The CLI verifies that an output inside a Git repository is ignored, refuses a symlink output directory, creates private files exclusively, and will not overwrite an existing run. Use a fresh output directory for each rehearsal.

The capture manifest has `formatVersion: 1` and a `resources` array. Each resource specifies a unique safe `key`, `kind` (`workbook` or `form`), private `providerId`, operational `role`, and, for a workbook, `expectedTitle`. Include current Main, backend, Excusals, retained archive books, and each original Form. Do not assume that archived raw-response tabs are equivalent or deduplicated copies.

Supply a locally reviewed reader module exporting `readOnlyImportPort` with these read methods:

| Method | Returned evidence |
|---|---|
| `file(id)` | Drive version and trashed status |
| `workbook(id)` | Workbook properties, sheet IDs/grid dimensions, Tables, protections, named ranges and other retained metadata |
| `grid(id, range)` | The requested bounded `GridData` block, including typed entered/effective values, formulas, formatted text, number formats, hyperlink/rich text/chip URI evidence, and notes |
| `form(id)` | Native Form metadata, including question IDs and linked workbook |
| `responses(id, pageToken)` | Native responses, response IDs, creation/edit timestamps, respondent evidence, question IDs and answers |

The reader must have no mutations and must throttle provider calls. The CLI does not authenticate a Google account or configure a Cloud project. Use the already authorized SHAMROCK reader, verify its account independently, and keep it outside Git. Do not replace a failed private read with an account that has different authority.

```sh
node scripts/import-parity.mjs capture \
  --manifest .build/d1-real-parity/manifest.json \
  --reader .build/d1-real-parity/reader.mjs \
  --private-dir .build/d1-real-parity/capture-run
```

Capture reads every configured physical grid in bounded chunks, records explicit empty rows, reads a Drive-version vector before/after the complete capture, and re-reads native response content because a Form submission need not change a Drive file version. It retries changed resources up to three passes. A coherent result is an **optimistic consistent-read window**, not a production writer fence, a guarantee that the data will remain unchanged, or proof of every historical response edit. An inconsistent result is retained as evidence but refused by the normalizer. A future cutover still needs its own controlled source fence and final delta reconciliation.

## Normalize without losing occurrences

```sh
node scripts/import-parity.mjs plan \
  --snapshot .build/d1-real-parity/capture-run/snapshot.json \
  --private-dir .build/d1-real-parity/initial-plan
node scripts/import-parity.mjs crosswalk-template \
  --plan .build/d1-real-parity/initial-plan/import-plan.json \
  --private-dir .build/d1-real-parity/crosswalk-review
```

`import-plan.json` contains a deterministic occurrence ledger, normalized candidate records, source-surface counts, collision groups and a hash. Each resource/sheet metadata object, nonempty physical row, and native response has an occurrence ID and a fingerprint. Repeated natural IDs remain separate occurrences. The immutable typed capture holds the full source cells, including fields outside the supported schema; the ledger never substitutes a flattened CSV for that evidence. Physical empty-row counts are also reconciled.

Every occurrence is exactly one of:

- `normalized`: a current authoritative backend candidate with resolved reviewed identifiers and valid supported fields.
- `evidence-only`: a retained header, mirror, source snapshot, raw response, native response or historical artifact that is not being represented as a new domain mutation.
- `quarantined`: a malformed/ambiguous source or an unresolved authoritative relationship. Its raw evidence remains retained and counted.

The crosswalk is bound to the snapshot hash, occurrence ID, raw fingerprint and a nonempty `reviewReference`. Suggestions are deliberately unreviewed. Review explicit source event/request IDs, unique exact email anchors, and explicit current flight/squadron labels; remove or resolve unsupported suggestions. A manual Leadership contact requires an explicit `personId: null`. Never make a person ID from a name or silently associate an old event with a reused display label. Retained email conflicts also need review. Run `plan` again with `--crosswalk PATH` after review. Reordering bindings does not change their meaning; stale, unknown and duplicated bindings fail closed.

Normalization retains raw grouped attendance selections and current excusal state. An excusal decision is not a new observed absence. A selected-cadet list is not a frozen event roster. A blank attendance value remains distinguishable from a correction operation, a denied request, or a missing observation. Numeric phone/CIP spellings use the retained display text with a diagnostic. Date-only values remain dates; timestamp serials use the source workbook timezone and reject ambiguous/nonexistent DST wall times. Photos use real native chip/rich-link/HYPERLINK URI evidence, never a visible filename alone.

`accounting.json` is regenerated from the immutable capture and reviewed crosswalk; a lost occurrence, changed fingerprint, altered disposition or edited plan fails verification. `readyForD1Write` remains `false`: normalization does not authorize a command replay, create principals, reconstruct old access grants or send mail.

## Reconcile effective facts and provenance

```sh
node scripts/import-parity.mjs reconcile \
  --snapshot .build/d1-real-parity/capture-run/snapshot.json \
  --plan .build/d1-real-parity/initial-plan/import-plan.json \
  --private-dir .build/d1-real-parity/source-comparison
```

`reconciliation.json` separates three kinds of evidence:

1. A matrix row can join its **same-workbook companion Directory snapshot** only when last name, first name, AS year, flight and squadron agree uniquely and its retained email anchor is unambiguous. Older terms use their own retained roster, including alumni; current membership is not projected backwards. Current unique Directory identity can remain valid when an older changed-name email association needs review.
2. Current event columns resolve through unique exact aliases of retained Events Backend IDs. Historical columns keep their physical snapshot-column identities and term-label evidence. Repeated historical labels never overwrite each other or silently become a current event. Matrix codes are imported as `legacy-effective-cell-snapshot` evidence, **not** fabricated attendance submissions. Event eligibility remains explicitly unknown where the original frozen roster is unavailable.
3. A backend row can acquire native Form provenance only from an exact respondent, timestamp, event and selected-content match. Native question IDs and response IDs are retained. A unique match proves the retained response association, not every earlier edit or a hidden per-person option ID. Generated excusal, bulk-fill and closeout rows are identified separately; they need not have a native Form response.

The report compares every resolvable current frontend/backend person/event cell, Overall/LLAB values, roster counts and flight/squadron/AS-year totals. Per-source matrices retain their exact stored percentage, formula, array-formula anchor and covered event-column range. A formula that stops before the final event columns is reported explicitly; importing saved history must not silently recalculate it using a wider range.

Historical policy evidence comes from the parent of commit `39117a897e3416e19d4fd729233f396fbf0ae5e7`, particularly `docs/system/DATA_LEGEND_RANGES.md` and `src/services/attendance.ts` / `src/services/excusals.ts`. ER means Excusal Requested; ED means Excusal Denied; UR means Unexcused – Report Submitted; MU means Make-Up; MRS means Medical / No PT. The old pending logic appends `R` to the requested type, explaining MUR. These codes are not automatically mapped to current codes.

The retained formulas demonstrate three distinct calculation policies:

| Policy | Credit | Denominator |
|---|---|---|
| Current | P, T, E, ES, MED | P, T, A, U, E, ES, MED |
| Earlier, UR counted | P*, E, ES*, MU*, MRS* | P*, E, ES*, T*, U, UR, MU*, MRS* |
| Earlier, UR neutral | P*, E, ES*, MU*, MRS* | P*, E, ES*, T*, U, MU*, MRS* |

`*` is the historical Sheets COUNTIF prefix wildcard, including its historical treatment of pending MU variants. All three use a zero-denominator result of `1`. Formula recognition requires the exact retained pattern sets; unrecognized formulas remain unavailable rather than being guessed from a term date. Existing historical presentation can be preserved alongside a clearly versioned corrected report later. This tool does not prescribe retaining a design defect in the new operational system.

## Verify a staged import

A future staging importer must return every occurrence ID, fingerprint and disposition in a private `formatVersion: 1` readback bound to the snapshot hash. It must preserve the evidence-only and quarantine ledger, not just successfully normalized records.

```sh
node scripts/import-parity.mjs compare \
  --plan .build/d1-real-parity/reviewed-plan/import-plan.json \
  --readback .build/d1-real-parity/staging-readback.json \
  --attendance .build/d1-real-parity/staging-attendance.json \
  --private-dir .build/d1-real-parity/staging-comparison
```

The optional attendance target contains `formatVersion: 1`, policy version `legacy-shamrock-credit-v1`, and rows keyed by explicit `personId` / `termId`, with stable event IDs and numeric Overall/LLAB results. Missing, duplicate, unexpected or changed occurrences fail accounting. Unresolved matrix bindings prevent a parity claim. Matching source row counts alone is insufficient. No hosted import or production parity is established by the local synthetic suite.

Run `node --test tests/v3/import-*.test.mjs` and `npm run build` after changing this tooling. Synthetic regressions cover source drift, native response paging/duplicates, typed/photo evidence, collisions, stale crosswalks, name-only rejection, historical roster separation, exact native-response links, historical code policies, array-formula propagation, lossless accounting and private CLI output.

## Authoritative imported baseline

Migration `0008_legacy_import_evidence.sql` adds the occurrence/provenance ledger and `legacy_attendance_baselines` without rewriting an earlier migration. Baselines reference normal `people` and `events`, but remain separate from `attendance_observations`, corrections and decisions. The Worker exposes only baselines belonging to a **completed** import in `FrontendSnapshot.legacyBaselines`. An imported pair begins at operation version zero; accepted genuine operations advance its version through the existing shared audit stream.

Reporting uses an imported effective code only until a genuine observation or correction supplies newer evidence. Imported P/T retain presence semantics against a pending or denied request. A later explicit null correction clears the baseline; it does not resurrect the old code. `observedCode` remains null until an actual observation exists. The reporting cell identifies its source as `legacy-baseline` and retains the baseline ID for provenance.

The initial adoption is restricted to a new, empty, paused staging database with suppressed notifications. The current roster can be frozen from exact matching current matrix/Directory evidence and explicit event configuration; this is an **import-time roster**, not a claim about who was eligible on an earlier event date. Each event adoption records a real `legacy.event-import` administration action for its versioned roster. Old attendance submissions, decisions and email effects are not replayed. Historical source matrices and their exact formulas remain separate retained snapshots, including unresolved identities.

The source planner uses bounded prepared parameters and resumable atomic batches. Its chosen bounds stay below the documented 2 MB string/row, 100 KB SQL text and 100-bound-parameter limits; verify hosted size, write-budget headroom and execution time before applying a real dataset. D1 Free currently permits 500 MB per database. These are provider limits, not a capacity guarantee. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
