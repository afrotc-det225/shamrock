# Trusted Leadership permissions

This is an opt-in isolated v3 capability. Migration 0011 creates no trusted accounts and starts disabled. It does not alter production sharing, triggers, code or data. The native host, scheduler, input and publisher integrations are implemented locally. Private account/resource provisioning and a live turnover/revocation rehearsal remain required before enablement. No production permission parity is claimed from local tests.

## Source policy and authority

The policy comes from current `ProtectionService`, `DirectoryService` and `ExcusalsService`, not arbitrary text in a Form:

| Assignment | Main frontend | Excusals |
| --- | --- | --- |
| Active trusted Leadership contact | Leadership contact fields; Attendance event cells across the wing | Only the following specific roles receive access |
| Exact Blue/Gold Squadron Commander | Same Leadership access | Their own Squadron's Decision cells |
| Wing/Cadet Wing Commander; exact Flight commander/deputy | Same Leadership access | Viewer only |
| Verified enrolled cadet | Existing explicitly configured frontend visibility | Self excusal submission in their current Flight; no managerial authority |
| Explicit permission manager | Privilege-bearing Directory/Leadership changes, subject to normal command authority | No inferred commander authority |
| Explicit automation publisher | Applies the reviewed Google policy | No human decision authority inferred |

Mission Support/Abroad Squadron Commander text does not create operational Squadron authority. Duplicate commanders fail closed for decisions and produce diagnostics. Role names are normalized for matching; identity always comes from the trusted named account binding and stable person/contact ID.

`permission_managers` and `permission_publishers` are separate explicit roots provisioned privately. A human permission manager cannot attest the native Google fence. `principal_accounts` maps a named normalized email to a principal, with verified Form or authenticated-confirmation evidence. New Google principals use `google.` plus the SHA-256 of that normalized email. Existing person links cannot be silently reassigned. A Directory email change invalidates the old derived binding; a reviewed new binding is required.

Explicit `admin_grants` and `access_grants` remain independent. Migration never guesses which old grants were role-based. Before enabling a deployment, review and remove obsolete explicit role grants privately, otherwise they intentionally remain authorized independently of Leadership. The existing owner/automation identities and specifically retained support/viewer baseline remain explicit. Groups, domains and anyone sharing are not substitutes for named policy membership.

## Changes and revocation

A trusted Directory Role, email, Flight/Squadron scope or Flight Path change, a Leadership role/email/person-link/activation change, or transition acceptance requires explicit permission-manager authority in addition to the existing command capability. Ordinary Leadership editors can change harmless contact fields, such as office location and phone. Linked profile fields still belong to Directory, not the contact record. Directory self-service Forms cannot set Role, operational status, scope or verified email; automatic enrollment uses the fixed initial cadet policy.

Every accepted Directory/Leadership edit rebuilds derived authorization in its existing atomic D1 transaction. Thus a phone change does not leave version-bound permissions permanently revoked. Transition acceptance also updates permissions atomically. Each revision includes a source/version guard, audit record and durable refresh job. Derived grants independently verify current profile/contact version, verified named account, active membership and linked contact version on every command. Unmanaged source drift therefore revokes D1 authority until explicitly reconciled.

D1 and Google cannot commit atomically. Before a privilege-bearing command is accepted, a separately authorized native publisher must persist a host-wide fence, close native input protections, read back the provider state and attest that exact normalized command hash and policy revision. The Worker rejects a missing, stale, mismatched or consumed fence. The publisher's native checkpoint is private; its digest is audited. The signed adapter boundary attests actual Google readback, rather than trusting a human editor's assertion.

Native input fencing closes edits; it does not revoke visibility. Existing Drive viewers may retain visibility between D1 acceptance and the next successful provider revocation. Normal scheduling bounds the next attempt to five minutes, but outages or inherited folder permissions can extend that window; there is no false guarantee of atomic visibility revocation. Permission publication revokes obsolete memberships before adding any new ones. Failures leave editing fenced and the durable checkpoint intact. An urgent visibility removal requires verified immediate provider revocation before operational handoff.

## Signed API contract

All routes use the existing signed bridge, environment/generation checks and current principal authority. There are no browser-runtime color, sharing or credential workarounds.

- `POST /v1/admin/permissions/commands`: manager-only `{environment,generation,principalId,commandId,expectedVersion,accounts,revokePrincipalIds,operationalSquadronIds}`. Each account has `{principalId,personId,email}`; IDs/emails are private runtime values. Operational Squadron IDs must resolve to Blue/Gold with actual Flights. An empty account/revoke change explicitly reconciles current trusted records. First use enables the policy. A replay must match its original input and still have current manager authority.
- `POST /v1/admin/permissions/fence`: publisher-only `{environment,generation,principalId,commandId,payloadSha256,expectedVersion,checkpointSha256}` after fresh native fence readback. The attestation expires after ten minutes and cannot be overwritten. Admin command hashing uses the normalized `parseAdminCommand` result; permission commands use their exact request JSON, and transition commands use their exact request JSON. Freeze the body before hashing. No committed command is reauthorized solely by possession of a fence token.
- `POST /v1/admin/permissions/claim`: publisher-only `{environment,generation,principalId,workerId}`; returns `{job:null}` when idle. It freezes the newest pending policy in a six-hour exclusive lease. No lease is automatically stolen.
- `POST /v1/admin/permissions/project` and `/ack`: add `{jobId,claimToken}`. Projection returns `{version,current,policyHash,policy}`. ACK completes only that lease and older pending revisions covered by it; later changes remain pending. Exact repeated ACK is safe after an ambiguous response. Superseded policies are acknowledged while still fenced and are never reopened.
- `POST /v1/admin/permissions/status`: publisher-only environment/generation/principal, readable while command intake is paused. Returns current policy revision/hash and whether every permission job is done.
- `POST /v1/admin/permissions/recover`: publisher-only `{environment,generation,principalId,recoveryId,workerId,jobId,claimToken,previousExpiry,checkpointSha256}`. After owner review and fresh native fence/readback, renew only the exact expired retained lease. It never changes worker/token or chooses another job; recovery is audited and idempotent. Do not call this automatically because time elapsed.

Manager requirements are retained with administrative receipts, so role-changing replays and receipt retrieval require current manager authority. Command IDs remain globally unique through `command_registry`. Policy revisions, derived rows, receipts/audit and refresh jobs roll back together on conflicts.

## Native integration and recovery

`runPermissionRefresh` consumes durable owner-private state through explicit ports. Its pure consumer idle path makes one signed claim request and no Google/private-file reads. The native wrapper still verifies its configuration; invocation caching shares those config reads with other consumers, while applied state is loaded only for real work. It stores the exact frozen projection, fences both books, revokes obsolete memberships, adds current members, saves the authoritative identity/access map, checks the current revision, acknowledges and verifies native field protections before removing the fence. An interrupted provider write is reconciled from fresh readback, not replayed blindly. Membership work is bounded to 25 mutations per phase per invocation (configurable up to 50).

`createNativePermissionProvider` supports exactly two explicitly bound isolated books, rejects forbidden production bindings, verifies their single expected owner, and manages complete paginated named Drive permissions. `createNativePermissionApi` performs public API calls with OAuth supplied by the runtime. Permission creation always sets `sendNotificationEmail=false`; no invitation emails are sent. Inherited unapproved permissions stop the workflow for folder-owner review. The existing keyed frontend host supplies current sheet/header/occupied-row mappings; the permission provider never writes business values, formatting, dropdowns or Table contents.

The native host integrates these gates; validate them together before opting in:

1. A shared Script Lock and owner-private checkpoint with canonical-content concurrency checks, plus the local `SHAMROCK_V3_PERMISSION_FENCED` marker. Persist/read back the marker before any provider operation.
2. Both native input handlers and the frontend publisher check `assertPermissionFenceClear`, including setup-only paths. Nothing may restore old static access during permission refresh.
3. Publisher access resolves through `permissionPolicyAccess` using the latest durable applied policy. Native input replaces its registry with active accounts in the applied policy (also available through `resolveAppliedPermissionIdentity`); never fall back to stale derived identities in an old static registry.
4. A privileged edit is frozen, fenced by the publisher, attested for its exact normalized command, then submitted under the actual human principal. Operator/AI API changes use the same process. Failed unaccepted edits keep the fence until the current unchanged policy is deliberately verified/restored.
5. Closed native policies clear `permissionManagers` as well as every ordinary editor list. Privileged fields belong only to those managers plus owner/runtime; adjacent ranges with different editor sets must not be merged.
6. Preserve the exact claim/checkpoint after a crash. On an expired lease, inspect the private checkpoint and actual memberships/protections, re-fence, use the explicit recovery route, update the checkpoint's expiry and resume. Never discard a claim or reopen stale access to clear an error.

Private fixed Main viewers and support identities preserve the separately reviewed baseline; they are not inferred from whatever sharing happens to exist. Derived Excusals viewers and Squadron commanders are replaced from the current trusted policy.


## Private native configuration and controls

The root configuration may contain `SHAMROCK_V3_PERMISSION_CONFIG` as a JSON string with `{ "version": 1, "configFileId": "PRIVATE_PERMISSION_CONFIG_FILE" }`. The referenced owner-only JSON file has this shape; actual identities/resource IDs stay in private operations storage:

```json
{
  "version": 1,
  "environment": "staging",
  "generation": 1,
  "enabled": false,
  "resourceReview": "NATIVE_PERMISSION_POLICY_REVIEWED_FOR_STAGING",
  "workerId": "permission-publisher-worker",
  "principalId": "permission-publisher",
  "stateFileId": "PRIVATE_PERMISSION_STATE_FILE",
  "mainReaders": [],
  "excusalReaders": [],
  "forbiddenSpreadsheetIds": ["PRODUCTION_MAIN_BOOK", "PRODUCTION_EXCUSALS_BOOK"]
}
```

The separate owner-only initial state is `{ "version": 1, "environment": "staging", "generation": 1 }`. The native host reuses the exact frontend workbook/Table bindings and stable row policy; it does not create replacement workbooks. Main/Excusals fixed viewer lists preserve only the reviewed sharing baseline. Staging account bindings should contain only explicitly authorized test accounts, even when the Directory contains imported real records; importing a person is not consent to share a staging file with that person.

Private `controlRequest` fields are `{requestId,sequence,action,stateSha256}`. `stateSha256` is SHA-256 of `permissionCanonical(state)`. Supported actions are `setup`, `resume`, `pause`, `command` and `recover`:

- `setup` verifies the isolated resources, fingerprints the exact publisher/configuration/book baseline, and remains paused. It can inspect an explicitly paused frontend. No command or access grant is created.
- `resume` requires `enabled=true` and the exact setup fingerprint, consumes the request once and clears only permission processing's pause. It cannot undo a later pause when replayed.
- `pause` preserves pending claims and fences.
- `command` adds `{commandFileId,commandSha256}` pointing to a separate owner-only reviewed command JSON. The hash uses canonical JSON for file review; the backend's command hash is generated separately from its required normalized body. The host rechecks a known receipt, prepares/readbacks the native fence if required, persists evidence, attests it under the publisher, then sends the original command under its actual manager identity. It stays paused afterward; submit a new reviewed resume control to publish the resulting policy. An ambiguous accepted-command response retries the same frozen control/receipt without requiring the pre-operation state to magically reappear.
- `recover` adds `{recoveryId,previousExpiry}`. It verifies the exact retained claim, closes/readbacks native protections, calls the explicit lease-recovery route, updates the same token's saved expiry, and remains paused for a separate reviewed resume.

The scheduled entry point consumes controls and runs permissions before spreadsheet publication/input. Ordinary input/publisher setup cannot bypass a permission fence. Explicit input setup may, however, recover an earlier **exactly closed** owner/runtime-only publication fence after a failed setup: it must verify either the full open field policy or that exact closed policy. A mixed, unknown or broadened protection state still fails. Permission repair sessions use the shared Script Lock and owner/resource isolation; they never write business cells.

A privileged native edit that receives `PERMISSION_FENCE_REQUIRED` is prepared and attested automatically under the same native lock, then retried as its original human command. Unauthorized managers are rejected before any provider fence request. The handler leaves a newly set shared fence closed, rather than restoring the previous policy in its cleanup path. Routine input identity reads use only the current applied named-account map; the idle input timer does not read the permission checkpoint.

Importing configuration pauses this module and invalidates its setup fingerprint without erasing consumed control history. Its owner-callable wrappers are `shamrockV3NativePermissionsControl`, `shamrockV3NativePermissionsRefresh` and `shamrockV3NativePermissionsPause`. Normal operation uses the existing timer and private controls, so no editor/browser run is required for each change. If a command is definitively rejected after fencing, preserve its evidence and review the unchanged current policy before deliberately restoring access; never clear the fence property by itself.

## Validation and bounds

Local tests cover manager/publisher separation, exact fence binding, scope/title rules, duplicate commanders, immediate D1 revocation, harmless changes retaining authority, stale writes rolling back, receipt revocation, claim watermark/coalescing, exact recovery, ambiguous ACK, inherited sharing, bounded provider work and a no-Google idle path. Tests instrument prepared statements for permission reconciliation and enabled Directory edits and require fewer than 50 per invocation. This is query-count evidence, not a hosted capacity measurement.

Limits are 500 Directory profiles, 200 contacts, 1,000 named accounts, 50 Flights, 20 Squadrons, 5,000 derived access grants and a 500,000-character serialized policy. Native membership reads collect all pages up to 1,000 permissions. Fresh schema bootstrap permits at most 160 reviewed statements/512 KiB; migration 0011 remains additive and does not edit applied migrations 1–10.

Before a live gate, rehearse real named-account role removal, transfer, commander replacement, office-phone edit, revoked manager replay, interrupted Drive update, expired lease recovery and cross-publisher fencing. Confirm view removal with actual account access as well as provider metadata. No source-only test establishes native `e.user`, active filter-view edit coordinates, provider propagation timing or complete production sharing parity.

Google API references: [complete paginated permissions](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list), [permission creation and invitation control](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create), [permission removal](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/delete).
