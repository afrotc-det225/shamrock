# Managed Forms and Directory self-service

Status: implemented for the isolated staging adapter, with local D1 and injected Google-port tests. This document does **not** establish live Google branching, cross-domain identity, production capacity or feature parity. Keep production on its existing runtime until the staging acceptance checks below pass.

## Supported workflow

The existing Attendance, Excusals and Directory Forms remain native Google Forms. Their existing item IDs, question IDs, response history, linked response destinations, descriptions and validation are preserved. Ordinary publication updates explicitly bound choice options with Google revision preconditions. It never deletes, moves or replaces existing questions. Optional reviewed Attendance layout provisioning adds missing AS-year checkboxes and Flight sections, using the existing private checkpoint and native continuation readback described below. Without that layout configuration, a Flight lacking an explicitly bound section stops publication.

Attendance event, Flight and cadet choices come from one coherent D1 snapshot. Explicit Flight, AS year and university filters preserve the existing Flight/crosstown question partitions; labels do not infer these partitions. Excusal event choices use the same event catalog. Directory choice lists use explicit private catalogs, matching the current nineteen-question Directory Form and its ten canonical dropdowns. Flight choices include empty Flights so a verified new cadet can enroll. Squadron is derived from the selected Flight in D1; its Form answer cannot grant a conflicting assignment.

Choices contain short, immutable twelve-character reference suffixes. Full catalog hashes stay private; a short-reference collision stops publication before any Form changes. The reference binds the original event/version, Flight roster/version or person. Publication retains old editions; submitting an older Form cannot silently target a different event or roster. Only changed catalog dependencies create another edition: an unrelated attendance observation does not rewrite Form choices. A response mixing editions or submitting a token to another question is retained for review. Required questions with no available choices keep the affected Form closed.

Native submission handlers fetch the response from the Google Forms API by its response ID. Verified responder email, question IDs and `lastSubmittedTime` establish identity and revision. The [native Forms response](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses) may contain zero through nine fractional timestamp digits; the journal preserves that exact timestamp. Backend numeric revisions use milliseconds, so a differing sub-millisecond revision conflicts rather than silently replaying another payload. Typed email, names, display labels and the installable trigger owner do not establish the human respondent. Every accepted native revision is captured in the private journal before commands are dispatched. Attendance with multiple events freezes one deterministic command per event; Excusals freezes one multi-event command. Retries reuse the exact command and source revision. New commands check frozen event versions; replay of an already committed command returns its original receipt.

## Additive Attendance sections and cohorts

The optional `ManagedFormBinding.attendanceLayout` uses `AttendanceLayout` in
`apps/google-adapter/src/forms-layout.ts`. It identifies the existing optional
checkbox template, section template, Mando/LLAB selector questions and section
anchors, crosstown university profiles, Secondary/Other section anchors and their
stable event-question IDs. Its review marker is
`OPTIONAL_UNVALIDATED_CHECKBOX_AND_SUBMIT_SECTIONS_REVIEWED`. The excluded Flight
labels explicitly include `Abroad` for the current detachment policy.

For every active Flight and AS year in the coherent D1 snapshot, the planner
keeps an existing cohort question or adds its missing counterpart. New Flight
sections append at the end; new cohort questions insert within their existing
section. Existing items retain their relative order and identities. Stable IDs
come from the private source binding and logical Flight/cohort key, with collision
checks. Each new section receives a verified Submit continuation, which also
preserves submission at the end of the formerly last section. No existing
section continuation is rewritten.

The new questions follow the current production policy: optional, unvalidated
checkboxes, with the reviewed template's native description and basic question
shape. Google [CheckboxItem](https://developers.google.com/apps-script/reference/forms/checkbox-item)
has no validation getter; this code does not claim to read or clone opaque
validation. It never clears validation on an existing question. A deployment
requiring validation on newly created cohort questions must explicitly extend
this reviewed template policy before release.

The complete create/update batch, final content, catalog and new continuation
IDs are saved before any mutation. Google supports caller-provided
[item and question IDs](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms#Item)
and revision-guarded
[createItem requests](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/batchUpdate#CreateItemRequest).
REST does not expose page-break continuation settings. The native host reads
those through FormApp, cross-checks item order/title/type against REST and checks
the REST revision again. It finishes only the newly created page breaks through
[setGoToPage](https://developers.google.com/apps-script/reference/forms/page-break-item#setGoToPage(PageNavigationType)),
with exact readback before acknowledgement or reopening. The script lock is
cooperative serialization; the API and FormApp phase are not one transaction.

If REST creation succeeds but its response is lost, replay recognizes the exact
saved content and does not create duplicates. If only some new continuations
were finished, replay accepts only their saved Continue/Submit intermediate
states and finishes the remainder. An unrelated edit, changed original
continuation, unknown cohort, expired lease or missing template stops the work
with intake closed. Retained editions include the exact generated cohort IDs
and per-event intake rules, so an older response still uses its original roster.
A cohort that later empties keeps its question identity but loses stale cadet
choices; the prior catalog stays available for genuine old responses.

The hard limits remain **300 total Form items**, with at most **250 managed
choice bindings** for additive Attendance and **150 creations per publication**.
Non-additive Forms retain the 150-binding limit. A local synthetic capacity
rehearsal with six Flights, all eleven canonical AS-year values and both
crosstown groups fit in 227 items, 199 bindings and 119 additions from the copied
108-item layout; its native request was approximately 94 KB. This measures the
bounded planner, not live Google quota or execution-time capacity. Bounds fail
before provider writes and never delete history. Active cadets without a
reportable Flight also stop publication instead of disappearing silently.

Before release, add a fictional Flight and previously absent AS year through
staging, inspect both Mando and LLAB navigation, submit the new cohort, empty it,
replay an old response and rehearse interruption between REST creation and
native continuation completion. The local injected-port tests cover these
contracts; live Google acceptance is still required.

## Directory activation and personal changes

The approved policy automatically activates a new **verified** Directory respondent. A bound initial Flight and AS year, first/last name and verified account are required. The backend links an existing unique profile with that email or creates a stable person and principal atomically. New profiles start at `C/AB`, blank Role and `Active 3/4`; they receive only their own `excusal.submit` capability. Claimed rank/Role cannot grant Leadership, management or Flight-wide attendance authority. Repeated enrollment does not restore a removed capability. Revoked principals, duplicate email matches, conflicting identities and previously inactive profiles require a Directory manager's review rather than undoing deliberate deactivation.

Existing cadets may change their own first/last name, university, phone, dorm, CIP broad area/code, AFSC, hometown/state, class year, date of birth and photo link. The command freezes the Directory version from the submitted catalog; stale changes conflict instead of overwriting a newer manager edit. Operational field proposals remain in the private review queue. An existing profile linked during enrollment retains its current operational fields; the initial link does not overwrite that profile.

Photo synchronization validates the actual Drive file ID and image MIME type, preserves the original URI including its resource key, and changes no sharing. The image inspection supplies the URI's resource key through Google's documented [Drive resource-key header](https://developers.google.com/workspace/drive/api/guides/resource-keys). The frontend publisher uses that authoritative URI for its native file chip. A displayed chip label is never a photo identity. Unsupported/external URLs or unavailable files remain reviewable, rather than being substituted with a guessed URL.

`shamrockV3ManagedDirectoryReviewQueue()` and `shamrockV3ManagedDirectoryReview(input)` require the authenticated active Google account to map to a principal with current Wing `directory.manage` authority. The reviewer supplies a fully reviewed profile, person/Flight and current expected version. The API never merges an old proposal into a fresh profile silently. Review input goes through the ordinary audited `directory.upsert` command. A committed enrollment receipt also saves the verified account/person mapping privately for subsequent self-service excusals; D1 still rechecks current principal, membership and capability on every command.

## Private configuration and storage

The optional `SHAMROCK_V3_FORMS_CONFIG` entry belongs in the existing automation-owned private configuration JSON. Prefer a string containing this pointer, using an actual private file binding outside Git:

```json
{"version":1,"configFileId":"FORMS_CONFIG_FILE_ID"}
```

The pointed owner-only JSON contains `NativeFormsConfig` from `apps/google-adapter/src/forms-native.ts`:

- `version: 1`, `environment: "staging"`, the current generation, `resourceReview: "EXISTING_FORMS_REVIEWED_FOR_STAGING"`.
- Independent `enabled` publication and `intakeEnabled` booleans, initially false.
- The authorized publishing `principalId`, `workerId`, two separate owner-only JSON file IDs (`stateFileId`, `intakeFileId`), and a registered `reviewResourceKey` for manager commands.
- The explicit existing principal registry. Only verified committed enrollment receipts may extend the cadet mapping; it never extends manager authority.
- Exactly three `forms` bindings. Each contains `key`, exact Form ID/title, registered source key, exact allowed editor emails, expected linked Sheet ID when present, explicit choice item/question IDs and sources, and the corresponding intake field bindings. Titles must contain `Staging`, ownership must match the configured automation account, and sharing must match the explicit named writers. No public/domain permission is accepted.

Choice source kinds are `events`, `flights`, `people` and `directory`. Optional event type/Flight and person Flight/AS year/university filters are explicit. `profiles` sources bind named Flight/crosstown roster groups; `categories` sources retain only currently populated event categories. `attendanceProfiles` freezes implicit Secondary/Other rosters. Intake `attendanceRules` selects exact event, scope and presence question IDs plus an explicit completeness policy for each branch. Legacy branches use partial reports, partitioned by the frozen actual Flight; selections from another event-type question cannot leak into that report. Every resulting Flight command still requires current backend authority. `navigationDefault` binds new event choices to a reviewed existing section. `canBeEmpty` is allowed only for a reviewed unreachable/optional empty branch; do not use it to bypass a required visible question. Existing conditional navigation is configured by stable target ID to an existing section ID or valid Google navigation action. Intake uses question IDs, not item titles or response Sheet column positions.

Initialize the two private documents as follows, replacing the generation privately:

```json
{"version":1,"environment":"staging","generation":1,"editions":{},"current":{}}
```

```json
{"version":1,"environment":"staging","generation":1,"entries":{}}
```

Storage stays in automation-owned Drive, so successors do not exchange `.env` files. The existing host supplies the signed Worker transport and secret. Configuration import leaves publication and intake paused and keeps this optional configuration file-owned. Each private state update checks its prior Drive version under the script lock, writes the JSON, then reads it back and compares canonical content. This is cooperative serialization, not a Drive transactional compare-and-swap against an owner editing outside the adapter.

Private documents are limited to 5 MB; retained catalog content stops before 4 MB. Capacity exhaustion stops publication without deleting historical references. Long-term catalog/journal archival and representative multi-year size measurements remain a release gate; no automatic history deletion or unbounded storage promise is implemented. All work uses the existing free Google/Cloudflare resources and adds no paid service.

## Setup, publication and recovery

Use the [Google authorization scopes](D1_GOOGLE_AUTHORIZATION.md) for the committed staging artifact. The old staging intake gate must remain paused while managed intake is enabled; this prevents both handler families from accepting the same native response. Existing old triggers may remain installed and return paused.

1. Bind the three existing staging Forms and private documents. Check question/section IDs, VERIFIED email collection, response destination and exact ACLs. Keep configuration gates false initially.
2. Run `shamrockV3ManagedFormsSetup()`. It closes the three Forms, verifies identity collection and installs exactly one trigger for each managed handler, replacing only duplicate managed triggers. Repeated setup is idempotent and leaves intake paused.
3. Enable only the reviewed publication configuration and run `shamrockV3ManagedFormsResume()`, then `shamrockV3ManagedFormsRefresh()`. The existing five-minute flush also invokes the optional consumer independently of old intake.
4. A `forms.refresh` claim projects one coherent D1 snapshot. All three plans and catalogs are saved before any Form content changes. All Forms close before writes. Each write uses a freshly read Google revision precondition; all three final destinations must verify before the shared checkpoint and acknowledgement. This is recoverable multi-Form work, not cross-Form atomicity.
5. After verified publication and trigger setup, explicitly enable the private intake gate and run `shamrockV3ManagedIntakeResume()`. It checks all published fingerprints and opens only Forms with usable required choices. Native Form publishing/access settings themselves remain an explicit reviewed provider setup step.
6. `shamrockV3ManagedFormsPause()` persists both local pause flags and closes the managed Forms. General staging Pause attempts the legacy, frontend and managed Form pauses even if another pause fails. `shamrockV3ManagedFormsStatus()` returns counts, not cadet data.

Partial or ambiguous publication retains the frozen plan and closes all affected Forms. A retry compares each Form to the saved before/after content, skips an already successful write, and never regenerates the plan from a newer snapshot. A changed question/destination, altered completed Form or expired lease requires reconciliation; it is not overwritten or acknowledged blindly. The original claim remains in private state. Form ACK currently completes that claimed effect only, so accumulated backend Form effects drain individually.

Queued command dispatch retries the saved command after an ambiguous response. Conflicts/rejections remain visible in private intake status. A submission received while paused remains in native Google response history; after reopening the reviewed gate, `shamrockV3ManagedFormReplay(key, responseId)` rereads it through the same native identity and journal checks. It accepts no caller-provided answers. A captured journal entry interrupted before interpretation can resume; a committed revision is never dispatched twice. Bulk automatic backfill of all response history is not implemented.

## Required live acceptance evidence

Before claiming parity, use the staged copies to verify all existing branch paths, selected-event scope, choice/reference rendering, preserved item IDs/response destinations, edited-response revisions and old-edition response binding. Submit as a real non-owner account, verify automatic enrollment and self excusal submission, and prove another cadet's profile and managerial actions remain inaccessible. Confirm photo URI/file chip behavior with the real Drive permissions. Test a manager review and stale self update, a paused response replay, forced partial publication/recovery, private state readback and final pause. Record actual Google quotas, lease duration and retained-state growth for the target wing size. The local tests exercise code and injected ports; they do not substitute for those provider checks.

The same controls can be requested through the owner-only config without opening the
Apps Script editor. Optional `controlRequest` contains a unique `requestId`, increasing
positive `sequence`, `action` (`setup`, `resume-publication`, `resume-intake`, or `pause`),
and canonical SHA-256 hashes `stateSha256` and `intakeSha256` of the reviewed private
journals. The scheduled refresh verifies both checkpoints and consumes the request
once before performing that control. A retained request cannot override a later pause.
An interrupted control requires a fresh reviewed sequence. This controls only the
bound staging Forms; it grants no new identity or operational capability.

Private Form journals verify canonical prior content before every write and exact
readback afterward. Provider metadata-only Drive version changes do not invalidate
an otherwise unchanged checkpoint. Changed content still stops the operation.

The shared five-minute scheduler discovers private setup controls every tick. It checks current backend queue availability before full publication and uses generation/file-bound work markers to avoid rereading empty intake/publication checkpoints. Writes mark pending before persistence; an interrupted publication retains its pending marker. An hourly pass reconciles state even after an idle result. Direct native Form submission remains immediate. Configuration caching lasts one invocation only and excludes journals, Form content and provider write/readback results. See the [free-tier forecast](D1_FREE_TIER_FORECAST.md) for measured local idle-call counts and remaining hosted CPU/runtime gates.
