# SHAMROCK D1 capability and acceptance matrix

Prepared 2026-11-05 for the [redesign plan](D1_REDESIGN_AND_MIGRATION.md), using the [source audit](D1_CURRENT_SYSTEM_AUDIT.md). Baseline: `d8cfc0171db772f8d5f5aff031eb7b3fda483676`.

These **151 proposed acceptance scenarios are not 151 implemented or passing tests**. All future D1 evidence is pending. They include the 121 scenarios found during subsystem review, rewritten to preserve needed outcomes and repair weak design, plus 30 design/reliability/optional-AI scenarios. The current 31 local regressions are a separate suite.

## How to use this matrix

For each case, the implementation work records: policy/capability owner, applicable rule/source/version, synthetic fixture, automated test reference, staging interaction evidence, observed result, known exception, and release version. Policy-dependent cases remain blocked for production until the operational rule is sourced; engineering repairs do not need approval merely because old code behaved differently.

Use three evidence tracks:

1. **Legacy characterization:** reproduce the current result where needed to explain historical data and migration differences. This does not make a bug a target requirement.
2. **New acceptance:** test the intended operational contract and explicit improved behavior.
3. **Lossless accounting:** every source occurrence and accepted command maps to preserved evidence, a canonical record, or a reviewed exception.

Automate domain, transaction, import and failure cases with fictional data. Test actual Google interaction, actor visibility, Tables/filters/chips/charts, Forms and permissions in isolated staging. Measure provider usage rather than deriving it from test counts. Cutover requires no unexplained critical discrepancy, not pixel-identical screens or identical defective outputs.

The code meanings/credit, participation/eligibility, finalization deadlines, decision authority, notification recipients/windows, annual progression and retention policy need identified authority. Proposed fixes such as stable identity, transactional writes, factual message wording, safe drafts, explicit permission checks and reliable retries are engineering requirements.

## Attendance

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| ATT-01 | Group attendance submission | Selected stable person/event targets receive observations; nonselected targets remain unchanged; actor and grouping retained. |
| ATT-02 | Mando crosstown selection | Required Trine/Valparaiso and flight workflows select correct cadets without duplication; validate current participation policy. |
| ATT-03 | LLAB group selection | Selected flight members resolve correctly, including crosstown, independent of submitter's own flight. |
| ATT-04 | Secondary/Other eligibility | Approved Abroad and AS-year participation rules apply; unknown enrollment does not silently disappear or grant eligibility. |
| ATT-05 | Duplicate delivery/timeout after commit | One source submission and effect set; identical retry returns receipt; no extra audit mutation or mail. |
| ATT-06 | Responder identity read failure | Bounded retry; unresolved or unverified identity is rejected/quarantined before domain mutation. |
| ATT-07 | Clear and later observation | Explicit correction/clear retains evidence and reason; later actual attendance is represented; blank is never silently converted to P. |
| ATT-08 | Legacy timestamps out of order | Historical reconstruction matches physical source-row order; new policy uses explicit observations/corrections, not sheet order. |
| ATT-09 | Sorted/reordered view | Stable identities target the intended person/event; integrity mismatch retains draft and blocks ambiguous writes. |
| ATT-10 | Missing event projection | Committed evidence remains safe; publication is pending/failed and repairable; no wrong-column write. |
| ATT-11 | Authorized manual correction | In-Sheets correction captures exact authorized payload, reason, actor and version; visible saved status follows receipt. |
| ATT-12 | Historical correction/tombstone | Preserve original evidence and legacy replay slot; new correction references its target; recompute affected old/new pairs under documented policy. |
| ATT-13 | Bulk selectors | Preview explicit target IDs and count; include/exclude/AND/OR semantics are clear; only reviewed targets change, including Abroad treatment. |
| ATT-14 | Codes and percentages | Reproduce legacy code table for history; approved policy fixtures establish new numerator/denominator and no-data display. No silent invented credit rule. |
| ATT-15 | LLAB and unusual labels | New calculation uses typed event identity; renamed/nonstandard display labels do not change metric membership. |
| ATT-16 | Enrollment changes | Policy-approved active roster and event-time membership apply; inactive/commissioned/dropped historical records remain intact. |
| ATT-17 | Event create/change/retire | Choices, obligations and views update; rename preserves identity; retirement does not delete historical attendance. |
| ATT-18 | Response backfill | Source provenance deduplicates; ambiguous records quarantine; reconstruction cannot overwrite unrelated current observations or send old mail. |
| ATT-19 | Duplicate names/labels | Distinct identities remain distinct; crosswalk requires evidence; no silent person/event merge. |
| ATT-20 | Unmatched identities | Every source occurrence preserved/accounted for; unresolved authoritative mappings block cutover; repeated import yields same result. |
| ATT-21 | Changed payload under same source ID | Identical fingerprint dedups; permitted Directory revision is explicit; unexpected attendance/excusal content change requires correction. |
| ATT-22 | Complete/partial/zero-attendee group reports | Covered roster/version and authorized completeness retained; partial report never implies all others absent; explicit zero-attendee completion works; overlap/amendment and later roster changes do not alter historical coverage. |

## Excusals

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| EXC-01 | Multi-event request | One source with separate event children and notification intents; request state does not erase actual attendance. |
| EXC-02 | Navigation placeholders/retired category | No placeholder or navigation answer becomes an event; retired/invalid choices reject with recovery guidance. |
| EXC-03 | Requested P/T/E/ES/MED | Valid approved outcomes follow policy; attendance correction and exception adjudication remain distinguishable; invalid value never silently defaults E. |
| EXC-04 | Denial before/at/after start | Approved deadline/finalization policy applies; unknown time blocks adverse finalization; denial alone does not manufacture an attendance observation. |
| EXC-05 | Request/denial after P/T | Actual attendance evidence survives; display and metrics reflect approved policy without stale-cell overwrite. |
| EXC-06 | Denial after observed absence | Observation remains independent; adjudication/final unexcused status follows the applicable policy version. |
| EXC-07 | Withdraw/supersede | Remove that request's effect and recompute current case/evidence; do not restore stale prior R/D/blank over newer evidence. |
| EXC-08 | Reconsider decision | Prior/new decision, authorized actor and reason retained; correct derived result and one intended change notification. |
| EXC-09 | Multirow decisions | Frozen authorized draft processes each stable request/version once; later range edits are not falsely attributed to earlier editor. |
| EXC-10 | Repeat unchanged decision | No duplicate effect/mail; explicit repair command can rebuild derived state without pretending a new decision occurred. |
| EXC-11 | Clear/invalid decision | Invalid input is visible; reopening/reconsideration is an explicit authorized operation, not inferred from a blank cell. |
| EXC-12 | Missing derived effect | Recompute from canonical decisions and observations without duplicate historical mail. |
| EXC-13 | New attendance/correction/request during repair | Repair uses current canonical evidence and policy; old decision cannot clobber unrelated newer observations. |
| EXC-14 | Malformed legacy effect linkage | Import records ambiguity; reviewed explicit request/decision linkage replaces prefix guessing; repair is repeatable. |
| EXC-15 | Concurrent decisions | Expected-version guard detects conflicts atomically; losing draft retained for review; actor sees actual result. |
| EXC-16 | Publish failure after decision | Decision receipt persists; publication retries without repeating mutation or enqueueing another message. |
| EXC-17 | Leadership/access turnover | Old decision authority revoked; new approver constrained to authorized scope; independent admin/read permissions verified. |
| EXC-18 | Configured workbook inaccessible | Fail visibly without creating an empty replacement or changing production binding. |
| EXC-19 | Decision spreadsheet usability | Readable request/outcome/reason, usable filters and dropdown drafts, protected recorded state, clear save status; exact colors/columns need not match. |
| EXC-20 | Multiple requests for one person/event | Every legacy request survives; new amendments/case conflicts are explicit; withdrawal cannot erase another valid request or observation. |
| EXC-21 | Concurrent submit and decision | Commands serialize with defined case versions; derived outcome is deterministic and repeatable under policy. |

## Notifications

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| MSG-01 | Event-day notice/routing | Approved event/flight scope and commander/deputy To/CC/fallback rules; content distinguishes excusals, observations and incomplete information. |
| MSG-02 | Cancelled/inactive/no event | No inappropriate scheduled mail; cancellation semantics validated against policy. |
| MSG-03 | Weekly review/closeout | Correct local window; approved deadline and review rules; missing/pending/observed/final states distinct; no unsupported adverse inference. |
| MSG-04 | No eligible events | No fabricated absence or perfect-attendance claim; show no applicable events where a report is requested. |
| MSG-05 | No recorded issues | Useful routine notice remains available; wording accurately states checked conditions and data completeness. |
| MSG-06 | Missing recipient/quota exhaustion | Visible routing/delivery backlog; no guessed recipient, swallowed failure or false success. |
| MSG-07 | Crash around mail delivery | Record uncertain delivery when appropriate; operator verifies before resend; no exactly-once guarantee. |
| MSG-08 | Shadow/import/replay | Outbound notifications suppressed, including future release of accidentally retained mail jobs. |
| MSG-09 | Pending requests but no A/U | Historical characterization documents old perfect wording; new message reports pending work accurately. |
| MSG-10 | Daily A/U/D/P/T without excusals | New notice never equates absence of excusal requests with proven complete attendance. |

## Migration continuity

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| MIG-01 | Cutover fence | Every writer and side effect accounted for; closed/buffered inputs retained; in-flight work drained before consistent import. |
| MIG-02 | D1 quota/outage | Forms source and bounded sheet draft journal preserve intake; pending status visible; bounded recovery without second authority. |
| MIG-03 | Edit during old publication | Publisher never touches draft input; stale/uncertain external writes detected and repaired; no promise that a script lock fences humans. |
| MIG-04 | Rollback after accepted writes | Controlled compatible rollback retains accepted command evidence; catastrophic restore follows stated backup recovery point; v2 fallback only when tested representable; never reopen stale snapshot. |
| MIG-05 | Missing historical evidence | Reconstructable, snapshot-only and incomplete periods distinguished; preserve original archived results; never invent past membership/decisions from current data; pre-cutover corrections and policy-restated reports identify their evidence basis. |

## Spreadsheet interaction

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| UI-01 | Routine access | Useful Directory/Leadership/Attendance/Dashboard and links remain accessible without AI; existing URLs retained where practical. |
| UI-02 | Alpha this week | Filter view answers the question using approved roster/events/marks; repeat after new event, roster change, publish and term transition. |
| UI-03 | Live metadata migration | Inventory saved views, sorts, tables, named ranges and customizations; preserve useful views or explicitly migrate field mappings without silent loss. |
| UI-04 | Sort/filter then edit | Supported sorting keeps identity aligned; partial-range identity mismatch blocks mutation and preserves input for review. |
| UI-05 | Directory readability | All required information legible with correct phone/CIP/DOB meaning and useful ordering; layout can improve. |
| UI-06 | Tables and repeat repair | Chosen native table/filter experience works; two repairs do not duplicate resources or destroy user views; no obsolete API workaround requirement. |
| UI-07 | Validation | Approved options accepted and invalid values rejected; options have one authority; validation styling is usable, not frozen to archived templates. |
| UI-08 | Photos | Rich-text/formula/Drive-chip migration preserves actual URI; refresh never substitutes visible filename. |
| UI-09 | Attendance presentation | Codes distinguish pending/recorded/no-data; numeric percentages filter/chart correctly; clear remains intentional; design can change colors/widths. |
| UI-10 | Real operator identities | Reader, self-profile user, representative, approver, admin and removed role tested; unknown original editor is never invented as a named actor. |
| UI-11 | Protection failures | Required identity/output/draft restrictions verified after rendering and simulated API failure; partial access repair reported. |
| UI-12 | Pending/rejected save | Timeout retains draft and command ID; retry applies once; rejection/conflict explains resolution without erasing user input. |
| UI-13 | Mixed rectangular paste | Frozen reviewable draft reports every allowed/rejected field; no top-left-only success or attribution of later edits to earlier actor. |

## Directory

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| DIR-01 | Directory submit/revision | Verified identity creates/updates the intended person; repeated delivery dedups; permitted source revision explicit. |
| DIR-02 | Same name/email change | Distinct people remain distinct; authorized identifier change retains identity/history; ambiguous merge requires review. |
| DIR-03 | All 20 fields | Lossless typed round-trip including blank, Unicode, phone, date-only DOB, CIP and photo URI; no unapproved field discard. |
| DIR-04 | Status/reactivation | Approved eligibility applies to current/event-time context; historical membership retained; invalid status produces a review task. |
| DIR-05 | Authorized field edits | Self-profile and administrator fields have explicit permissions; necessary dependent views update; stale mirrors cannot overwrite D1. |
| DIR-06 | Concurrent fields | Documented version/merge rule preserves unrelated changes and exposes same-field conflicts; no silent overwrite. |

## Leadership

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| LEAD-01 | Role projection | Approved wing/group/squadron/flight/advisor roles display and route from explicit assignments, with useful ordering. |
| LEAD-02 | Operational squadron scope | Canonical approved units route correctly; similarly named nonoperational roles do not gain authority by substring. |
| LEAD-03 | Manual/cadre and cadet roles | Manual contacts survive; ending cadet assignment removes derived access/contact role without deleting person history. |
| LEAD-04 | Derived contact edit | Edit reaches owning profile/assignment or clearly rejects; later sync cannot silently discard an accepted change. |

## Forms

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| FORM-01 | Public form entry points | Existing URLs remain where practical; verified identity and acceptance state tested under actual intended Google account. |
| FORM-02 | Directory questions | All needed profile inputs and validation retained; unnecessary questions can simplify; routine choices do not proliferate response columns. |
| FORM-03 | Attendance branches | Required Mando/crosstown/LLAB/Secondary/Other selection capabilities work; exact navigation may improve. |
| FORM-04 | Special/unknown AS year | Approved AS500/AF Civ behavior tested; unknown values surface explicitly rather than vanish through a title regex. |
| FORM-05 | Event refresh | Stable item/event mapping updates choices without unnecessary roster rebuild; one-off events work; label changes preserve identity. |
| FORM-06 | Excusal selection | Multiple events and requested outcomes/reason captured accurately; no placeholder submission; simpler navigation allowed. |
| FORM-07 | Structural rebuild | Preserve raw evidence and acceptance state; verify fresh destination; durable async dependency; repeated repair cannot duplicate intake. |
| FORM-08 | Choice identity across refresh | Immutable choice references resolve duplicate names, renamed events, delayed open-form submissions and replay after rebuild; old tokenless ambiguity quarantines; item IDs alone are never treated as entity IDs. |

## Dashboard

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| DASH-01 | Cards/links | Needed counts/metrics/links work; aggregation definition documented and policy-versioned; intentional legacy/new differences explained. |
| DASH-02 | Charts/history/empty data | Charts render numeric data and useful empty state; historical groups/terms selected explicitly rather than accidental archive-name regex. |
| DASH-03 | Flight and cohort reporting | Approved flight inclusion and GMC/POC definitions tested, including AS500/AF Civ; no lexical sorting assumption. |
| DASH-04 | Birthdays | Approved fields/readers only; dates, shared surnames, year boundary and leap-day handling explicit; no requirement to expose full DOB unnecessarily. |

## Archives

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| ARCH-01 | Historical access | Records, term interpretation and useful views retained under approved access; exact old table IDs/styles are not mandatory if migrated safely. |
| ARCH-02 | Duplicate archive names | Every archive accounted for; historical reporting includes correct snapshots without guessing from suffixes. |

## Reconciliation

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| REC-01 | Maintenance/resume | Explicit domains actually stop; retained input drains safely; old ambiguous partial pause is not preserved. |
| REC-02 | Reconcile | Repairs publications and processes durable commands; arbitrary cell difference is never treated as new human intent. |
| REC-03 | Full projection rebuild | Canonical records reconstruct usable views/photos/charts/forms/access with safe IDs and drafts; acknowledged commands never reapply. |

## Operations and handoff

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| OP-01 | 49 menu dispositions | Every listed capability has implemented replacement/accepted retirement and help; no requirement to retain 49 buttons. |
| OP-02 | Operator access | Consolidated controls discoverable and authorized; routine viewing/filtering independent of AI and admin menus. |
| OP-03 | Repeated setup | Same configured resources, correct unique triggers, no duplicate questions/headers/tables; completion means verified health. |
| OP-04 | Resource permission/transient failure | Visible actionable failure; no new empty resource or production pointer replacement. |
| OP-05 | Delayed form destination | Evidence intact; durable checkpoint and source identity; resume verifies exact destination and prior acceptance state. |
| OP-06 | Form collision/duplicate headers | Fail visibly and retain recovery evidence; no global success before child verification. |
| OP-07 | Trigger repair during jobs | Correct manifest; running continuations preserved/reconstructed; old-owner generation rejected; no duplicate mail. |
| OP-08 | Explicit maintenance controls | Selected intake/processing/publication/mail states match displayed behavior; resume shows pending failures accurately. |
| OP-09 | Full migration maintenance | All mutation paths fenced; late submissions/journals retained; no unnoticed background write or mail. |
| OP-10 | Semester preparation | Reviewable schedule/roster plan; only approved changes applied; old term records and membership retained. |
| OP-11 | Academic-year progression | Approved policy/explicit decisions govern every AS/status/rank; no accidental dropped advancement or automatic commissioning. |
| OP-12 | Cancel/resume draft | No mutation before final application; complete inputs saved; missing answers never silently replaced with defaults. |
| OP-13 | Interrupt every phase | Resume once with verified prerequisites; no duplicate archive/progression/reset/trigger; form finalizer completes before dependent success. |
| OP-14 | Concurrent transition/intake | One active term transition; explicit source term for each retained submission; no cross-term misassignment. |
| OP-15 | Retention with active job | Never delete required recovery snapshots; only approved eligible artifacts expire; failed cleanup retries. |
| OP-16 | CSV quoting/headers/dates | Versioned schema, lossless text/date handling; malformed file causes no domain mutation; confirmed legacy consumers have compatibility fixtures. |
| OP-17 | Import modes/identity | Reviewed create/update/replace scope, stable IDs, counts and expected versions; no silent label merge or destructive default. |
| OP-18 | Import dependency repair | Roster, forms, matrix, leadership and reports refresh exactly as needed; old missing/duplicate refresh bugs fixed. |
| OP-19 | Role/contact assignment | Correct source ownership; unmatched inputs reported; saved versus publication-pending status truthful. |
| OP-20 | Audit failure | Required audit and domain mutation commit atomically or fail together; delivery attempts recorded separately. |
| OP-21 | Progress/reconnect | Bounded poller; closing UI does not cancel work; durable status resumes and distinguishes accepted/waiting/complete. |
| OP-22 | Support diagnostics | Useful redacted metadata; restricted references stay private; structure dump never presented as full backup. |
| OP-23 | Isolated restoration | Data/schema/config bindings and projections recover; post-backup commands reconciled; no production side effects or historical mail. |
| OP-24 | Successor exercise | Own accounts can diagnose/change/test/stage release/restore/rotate ownership from docs without transferred production env files. |
| OP-25 | Timezone/DST | Approved local daily/weekly/term windows and deterministic keys prevent duplicate or wrong-day actions. |
| OP-26 | AI/development outage | Forms, attendance, Sheets decisions/filtering, schedules and repair controls continue without AI/GitHub runtime availability. |

## Reliability, identity, free tiers and recovery

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| REL-01 | D1 transactional guard | Stale version or authority generation causes entire command batch to fail; zero-row UPDATE is not mistaken for transaction failure. |
| REL-02 | Command collision | Same ID/different payload rejects; concurrent duplicate command returns one stable outcome. |
| REL-03 | Forged/replayed bridge request | Signature, timestamp, method/path/body/environment checks enforced; altered actor/payload rejected. |
| REL-04 | Revoked actor/delayed draft | Current authorization enforced at commit; revoked privilege cannot apply buffered privileged commands. |
| REL-05 | Missing Google actor | Draft retained; authenticated confirmer signs exact reviewed payload; record confirmer, not fictional original author. |
| REL-06 | Token/session validation | Google signature/issuer/audience/expiry/sub and CSRF/session binding validated; arbitrary email/header is not identity. |
| REL-07 | Publisher overlap/expired lease | Current claim token and per-resource serialization; no unsafe takeover of possibly active request; uncertain write repaired from latest desired state. |
| REL-08 | Multichunk publication | Checkpoint advances only after verified complete generation; interrupted partial view is visibly stale and repairable. |
| REL-09 | Concurrent input/publication | System output and user drafts separate; no read-then-write claim of human compare-and-swap; bulk command snapshot immutable. |
| REL-10 | Permission removal and stale job | Load current grants; revocation prioritized; stale job cannot knowingly re-grant removed access; readback detects drift. |
| REL-11 | Peak free-tier workload | Measure Worker CPU/requests, D1 reads/writes including indexes, Google runtime/calls/mail and total account usage under retry/closeout load. |
| REL-12 | Storage/retention forecast | Measured bytes/indexes/history support approved multi-year retention below capacity triggers; no silent deletion or paid upgrade. |
| REL-13 | Quota reset/backpressure | Daily limits/time windows handled; bounded queue growth/age; intake cap and operator procedure tested before exhaustion. |
| REL-14 | Native export/restore | Export blocking period measured; input retained; isolated restore verifies counts/foreign keys/derived results; no inconsistent paginated snapshot claim. |
| REL-15 | Independent backup failure | Missed/late GitHub backup visible in Google health; protected Drive retention/hash/version manifest verified; no data in Git or CI artifacts. |
| REL-16 | Release/schema mismatch | Worker/adapter contract handshake prevents unsafe mutations; additive migration supports previous compatible release. |
| REL-17 | Free private deployment | Repo-level secrets and manual workflow work without paid environments/org-secret access; budget controls actually stop billed use. |
| REL-18 | Public/private boundaries | Public source/fixtures/CI have no real records/IDs/secrets; private Git also excludes live data/credential files; secret rotation demonstrated. |
| REL-19 | Institutional owner turnover | Two custodians; Google trigger/OAuth and Cloudflare/GitHub access recovered; departing identity removed; orphan triggers neutralized. |
| REL-20 | Policy change/version | Effective dates and authority recorded; historical results reproducible; future change does not silently rewrite old reports. |
| REL-21 | Draft row movement/removal | Pending input stays attached to immutable person/request/event identity through sort, roster departure and publication; output refresh cannot rebind a draft; unresolved drafts retained. |
| REL-22 | UI hosting and trust | Real institutional account can use the approved launcher/confirmation flow; shared bound code contains no bridge secret or trusted actor assertion; trusted page reloads and authorizes the exact draft. |

## Optional AI-client integration

These five cases gate any enabled chat integration, not the independent deterministic application. Use fictional data until account eligibility and the permitted data boundary have been established.

| ID | Scenario | Required evidence / outcome |
|---|---|---|
| AIC-01 | Native Gemini account eligibility | Verify the actual client's personal-account, age/location/language/activity requirements; do not assume ND work/school access supports custom MCP. |
| AIC-02 | MCP authorization and revocation | Named tools enforce current person/capability/scope; forged actor arguments fail; revocation takes effect; operational access does not grant SQL, repository write or deployment access. |
| AIC-03 | Chat mutation and retry | Exact reviewed operation reaches the same command/audit path as deterministic UI; duplicate call or lost response cannot repeat effects; chat confirmation is not a substitute for server authorization. |
| AIC-04 | Model outage and quota boundaries | Ordinary Forms/Sheets/schedules keep working; custom-site sign-in does not claim pooled Gemini allowances; any API project has verified free limits and data terms. |
| AIC-05 | Successor context and Google hooks | New authorized chat account retrieves current versioned documentation; fictional tool-triggered operations explicitly publish Google updates without relying on API writes to fire edit triggers. |

## Release evidence package

Retain a private, access-controlled record of the source census, mapping/disposition counts, policy decisions, test results, staging screenshots where useful, capacity measurements, cutover rehearsal, restore evidence, authorized recipient/access checks and successor exercise. Keep personal records, raw resource identifiers and credentials out of this repository. Sanitized summaries can be committed with the implementation.

A signed-off matrix is a release gate. This planning document does not certify production feature parity, approve data hosting, or authorize migration/deployment.
