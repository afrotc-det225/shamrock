# Administrator panel: hosted staging

This Worker serves the same administrator interface with verified Google sign-in,
separate D1 session/proposal persistence, and a service binding to an explicitly
reviewed fictional or private real-data staging backend. It cannot select a production environment. The production
Apps Script system is unaffected. Do not deploy `local-fixture.ts` or the Node
owner-local server.

## Provider setup

Coordinate with the main migration release owner. Use the existing free Workers
plan, free D1 capacity, and workers.dev address; no Cloudflare Access subscription,
paid model, custom domain or GitHub subscription is required.

1. Build with `node apps/admin/build-domain.mjs`,
   `npm run build --prefix apps/admin`, and
   `node apps/admin/build-hosted.mjs --release` from a committed checkout. The
   generated `.build/admin/hosted-release.json` pins source, Worker, schema and
   every static asset by SHA-256; release mode refuses dirty imported source.
2. Create a separate session database and use `installPanelSchema` from `setup.mjs`
   with a committed source hash and provider callbacks that inspect/apply/read back
   the exact target. It refuses a nonempty/mismatched database, pins the schema hash
   in `panel_schema`, and includes a transactional empty-database assertion. Apply
   its ordered statements atomically; never execute the raw schema blindly. It is
   independent of the operational migration ledger. Record its schema hash and
   deployment binding in the private operations record.
3. Make a private resolved copy of `wrangler.example.jsonc`. Its database ID,
   origin, backend service, bridge key ID, generation and source must agree with
   the reviewed fictional staging release. The main file is
   `.build/admin/hosted-worker.mjs`; static assets are `apps/admin/dist/`.
   Resolve paths relative to the private configuration's directory.
4. Register a distinct `test` source named `admin-staging-web` in the fictional
   backend. Do not impersonate a Google spreadsheet source. A future production
   release needs a dedicated web/admin source contract, migration and audit tests.
5. Create a Google OAuth **Web application** client in the project-owned Google
   Cloud project. The exact callback is
   `https://shamrock-admin-staging.det225.workers.dev/auth/callback`.
   Only `openid email` scopes are requested; no Sheets, Drive, Forms, refresh
   token or offline access. No browser Google SDK or JavaScript origin is required
   for this server-side flow. Follow Google's consent-screen test-user settings
   while the client remains in Testing.
6. Store `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `BRIDGE_SECRET` as Worker
   secrets from the shared vault. Never add them to source, a public config, logs,
   chat or the browser bundle. Provider settings are the runtime configuration;
   successors do not need to inherit an environment file.
7. Map the operator's **verified Google subject** to the reviewed existing D1
   principal in `identity_bindings`. Obtain the subject through a verified Google
   identity flow; never infer it from a submitted email. The same operational
   principal must be active and hold the required backend grants. For a reviewed
   new staging login, the one-time invitation below obtains the subject during
   that account holder's actual hosted sign-in. There is no public enrollment or
   grant endpoint.
8. Deploy only the separate administrator staging Worker and verify the checks
   below. Preserve the original production resources and command gates. Resume
   only the fictional staging mutation gate when the coordinated test requires it.

The target hosted compatibility date is November 16, 2026. The locally installed
workerd currently supports an older date; emulator tests use the existing July 1
baseline. Those tests are not evidence for the hosted compatibility date. Verify
the actual deployed Worker through the hosted acceptance checks.

For the private real-data preview, set `STAGING_DATASET=real` and
`BACKEND_SERVICE_NAME` to the reviewed isolated service ending in `-real-parity`.
Its exact HTTPS origin must be that service's first hostname label under the
account's `workers.dev` subdomain, without a port or path. Verify the actual
`BACKEND` service binding matches this name, then bind the matching bridge key,
generation and verified administrator principal. These are private deployment
settings, never browser inputs. The fictional default retains its separate
staging backend. Do not rebind an existing Google subject based on a supplied
email, merge fictional receipts into real history, or enable operational intake
merely to view records. Record the data capture date and import comparison in the
private release evidence; a real dataset flag does not establish currentness.

### One-time reviewed staging login

Apply `migrations/0004_login_invitations.sql` to the separate panel session database
after its earlier migrations, and record the exact schema hash in the private
release evidence. Leave the base `schema.sql` hash unchanged. An operator may
privately insert a `login_invitations` row only for an explicitly reviewed account
and an existing, appropriately scoped operational principal. Store the SHA-256 of
the account email lowercased without whitespace, the principal, and integer
`created`/`expires` milliseconds; expiry must be no more than 24 hours after creation.
Leave both consumption fields null. Keep the invitation count below 2,000, remove
expired unused invitations during reviewed maintenance, and retain consumed rows
as private enrollment evidence. No UI or API creates invitations.

The account holder uses the normal hosted Google login with only `openid email`
consent. After signature, issuer, audience, nonce, PKCE and verified-email checks,
the callback hashes Google's signed email claim and atomically creates the subject
binding and consumes the matching unexpired invitation. No subject is inferred
from email. An existing subject is never replaced or reactivated, and a principal
that already has a login binding cannot acquire another through this mechanism.
Wrong, missing, unverified, expired or previously consumed invitations do not grant
access. Concurrent claims admit one subject; a failed consume rolls back its new
binding. Normal later sign-ins use the established subject, independently of the
invitation's expiry. This step does not create backend roles or prove native
Google Sheet/Form access.

## Identity and request protections

- Authorization code flow uses a browser-bound, ten-minute, single-use state,
  PKCE S256, and nonce. Login invalidates the browser's old session before account
  selection to prevent account confusion on a denied sign-in.
- `jose` verifies RS256 signatures from Google's fixed JWKS endpoint, issuer,
  client audience, authorized party, token age/expiry, nonce, verified-email claim
  and subject. Only the subject maps to the operational principal.
- Eight-hour opaque sessions are hashed in D1; cookies are Secure, HttpOnly,
  host-only and SameSite=Lax. Every request rechecks the active identity binding.
  The same indexed query reads the session's preview mode, avoiding a second D1
  round trip without caching authorization between requests.
  Logout deletes the session. Removing a binding immediately blocks later requests.
- Same-origin checks and a constant-time CSRF check protect writes. The Worker
  never trusts a browser-supplied principal, email, operation grant or bridge key.
- The backend independently checks the principal, exact operation grant, source,
  generation, mutation fence and optimistic record version. A Google login by
  itself grants no operational authority.
- Proposals are scoped to the principal and backend binding. A database lease
  prevents simultaneous application; ambiguous failures preserve the exact command
  for idempotent retry. A stale or rejected command requires a new review.
- Snapshot transfer and requests are bounded. Semester capture proceeds in saved
  batches; the UI continues those batches without requiring the operator to manage
  cursors. Large transfers that exceed the free-tier request budget fail closed.
- Display reporting runs in the browser using the shared pure reporting module,
  the fresh authenticated snapshot and a server timestamp interpreted in Eastern
  time. This avoids Worker ICU initialization and duplicate report serialization.
  These display results never authorize commands or supply trusted calculations
  to D1. Backend authorization, version checks and business validation still run
  for every change; no cross-user snapshot cache is used.
- The hosted assistant is disconnected. No staging records or private backend
  context go to CRC. This gate is independent of normal administrator operations.

Hourly cleanup removes bounded batches of expired authentication material only.
Unfinished/uncertain proposals are retained. Unsubmitted/rejected/cancelled records
expire after 30 days; completed panel receipts after 90 days. Operational audit
receipts remain in the backend. Authentication tables are capped at 2,000 rows;
sessions additionally at 20 per subject, and proposals at 2,000 total/500 per
principal with a 128 KB record bound. Limits fail closed without upgrading billing.
All request logging and tracing are disabled because
OAuth callback URLs contain transient authorization codes. Do not enable automatic
URL/body/header tracing on authentication routes. Operator data changes remain
audited in the operational backend; add only redacted event-code logs if needed.

If D1 explicitly rejects a request for exceeding its daily read or write limit,
sign-in returns `SERVICE_LIMIT_REACHED` rather than blaming Google credentials.
Authenticated API requests return HTTP 503 with that same safe code and a
`Retry-After` value for the next midnight UTC reset. No provider error details,
OAuth values or automatic retries are exposed. Stop hosted rehearsals until the
reset; do not upgrade billing or rotate working OAuth credentials to bypass this
limit. An ordinary SQL, token-exchange or identity error is not classified as a
daily limit. Free-tier exhaustion prevents authenticating and reading records;
health/static-page success alone cannot establish that sign-in is working.

## Hosted acceptance

- Public page loads the designed sign-in interface; anonymous `/api/state` and
  `/api/session` requests cannot access records or mint an authenticated session.
- Login redirects only to Google, with the exact callback and minimal scopes.
  Sign in as the explicitly authorized operator. Confirm the correct principal
  appears in backend audit evidence after a fictional change.
- An unregistered Google account is refused. Wrong nonce/audience/signature,
  expired or reused state, missing browser cookie, cross-origin writes and forged
  identity headers must fail. Automated tests cover these without live credentials.
- Rename a fictional event, read back D1, and verify attendance/excusal identifiers
  remain linked. Repeat a saved command and verify one mutation. Test a stale edit,
  a revoked backend grant and a revoked identity binding.
- Verify native Sheet/Form delivery separately using the main migration's paused
  rehearsals. Database acceptance alone does not establish Google publication.
- Verify free-tier request/CPU/D1 usage in the provider for the real hosted flow;
  never upgrade a plan automatically when a limit is encountered.
- Test sign-out and a fresh browser; there must be no local-owner bypass on the
  hosted Worker. Inspect logs for absence of tokens, callback query strings and PII.

## Recovery and handoff

### Verified staging evidence (November 16, 2026)

Release `fed4946` was deployed to the separate administrator staging Worker.
Public page and health checks returned 200; anonymous state/session requests
returned 401. A real Google account-selection/callback flow successfully opened
the panel with the explicitly registered staging operator. The dashboard showed
the fictional backend's 16 cadets, six events and three pending excusals;
attendance rows and percentages loaded. Signing out returned to the sign-in page.
Automated authentication, authorization and proposal tests passed (15 tests),
alongside browser workflow and mobile-layout checks. This evidence does not
establish production readiness or live spreadsheet publication parity.

The initial release had a measured state response above the free-plan CPU budget.
Display reporting was subsequently moved to the browser; its free-tier headroom
must be measured again on the hosted release before capacity is claimed.

OAuth credentials are held in 1Password under
`SHAMROCK administrator staging OAuth` in the SHAMROCK vault and deployed as
Worker secrets. Successor access to that vault still needs a separate handoff
check; creating the vault alone does not establish shared access.

Keep the signed-in administrator panel and all ordinary operations independent of
CRC. A successor needs the project-owned Cloudflare/Google accounts, shared vault,
and an explicitly registered personal Google subject with backend grants.

For an access incident, deactivate the relevant identity binding and backend
principal/grants, then delete their sessions. Pausing backend mutations is the
independent stop switch. Preserve proposal records when troubleshooting interrupted
writes; retry the same command only after checking its receipt. Do not clear an
active proposal lease to force a second write.

To roll back, restore the prior reviewed administrator Worker/assets version with
its compatible session schema and bindings. Do not roll back or overwrite the
operational database to undo a presentation deployment. If the auth database must
be restored, invalidate all restored sessions and OAuth states before reopening
access; old session tokens must not become valid again.

The main interface intentionally omits development badges. Its separate staging
hostname and these release records identify the environment. This presentation
choice does not connect production data or remove staging isolation.

## Paged panel transport and scoped commands

`/api/state` returns a fresh panel manifest and display metadata after session
bootstrap. The initial administrator Events list reads only verified terms/events
through an explicit `events-list-v1` profile (four page requests for the local
fixture, five for a 47-event fixture). Editors, the account-preview selector and
other current-data screens request a complete snapshot on demand. History can
load independently after authorization. These local counts are not hosted CPU
or end-to-end latency measurements.

At most two bounded `/api/page` requests run concurrently; each section's cursor
remains sequential. Exact zero counts in a strictly validated manifest eliminate
redundant empty pages. Completed profiles/captures publish only after final
revision verification; superseded navigation invalidates and aborts earlier work,
including waiters on the same session/bootstrap or capture promise. Full-capture
limits remain 512 pages and 16 MiB; no partial snapshot
or cross-user cache is displayed. An unchanged manifest reuses only this tab's
verified in-memory capture, keyed by backend/principal binding, generation, scope
and authority revision. Sign-in, logout or authorization errors clear it; every
refresh still asks the server for current authority and revision. Full administrator reads check the current panel
access fingerprint before and after every full-data page, including private lifetime
Directory/contact catalogs. Scoped reads use only the backend's panel pages;
request-only people stay in the excusal queue rather than entering the roster.
Changes to records or authority invalidate the capture. Session identity always
comes from the verified Google subject binding, never request JSON.

Scoped navigation exposes Attendance & excusals only. Flight Commanders can see
their authorized Flights without receiving private Directory/contact fields.
Blue/Gold decision authority comes from each server-authorized request's
`canDecide`; attendance correction controls follow the separate Flight capability.
Hiding controls is not authorization: both preview and apply check fresh backend
authority, and scoped decisions/corrections use `/v1/admin/panel/commands`, whose
scope predicate is checked inside the mutation transaction and on receipt replay.
Other management proposals and transition reads require current full panel access.
Existing Google Sheets permissions are unchanged.

Hosted proposals show parsed proposed values, not a claimed before/after diff.
They do not collect the full dataset to build a preview. Decision/correction
preflight checks the target versions; all actual writes retain the saved expected
versions and the backend's business validation. Apply never rebases a draft.
Semester previews show training weeks and proposed people changes; backend
preparation validates the actual roster. Each apply continuation captures at most
one preparation step. Interrupted operations retain the same command for retry.

These changes reduce per-request work; local tests do not establish the live
Workers Free CPU budget. Measure cold and warm `/api/state`, both page surfaces,
proposal/apply and transition continuation requests after each hosted release.
Do not raise billing tiers or claim production capacity from successful HTTP codes.

### Paged release rehearsal — 2026-11-17

The hosted administrator panel was updated through release `7cb46ed`, following
`8539c3b`'s paged transport and scoped UI. An existing authenticated owner browser
loaded the final page with the supplied shamrock and without the breadcrumb bar.
HTML, JavaScript, CSS and JPEG responses had the expected MIME types; unauthenticated
state requests returned 401. The HTML entry explicitly retains `text/html` even
when the asset-upload service retains stale binary metadata; `nosniff` stays on.

A programmatic five-minute session used only the already verified owner binding
for a fictional-data read/command rehearsal. Full capture returned 16 people,
7 events and 9 requests in 19 browser API requests. A saved decision preserved its
existing decision and reason, advanced its version once, and returned an identical
receipt on retry. Receipts omitted submitter/decider identity fields. Temporary
sessions and local session tokens were removed afterward. This was not a new
Google OAuth login test or a live ordinary-cadet access test.

Cloudflare's sampled request CPU maxima were 7.273 ms in the read window,
6.744 ms in the command/replay window for the panel, and 8.929 ms for its fictional
backend in the command window. Startup CPU was reported separately. All measured
successful operation requests returned 200. These bounded fictional rehearsals
met the 10 ms request target; they do not establish full real-data capacity, all
semester-transition paths, long-term daily quotas or every cold-start outcome.
Private operations records retain the request windows, release hashes and metrics.

All 25 admin tests passed, including scoped route denial, access revocation during
capture, atomic command scope, replay revocation and unchanged-data refresh. Local
Chromium desktop/mobile tests exercised the workflows, document scrolling, sticky
headers and reduced motion. A real non-owner Google account with a reviewed Flight
assignment is still needed for the final hosted scoped-account acceptance check.
Production remains unchanged.

### Account preview release gate

`View as` remains disabled until its operational backend and separate panel schema
are deployed and exercised together. In addition to panel migration `0002`, apply
`0003_preview_intents.sql` before deploying the integrated preview bundle. It saves
entry/exit audit request IDs before network calls, fences pending entry against
command apply leases, and prevents delayed entry responses from restoring an
exited session. Missing schema fails closed, including when the feature flag is off.

The browser carries a separate consistency token for each snapshot, catalog or
historical report. These tokens never choose the actor or target; the verified
session and server-side preview record do. Full-target state bootstraps the full
snapshot reader, whereas scoped targets use the scoped panel reader. Catalogs
start independent transfers and must still match the enclosing data revision.
The actual administrator remains the audit actor throughout. Local tests cover
real backend full/scoped transfers, wrong-entry tokens, revocation, pending entry,
interrupted entry/exit retries and delayed-entry cancellation. They do not prove
hosted CPU or another cadet's Google sign-in.

The Cadets table and View as selector use the same seniority, last-name,
first-name ordering as the spreadsheet Directory. Leadership keeps its separate
cadre, operational-role and rank ordering. Sorting is local to the displayed
list and never changes stable record IDs, snapshot paging or authorization.
