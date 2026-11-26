# Panel query and loading checkpoint

Checkpoint: 2026-11-17. Work remains local; no deployment or production cutover is part of this checkpoint.

## Implemented locally

- Manifest requests can select the sections whose counts are needed. An empty selection obtains access and revision information without counting operational records. Omitting the selector preserves the complete transport used by native Google publication.
- Partial manifests are explicitly marked and cannot be assembled into complete native snapshots. Data pages, verification requests and native effect requests reject manifest selectors.
- The hosted panel accepts `events`, `access` and `full` state profiles. Profile-aware state requests begin with a cheap access manifest. Events requests count and fetch terms and events; editors still obtain a complete snapshot. History and Assistant can start with access information alone for administrators.
- Browser captures remain bound to the signed-in principal, environment, generation, data/access revisions and View as context. Fresh authority checks remain required. View as retains its existing read-only transport; it does not use the selected Events shortcut.
- An offline read-budget rehearsal accepts an explicit private SQLite export, budget configuration and new private output directory. It makes no provider requests and must not be treated as hosted capacity acceptance.

## Validation and observed costs

Both TypeScript builds, the hosted Worker build, 72 focused worker tests, all 62 administrator tests and the offline budget helper test passed. Tests cover selected/full parity, invalid selectors, empty selections, revocation races, full/scoped View as and rejection of partial native snapshots. Whitespace and changed-file privacy scans passed. The complete repository suite and complete browser regression pass remain release gates.

Local Miniflare measurements against the retained real-data export:

| Manifest | Previous rows read | Selected rows read |
| --- | ---: | ---: |
| Panel access | 27,734 | 66 |
| Events metadata | 27,398 | 208 |
| Flights and squadrons metadata | 27,398 | 26 |

These numbers measure manifests, not entire browser loads. They are emulator results, not a free-tier production capacity guarantee. Private measurement artifacts remain in ignored `.build/read-cost-review/`.

The reusable offline rehearsal also passed against all 94 tables and 25,575 rows in the retained export, with schema, indexes and foreign keys preserved. Initial state read 66 rows; the complete Events transfer read 1,491 rows through 15 backend requests; an unchanged-state check read 66 rows. Repeating the Events transfer read the same 1,491 rows: server caching has not been added. Every measured operation wrote zero rows. Evidence is retained privately in `.build/panel-read-rehearsal-20261117/result-current/`.

## Continue from here

1. Finish hosted/client regression validation, including scoped accounts, full View as, switching profiles, editor fallback, retained drafts and identity changes. Review the complete working-tree diff before committing.
2. Extend the passing offline read-budget rehearsal to additional page profiles and eventual cache-hit/invalidation cases; measure complete cold and repeated page loads, not just manifests.
3. Implement and test the private server response cache. This is **not implemented** at this checkpoint. Keep D1 authoritative, authorize before cache lookup, bind keys to principal/scope/generation/revisions, and test writes, revocation, View as and reporting-time boundaries. No stale cached permission may authorize a read or write.
4. Evaluate page-specific Cadets, Leadership and Attendance loaders separately. They retain the complete loader at this checkpoint.
5. Run the full repository checks, privacy scan and browser tests; commit and push the coherent change before any staging deployment.
6. Once the hosted D1 daily allowance is available, deploy only to isolated staging and run a bounded real-data rehearsal. Recheck free-tier usage and permission behavior. Keep the native spreadsheet publisher and production untouched.

The account's exhausted D1 allowance prevented hosted real-data acceptance during this work period. Do not repeatedly query a quota-exhausted database or claim this local checkpoint is deployed.

### Events repeat-read implementation

For the signed-in Wing reader, the hosted panel now reads only the current term
and its event pages. A fresh authority response supplies the data and access
revisions. The panel verifies the same authority after the final page on a
miss. A warm isolate can reuse the result for five minutes after a fresh access
check; its cache holds at most sixteen lists of at most 128 KiB each. Each key
includes the authenticated backend binding, term and revisions. Scoped users
and View as keep their separate permission paths. The browser keeps its
conditional revision check. Private HTTP responses still use no-store.

A November 25 offline comparison against the refreshed staging-data copy found
1,541 D1 rows read for the previous transfer, 757 for a cold Events list, and
70 for a warm list. All returned the same event content. The warm read requires
one signed backend call and writes zero rows. The reproducible command is
`scripts/rehearse-panel-reads.mjs`. A new isolate pays the cold cost. No KV,
R2, persistent cache, or additional scheduled refresh is needed.
