# Historical source reports

The historical reader exposes the retained matrices from a completed migration-8 import. It does not reconstruct observations, replay decisions, merge source copies, or substitute today's roster or credit policy. The current reporting model continues to handle current operational facts; historical source reports preserve each archived result independently.

Both routes are signed JSON POST operations using the existing bridge HMAC. The supplied principal must currently be active and have a wing `frontend.read` grant. A flight grant does not authorize the entire archive. Authorization, generation and report evidence are read in one D1 batch. Paused staging permits these reads. Imports still marked `loading` are unavailable.

- `/v1/admin/history/list`: `{environment, generation, principalId}`. Lists at most 100 completed matrix copies with stable snapshot IDs, source titles, period labels, row/event counts and unresolved-row counts.
- `/v1/admin/history/read`: the same fields plus `snapshotId`. Returns one `legacy-source-report-v1` report. Unknown fields and a mismatched environment/generation are rejected.

These endpoints disclose the authorized report and retained roster, not raw Form responses, email/phone fields, native photo URIs or provider workbook identifiers. They create no jobs or notifications and require no additional paid service. Report reads remain subject to the account's free D1 read quota.

Each row has a stable source-occurrence key, an optional person ID and an explicit resolved/unresolved status. A missing historical identity is retained, counted and diagnosed. The report uses the saved matrix labels and source roster, including alumni. It does not infer original event eligibility from that roster. Each event column keeps its snapshot event ID and exact code; a current canonical event ID is included only when the import proved it. Repeated labels in different source copies never merge.

The pure domain calculator recognizes the complete saved production formula template for one of three evidenced policies: current credit, older credit with UR in the denominator, or older credit with UR neutral. It never evaluates arbitrary spreadsheet expressions. Historical wildcard treatment, including MU request variants, and zero-denominator result `1` are preserved exactly. Overall and LLAB calculations use the original column range; LLAB additionally applies the saved case-insensitive LLAB header mask. A range extending beyond populated event columns includes only retained populated events, with the remaining captured blank cells contributing no credit.

Each percentage contains the saved value, independently calculated value, policy version, exact source formula/range, covered and excluded event IDs, and comparison status. A manually entered value or unrecognized/modified formula keeps its saved value with `formula-unavailable`; it is never silently reinterpreted. A disagreement is reported as `saved-percentage-mismatch`. Excluded event columns remain in the row with their exact codes and an explicit diagnostic. This preserves saved history while allowing a separately versioned corrected report later.

`legacyHistoryTable(report)` produces a values-only, read-only sheet model with the usual seven fixed Attendance columns followed by events. Stable source row ID, person ID and identity status are hidden metadata columns. The native publisher below writes typed literal values, protects the entire historical view and uses native Tables. It never executes captured source formulas or assigns edit handlers to these rows.

A read is bounded to 500 rows, 128 event columns and 64,000 cells. Stored row payloads are limited to 4 MB, metadata to 256 KB and source roster to 1 MB; the final response is capped at 5 MB. A larger or inconsistent source fails explicitly instead of returning a truncated report. A source copy with an empty roster remains distinguishable from a reconstructed current roster.

Run `npm run build:v3 && node --test tests/v3/legacy-history.test.mjs`, then the repository checks before release. Synthetic tests cover historical policy differences, exact range exclusions, unresolved rows, changed/manual formulas, retained unknown codes, authenticated routing, revoked/insufficient grants, incomplete imports, generation binding and capacity limits. Real-data validation belongs only in ignored restricted local evidence; successful local reproduction does not establish hosted endpoint or Google presentation readiness.

## Bounded native History workbook

`createNativeHistoryRuntime` is exported by the isolated staging bundle. It creates read-only report tabs inside a separately provisioned private workbook and exposes `setup()`, `resume(bindingHash)`, `run()` and `pause()`. It does not create files, install triggers, change the operational Main workbook or send mail. The Main Dashboard can link to this workbook after the reports finish verification; no technical recovery tabs are added to Main.

Supply a new empty spreadsheet with its default `Sheet1` and a separate owner-only JSON checkpoint containing `{"version":1}`. Store the following JSON string under `SHAMROCK_V3_HISTORY_CONFIG` in the existing private configuration file. Use private runtime identifiers, never source-controlled IDs:

```json
{
  "version": 1,
  "environment": "staging",
  "generation": 1,
  "enabled": true,
  "resourceReview": "EXISTING_PRIVATE_HISTORY_REVIEWED_FOR_STAGING",
  "principalId": "reviewed-history-reader",
  "stateFileId": "PRIVATE_STATE_FILE",
  "spreadsheetId": "PRIVATE_HISTORY_WORKBOOK",
  "expectedTitle": "SHAMROCK History",
  "api": {
    "baseUrl": "https://reviewed-staging-worker.example.invalid",
    "keyId": "reviewed-readonly-key",
    "secretProperty": "SHAMROCK_V3_HISTORY_READER_SECRET"
  }
}
```

`api` is optional and defaults to the bound staging host. A separate real-data staging Worker must use its own reviewed origin/key and named private Script Property; credentials never appear in configuration JSON. Its principal needs Wing `frontend.read`. The generation is explicit and must match the staging host. The configuration, checkpoint and workbook must belong to the effective automation account and have exactly one owner permission with no other sharing. Their types/title are checked, and the workbook/checkpoint cannot reuse the frontend, journal, maintenance archive or private configuration binding.

`setup()` verifies the bindings and checkpoint while setting `SHAMROCK_V3_HISTORY_PAUSED=true`. Review its returned configuration digest, then `resume(bindingHash)` enables only that exact configuration. A private bootstrap can pass the reviewed digest programmatically; no browser editor action is required by this runtime. `run()` is safe for an explicit scheduler to call: absent enablement it returns paused, and overlapping invocations return busy under the cooperative script lock. No human editor or historical actor is invented for these read-only publications. `pause()` stops subsequent continuations without deleting the checkpoint.

The staging globals expose `shamrockV3HistorySetup`, `shamrockV3HistoryStart`, `shamrockV3HistoryContinue` and `shamrockV3HistoryPause`. Start requires the active human account to be the automation owner and enables the exact reviewed private binding. Continue advances at most 40 bounded continuations over a maximum 210-second loop; it stops on pause, contention or completion. The ordinary five-minute scheduler advances one continuation and does no history IO while paused. Global staging pause also pauses History. These administrative controls do not add sheets or menus to Main.

For a separate Worker key, the optional `shamrockV3StagingImportCredential` supports one-time programmatic delivery from an owner-only temporary JSON file into a named Script Property. Its root configuration pointer `SHAMROCK_V3_CREDENTIAL_IMPORT` contains only `{version:1,fileId,requestId,sequence}`. The separate delivery contains `{version:1,environment:"staging",generation,requestId,targetProperty,workerOrigin,keyId,secret,expiresAt}`; expiry is Unix seconds within the next hour. Read the key from 1Password directly into process memory when creating that private delivery, never into source, command arguments or a shared configuration file. The target must exactly match either the current host bridge or the configured History reader. Import requires the active automation owner, pauses all staging services, checks both files' ownership/sharing/version, verifies the saved Script Property and moves the temporary delivery to Trash. Its receipt contains no secret, and interrupted cleanup can retry without importing a different key. Remove the nonsecret pointer after completion. This replaces copying environment files during setup; vault custody remains a separate handoff check.

The publisher calls only `/v1/admin/history/list` and `/v1/admin/history/page`. Each continuation processes at most eight retained matrix rows. It first collects source row positions, then writes compact rows in their original source order, then reads every literal row back against the same immutable source digest. It does not fetch the whole-report API or reconstruct historical rosters. The private checkpoint contains bounded metadata, stable row positions and progress; it never stores the full report. Its 128 KB bound fails explicitly before further publication.

Each source copy gets a distinct tab even when period labels repeat. The tab stays hidden until every page, native Table and whole-sheet protection has been verified. The visible **History** index links completed reports and shows retained row and unresolved-identity counts. Only report tabs and the index are visible. Machine headers and source identity columns are hidden within report tabs. Current Attendance sizing is reused: 21-pixel rows, uniform 75-pixel event columns, 10-point body text, small wrapped event headings, frozen name columns and compact hidden AS Year/Flight/Squadron columns. Native Tables provide filtering and banding; familiar codes retain their colors. Read-only source cells have no editable dropdown controls.

Wide native Tables are created with their stable identity and range, then configured by `updateTable` in the same atomic Sheets batch. A real-data staging rehearsal reproduced Google's HTTP 500 when the 78-column Table's column and banding properties were included directly in `addTable`; the create-then-configure batch succeeded with the same headings, colors and layout. This changes the API request shape without introducing manual styling or exposing a partly configured report.

Saved Overall/LLAB values and attendance codes remain literal, including old codes, blank values, manually entered percentages and text beginning with `=`. Numeric percentages use percentage formatting. Unknown codes and unresolved identities remain in the report with highlighted name cells and explanatory notes. Saved percentage notes distinguish verified formulas, unavailable calculations, mismatches and excluded columns. Exact source event labels remain in notes; only duplicate native Table display headings receive a numeric suffix. Source row IDs remain separate even when names match.

Unknown page/write results retain the cursor and retry the same immutable target. A lost final unhide/index response triggers complete literal re-verification before confirming that report. Changed source digest, revoked reader authority, changed sharing, unexpected native Table/protection or a formula discovered during readback stops progress. An external workbook revision change during verification also stops progress; retain the private checkpoint for review instead of discarding it or accepting partial work. Private checkpoint saves compare content and read back the result; Drive metadata drift alone is not an atomic compare-and-swap. The script lock coordinates this host, not arbitrary owner edits in the Google UI.

The seven native mock regressions in `google-history-native.test.mjs` exercise a separate read-only API binding, six independent reports, source-order preservation, literal formula-like text, native Tables/protections, compact layout, interrupted creation/final publication, missing authority, changed sharing/source content and tampered checkpoint/content. A local read-only rehearsal of the six imported real-data reports preserved all **510 rows**, including **6 unresolved source rows**, with exact saved row order and values. The largest eight-row response was **111,765 bytes**. This establishes local import/presentation-plan parity only; the actual Google workbook and account quotas still require hosted staging verification. Page reads, Sheets writes and Drive checkpoint calls use existing free-tier APIs; pace the scheduler and measure total account usage during that rehearsal.
