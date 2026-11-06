# SHAMROCK account handoff

Transfer operational responsibility while preserving the existing production script, spreadsheets, Forms, response history and links. This is separate from the D1 migration; the [production operator runbook](OPERATOR_RUNBOOK.md) remains authoritative for current workflows. Keep real accounts, resource IDs, permission inventories and recovery material out of this public document.

## Current checkpoint

During the November 5, 2026 local-time handoff, the incoming automation account accepted ownership of all six privately owned production resources: the three Forms, Excusals Management workbook, Backend workbook and Apps Script project. Read-back confirmed the incoming account as sole owner, the outgoing account retained as writer, and no pending ownership requests. Other permissions, resource IDs, names and parents were preserved. Main and Archive remain in the Shared Drive with unchanged organizational ownership. All 55 protected areas remain editable by the incoming account, and all 27 production source files still match the baseline. The existing deployment inventory is unchanged and contains no active web-app or API-executable entry points. Production still uses its existing default Google Cloud project and Indianapolis timezone.

The production trigger cutover is complete. The outgoing account's 11 triggers were removed and its empty trigger view verified before replacements were installed. The incoming account ran the existing Backend **Reinstall triggers** menu; it completed at 19:45:51 local time after approximately 22 seconds. The incoming view then showed all 11 canonical handlers owned by that account; the outgoing view showed the same 11 as `Other user` and none owned by it. A fresh diagnostic confirmed all handler/event types, seven exact resource bindings and four clock triggers. The clock schedules were checked against the prior configuration: every ten minutes, daily at the 03:00 and 05:00 hours, and Sunday at the 17:00 hour.

The maintenance hold ran from 19:37:26 to 19:50:04 local time. All three Forms were temporarily closed and 33 temporary protections held ordinary edits across Main, Backend and Excusals Management. After verification, all three Forms returned to their original open states, all 33 temporary protections were removed, and their 34 original protections were unchanged. Form response counts and identity/timestamp hashes remained unchanged through the hold. All three response destinations still point to the original Backend. All ten Script Properties, including the saved July transition state, are byte-identical to the pre-cutover baseline taken after the earlier allowlist repair. Final read-back confirmed all six ownership transfers, all 55 protected areas editable by the incoming account and all 27 source files unchanged. No production code deployment occurred.

The new account's automatic Directory reconciliation completed at 19:46:39. After intake restoration, reloading Backend displayed the SHAMROCK menu and the new `onBackendOpen` trigger completed at 19:51:35. Two structure-dump diagnostic executions yielded usable snapshots but displayed `Failed` because an existing helper attempts to open a Form as a spreadsheet. Independent Forms API checks confirmed the original bindings and settings; that diagnostic defect was not changed during the account switch.

The existing production Forms were found to use `RESPONDER_INPUT` email collection for all three Forms. This is responder-entered email, not verified Google account identity. That setting is preserved during this account switch; it must not be represented as verified-email intake. Changing the identity workflow is separate from transferring the existing operational system.

A separate two-account audit identified protected-range gaps, repaired by adding only the incoming account to 42 existing editor lists: 16 Main, nine Excusals Management and 17 dedicated Archive ranges. Final incoming-account read-back is affirmative on all 55 protections: 18 Main, seven Backend, nine Excusals Management and 21 Archive. Existing editors and all other protection fields were preserved by the targeted permission repairs. The incoming account was also added to the existing Main runtime allowlist and verified after reload, with the other nine Script Properties unchanged. Main, Backend and management access remained affirmative after the actual reconciliation rebuilt protections. All 27 production source files still exactly match the pre-handoff snapshot; no production code deployment occurred.

The incoming account ran the existing historical-decision reconciliation before the cutover, after a bounded in-memory check. Two prior approvals and their attendance effects were repaired in production; newer attendance was preserved and notifications were not resent. This changed the affected production records, without changing source or trigger ownership at that stage. The private checkpoint holds the counts, audit/read-back evidence and the separate limits of the completed historical failure review. Observation of the next legitimate production submissions, decisions and mail, plus successor recovery custody, remains outstanding; no test submissions or notification sends are claimed by this checkpoint.

## Establish the baseline

Record the following in restricted operational storage, with credential recovery in the shared password manager. Repository notes should contain logical names and recovery instructions, not raw runtime bindings or secrets.

- The deployed source commit, existing Apps Script project, manifest/timezone, deployments and their execution identity, plus the matching private local deployment configuration. Do not create a replacement project or change the production deployment target.
- Every configured workbook, Form, response destination, archive and parent location: logical purpose, owner or Shared Drive, inherited/direct permissions, current sharing restrictions, and the incoming account's effective access. Verify all six access grants from that account, including opening the existing script and reading its settings.
- All current Script Properties, preserving their values in approved restricted recovery storage. Include resource bindings, editor allowlists, formatting flags, resumable operation state and any delivery/reconciliation state. Do not run property cleanup or reset during the handoff. The documented key catalog is [Config properties](../../src/config/properties.ts); it is not a substitute for inspecting the actual project.
- The associated Google Cloud project: default versus standard, project identity, enabled APIs, OAuth client/consent configuration, access administrators and billing status. For a standard project, establish incoming administrative access separately from Drive sharing. Inventory existing settings before considering any Cloud project change; changing projects can require reauthorization and API reconfiguration. [Google Cloud project guidance](https://developers.google.com/apps-script/guides/cloud-platform-projects).
- Trigger manifests under the outgoing creator and any other known historic creators: handler, event type, source, schedule/timezone, trigger UID, creator and last successful execution. [`ScriptApp.getProjectTriggers()`](https://developers.google.com/apps-script/reference/script/script-app#getProjectTriggers()) lists the current user's project triggers; the installer cannot use that account-scoped list to remove another creator's set. The current Triggers UI can nevertheless display rows labelled `Other user`, as observed during this handoff. Inspect the relevant creator's account for management and exact bindings; do not infer global absence from an account-scoped API result.

Confirm no Form rebuild, term transition or other resumable operation is running. A one-time continuation trigger is an unfinished operation to resolve, not a duplicate to delete casually. Record the latest source-response counts/timestamps, backend row counts, last successful reconciliations and recent failures so a handoff gap is detectable.

## Authorize the incoming account without changing production

Use a browser profile signed in only as the incoming account. Open the **existing** production Apps Script project, select `getShamrockProgress` in the function selector, and run it with no arguments. Complete Google's consent prompts for that account. This function returns `null` for a missing/invalid run ID; it does not install triggers, process a Form, mutate a Sheet or send mail. Its implementation is in [src/index.ts](../../src/index.ts), with the invalid-ID guard in [ProgressService](../../src/services/progress.ts).

This authorizes the production script's existing requested scopes; it is not a resource-access test or trigger migration. A CLI login or Drive permission grant alone is not this authorization. Verify incoming access to each configured file separately. Do not select setup, trigger installation, notice dispatch, cleanup or replay functions as authorization probes.

## Verify protected-range access before cutover

File-level writer access or `capabilities.canEdit` does not establish permission to write every protected cell. Using the incoming account's credential, inspect Main, Backend and Excusals Management protections and verify `requestingUserCanEdit` for the ranges its workflows must update. Record the result separately from file sharing. Audit archive workbook/tab protections separately before relying on archive or transition operations. Google defines this field on [ProtectedRange](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets#ProtectedRange).

Current source has two different administrator lookups. [Excusals Management access synchronization](../../src/services/excusals.ts) resolves backend owners/writers through paginated Drive permissions and includes them in the intended administrator set, so the incoming explicit backend writer is retained by that sharing policy. [Frontend protection setup](../../src/services/protection.ts) instead derives administrators from `backend.getEditors()` and their profile email addresses. Neither source rule proves that the existing protected ranges already admit the incoming account; read their effective permissions directly before changing the trigger creator.

Verify the durable administrator sources used by later protection refreshes as well as today's range ACLs. `MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS` is the optional explicit Main protection allowlist; review it without discarding existing entries. Its incoming-account entry has been added to the existing three entries and verified after reload at this checkpoint. A one-time range repair alone does not establish how a future refresh will resolve that account.

If a repair is needed, preserve the existing administrator and leadership ACLs and add only the intended access to the existing resources, then verify it again under the incoming identity. Do not use full Setup to repair account access: [spreadsheet provisioning](../../src/services/setup.ts) can create a replacement when a configured spreadsheet cannot be opened and update its stored binding. Restore access to the original asset instead of risking a replacement during handoff.

## Decide durable ownership

Writer access can support the controlled trigger change while the outgoing owner remains available for recovery. Record separately whether each private resource will remain under a stable existing owner or transfer to the project account. If transferring between consumer accounts, the incoming account must accept the ownership request; writer access and a pending request are not completed ownership. Workspace transfer restrictions differ. Shared Drive files are owned by the organization and do not use individual ownership transfer. [Google Drive ownership guidance](https://developers.google.com/workspace/drive/api/guides/transfer-file).

Retain outgoing recovery access through validation. Do not move or copy resources to work around an ownership restriction: that can change access, links or runtime assumptions. An account handoff also needs password-manager vault access, recovery factors, GitHub organization/repository administration and Cloudflare account access. Being able to sign in once does not prove a successor can recover the account.

## Cut over triggers once

Use a quiet maintenance window away from attendance submissions and scheduled notices. The current normal production manifest is **11 triggers**, matching [the installer](../../src/services/setup.ts):

| Handler | Binding or schedule |
| --- | --- |
| `onFrontendEdit` | Main workbook, edit |
| `onBackendOpen` | Admin workbook, open |
| `onBackendEdit` | Admin workbook, edit |
| `onExcusalsManagementEdit` | Excusals Management workbook, edit |
| `onAttendanceFormSubmit` | Existing attendance Form, submit |
| `onExcusalsFormSubmit` | Existing excusal Form, submit |
| `onDirectoryFormSubmit` | Existing directory Form, submit |
| `reconcilePendingDirectoryEdits` | Every 10 minutes |
| `cleanupExpiredTransitionArchivesV2` | Daily, 03:00 hour |
| `sendDailyEventAttendanceNotices` | Daily, 05:00 hour |
| `sendSundayAttendanceCloseout` | Sunday, 17:00 hour |

Clock schedules use the manifest's `America/Indiana/Indianapolis` timezone and are not exact-to-the-minute appointments. There is no frontend open trigger. Three retired weekly attendance handlers and temporary continuation handlers are not part of this normal set.

1. Save each Form's current accepting-responses state, temporarily close intake, and hold spreadsheet edits with appropriate temporary protections/operator coordination. Preserve existing Forms and destinations. Capture the final intake/decision baseline and wait until existing executions have finished.
2. Under the outgoing trigger creator, remove the inventoried production triggers. Verify removal in that account's trigger view and wait for any already-started execution to finish. Retire any additional known creator's production triggers in that creator's session too. Record this checkpoint before creating replacements.
3. Under the already-authorized incoming account, run the existing backend menu **SHAMROCK → Setup & Automations → Reinstall triggers** once. Review its confirmation. This repairs the current user's trigger set; it cannot remove another creator's triggers through its account-scoped inventory. Do not run full provisioning or rebuild Forms for an account change.
4. Inspect the actual incoming manifest: exactly the 11 handlers above, one per expected binding/type, correct schedules and creator. Read back all IDs privately against the original inventory. The current installer catches some deletion failures, so a success message alone does not prove duplicate-free installation. Stop and inspect any mismatch before reopening intake.
5. Recheck the outgoing account's trigger view. Restore the saved Form accepting states and ordinary spreadsheet protections only after both ownership views agree. Record the cutover time and new trigger UIDs in restricted operational storage.

**Do not use `AUTOMATIONS_PAUSED` as the cutover barrier.** Current code checks it on selected edit/reconciliation paths, while Form submission and scheduled attendance-notice wrappers do not universally enforce it. Removing the old triggers, holding intake and waiting for in-flight work is the actual transition boundary. Likewise, the D1 staging pause flag controls only that isolated system.

## Verify and recover

Observe the first legitimate Form submissions, spreadsheet decisions and Directory reconciliation under the new creator. Verify one expected backend/audit outcome per input, retained response history, unchanged attendance codes, unchanged source/destination IDs and no duplicate executions. Review the sender identity and recipient configuration before the next normal notification; changing the trigger creator changes whose account sends mail. The current [attendance mail routines](../../src/services/attendance.ts) use `GmailApp` without an explicit `replyTo`, so replies follow the new sender account. Changing only the trigger creator does not change the configured recipient routing; excusal routines retain their explicit reply-to choices. Inspect the incoming account's Sent mail for the first legitimate scheduled message and verify the expected sender, replies and recipients. Do not send test notices or manually invoke notification/closeout handlers just to test authorization.

Compare the cutover baseline against raw responses and decisions. Inputs made while triggers were absent are not guaranteed to replay automatically. Reconcile an identified gap through the existing supported workflow after duplicate checks; do not blindly replay the latest Form response or rerun bulk operations. Preserve all source input while investigating.

If validation fails, close intake again, remove the new account's triggers and verify they are gone before reinstating the old creator's recorded set. Wait for active executions to finish, preserve all data and Script Properties, then restore the prior intake/protection state. Keep both accounts available until recovery is proven. Missing authorization or access is a reason to keep the old installation operating during preparation, not to install both sets concurrently.

Mark the handoff complete only after incoming access and consent, the two-account trigger checks, observed workflow validation, ownership dispositions, Cloud project access and account/password-manager recovery have been recorded. Until then, report the last verified checkpoint and the remaining owner-dependent action.
