# Managed Forms and Directory self-service

Status: implemented for the isolated staging adapter, with local D1 and injected Google-port tests. This document does **not** establish live Google branching, cross-domain identity, production capacity or feature parity. Keep production on its existing runtime until the staging acceptance checks below pass.

## Supported workflow

The existing Attendance, Excusals and Directory Forms remain native Google Forms. Their item IDs, question IDs, response history, linked response destinations, descriptions, validation and section structure are preserved. Publication updates only explicitly bound choice options, with Google revision preconditions. It never deletes, moves or recreates questions. Existing branches require explicit stable destination bindings; adding a Flight that lacks a reviewed branch stops publication.

Attendance event, Flight and cadet choices come from one coherent D1 snapshot. Explicit Flight, AS year and university filters preserve the existing Flight/crosstown question partitions; labels do not infer these partitions. Excusal event choices use the same event catalog. Directory choice lists use explicit private catalogs, matching the current nineteen-question Directory Form and its ten canonical dropdowns. Flight choices include empty Flights so a verified new cadet can enroll. Squadron is derived from the selected Flight in D1; its Form answer cannot grant a conflicting assignment.

Choices contain short, immutable twelve-character reference suffixes. Full catalog hashes stay private; a short-reference collision stops publication before any Form changes. The reference binds the original event/version, Flight roster/version or person. Publication retains old editions; submitting an older Form cannot silently target a different event or roster. Only changed catalog dependencies create another edition: an unrelated attendance observation does not rewrite Form choices. A response mixing editions or submitting a token to another question is retained for review. Required questions with no available choices keep the affected Form closed.

Native submission handlers fetch the response from the Google Forms API by its response ID. Verified responder email, question IDs and `lastSubmittedTime` establish identity and revision. The [native Forms response](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses) may contain zero through nine fractional timestamp digits; the journal preserves that exact timestamp. Backend numeric revisions use milliseconds, so a differing sub-millisecond revision conflicts rather than silently replaying another payload. Typed email, names, display labels and the installable trigger owner do not establish the human respondent. Every accepted native revision is captured in the private journal before commands are dispatched. Attendance with multiple events freezes one deterministic command per event; Excusals freezes one multi-event command. Retries reuse the exact command and source revision. New commands check frozen event versions; replay of an already committed command returns its original receipt.

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
