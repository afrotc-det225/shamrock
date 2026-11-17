# Independent native staging host

Use an independent Apps Script project for a real-data staging rehearsal. Keep the
fictional fixture's script, resource pointers, triggers, credentials, claims and
checkpoints intact. This mode uses the native Main/Excusals Tables and managed
Forms; it requires no legacy journal workbook, projection tabs or technical
decision-input sheet. It is staging-only and does not authorize production cutover.

## Host configuration

The owner-private root JSON file contains `SHAMROCK_V3_HOST_CONFIG` as a JSON
string with this shape:

```json
{
  "version": 1,
  "environment": "staging",
  "mode": "native-only",
  "resourceReview": "EXISTING_RESOURCES_REVIEWED_FOR_STAGING",
  "workerOrigin": "https://worker.example.invalid",
  "keyId": "REVIEWED_STAGING_KEY_ID",
  "generation": 1,
  "expectedAutomationEmail": "automation@example.invalid"
}
```

The root may also carry the existing frontend, managed Forms, native input,
permission, maintenance, History, owner-mail and private credential configuration
or pointers. They retain their separate schemas, owner checks, pause gates,
setup receipts and recovery state. The native-only root must omit
`SHAMROCK_V3_PRINCIPALS`, both old choice catalogs, `SHAMROCK_V3_PROJECTION_CONFIG`
and `SHAMROCK_V3_PRESENTATION_CONFIG`. The host itself must omit `journal`,
`attendance`, `excusal` and `decisionInput`.

Use `EXISTING_REAL_DATA_FRONTEND_REVIEWED_FOR_STAGING` for a reviewed real-data
frontend. The existing fictional marker remains valid for fictional fixtures.
Both require exact staging workbook titles, distinct private state and workbook
bindings, the intended owner and the same full protection/native Table checks.
The marker does not grant access or bypass a publication gate.

Omitting `mode` retains the original transport fixture and its required bindings.
Import rejects switching modes in an already configured script. It pauses all
consumers but preserves the previous configuration and recovery state on refusal.
Repairing a damaged transport configuration within that same mode remains supported.
Do not manually remove the old host property to bypass this separation.

## Setup sequence

1. Create a separate script using committed staging artifacts and the existing
   no-billing staging GCP project. Complete the owner's Google association and
   authorization. Set the new script's initial `SHAMROCK_V3_CONFIG_FILE_ID`
   property; the public project-content API cannot set Script Properties.
2. Create distinct owner-private configuration/checkpoint files and retention
   storage. Reuse the exact verified real-data frontend baseline only after fresh
   literal readback. Do not copy fictional pending claims, control receipts,
   trigger IDs, journals or provider-review attestations into the new script.
3. Import the native-only root and deliver its reviewed bridge credential using
   the private credential procedure. Both imports remain paused. The host needs
   no old transport principal registry; managed Forms/input keep their own
   explicit enrolled identities. An automation operator is not an imported cadet.
4. Run `shamrockV3StagingSetup`. It pauses every consumer and installs exactly one
   verified five-minute `shamrockV3StagingFlush` scheduler. Repeated setup keeps
   the verified scheduler. It does not read or initialize legacy projection,
   presentation, journal, Form or decision-input resources. If old transport
   submit/edit triggers exist, setup refuses and retains them.
5. Run the separate managed Forms and native input setup procedures while paused.
   The standard three managed Forms install three submit triggers; two native
   workbooks plus the confirmation Form install three more triggers. Keep Forms
   closed and review the existing baseline/physical slot readback before any
   explicit consumer resume. Setup does not resume frontend, input, Forms, mail,
   permissions, maintenance or History.
6. Verify the intended staging Worker, generation, registered sources, explicit
   principals and private checkpoint ownership. Keep notifications suppressed
   until their separate owner-only rehearsal. Run the native workflow and failure
   tests, then pause every consumer between rehearsals.

`shamrockV3StagingResume` refuses in native-only mode. The old attendance,
excusal and technical decision handlers remain inert even if the old enable flag
is accidentally set. The scheduler skips the old transport host completely while
continuing the modern consumers' controls and explicit gates. Original projection
initialization/repair calls return `native-only` without touching storage.

If an existing independently configured History publisher remains in the fictional
script, leave its checkpoint there; do not bind a second scheduler to that state.
See [native input](D1_NATIVE_INPUT.md), [managed Forms](D1_MANAGED_FORMS.md),
[frontend publication](D1_FRONTEND_PUBLICATION.md) and the
[staging runbook](D1_STAGING_RUNBOOK.md) for their separate acceptance evidence.
Local tests establish bootstrap/routing isolation, not live OAuth, ordinary-user
editor identity, FilterView coordinates, protection enforcement or production readiness.

## Adopting existing staging protection guards

A verified populated baseline can still retain an older initialization guard.
Native input setup requires the exact managed protection policy across both
workbooks; owner-only sharing and an equivalent-looking whole-sheet guard do not
substitute for that policy. Inspect the guard IDs, ranges, descriptions, editors
and unprotected ranges before setup. If the reviewed guards are the original
initialization guards, use the existing protection planner's explicit adoption
input for only those IDs. Simulate the plan, apply its bounded metadata updates,
and verify the exact closed policy and an empty second repair plan. Never delete
all guards, reopen editable holes or weaken the assertion to clear setup.

Read every populated Table back against the retained baseline and compare native
validation, styles, dimensions, Tables, filters and charts before and after the
adoption. Preserve the pending setup control when failure occurred before its
receipt was consumed; a later scheduled retry can finish the same reviewed setup.

In the November 17 UTC real-data staging rehearsal, explicit adoption of 15
existing owner-only guards preserved all compared values and presentation. The
next scheduled setup completed and bound 562 physical rows across Directory,
Leadership, Attendance, Blue and Gold. The owner's live Triggers page confirmed
seven triggers, and Executions confirmed the successful scheduled run. All four
Forms remained unpublished and closed. This establishes paused setup, not native
submission, decision, non-owner access or production acceptance.
