# SHAMROCK web panel

Cadets and staff use Google sign-in at [SHAMROCK](https://shamrock.det225.workers.dev/). One Worker serves the web panel and the signed records API. D1 holds cadet records, and the existing SQLite Durable Object holds sessions and proposals. The local development fixture uses fictional cadets and events. See the [site release guide](hosted/README.md) for configuration and verification.

The Cadets roster uses slate for AS-year progression and matched blue and gold shades for flights. Flight path statuses use blue, teal, and green, with dark green for Commissioned. Under **More fields**, CIP codes and broad areas share the color of their academic family, and officer AFSCs use the color of their career group. The exact names and codes remain visible. Empty and undecided values are gray.

On laptop screens the list heading and filters stay in place as the roster scrolls. The Cadets roster loads Google Drive photo thumbnails as rows come into view. A missing or inaccessible thumbnail shows the cadet’s initials. Under **More fields → Photo link**, in the cadet editor, and in **My profile**, open the source photo or use the Drive preview when the thumbnail is unavailable. SHAMROCK checks the signed-in viewer’s Directory permission before serving a privately published thumbnail. The original and inline Drive preview use the viewer’s Google access.

To publish or refresh Drive portraits, prepare a private JSON array of reviewed `{personId, photoLink}` pairs from the Directory. Use a trusted import or verify new associations before publishing, since cadets can edit their own links. Run `node scripts/prepare-directory-photos.mjs <custodian-google-account> <private-roster.json> <new-private-bulk.json>` using the SHAMROCK account’s Google CLI login. Upload the result with `wrangler kv bulk put <new-private-bulk.json> --namespace-id <HISTORY_FILES namespace> --remote`. Keep both files outside Git and the static assets. This uses the existing private KV namespace with separate keys for portraits. Rerun after a photo changes or is withdrawn in Drive. For immediate withdrawal remove its Directory link or delete its portrait key. A new link cannot retrieve a different person’s published thumbnail.


Attendance and History share the Overall and LLAB color scale from coral at 80% or below through amber to green at 100%. Blank and N/A marks are gray, Present is green, and Unexcused is white on deep red. Both matrices show Cadet, Overall, LLAB and event columns. Use the Flight and AS year filters or the Sort by menu to organize the rows. The code key opens from either page heading. Corrections are available on eligible current attendance cells. History displays the saved semester report.

## Try the panel

From the repository root, with the root dependencies already installed:

```sh
npm ci --prefix apps/admin
node apps/admin/build-domain.mjs
npm run build --prefix apps/admin
npm start --prefix apps/admin
```

Open `http://127.0.0.1:4173`. The host binds to loopback only. No Google account,
Cloudflare subscription, AI service, or environment file is needed. A local session
is established automatically; this is **not** hosted administrator authentication.
Do not publish or tunnel this server. The database principal is a fictional owner.

The app uses the actual Worker command handlers and local D1 through Miniflare.
Fictional state and proposal receipts persist under ignored `.build/admin/data/`.
Each migration fingerprint gets a separate fixture, preserving older local test
datasets without applying unreviewed upgrades to them. A changed schema therefore
starts a fresh fictional rehearsal. Local fixture state is not a backup of staging.

Browser validation on November 16, 2026 passed the full fictional save sequence:
event rename, cadet edit, excusal denial, attendance correction and semester
preparation/status. Nine automated tests passed, along with the frontend build,
the production TypeScript build and the changed-file privacy scan. A live CRC
procedure answer used the panel controls correctly after adding the operator guide
to its instructions; observed response time was 27 seconds. These results do not
establish hosted authentication, Google publication, or production readiness.

## Operator guide

- **Overview:** Wing readers see roster counts, birthdays and attendance charts when they open the page. Attendance averages show the percentage-point change from the preceding published semester. The birthday agenda groups names by date. Filter by flight, browse months, or select a calendar week. Reset returns to the default agenda for the selected flight. Hover, focus or tap a bar or semester point for its exact value. Use the semester chart’s selector to switch between Overall and LLAB.
- **Events:** find the existing event, select its name or pencil, edit its name,
  Attendance header, Eastern start/end times, location or notes, then select
  **Review change → Apply change**. Attendance and excusals stay linked. Do not
  create a replacement event to rename one. Advanced details contain the explicit
  expected roster, Flights, training week, display order and semester.
- **Cadets:** search for a cadet, open their record, update details or Flight,
  and review/save. Additional academic, personal and photo fields are collapsed.
  Mark a person inactive using Flight Path; do not delete their history.
- **Leadership:** update manual contacts and reporting/office details. A linked
  cadet's identity and role are edited under Cadets. Changing a title does not
  grant system access.
- **Attendance:** filter the current matrix by flight, event type, or training week. Select an eligible cell to review a correction, enter a reason, and confirm the change.
- **Excusals:** review the pending queue for your scope. Search by cadet or event, or filter by flight and decision status. Authorized reviewers can open a request and record a decision.
- **Semester planning:** name the next semester, choose the first training-week Sunday and
  weekly schedule, explicitly review cadet changes, and prepare the plan. Cadets
  retain their status unless explicitly changed. Preparation does not activate
  the semester. **Check progress** shows the archive state; activation is available
  only after a verified archive. The local fixture has no Google archive consumer,
  so it intentionally stops at the archive gate. Never fabricate an archive receipt.
- **System:** inspect saved changes. An interrupted request can retry its original
  saved command without duplication. A conflict requires reloading the record and
  reviewing a new change. A saved database change does not prove Google publication.
- **Assistant:** optional procedure help. It can read a non-personal aggregate
  summary and allowlisted project procedures. It cannot change data, execute SQL,
  modify code, deploy, or repair bugs. Core administration works when it is disabled.

The panel handles identities and version checks. Operators never enter record IDs,
API requests, SQL, or version numbers. When a record has changed, reload and review;
never guess a version, use zero, or increment it manually.

### Editor and preview loading

Leadership editors open from the authorized Leadership list, including contact versions and office and cell phone fields. Cadet editing fetches the selected Directory record when needed. A single event edit loads only that event’s roster assignments. Bulk scheduling loads the current semester’s assignments. View as opens immediately and reuses the displayed Directory roster or fetches a compact name list. Selecting a person checks their current access. System counts the roster and event-editor requests separately from Record pages.

## Hosted staging Assistant

Only the configured Google subject with current Wing access can ask a question. View as disables chat. The Assistant routes each submitted question automatically. Procedure questions use the operator guide. Wing reporting uses the same access-checked dashboard and semester averages as Overview. Only selected aggregate numbers and term labels are passed to OpenAI. Keep personal details out of questions.

The real-data staging Worker requires secret bindings `ASSISTANT_OWNER_SUB` and `ASSISTANT_KEY`. Match the subject to the verified maintainer login. Rotate the dedicated restricted key with write access to Decisions and Responses before its expiry. Review model prices and the credit grant at rotation. Remove the key binding to disable service. Keep paid recharge off for a credit-only installation.

Both staging hostnames use the same Durable Object spending ledger. It atomically reserves at most 200 five-cent allowances in any rolling 32 days ($10 across all SHAMROCK Assistant traffic), with at most 32 messages per rolling day. Direct questions reserve one allowance. Other questions reserve three before routing or generation. Failed and interrupted dispatches retain the reservation. The ceiling covers this application at the documented model tariffs. Other clients using the OpenAI organization have separate usage.

The Decisions API selects intent and a reviewed source area from bounded chat text. Common unambiguous questions use local routing. An explicit Decisions permission or endpoint denial falls back to a bounded Responses classifier within the same reservation. Focused implementation jobs use GPT-5.3-Codex with up to 40,000 request bytes and 2,200 output tokens. If the request names one reviewed file or known function, the assistant uses that source for the change. A coding job can edit a primary file and up to two related files from the reviewed source catalog. Before tests start, every substitution must match the identified release exactly once. The conversation displays each affected file. Four pure-function areas run baseline and candidate checks automatically on new proposals in an isolated browser worker. Each new staging proposal queues repository checks automatically. The owner sees the result in the conversation, including when reopening it later. The detachment's public staging-runner workflow claims one private patch with a short-lived GitHub workload identity, fetches its exact public release, and runs the baseline and edited suites in isolated containers without network access. Each suite also builds the panel and runs the desktop, mobile and maintenance browser checks with Chromium and fictional data. The public run exposes only success or failure. A ten-minute schedule picks up queued work; GitHub can delay scheduled starts. An optional staging-only Actions dispatch token starts jobs sooner. Up to 20 jobs can be queued per rolling day. After passing tests, the owner may explicitly publish the tested change to a public review branch in the isolated runner repository. Only the committed code change is published. The original request, test logs and chat stay private. The runner has no write credentials for SHAMROCK.

## Optional CRC connection

The tested model is `qwen3.5:122b`, selected after a live model-catalog check and a
successful tool-call probe. That is limited integration evidence, not proof of
reliable autonomous maintenance. The host may receive `SHAMROCK_CRC_API_KEY` through
a private process environment populated from a vault. Do not put it in a tracked
file, browser bundle, screenshot, or chat. No credential is needed for ordinary UI
tests. Existing personal credentials are not a successor handoff solution.

CRC connectivity, account eligibility, model availability and usage limits may
change or end. The UI states that the assistant may be retired. There is no paid
fallback. Prompts are sent only when the operator asks the assistant; cadet records
are not automatically included. Questions can still contain information the operator
types, so avoid entering personal or sensitive records in this optional service.

## Architecture and controls

- React/Vite frontend; reusable components and feature screens under `src/`.
- Loopback Node host with exact Host/Origin checks, same-site HTTP-only session
  cookies, write CSRF checks, bounded input, and no generic backend proxy.
- Server-owned principal and source binding; no client-supplied email establishes
  identity. Production environment configuration is refused.
- Shared `captureOperationalSnapshot` reads current-term pages and lifetime
  Directory/contact catalogs with revision verification and transfer bounds.
- Shared domain parsers, optimistic versions and typed signed commands perform
  changes. The app does not edit backend tables directly for operations.
- Durable local proposals preserve the exact reviewed command and idempotency key.
  Known conflicts/rejections require fresh review; uncertain transport failures
  retain the request for retry. Completed receipts recheck operation authority.
- `local-fixture.ts` is only for fictional initialization and test inspection in
  local Miniflare. **It must never be a deployed Worker entry point.**
- The build outputs go to `.build/admin/` and `apps/admin/dist/`; they do not replace
  the main thread's `.build/v3/` or production Apps Script artifacts.

## Validation

```sh
node apps/admin/build-domain.mjs
npm run build --prefix apps/admin
npm test --prefix apps/admin
# Install a test browser once if needed:
npm exec --prefix apps/admin -- playwright install chromium
npm run test:browser --prefix apps/admin
npm run build
git diff --check
```

`SHAMROCK_CHROMIUM_PATH` may select an existing test Chromium binary. Browser tests
create a disposable fictional D1 fixture and an ephemeral loopback server. They
exercise event/cadet updates, excusal decisions, attendance correction, semester
preparation, navigation and mobile layout. They do not contact Google or CRC.

## Hosted staging and remaining work

The local Node host remains loopback-only. The separate `hosted/worker.mjs` is the
Workers-native entry point, with verified Google subject mappings, backend
per-operation authorization and a separate D1 store for sessions and proposals.
Follow [hosted setup and recovery](hosted/README.md); never expose the local-owner
session bootstrap or deploy the local fixture entry point. The hosted assistant
remains disconnected from all records. A new web/admin source contract is required
before production; the fictional rehearsal uses an explicitly registered test source.

Hosted acceptance must cover ordinary administrator roles, revoked identity,
concurrent edits, real-data sizes, snapshot fences, native Sheet/Form convergence,
archive restoration, hosted usage budgets and successor access. Final production
cutover is a separate approval after that evidence is complete.

### Presentation verification

The generated concept was checked against browser screenshots at 1488 × 1056,
with a separate 390 × 844 mobile check. Browser/IAB was unavailable, so the checks
used an isolated Playwright Chromium process. Direct image inspection covered the
navy sidebar and green/gold palette, navigation order, compact table typography,
editor/primary-action placement, and spacing/responsive behavior. The desktop
drawer was corrected to reserve page width instead of obscuring event statuses.
The search input's overlapping background was corrected. No page-width overflow
or JavaScript runtime error remained in the checked views.

Intentional differences from the concept: development badges are omitted from normal navigation; start/end fields show full Eastern datetimes; the editor
includes Location and collapsed roster details needed for the actual command;
typography is more compact. The screenshot is a design reference, not the shipped
interface. All controls are native HTML/React elements.

This first panel does not yet expose Flight/Squadron catalog administration,
permission grants, notification routing and closeout controls, bulk CSV operations,
photo-fetch recovery, or historical excusal request browsing. Those backend workflows
must gain reviewed UI controls before calling the panel a complete replacement for
all administration. Source-code bug fixes still require a development workflow.

### Historical attendance

Hosted administrators can open **History**, select a retained report, and filter
by cadet or Flight. Each source copy remains separate, including copies for the
same semester. The table preserves literal attendance codes and saved Overall/LLAB
percentages; it does not recalculate old records using current policy. Historical
identities without a current Directory link remain visible. The panel reports
saved-percentage mismatches without overwriting their evidence.

Reports load through bounded authenticated pages and appear only after the whole
archive has passed its hash/binding verification. Leaving the page or selecting
another report stops subsequent requests. Both sides of every hosted read check
current administrator access; scoped Flight/Squadron readers cannot fetch Wing
archives. Retained reports do not poll while open. This is separate from current
data's automatic refresh and does not expose historical excusal details.

Local acceptance on the retained November 6 capture covered all six reports
(510 rows), with every displayed attendance code matching its source report.
That loopback-browser check does not establish hosted CPU capacity or completeness
against later production updates. The hosted real-data binding remains a separate
release gate.

### Loading behavior

Hosted administrators initially load only the Events list: an explicit
`events-list-v1` profile containing verified terms and event rows. It is never
passed to attendance reporting or represented as a complete snapshot. The local
fixture uses four page requests (manifest, terms, events, verify), plus state and
session bootstrap; a 47-event fixture uses five page requests. Directory, rosters,
attendance and excusals are not fetched just to display this list.

Edit/Add/Change schedule fetch the complete verified snapshot on demand before
opening controls, retaining exact eligibility and Flight bindings. The View as
selector does the same only when opened. Other data screens currently load the
full snapshot; History can load independently after the access check. Navigation
aborts superseded reads and discards late results. The existing in-memory cache
is keyed by environment/actor binding, manifest/access revision and View as
revision; no private data is written to browser storage.
Opening an editor keeps the Events list visible with a compact loading status
and Cancel control. Repeat editor launches remain disabled until it finishes.
Returning to Events uses the list profile on a changed revision even after an
editor loaded a full capture. Every capture waits for the shared session bootstrap;
rapid navigation invalidates older waiting intents before they can start requests.
Throttled browser tests cover these races, including navigation to History while
an editor is loading. Mobile account controls occupy a separate row above navigation.

The initial loading view retains the page heading and table layout, reports actual
loading/verification stages, and offers Cancel/Retry. Its progress indicator counts
completed record groups; it is not an elapsed-time estimate. Motion is disabled
when reduced motion is requested. The site icon uses the same transparent SVG as
the panel mark.

Complete captures fetch at most two independent sections concurrently, keeping
each section's cursor sequential and reconstructing the original section order.
An exact, bounded manifest can establish that a section is empty; only those
sections omit the redundant empty-page request. Final revision/access verification
still runs, and duplicate, missing or invalid manifest entries fail closed.
In the local fictional fixture, a complete capture dropped from 17 page requests
to 13, plus the unchanged initial state request. This is a local request-count
measurement, not hosted CPU or wall-clock evidence. No browser-persistent data
cache or background prefetch was added.

Hosted `/api/state` also defers saved-change receipts. It returns
`receiptsDeferred:true` for the administrator's own full-access view and omits
inline `history`; missing receipts never mean an empty change log. Overview,
System and Semester load `GET /api/receipts` only while those screens are open,
show loading/error/retry states, and refresh after the parent state reloads
(including a saved apply). Leaving a screen cancels its receipt request. The
local fixture still accepts its existing inline history.

The receipt endpoint rechecks current full panel authority before and after the
bounded, indexed proposal query. It returns only the authenticated principal's
receipts for the exact backend binding, and View as rejects this route. Records
stay in component memory; no browser-persistent cache or background receipt
prefetch is used. `node tests/receipts.browser.mjs` exercises deferred loading,
failure/retry, System's saved-change retry and Semester's preparation history.

### School sign-in and cadet workflows

Use Google sign-in with the school address in the Directory. Google-managed accounts at the five partner schools can start registration. Registration collects Directory and academic details and creates an active cadet when submissions are open. An existing Directory record retains its assignments when connected. A recognized Gmail or Google Workspace address already used in the Directory can also sign in. For a campus Google cannot verify as its mail host, a custodian must confirm the account holder independently and associate the Google subject with the existing Directory principal. A matching address alone cannot claim that record. The Google consent audience must permit the account.

**My requests** lists each event, requested code, excusal reason, status and decision reason above the submission form. **Excusals** gives flight commanders and deputies read-only access to their flight’s requests. Blue and Gold squadron commanders can decide requests assigned to their squadron at submission. **My Flight** gives commanders and deputies their eligible Flight attendance roster, flags awaiting review and Flight duty assignments. A duty is a roster label and grants no access. Resolving a flag records the review. Attendance corrections use the existing attendance workflow.

Blue and Gold commanders land in **Excusals**, filtered to requests awaiting a decision, oldest first. Choose **All decisions** to inspect past decisions. The request keeps the Squadron captured at submission when the cadet changes Flight. Submissions and decisions share the existing processing and spreadsheet publication paths. While staging submissions are paused, users can read their records and administrators can preview both queues.

### View as

Permission managers with Wing access can select a person in **View as**. A linked cadet can report attendance, request a correction, and edit their own profile. Their Flight and Squadron roles govern additional actions. A verified leadership target can make scoped attendance, excusal and record edits through the proposal workflow. The selected person’s grants apply to each save. Unlinked Directory records are available for inspection until the cadet connects their own school login. Account linking and the owner Assistant require the actual account holder.

The sidebar account area identifies the effective person and provides **Exit view**. The session retains the administrator’s real identity. Delegated command IDs carry the audited entry ID, which identifies the administrator and the selected person. Switching people, exiting, or revoking access invalidates pending edits. A system-wide submission pause applies equally to direct and delegated saves. Semester transitions and system maintenance use the direct administrative workspace.

Entry and exit audit IDs are saved before network calls in `session_preview_intents`.
Interrupted entry remains read-only and offers Retry/Exit; retries reuse the exact
audit ID. An exit clears local mode transactionally before audit delivery and retains
a failed exit request for a later retry during that session. A delayed entry response
cannot recreate a cancelled preview. Session deletion removes these session-scoped
intents; completed operational audit records remain in the backend ledger.

Release requirements: apply `hosted/migrations/0002_view_as.sql` and then
`hosted/migrations/0003_preview_intents.sql` to the **separate
panel session database**, verify its schema/foreign key, and deploy the operational
backend's reviewed View as routes/audit migration before enabling
`VIEW_AS_ENABLED=1`. The base `hosted/schema.sql` hash remains unchanged; retain a
separate migration hash in the private release evidence. The new Worker reads the
preview table even when the feature flag is off, so a missing migration fails
closed. Turning the flag off prevents new entries but preserves existing read-only
sessions and permits exit. Do not deploy this bundle before that migration.

Local acceptance includes verified-actor preservation, mutation/header-bypass
rejection, entry/apply lease exclusion, revoked-access exit, and browser checks
for disabled changes, usable filters, reload persistence, no-access states and
mobile layout. Hosted dual-identity/CPU and real Google-account tests remain
separate deployment gates.

The presentation now takes its navy, gold and Libre Franklin inspiration from
[Notre Dame AFROTC](https://afrotc.nd.edu/). Fonts are self-hosted open-license
Libre Franklin and Barlow Condensed; no licensed Notre Dame font files are copied.
The mark uses the supplied shamrock silhouette as a transparent vector, without
a monogram, registration mark or background tile. The canonical SVG and transparent
PNG are in `assets/brand/`; their public copies are `/shamrock.svg` and `/shamrock.png`. Environment information stays
in deployment records and the separate hostname instead of dominating the interface.

## Internal-tool interaction rules

Use direct labels rather than slogans, introductory blurbs or redundant help.
Planning notes belong in the OPLAN. The panel does not collect event or semester
planning notes; existing event notes are preserved when editing other fields.
Audit reasons for attendance corrections and excusal decisions remain distinct.

The panel refreshes data every minute while visible and online, and when returning
to the tab after at least 15 seconds. Reads do not overlap. Open editors and dirty
semester forms pause background refresh; writes retain their original expected
versions and always receive fresh server checks. Failed refreshes back off to five
minutes and display a retry status. Successful writes force a fresh read.

A failed records read keeps a successful sign-in active and shows record-loading
guidance, never a change-receipt instruction. Mutation and sign-out failures keep
their actionable messages. Storage failures retry after 60, 120, 240 and then 300
seconds; a longer server `Retry-After` is respected. Focus and network-status events
share that deadline and cannot bypass or reset it. A successful read resets the
backoff. During an outage, editors stay mounted with their drafts preserved while
their native modal and all record controls are suspended; recovery restores them.
`node apps/admin/tests/records-outage.browser.mjs` covers read-error messaging and
retry bounds, and `node apps/admin/tests/outage-draft.browser.mjs` covers draft and
modal recovery. Both use fictional local data and make no provider calls.

Semester name, length and recurring meeting defaults come from the current term.
The first Sunday remains an explicit calendar choice; the system does not invent
Notre Dame academic dates. Preparing a semester records an automatic audit label,
not an additional OPLAN notes field.

The Events list keeps its columns aligned when filtered. On narrow screens, status appears beneath each event name. The list follows schedule order by default. Use Type to filter events or Sort by → Type to group them alphabetically by type, retaining schedule order within each group. On Cadets, Attendance and History, Default sorts by AS year and then name.

Events → Change schedule selects active events by semester, type and effective
date. Each preview shows the original and proposed Eastern date/time; moves stay
within the event's Sunday-based training week. Saving uses the existing audited
event command for each event, preserving its identity, roster and historical
links. The batch is not atomic: completed events remain saved after an interruption.
Retry in the open dialog reuses each saved proposal ID. Stale versions stop the
batch for review. It does not silently rebase changes or overwrite newer edits.

Flight Commander panel access must use server-scoped reads and trusted assignment
data; filtering a Wing snapshot in the browser is insufficient. Blue/Gold Squadron
Commanders retain excusal approval authority. Existing spreadsheet permissions
are unchanged. The third-hour attendance policy is unchanged until a versioned
configuration workflow and its parity tests are implemented.

The page heading supplies context without a duplicate breadcrumb bar. Desktop
list controls stay at the top when scrolling. The document owns vertical scrolling, avoiding nested scroll regions on trackpads.
Tables scroll horizontally only when needed, retaining the first identifying
column. Column headings stick on tables that fit horizontally. On small screens,
filters scroll normally so they do not consume most of the viewport.
The sidebar marks the current page with a gold icon and short underline rather
than a filled selection box. Flight labels, event types and decision states have
color cues alongside text; attendance rates include a small proportional bar
without introducing new pass/fail thresholds. Editors and feedback use brief
transitions only when the user has not requested reduced motion.

In the real-data staging panel, **History → Semester** opens the latest saved attendance sheet. Choose an earlier semester to view its roster, saved Overall and LLAB percentages, and event codes. Flight, AS year, and cadet-name filters apply within the selected semester. The duplicate backend matrix and alternate workbook copies are retained for reconciliation. The [History runbook](../../docs/runbooks/D1_HISTORY_REPORTS.md#semester-reports-in-the-staging-web-panel) covers publication after an import.

### Successor maintenance workflow

In real-data staging, sign in with the designated maintainer account, open Assistant and describe the intended change. Describe the symptom and expected behavior with fictional examples. SHAMROCK selects the relevant committed source and shows the proposed changes against the exact release revision. Repository checks start automatically. Reopen the chat to see the result.

**Test with fictional data** runs the released and proposed functions separately in a browser worker using an isolated JavaScript interpreter. The table shows regression cases and any additional example supplied by the model. A pass applies only to the displayed case. Four pure functions have executable cases: the excusal queue, birthday agenda, cadet comparator and Sunday closeout code. The hosted runner checks the released source and proposed edits independently. After a pass, review the diff and choose **Publish tested change to a public review branch** to create a Git commit in the staging runner repository. A maintainer must promote that commit separately. Google provider behavior requires a separate staging rehearsal.

On phones, the Assistant shows the three most recent saved conversations above the composer. Open **Recent chats** for the full list. Returning to the app refreshes history if its last check was more than a minute ago. A loading ring marks the selected chat while its transcript and Markdown formatter load together. If reply formatting fails to load, the conversation still opens with the original text. Loading and retrying history spend no model credits.

Commissioning forecasts use the active AS400 cohort and compare archived AS-year headcounts by academic year. A roster snapshot is evidence of cohort size; actual commission totals require outcome records. Other operational context covers GMC/POC progression, Field Training exceptions, Flight and Squadron roles, LLAB and PT, crosstown attendance, duty coverage and AFSC preferences. The model receives reviewed program context and authorized aggregates.

Recognized standalone workflow or Wing summary questions reserve one slot. Other requests reserve three slots before routing through Decisions. The router receives bounded recent chat and the list of reviewed source areas. Focused patches use GPT-5.3-Codex with low reasoning (40,000 bytes and 2,200 output tokens). Architecture questions use GPT-5.4 with high reasoning (9,000 bytes and 2,000 output tokens), with excerpts from up to three reviewed files. Both modes share 200 slots per rolling 32 days, 32 submissions per rolling day, with immediate follow-ups allowed. Three five-cent slots reserve fifteen cents. The test button runs locally and spends no API credits. The model credential belongs to the credit sponsor. At handoff the successor can use the same authorized SHAMROCK account. Before retiring the sponsor credential, replace the staging secret with a restricted key with write access to Decisions and Responses from the successor's funded project, check current pricing, and verify the routing receipt on a fresh panel question. For immediate hosted test starts, renew the staging runner token before its GitHub expiration. Limit it to the staging runner repository with Actions read/write permission and update the STAGING_RUNNER_DISPATCH Worker secret. Scheduled pickup remains available during rotation.

Wing Leadership and View as roster data share private server-side catalog entries across authorized Wing accounts at the same database bookmark. Individual Directory edits retrieve one cadet in the authorization transaction. Full snapshot consumers use the last returned person/event pair to continue attendance baseline pages, including explicitly selected semesters. Returned pages and manifests can be reused for the same signed request at the same bookmark. The System usage table measures this tab. Account-wide D1 totals also include native publication, imports and other clients.

Semester planning groups active cadets by current AS year. For Fall to Spring, AS100/150 default to AS100 and AS200/250 to AS200. For Spring to Fall those groups default to AS200 and AS300, and AS300 defaults to AS400. Active AS400s stay AS400 from Fall to Spring. From Spring to Fall their default outcome is Commissioned, retaining AS400 on their record. Use an individual exception for delayed commissioning or continued enrollment. Other AS years, AF Civ and unrecognized term directions initially retain their current classification. Review cohort destinations, then search for individual exceptions. Adding an exception holds the cadet's current AS year until a different one is chosen. Removing it restores the group rule. Flight and Flight Path status can also be changed individually. Only changed records enter the version-checked semester proposal. Operators review commissioning and Field Training outcomes before semester activation.

The panel keeps the last loaded page visible while opening another page within the same session. The previous page is temporarily read-only during the switch. Visiting the sign-in link with a valid SHAMROCK session returns to the workspace. Expired or revoked sessions follow the Google sign-in flow.

Workspace navigation uses bookmarkable links, such as `/attendance` and `/me/profile`. Refresh, opening a link in another tab, and browser Back and Forward preserve the requested page. Leadership pages use top-level paths. Personal pages use /me/. Existing query-string bookmarks resolve to the corresponding path. Existing sign-in and role checks still determine what the viewer can open.

History opens with the semester selector and roster filters already in place. The hosted archive returns its semester list and latest published report together. Choosing another semester loads that report on demand.

The hosted Assistant lists recent conversations for the authorized maintainer. Completed exchanges expire individually after 90 days in the existing private history KV namespace. Reopening a conversation reads its transcript without requesting a model response. Follow-ups use the existing bounded context and budget.
