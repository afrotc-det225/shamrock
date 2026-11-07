# D1 frontend reporting rules

Status: pure local reporting implementation, covered by fictional tests. It does not deploy a Worker, query D1, publish a sheet, infer a final absence, or establish production readiness. The supported runtime remains the existing Apps Script deployment.

`packages/domain/src/frontend-reporting.ts` exports `buildFrontendReporting`, `calculateAttendanceCredit`, `calculateAttendancePercent` and `buildBirthdayView`. Inputs are normalized typed facts; outputs are literal values with stable identities, calculation details and diagnostics. No provider credentials, external service, AI call, or paid dependency is required.

## Versioned numerical baseline

The required policy identifier is `legacy-shamrock-credit-v1`. It identifies the checked-in operational calculation, not certification that every historical implementation choice is mandated by regulation. Policy changes require a new explicit version and acceptance evidence.

| Effective code | Credit numerator | Counted denominator |
|---|---:|---:|
| P, T, E, ES, MED | 1 | 1 |
| A, U | 0 | 1 |
| R, D, N/A, blank | 0 | 0 |

A zero denominator produces `1` (100%), preserving the existing numerical result. Every result also supplies `noCountedAttendance`, numerator and denominator. Presenters must retain that distinction; 100% with no counted attendance is not evidence that everyone attended. `calculateAttendancePercent(['P', 'T', 'A', 'R', 'N/A', ''])` returns `2 / 3`; an empty array returns `1`.

Overall includes the selected term's matrix events. LLAB uses explicit event type, fixing the legacy dependence on event label text. Dashboard percentages average individual cadet percentages, not pooled credit across person/event pairs. Empty groups have `null` averages. The Below 80% count uses a strict `< 0.8` comparison. These rules come from `src/services/attendance.ts` (`CREDIT_PATTERNS`, `TOTAL_PATTERNS`, `applyAttendanceFormulas`) and `src/services/frontend-formatting.ts` (`buildDashboardChartData`, `formatDashboard`).

## Stable identities, roster and event eligibility

Person, flight, squadron, term, event and fact identities are explicit. Event column machine headers are `event:<eventId>`; visible labels may duplicate or change without changing joins. Names and physical row order are never keys.

The current roster excludes Inactive, Commissioned and Dropped flight-path statuses. Blank and unknown statuses remain included, matching the current baseline. AS year ordering, GMC and POC membership come from the canonical arrays in `src/utils/arrays.ts`; AS500 is GMC. Events sort by training week, Mando/Secondary/LLAB/Other, configured display order and stable ID. Third Hour remains excluded from the normal attendance matrix.

Historical terms require their own roster snapshots. Those snapshots retain the recorded AS year and flight, even if someone has since commissioned or moved flights. A missing snapshot yields `missing-historical-roster`, an empty historical matrix and a null chart average. The implementation never reconstructs a historical roster from today's active members. Current plus the two most recent earlier terms supply comparison charts.

Each event supplies an exact `eligiblePersonIds` snapshot or `null`. Null means unknown. The projection does not infer event eligibility from today's flight, a name, expected-group label, or whether someone submitted a report. It returns eligible/unknown counts independently from numerical credit. Evidence outside a supplied roster remains visible with `evidence-outside-eligibility` requiring review, but an explicitly ineligible cell contributes neither numerator nor denominator. Unknown eligibility retains the legacy numerical treatment with a diagnostic. Evidence is never silently discarded, changed to N/A, or used to infer absence. Review must resolve the inconsistency before relying on the affected calculation.

Wing, squadron and flight scopes filter matrix rows, birthdays, counts and current group charts. The current attendance-by-flight chart excludes Abroad, matching the existing dashboard. Scope filtering is presentation behavior, not an authorization boundary: the caller must authenticate and authorize access before supplying facts or publishing output.

## Observation, correction and excusal precedence

The caller supplies observations, explicit corrections and current request states separately. `order` is a positive committed causal order comparable within a person/event pair. It must come from a durable shared command/audit sequence or an equivalent causal record. Request-local versions, sheet row numbers, lexical IDs and timestamps alone are not interchangeable ordering evidence.

The latest independent attendance fact supplies `attendanceCode`. A correction can set any supported code or explicitly clear with `null`. A later report can supersede an earlier correction. `observedCode` and its source ID remain independent; a correction does not rewrite the original observation. Clearing is distinct from having no correction.

| Situation | Projection behavior |
|---|---|
| P/T evidence and pending or denied request | Preserve P/T; retain request status separately |
| Approved outcome and P/T attendance | Preserve P/T; conflicting requested P versus observed T (or vice versa) requires review |
| Approved P/T/E/ES/MED and absence or blank | Apply the approved outcome unless a later explicit correction exists |
| Later explicit correction, including clear | Use the correction; do not restore an old approval over it |
| Pending request newer than other non-presence evidence | Display R and retain the independent evidence |
| Denied request | Preserve the independent attendance value; never manufacture U or D |
| Withdrawn/Superseded | Remove that request's adjudication; recompute from retained evidence, never restore a stale prior-code snapshot |
| Multiple nonterminal requests | Preserve independent attendance and emit an overlapping-request diagnostic |
| Conflicting attendance facts at the same committed order | No arbitrary winner; effective value is unresolved and diagnostics require review |
| Correction and adjudication with ambiguous ordering | Preserve the correction and emit a precedence diagnostic |

This preserves operational evidence and the legitimate correction/decision workflows while replacing the legacy destructive overlay behavior. Legacy `effectForDecision`, `updateAttendanceOnExcusalSubmission` and `repairAuthoritativeAttendanceEffects` in `src/services/excusals.ts` establish the source behavior and the intent to preserve later independent attendance. The existing D1 domain already records observations and decisions separately. No prior snapshot, missing event start time, or denial by itself is adequate evidence of absence. Weekly closeout remains a separate, explicit workflow; this reporting module does not perform it.

Every cell includes source type, request summaries, eligibility and `needsReview`; the report also has structured diagnostics and a report-level flag. Diagnostics contain stable IDs and fixed codes, not private reasons. A conflicting output must not be presented as a fully adjudicated result. This layer does not decide how an authorized reviewer resolves overlapping cases or grant permission to edit a record.

## Dashboard and birthdays

The six summary cards are total cadets, GMC cadets, POC cadets, average Overall, average LLAB, and Below 80%. Additional fields expose no-data cadets, event eligibility and pending requests. Chart series cover roster by AS year, attendance by AS year/current and prior terms, current flight/squadron averages, and chronological term averages.

Birthdays use date-only ISO input and an explicit `asOfDate` already resolved in the detachment's configured time zone. Output preserves the source birthday, current-year occurrence, Sunday week start, display string and successive Sunday–Saturday group number. Duplicate surnames receive a first initial, matching the existing formula. A February 29 birthday rolls to March 1 in a non-leap year, matching Google Sheets `DATE`. Invalid dates fail instead of depending on locale parsing. This follows `buildDashboardBirthdayFormula` in `src/services/frontend-formatting.ts`; a future operational change to leap-day observance needs explicit approval.

## Integration and checks

The builder bounds the total output at 100,000 person/event cells and validates duplicate IDs, unknown targets, invalid codes, dates, causal orders and policy versions. Caller-provided facts must come from one coherent committed snapshot. No direct production SQL wiring is included here, and local performance does not establish hosted Worker CPU headroom.

Run:

```sh
npm run build
npm run build:v3
node --test tests/v3/frontend-reporting.test.mjs
```

The fictional suite covers every attendance code, mean-versus-pooled percentages, typed LLAB classification, stable identity, explicit clear/replay, approvals and later corrections, denial/withdrawal, conflicts, eligibility, historical rosters, scoped views, birthdays, retired events, permutation stability and capacity rejection. Rendering, real account permissions, live concurrent edits and production cutover remain separate release gates.

Historical transport calculates at most four saved rows per request. The smaller page bounds repeated formula interpretation and response serialization on Workers Free; clients retain the original snapshot binding and assemble every page before publication. Hosted CPU measurements and Google request budgets remain separate release checks.
