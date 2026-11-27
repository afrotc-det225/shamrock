# Read-only account preview

This is a local implementation contract. Hosted schema/application deployment,
administrator server integration and named-account acceptance are separate
release gates. Production remains unchanged.

An authenticated administrator with current `fullSnapshot` access may select a
Directory person to inspect that person's actual panel access. The real Google
actor stays unchanged. The target must have exactly one active principal and an
existing verified `principal_accounts` binding. The preview never creates an
account, infers a login from an email string, grants access or impersonates the
target for commands. Flight and Squadron scope reuse [the panel reader](D1_PANEL_READS.md).

## Entry and exit

The trusted panel server signs `POST /v1/admin/panel/view-as/authorize` with one of
these exact bodies. `principalId` is always its real authenticated actor.

```text
{environment,generation,principalId,action:"enter",auditId,targetPersonId}
{environment,generation,principalId,action:"exit",auditId,entryAuditId}
```

The server generates and retains each audit ID before sending; retries reuse the
same ID and payload. A different payload under an existing ID is a conflict.
Successful responses use `PanelViewAsAuthorization`:

```text
{contractVersion:"panel-view-as-v1",readOnly:true,action,entryAuditId,
 targetPersonId,targetPrincipalId,status,access}
```

Entry statuses are `ready`, `no-active-principal`, `ambiguous-principal`,
`no-verified-login` and `no-panel-access`. The last four return `access:null` and
cannot read preview pages. `targetPrincipalId` is null when there is no unique
active mapping. A missing person returns `404`; an actor without explicit full
panel authority returns `403`. Derived Wing spreadsheet read grants alone do not
authorize an administrator to enter View as. Readiness or pagination failures
remain failures; they are not converted to a fictional no-access role.

The BFF stores both `preview_person_id` and `preview_entry_audit_id` in its
server-side session. It keeps the real actor identity and its normal login
binding. Browser parameters or headers must never select a target on subsequent
reads. Selecting another person creates another audited entry; exit the old
entry as part of that transition.

Exit returns `status:"exited"` and `access:null`. It may record the authenticated
actor's own exit after that actor loses Wing authority. The BFF always clears
its local preview first, even if the exit audit is unavailable; audit failure
must never trap the user in preview. An exited entry cannot read again or reopen
under an old entry ID. Entry retries re-evaluate current access and reject changed
mapping, changed no-access status or a closed entry.

Migration `0016_panel_view_as_audit.sql` adds the separate
`panel_view_as_audit` ledger. It retains real actor, target person/principal,
entry/exit IDs, status, environment/generation, payload digest and timestamp. It
does not store private profile fields or signing material. Entry authorization
and the insert predicate share the checked actor/mapping state; exit is bound to
the real actor's existing entry. These audit writes create no operational command,
operational audit revision or spreadsheet refresh effect. Backups must include
the additive table through the ordinary complete database inventory.

## Guarded reads

Only `POST /v1/admin/panel/view-as/page` reads preview data:

```text
{environment,generation,principalId,targetPersonId,entryAuditId,
 viewRevision,kind,page}
```

`page` is the original reader's body with `environment`, `generation` and
`principalId` omitted. The server derives those three fields. Supported kinds:

| Kind | Original reader | Target requirement |
| --- | --- | --- |
| `panel` | `/v1/admin/panel/page` | `fullSnapshot:false` |
| `snapshot` | `/v1/admin/snapshot/page` including its catalog pages and explicit `termId` | `fullSnapshot:true` |
| `history` | `/v1/admin/history/page` | `fullSnapshot:true` |
| `history-list` | `/v1/admin/history/list`; `page:{}` | `fullSnapshot:true` |

A full-read target must use the original full transport; a `panel` request for
that target returns `400 VIEW_AS_TRANSPORT_MISMATCH`. Scoped targets cannot use
the full or historical paths. Unsupported kinds and caller-supplied identity
fields are rejected. There is no generic arbitrary-path forwarder or fallback
to the actual administrator's ordinary reads.

The response preserves the original target reader's response as `page`:

```text
{contractVersion:"panel-view-as-page-v1",readOnly:true,environment,generation,
 entryAuditId,targetPersonId,targetPrincipalId,viewRevision,kind,page}
```

Start each manifest or catalog transfer with `viewRevision:null` and the
original reader's null initial revision/source hash. The history list also
uses null. For every subsequent page and final verification, retain both the
returned `viewRevision` and the original reader's revision/hash. Never rebase a
partly collected transfer. View revisions bind the real actor, audited entry,
target account mapping, reader kind and underlying data/access/source revision.
Changing a target or entry cannot reuse a prior page sequence. A changed binding
returns `409 VIEW_AS_CHANGED`; no partial data is returned. The outer envelope
is bounded by `PANEL_VIEW_AS_PAGE_MAX_BYTES` (130,048 bytes), including the
original reader's existing 128,000-byte page budget.

The Worker checks real-actor full access, the unique active target mapping,
verified account evidence, target full-read authority where needed, and the
still-open audited entry inside **every underlying D1 read batch**. The scoped
reader additionally retains its own before/data-transaction authority checks and
scope revision. Thus revocation, account rebinding, Flight/role changes and a
concurrent exit cannot release data under an earlier authorization check. This
does not broaden existing Sheets permissions.

## Mandatory administrator-server fence

The original capabilities, including `canDecide`, remain accurate descriptions
of the target. They are not preview write permission. The BFF must enforce
`readOnly` from its server-side session before every operational handler,
including commands, alternate command routes, retries, receipt lookups, imports,
exports with side effects, event changes and other management operations. Do not
rely on a disabled button, omitted header, browser-supplied `readOnly`, or a
changed actor ID. Entry, target change and exit are the narrowly allowed preview
management operations; they only write preview audit records.

Existing core endpoints continue to serve their legitimate native clients and
do not know the BFF's session. The server fence is therefore required even when
all new Worker tests pass. Every permitted preview read must use the wrapper;
ordinary actor-wide reads, command receipts, contact data and retained reports
must not bypass the target scope through an alternate route.

## Validation and release gates

Local tests cover exact Flight and full-target read parity, private-field and
unrelated-Flight exclusion, missing/ambiguous/unverified accounts, idempotent
audit IDs, no operational revisions/effects, exit after revocation, closed-entry
rejection, entry/target revision isolation, target role drift, account rebinding,
revocation inside the data batch, and retained source/hash paging interrupted by
exit. Injected reads stay below the Free per-invocation query bound; this is not
a hosted CPU or rows-read measurement.

Before enabling View as, deploy and verify the additive schema and exact Worker
release separately, verify BFF session binding and all mutation/alternate-route
denials, rehearse real named-account target/actor revocation, and measure hosted
CPU on representative scoped/full/historical pages. Leave ordinary automation
gates, schema data and production bindings unchanged during staging rehearsal.

A school-account Wing grant can open the Wing workspace in View as when its principal matches the normalized Directory email hash and the target has active Wing access. When both the school and personal Google identity point to the same person and verified address, the Wing workspace uses the school grants and the personal workspace uses the Google account. Unrelated extra identities block the preview. The preview rechecks this mapping when reading the workspace. Exit a previously denied preview before selecting the person again.
