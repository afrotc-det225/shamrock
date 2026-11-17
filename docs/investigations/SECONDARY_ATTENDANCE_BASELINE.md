# Secondary attendance baseline extraction

Source reviewed: `6d34739` (2026-11-17). This note records the supported source behavior; it is not a provider readback or authorization to change participation requirements.

The recovered admin-panel conversation used eliminating POC Third Hour attendance as an example of future maintainability. It did not request a change to Secondary PT. The existing system explicitly retires Third Hour. Therefore, no new Secondary PT policy, migration or UI toggle should be inferred from that example.

## Supported production behavior

- `src/services/forms.ts:256–257` explicitly states that Third Hour is retired and excludes its legacy event definitions from both event-choice buckets. The filter examines event type, display name and ID.
- `src/services/attendance.ts:75–87` excludes Third Hour definitions from the Attendance matrix event list.
- `src/services/setup.ts:4–18` defines `removeRetiredThirdHourEvents`. The current event refresh calls it at `src/services/setup.ts:3368`. Retirement is deliberate supported behavior, not an unimplemented new policy.
- `src/services/forms.ts:335–350` builds Secondary's candidate groups from operationally active Directory records and excludes Abroad. It does not restrict Secondary to GMC or POC. `src/services/forms.ts:765–776` creates a Secondary checkbox group for each available AS year.
- `src/services/transition.ts:606–635` creates a weekly Secondary event with `expected_group: 'All Cadets'`, starting on the reviewed Sunday and ending the following Saturday at 23:59. Secondary PT is not an independently scheduled Third Hour meeting.
- `src/utils/arrays.ts:4–20` establishes the actual category lists. GMC is AS100, AS150, AS200, AS250 and **AS500**. POC is AS300, AS400, AS700, AS800 and AS900. Do not substitute a numeric threshold such as AS year >= 300. AF Civ is in neither category.

## D1 parity findings at the reviewed commit

- `packages/domain/src/event-rosters.ts:12–19` derives ordinary event rosters from active members of the selected operational Flights, excluding Abroad for Mando, Secondary and LLAB. It does not exclude POC from Secondary.
- `packages/domain/src/transitions.ts:138–159` uses active non-Abroad members for its generated Mando, Secondary and LLAB events. Secondary spans the training week, and the generated expected group is All Cadets.
- `packages/domain/src/frontend-reporting.ts:351` suppresses the retained `third-hour` reporting type.
- `packages/domain/src/admin.ts:337–360` limits event creation to Mando, Secondary, LLAB and Other. `tests/v3/admin.test.mjs:56` already rejects a new `third-hour` event. `tests/v3/frontend-reporting.test.mjs:194` already covers retirement in event ordering/reporting.

No D1 parity defect in these specific Secondary/Third Hour rules was established by this source inspection. Existing legacy event import/classification and live native Forms still require their independent real-data/provider rehearsals; this note does not claim those tests passed.

## Isolated investigation boundary

A proposed versioned POC/Secondary setting was started in the separate `feat/v3-poc-policy` worktree before the recovered conversation clarified the example. That implementation is incomplete, untested and **not an approved requirement**. Its proposed migration 0016, routes and eligibility changes must not be integrated or deployed. The unchanged supported default remains all active non-Abroad cadets for Secondary PT.

Only a later explicit operational request would justify designing such a setting. That request would need to distinguish a change in Secondary participation from restoration or management of the retired Third Hour event type. Historical attendance and captured rosters would remain separate from any future policy change.
