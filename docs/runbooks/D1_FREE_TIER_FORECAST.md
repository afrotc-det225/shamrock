# D1 and Google free-tier forecast

Reviewed November 6, 2026. This is a workload model with explicit measured and unmeasured parts, not a guarantee of permanent free service. Current scale is 113 retained profiles, 90 active cadets and 47 events: **4,230 current attendance cells**. A five-minute timer runs **288 times per day**, even when nobody submits anything. The automation account is a consumer Google account, so institutional Workspace quotas must not be assumed.

## Provider budgets

| Resource | Current free/consumer budget | Practical boundary |
| --- | --- | --- |
| Apps Script URL Fetch | 20,000 calls/day | Google REST and signed Worker calls both use this budget |
| Apps Script triggers | 90 minutes total runtime/day; six minutes per execution; 20 triggers per user/script | At 288 ticks, 18.75 seconds average per tick consumes the entire daily runtime before user-trigger work |
| Google Sheets API | 60 reads and 60 writes/minute/user/project; 300 each/minute/project | A batch counts as one request; burst concurrency still matters |
| Google Forms API | 390 normal reads, 180 expensive response-list reads and 150 writes/minute/user/project | No daily API count limit, but Apps Script's URL Fetch limit still applies |
| Workers Free | 100,000 requests/day; 10 ms CPU/request | Network wait is excluded from CPU; serialization and application work are not |
| D1 Free | 5,000,000 rows read/day; 100,000 rows written/day; 500 MB/database; 5 GB/account | Index writes count too; free quota exhaustion stops queries rather than authorizing a paid upgrade |
| D1 request/recovery | 50 D1 calls per Worker invocation; seven-day Time Travel | A D1 batch counts as one invocation call, but all its rows count toward daily usage |

Sources: [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas), [Sheets limits](https://developers.google.com/workspace/sheets/api/limits), [Forms limits](https://developers.google.com/workspace/forms/api/limits), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). Recheck these at each release and confirm the actual account remains on its free plan. This design does not require R2, paid GitHub, a custom domain or paid inference.

## Measurements and their limits

A disposable local Miniflare probe copied the restored schema-8 operational rows and indexes: 113 profiles, 90 active, 47 events and 4,230 baselines. The original backup was opened read-only. Raw source-occurrence JSON was minimized only in the disposable copy; operational rows and query joins were retained. The actual coherent snapshot SQL read **26,357 rows**, wrote zero, and used one D1 batch of 16 statements. Each empty frontend/forms claim read one row and wrote zero. This snapshot predates operational adoption. Of 459 preserved requests, the reviewed disposition proposes 356 operational requests (including 71 pending), 100 retained only as history and three quarantined; adoption and later history increase its cost. These are local SQL counters, not hosted billing or CPU measurements.

A separate fictional 90-person/25-event fixture measured the actual Worker command paths:

| Operation | Local rows read | Local rows written |
| --- | ---: | ---: |
| One 90-person attendance report | 1,280 | 657 |
| Identical attendance retry | 553 | 0 |
| One maximum 25-event excusal submission | 958 | 391 |
| One decision | 572 | 31 |

The fixture starts with little prior history and is not an upper bound on an aged database. Those commands used four or five D1 calls, within the invocation budget. The existing public `npm run capacity:v3` separately checks the maximum 500-person/25-event interactive fixture. Neither local test establishes hosted CPU headroom or a daily workload. Subsequent actual Worker analytics found whole-snapshot CPU around **37.5 ms** for a roughly 1.56 MB response and whole-history CPU around **20–30 ms**. Successful HTTP 200 responses do not make those calls safe under the Free 10 ms CPU limit. Bounded coherent snapshot/history pages and fresh hosted CPU measurements are required before cutover. The observed snapshot wall time (676 ms) is distinct from CPU time.

## Daily planning model

Count **all coherent snapshots**, including frontend publication, Form publication, input context reads, reporting and maintenance. Coalescing frontend refresh jobs avoids republishing once per accepted command; it does not make every snapshot free. The measured snapshot alone gives:

| Total snapshots/day | Snapshot rows read/day | Share of 5M read budget |
| ---: | ---: | ---: |
| 20 | 527,140 | 10.5% |
| 60 | 1,581,420 | 31.6% |
| 150 | 3,953,550 | 79.1% |
| 180 | 4,744,260 | 94.9% |
| 288 | 7,590,816 | 151.8% |

Thus polling a full snapshot every five minutes is already unsuitable. Empty queue checks should remain cheap; full snapshots belong to actual work. Use the following measured-anchor example, not a claim about the detachment's actual daily mix: four full-wing reports, 15 maximum-size excusal submissions, 15 decisions and 20 duplicate attendance deliveries consume about **39,130 reads and 8,958 writes**, before queue effects, admin edits, corrections, notifications, snapshots and their retries. Sixty snapshots add about 1.58M reads. Reserve at least half the free write budget and substantial read/CPU margin until actual peak-day counters are recorded. A busy-day 150–180 snapshot count is too close to the read limit once history and other work are included.

Google also needs a complete request/runtime model. The pre-optimization source call-path audit found approximately **77–78 URL Fetch calls per enabled empty timer tick**: nine frontend, nine or ten maintenance, 15 Form intake, 20 Form publication and 24 native input. That is about **22,400 calls/day before submissions**, exceeding the consumer allowance. With all optional gates paused but configured, repeated private config reads still cost about **18 calls/tick**, or **5,184/day**. These are static stable-metadata path counts, not observed hosted timing; extra permission pages, metadata drift, retries and pending work add cost. A single shared five-minute trigger is not itself proof of efficient polling. The scoped scheduler optimization now measures **seven calls per enabled empty tick** and **six per paused configured tick** in injected-provider tests. Private config reads share only that invocation; state, Sheet, Form and Worker mutation results do not. A signed, current-authority availability read precedes expensive work; durable work markers/retained claims force retries. Each hour forces reconciliation, and maintenance is due every 15 minutes. Direct input triggers still run immediately; background retries/publication retain the five-minute poll. Control requests remain discoverable every tick. These tests do not establish hosted duration.

A planning allocation after this change is 288 × 7 = **2,016 base calls/day**, plus 24 hourly reconciliations, 96 maintenance windows and real work. Reserving 80 extra calls per hourly reconciliation and 10 per maintenance window gives **4,896 calls/day** before submissions and publication (a conservative allocation, not a measured full-day count). New paged snapshots and permission consumers must be added to that model. Use `daily URL Fetch = idle ticks × idle calls + reconciliation + maintenance + publication passes × extra calls + input events × calls + retries + operations`. For runtime, use the corresponding observed execution seconds and include simultaneous triggers and lock waits. A 10-second empty five-minute tick already consumes 48 of the 90 available trigger minutes. Target an empty tick well below that and leave room for attendance bursts. Every execution must remain under six minutes; a daily total below quota does not excuse a single oversized run.

## Migration and retention

The actual hosted real-data import recorded **61,621 written rows** across 326 verified steps. That is **61.6% of a free day's write allowance** before a second restore, rehearsal, ordinary activity or other databases on the same account. Do not schedule a full import and equivalent full SQL reimport into one quota window without measured headroom. The later actual hosted Time Travel restore used a disposable marker and exact before/after verification instead of a second 61,621-row import; its marker checks added five SQL writes. Pause before crossing the limit and continue the saved plan in a later window; never truncate evidence or enable billing automatically.

The restored local SQLite database occupies **58,613,760 bytes (~58.6 MB)**, about 11.7% of the 500 MB single-database ceiling. Source-occurrence evidence accounts for roughly 45.4 MB and saved matrix rows another 5.5 MB. The separately observed hosted database size was **58,757,120 bytes**; source-table page attribution above comes from the local restore. The 4,230 effective attendance cells alone therefore understate storage substantially. Repeating an equivalent evidence import each term would consume roughly 117 MB/year at two terms/year, before ordinary growth; that is a sensitivity example, not a retention policy or a reason to delete records.

Keep raw migration evidence once, with verified external backup/checkpoint custody, rather than reimporting the same history every term. Measure incremental audit, response, request, correction and catalog bytes over a real term before projecting years. Every private Google journal also has its own bound (typically 5 MiB), and input receipt markers and historical snapshot/queue bounds are finite. Archival must preserve unresolved drafts, exact response catalog bindings, receipts and authoritative history. No automatic destructive retention or paid expansion is authorized.

## Release measurements still required

Record at least an idle day, a normal attendance day and a burst/retry rehearsal. Capture aggregate counts only in public notes: Worker requests and CPU percentiles/errors; D1 rows read/written and database bytes; Google API read/write rates; Apps Script URL Fetch counts, execution duration and trigger totals; queue age; pending/rejected drafts; and private checkpoint sizes. Include the real adopted requests/history, all enabled consumers and any additional permission consumer. Re-run after schema/query/index or polling changes.

The acceptable result is measured headroom on the actual free account with deterministic backpressure and visible retained work. If it fails, optimize or reduce unnecessary polling/publication and rehearse again. Keep the existing production system operating; do not change subscription, silently drop history or assume an AI agent can bypass provider limits.
