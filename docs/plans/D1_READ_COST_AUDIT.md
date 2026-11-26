# November 26 staging read-cost audit

## What used the daily allowance

At 1:01 p.m. Central on November 26, 2026, Cloudflare's account database analytics reported **3,215,019 rows read**, **14,057 rows written**, 21,109 read queries and 378 write queries since 00:00 UTC. All reported database reads belonged to real-data staging. This was 64.3% of the shared 5,000,000-read Free allowance, leaving 1,784,981 reads at the time of measurement. The 100,000-write allowance was at 14.1%. The daily window began at 6 p.m. Central on November 25. Development and rehearsals consume the same account allowance as other databases on that account. [D1 pricing and quotas](https://developers.cloudflare.com/d1/platform/pricing/)

| Hour beginning, Central | Rows read | Share of day so far |
|---|---:|---:|
| Nov 25, 8 p.m. | 844,507 | 26.3% |
| Nov 25, 9 p.m. | 1,152,447 | 35.8% |
| Nov 25, 10 p.m. | 790,835 | 24.6% |
| Nov 26, noon | 398,643 | 12.4% |
| All other hours combined | 28,587 | 0.9% |

The three evening hours account for 86.7% of the reads. The retained import receipt accounts for 25,049 reads and 14,001 writes. It explains almost all writes. Import verification, Google publication, retries and web browsing have separate read paths. SQL shared by multiple callers does not identify a specific operator or assign an exact share to each workflow.

At 1:16 p.m. Central, Workers analytics returned 781 requests for the canonical frontend, 645 for the staging web panel and 1,855 for the real-data backend, with zero Worker invocation errors in those groups. The front door can call another Worker, so the combined 3,281 invocations include internal traffic. A Worker can run multiple SQL statements per request, and D1 can visit thousands of records for a single statement. Worker errors also exclude application errors handled and returned by the Worker.

## Why Query Insights showed nearly seven million

| Normalized query group | Estimated executions | Mean rows read per execution | Estimated group reads |
|---|---:|---:|---:|
| Baseline page with import revision (the supplied SQL) | 544 | 12,833 | 6,981,152 |
| Earlier baseline page | 198 | 12,833 | 2,540,934 |
| Excusal request paging | 81 | 1,880 | 152,280 |

The first group averaged 257 rows returned. About 50 rows were visited for every row returned. Cloudflare's query-level dataset uses adaptive sampling. The sampled intervals for that query averaged about 68 in the two busiest hour groups. The sum in Query Insights is an estimated aggregate for the normalized SQL and its bindings. The returned analytics provide no maximum for an individual execution. Use account database analytics to track the daily allowance, Query Insights to identify expensive shapes, and per-statement D1 metadata to measure a reproducible invocation. Adding the sampled group totals to the account total would double count different measurements. [Query Insights](https://developers.cloudflare.com/d1/observability/find-expensive-queries/) · [Cloudflare sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)

## Query plan and implementation

The legacy baseline page is part of a semester snapshot. Callers include spreadsheet publication, the former Forms publication path and consumers requiring a complete capture. Lists in the operational web panel also have their own endpoints. Seeing this SQL alone does not establish that opening the home page triggered it.

SQLite used the event-first index to find matching cells, joined each candidate to its completed import run, then used a temporary B-tree to put the results in person/event order. Each new page repeated that work. LIMIT 257 bounded the result sent to the caller. It did little to bound the work done before the sort. The long scoped-people CTE in the supplied statement was unused and absent from the execution plan. Removing its text would not fix the cost.

The implicit current-semester page now streams the existing unique person/event index. A continuation uses the last emitted pair, which also handles pages shortened by the response byte cap. The event scope, completed-import filter and revision calculation still apply. Each request checks access, environment, generation and revision. Explicit historical semester requests retain the event-first query. Offset clients still work. The Apps Script pager uses the seek token when the backend supplies it. No additional database index, migration, cache service or write is required.

| Single current-semester SQL transfer on local real staging records | Pages | Rows visited |
|---|---:|---:|
| Original event-first query, sorting each page | 17 | 218,144 |
| Person/event order, retaining OFFSET | 17 | 78,957 |
| Person/event order with seek continuation | 17 | 9,341 |

All 4,230 baseline records, codes, import revisions and their ordering matched, including records for retired events. The original query visited 12,832 rows on each page in this reproduction. The seek version visited 563 on the first and 318 on the last. The 95.7% reduction applies to this SQL transfer. Historical terms can have a very different distribution. Remeasure as current-term records become a smaller fraction of retained baselines.

## What the Google adapter needs

To rebuild native Form choices, SHAMROCK reads the people, flights, terms, events and event-to-flight assignments. Its former full capture also fetched attendance baselines, event rosters, contacts, correction history and excusal requests. The new Forms manifest counts and transfers only the five catalog sections. It requires the named Forms lease and checks semester, identity of the effect, revision, page counts and final verification. The complete spreadsheet capture still includes attendance and excusals.

| Local Worker projection with the same synthetic Forms publication lease | Page calls | D1 reads | D1 writes during projection |
|---|---:|---:|---:|
| Original full capture | 55 | 314,045 | 0 |
| Full capture with improved baseline paging | 55 | 105,242 | 0 |
| Forms catalog with five sections | 10 | 17,523 | 0 |

These numbers cover the coherent data transfer. Claiming or acknowledging a lease, Google API calls, and updating publisher checkpoints are separate costs. The local reproduction exercised the real Worker query code against a copy of the staging data and runtime indexes. Authorization used a local fixture lease. Import-provenance tables unrelated to the queries were omitted. These are repeatable measurements of query work, independent of hosted sampling. A second comparison matched the fields consumed by the Forms planner against the full capture. Using the existing native staging checkpoints, the Attendance, Excusals and Directory Form plans also matched in full, including choices and their destinations. Native Forms, Sheets and hosted D1 were not written in this audit.

For context, the full read path without an effect lease spent 27,542 reads on the manifest, 26,516 on excusal requests, 24,261 on event rosters, 12,136 on people, 9,596 on the optimized baseline pages and 4,140 on contacts. These categories include repeated per-page checks. The narrow Forms manifest cost 4,639. These measurements identify where another round of query work can pay off.

## Opening the web panel

The full snapshot SQL and the browser's default list are different paths. There was also a genuine page-load problem. Overview fetched its small counts and birthdays, then automatically requested the entire authorized Attendance matrix to draw three charts and a roster breakdown. On the staging replica that second request alone cost 37,237 reads for a cold Wing view. The change keeps counts and birthdays available on arrival and adds **Show attendance charts**. When reporting data is already loaded the charts render directly. The deferred response is tied to the current capture, View as state and revision.

| Cold backend profile on the November 25 staging export | Wing reads | Scoped reader reads |
|---|---:|---:|
| Cadets list | 197 | — |
| Additional cadet fields | 197 | — |
| Leadership | 300 | — |
| Overview counts and birthdays | 1,465 | — |
| Attendance matrix | 37,237 | 28,260 |
| Excusals | 1,971 | 8,343 |

These are native D1 counters on a local workerd replica, one call to the specific browse endpoint and its authorization checks. They exclude sign-in, session establishment, HTTP routing and background refreshes. A cold Wing Overview previously triggered **38,702** profile reads; the default view now requires **1,465**, a 96.2% reduction. Opening the charts explicitly still costs the matrix read on a cold cache. One hundred cold full-matrix Wing views alone would use about 3.72 million daily reads. A low traffic site can exhaust this allowance with eager loads or replaying publications.

A broad cache cannot fix the first read after a miss. The existing private browser memory and short-lived Worker cache already help repeat visits. Scope, actor, View as and revision participate in reuse. Fresh authorization is essential when a cadet changes flight, a leader loses decision authority or the operator exits View as. Keep static assets and immutable semester artifacts separate from live, permission-sensitive data.

## Remaining costs and how to operate within the free tier

1. **Measure full-matrix demand.** Split matrix first paint by the selected flight and event window if full-matrix cold reads dominate after release. Preserve sorted identities and reporting totals. The current compact matrix serializes person/event references, often with correlated lookups per fact. Test joining those keys once and confirm that identity mapping, scoped membership and JSON ordering match on the full replica.
2. **Improve the Overview read itself.** Even deferred, 1,465 rows for a few counts is high. Measure each count separately. A small per-term summary keyed by attendance, directory, roster, event and excusal revisions could serve commonly needed aggregates. Birthdays and date-sensitive reporting require a date boundary in the cache key. Use the same reporting rules for Sheets, the panel and any stored summary.
3. **Reduce work on a changed publication.** A complete spreadsheet projection still needs about 105,000 reads before Google operations. Inspect the manifest counts, excusal request pager and event roster pager first. Persist progress so a transient Google error can retry provider work without downloading every D1 page again. Coalesce compatible refreshes by revision. Keep source decisions, original identities and receipt idempotency intact.
4. **Account for rejected and interrupted work.** Some snapshot routes run the permission/revision checks and payload query in one batch, then inspect the guards. They protect the response but a denied or stale request can still consume query resources. Measure rejected workloads separately. If material, predicate expensive work on the same guard inside the transaction. A preliminary cache or authorization check must never become sole authority for a data read or command.
5. **Use existing storage according to its job.** Cache versioned, immutable History files behind the existing access check. A new R2, KV or Durable Object copy of all active records would require invalidation and permission management and would leave expensive cold database reads in place. Evaluate a scoped snapshot or aggregate only after measuring its hit rate, update frequency and stale-data behavior. No new paid service is needed for the changes in this audit.
6. **Reserve capacity for operational reads and writes.** Suggested operator thresholds are 50% of the daily read allowance for investigation, 70% for deferring optional hosted rehearsals and 85% for holding bulk replays until reset. These are proposed operational thresholds, not installed alarms. Keep all daily counts across staging and production in the same account budget. Record request class, profile, cache hit/miss and aggregate work per operation if adding telemetry. Keep cadet data, principal identifiers, bindings and raw SQL parameters out of logs.

## Verification and staging release

Run `npm run check` from the repository root. The baseline regression in `tests/v3/admin.test.mjs` exercises the signed page endpoint across three pages, tests a rejected actor, stale revision and wrong term, and limits the reads for the last single-row page. The native Forms suite checks publication, interrupted work, access fencing, retry behavior and fixture Form choices. The browser and adapter have separate build targets. Run panel unit and browser tests in addition to the root checks.

Release the compatible staging backend first. The previous adapter and offset readers still work with it. Then publish the staging adapter and panel. Verify the served asset version, a cold Overview, and an explicit chart load. During the next approved publication window compare the native Form choices and read the final receipt. Compare account-level hourly usage across comparable workloads. Record local versus hosted numbers separately. Roll back the adapter before reverting the Worker, since the narrower Forms manifest requires the updated server. No database migration or data repair is part of this release.
