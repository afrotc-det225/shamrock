# Bounded coherent frontend and historical reads

A real imported frontend exceeds one megabyte. Returning it from one Worker invocation consumed more CPU than the Workers Free allowance even when the request happened to return HTTP200. Successful responses under burst tolerance are not a capacity guarantee. The page protocol limits the work performed in each invocation before serialization; it does not build a whole snapshot and then split its JSON.

## Frontend protocol

Use signed POST `/v1/admin/snapshot/page`. Effect consumers use `/v1/admin/effects/project/page` with the existing `workerId`, `effectId` and `claimToken` fields. Both include environment, generation and current `principalId`.

1. Send `section: "manifest"`, `offset: 0`, `revision: null`.
2. Read each manifest section in its advertised order, starting at offset zero, using the returned revision. Follow `nextOffset` until null. Empty sections still have one empty page.
3. Send `section: "verify"`, `offset: 0` and the same revision.
4. Call `assembleFrontendSnapshotPages` only after final verification succeeds. Only then may a native consumer build its publication plan or start provider writes.

Each data read is bounded by SQL LIMIT (up to512 small relationship rows, fewer for larger records) and128,000 response bytes. The Worker reads authorization, revision, optional effect lease and its data in one D1 batch. Any operational or administrative revision change returns `SNAPSHOT_CHANGED`; discard the entire incomplete transfer and retry from its manifest. A permission revocation, pause during an effect projection, expired/stolen lease or unfinished import/adoption also fails closed. No page acknowledges an effect or changes a lease. Existing claim-time floors and ACK coverage remain unchanged.

The assembled result retains the current `FrontendSnapshot` contract. Event eligibility is transported separately and joined only by exact event IDs. Term rosters remain separate from the current Directory. Pair versions are the maximum actual causal audit order across the complete observations, requests and corrections, with version zero for imported baselines; they are identical to the existing SQL union. Leadership uses the same canonical role function and the same server-derived virtual contact hashes. A missing page cannot silently turn a roster into an empty roster or a pair into version zero.

The Google client must cap total pages, total bytes and elapsed time, and persist a complete snapshot before any native publication. It must not fall back to the oversized whole-read route. Old whole-read functions remain available for existing callers and tests; they do not establish Free-tier capacity for internal notification, closeout or transition preparation. Those operations require their own scoped-query or frozen-content handling. Direct administrative SQL changes remain outside optimistic audit revision tracking: perform migrations/imports behind their existing paused deployment procedure and do not change audited records manually during a paged read. Imports/adoptions expose an explicit loading fence until their completed audit is committed.

## Retained historical reports

Use signed POST `/v1/admin/history/page` with environment, generation, principalId and snapshotId. Start with `section: "manifest"`, `offset: 0`, `sourceSnapshotSha256: null`; use the returned source hash on every subsequent request. Read `roster` pages and then `rows` pages, followed by a `verify` request. `assembleLegacyHistoryPages` reconstructs the existing report only after every expected row and roster entry arrives.

The server calculates at most eight source rows per request and returns at most128,000 bytes. Metadata and roster are not repeated in each row payload. Raw Form responses and contact details are not exposed. A source occurrence ID remains the stable row identity, and the original physical row order is restored after transport. Original saved formulas, covered/excluded event columns, historical codes, stored percentages, calculated comparisons, unresolved identities and diagnostics are preserved exactly. Different retained source copies never merge just because they share a term label.

Completed import snapshots are immutable. Every page rechecks current Wing read authority and the completed source-hash binding. If evidence is unavailable, malformed or too large, the transfer fails; it never publishes a truncated historical report.

## Evidence and release gate

Synthetic regressions compare assembled results with the original coherent readers and cover missing/duplicate/torn pages, revision changes, revocation, lease expiry, pauses, loading imports and historical identity corruption. Private real-data rehearsal also compares every assembled field across the current snapshot and all six retained reports; no real records belong in Git or console output.

After deploying committed code to isolated staging, measure representative manifest, dense data and history-row invocations using Cloudflare CPU metrics. Read-only local equivalence and small response bodies do not prove hosted CPU limits. Keep staging paused and production unchanged until the rest of the existing release gates pass.
