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
3. A backend row can acquire native Form provenance only from an exact respondent, timestamp, event and selected-content match. Native question IDs and response IDs are retained. A unique match proves the retained response association, not every earlier edit or a hidden per-person option ID. The captured email-collection mode is recorded; a historical responder email is **not** verified human identity, and creates no principal or access grant. Generated excusal, bulk-fill and closeout rows are identified separately; they need not have a native Form response.

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

## Prepare and resume a guarded staging adoption

`prepare-staging` produces a reviewable SQL plan; it does not connect to D1 or apply it. The owning source must be tracked and unchanged from its recorded commit. Keep every generated file in the ignored private directory. Supply a reviewed JSON object containing `formatVersion: 1`, the exact snapshot/initial-plan/reconciliation hashes, a `reviewReference`, and explicit true values for `adoptCurrentProfiles`, `adoptCurrentEvents`, `adoptCurrentEffectiveCells`, `freezeCurrentRoster` and `preserveHistoricalQuarantine`.

```sh
node scripts/import-parity.mjs prepare-staging \
  --snapshot .build/d1-real-parity/capture-run/snapshot.json \
  --plan .build/d1-real-parity/initial-plan/import-plan.json \
  --reconciliation .build/d1-real-parity/source-comparison/reconciliation.json \
  --review .build/d1-real-parity/adoption-review.json \
  --generation 1 \
  --private-dir .build/d1-real-parity/reviewed-staging-plan
```

The resulting `model.json` and `execution.json` contain private data. `summary.json` contains counts and write estimates. This bounded adoption creates current Directory profiles, current event catalog/rosters and effective attendance baselines, with all source occurrences, historical matrices and resolved native response associations retained separately. It does not yet adopt Leadership contacts or excusal requests into their operational tables. Their original records remain in the evidence ledger; complete those mappings before claiming their workflow parity.

An explicit provider runner must call `assertStagingImportTarget` with the exact reviewed execution hash, account, database, name and generation. The database must be newly created for this rehearsal, have migration 8, remain paused and suppress all notification delivery. `sourceCommit` must identify the committed planner; plans created without it are local rehearsals only. Keep the Worker bound elsewhere until import readback succeeds. No command, notification, outbox or refresh effect is generated by this plan.

Execution order is initialization, the ordered groups from `packStagingImportBatches`, full `verifyStagingImportReadback`, then completion. Each group is an atomic provider batch with at most 48 statements and 1.8 MB of serialized arguments. This is a conservative transport choice, not a statement of D1's query-count limit. Every insertion step has a paused-state assertion and a durable payload-hash receipt in the same transaction. Full readback compares every stored value, including raw typed evidence, against the frozen plan; copied fingerprints and matching counts alone cannot authorize completion. Run the real Worker snapshot/reporting comparison after completion as a separate parity check.

Before any write, obtain current **account-wide** D1 `rowsWritten` for the UTC day, including other databases, schema setup and rehearsals. `estimateStagingImportWrites` counts each inserted row and every schema-8 index, plus assertion/receipt/init/completion overhead. It reports a bound for each transport batch. Verify the index counts against the actual migrated schema, and reconcile the estimate with returned provider `meta.rows_written`; database size and SQLite `changes()` are not substitutes for D1 billing metrics. `assessStagingImportQuota` requires an account-bound sample no older than five minutes, includes locally recorded writes since that sample, and preserves at least 10,000 writes of headroom under the free 100,000/day limit. Concurrent account activity can still consume that reserve, so refresh the sample during execution. [Cloudflare D1 pricing and usage accounting](https://developers.cloudflare.com/d1/platform/pricing/).

If headroom is insufficient or a response is ambiguous, stop between atomic groups and leave the import `loading`, intake paused and notifications suppressed. Preserve the same private execution file and hash. After quota resets at 00:00 UTC, obtain a fresh account sample and use `inspectStagingImportResume` to verify the durable run binding and contiguous receipt prefix. Do not rerun initialization, generate a new timestamp/plan, or delete the partial evidence. Only the still-missing ordered groups may run; an already committed group can also be retried idempotently after verifying its receipt, with retry overhead budgeted. A mismatched receipt or run binding requires investigation. A completed run is read-only: never replay its completion or import steps. There is no paid-tier fallback.

Completed imported matrices are available through the authenticated historical reporting reader; see [Historical report reads](D1_HISTORY_REPORTS.md). Current operational baselines and historical source copies remain separate.

Current Leadership contacts and actionable Excusals use the separate [operational adoption](D1_OPERATIONAL_ADOPTION.md) after the initial import is complete. Its reviewed subject crosswalk and retired/quarantine accounting do not alter the original source ledger.
