# SHAMROCK administrator panel

This is an isolated, local staging application. Its D1 database contains fictional
cadets and events. It does not change production or publish to Google. The intended
hosted address is `shamrock.det225.workers.dev`; this version is **not deployed**
there. Workers-native Google sign-in and D1 session/proposal storage are implemented under
`hosted/`. Provider setup and live account verification follow the [hosted staging
runbook](hosted/README.md), coordinated with the main D1 migration work.

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

- **Overview:** see current roster/event/request counts and common tasks.
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
- **Attendance & excusals:** choose an event and Flight, select **Correct**, choose
  the attendance code and enter a reason. On Excusals, select **Review**, record
  the decision and reason, then review/save. Overall and LLAB percentages use the
  shared reporting rules, not AI calculations.
- **Semester:** name the next semester, choose the first training-week Sunday and
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
photo-fetch recovery, or full historical report browsing. Those backend workflows
must gain reviewed UI controls before calling the panel a complete replacement for
all administration. Source-code bug fixes still require a development workflow.

The presentation now takes its navy, gold and Libre Franklin inspiration from
[Notre Dame AFROTC](https://afrotc.nd.edu/). Fonts are self-hosted open-license
Libre Franklin and Barlow Condensed; no licensed Notre Dame font files are copied.
The three-leaf SHAMROCK mark is an original vector. Environment information stays
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

Semester name, length and recurring meeting defaults come from the current term.
The first Sunday remains an explicit calendar choice; the system does not invent
Notre Dame academic dates. Preparing a semester records an automatic audit label,
not an additional OPLAN notes field.

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
