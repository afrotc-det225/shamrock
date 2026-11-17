# Operational CSV and bulk Attendance tools

These staging tools perform ongoing administration through existing audited D1
commands. They are separate from the one-time legacy migration loader and require
no extra UI or paid service. Ordinary Forms, Main, Blue/Gold, publication and
notification workflows remain the normal runtime.

The supported interface is `node scripts/operational-admin.mjs --help`, after
`npm run build:v3`. It reads and creates owner-private files, never environment
files, direct SQL changes or production resources. The `capture`, `export` and
planning commands perform no provider writes. `apply` is an explicit bounded
operational write using an exact reviewed plan hash.

## Existing rules and supported baseline

The existing `src/services/admin.ts` exports directory, events, attendance,
excusals, Data Legend and cadre/Leadership. Its imports merge events by ID or label
and replace other entire tables. The replacement uses stable IDs and expected
versions rather than name matching, deleted logs or fabricated past actions.
`cadre` is accepted as the current category alias for `leadership`.

The legacy `AttendanceService.fillEventColumn` combines event names/prefixes/
suffixes/contains with OR. Its cadet name, Flight, university and AS-year criteria
also combine with OR; `includeAbroad` adds Abroad, while no cadet criteria selects
all displayed cadets, including Abroad. `translateLegacySelectors` preserves
those precise semantics. New selectors explicitly express AND, OR, additions and
exclusions. They never use displayed names or row numbers as command identities.

All CSV files use the exact `schema_version` header plus the category's versioned
machine headers in `scripts/lib/operational-csv.mjs`. Every row declares
`shamrock-operational-v1`. RFC-style quoting, doubled quotes, CRLF/LF, Unicode,
leading zeros and literal text are preserved. Dates use canonical `YYYY-MM-DD`;
timestamps use canonical UTC ISO strings. The schema validates the entire file
before producing any write plan. Missing/extra headers, malformed rows, duplicate
IDs, invalid dates and stale versions stop planning. The former arbitrary sheet
log layout is not silently reinterpreted as new operational commands.

| Category | Export/import behavior |
| --- | --- |
| Directory | Complete versioned profiles and explicit Flight IDs. Create/update preserves identity; inactive records remain retained. |
| Leadership | Manual profiles and Directory-linked contact fields. Linked identity/role fields remain Directory-owned; CSV cannot overwrite them. |
| Events | Explicit event/term IDs, versions, ordered UTC times, Flight IDs and captured eligible-person IDs. A label edit never changes event identity or its term. Existing roster arrays are preserved unless explicitly reviewed. |
| Attendance | Current-term matrix cells with person/event IDs and both causal base/event versions. A changed code creates an `attendance.correct` command with a required reason; no attendance submission is invented. |
| Excusals | Original person/event/outcome/reason remain evidence. Create rows start as Submitted; existing rows permit reviewed versioned decisions with a reason. No historical requester or decision actor is manufactured. |
| Data Legend | Canonical source/configuration patch described below. Ad hoc sheet edits that the legacy rebuild overwrites are not retained as an operational import path. |

Imports require one explicit mode: `create`, `update`, `merge`, or `replace`.
Replace additionally requires `replaceScopeIds`, including every imported or
removed target. Missing reviewed Directory/Leadership records become inactive;
missing Events become inactive; missing nonterminal Excusals are withdrawn with
the plan reason. Everything outside the explicit scope stays unchanged. Attendance
replacement is not supported: select the exact cells and use explicit blank
corrections when clearing is intended. No mode deletes history.

## Private configuration and planning

Store working files in a private directory (mode 0700) outside Git or beneath an
actually ignored directory such as `.build/operational-admin/`. Files must belong
to the operator and have no group/other access (mode 0600); symlink files are
rejected. Export and plan output never silently overwrite an existing artifact.
No real records, resource bindings, account addresses or vault references belong
in either repository.

The private CLI config contains:

```json
{
  "version": 1,
  "environment": "staging",
  "generation": 1,
  "workerOrigin": "https://REVIEWED-STAGING-WORKER.example.invalid",
  "keyId": "REVIEWED_KEY_ID",
  "principalId": "REGISTERED_AUTOMATION_PRINCIPAL",
  "resourceKey": "REGISTERED_OPERATIONS_SOURCE",
  "sourceKind": "sheet",
  "secretReference": "op://VAULT/ITEM/FIELD"
}
```

The signed adapter uses the current registered sheet-source contract for its
logical operations source. Configure a dedicated authorized automation principal;
do not put an arbitrary human's identity in this file. `authenticated-confirmation`
records the reviewed signed operation; it is not a fabricated Google edit event.
D1 rechecks current principal, capability, source, generation and row versions for
each command. The fixed `op read` integration reads the credential into memory for
capture/apply; it does not log or save it. Other steps require no secret access.

1. Run `capture --config ... --private-dir ...`. The result pins the target,
   coherent database revision and snapshot hash. It reads bounded pages and
   verifies the final revision; concurrent changes require recapture.
2. Run `export --snapshot ... --category ... --private-dir ...`; Attendance also
   requires `--as-of YYYY-MM-DD`. Edit only supported columns in the private CSV.
3. Prepare a private specification with `formatVersion:1`, `batchId`, `reason`,
   `asOfDate`, `mode` and optional `replaceScopeIds`. Run `plan-import --config ...
   --snapshot ... --csv ... --category ... --spec ... --private-dir ...`.
4. Review `operational-plan.json`: exact targets, before/after values, command
   payloads, versions, counts and row-write planning estimate. The summary alone
   is not sufficient to approve a broad replacement.
5. Run `apply --config ... --plan ... --review-sha EXACT_PLAN_HASH --private-dir ...`.
   Each invocation attempts five commands by default; `--max-commands` accepts
   1–10. Repeat the same command until its retained result is terminal.

The plan binds the environment, generation, origin/key/principal/source
fingerprint, captured revision, source commit and original targets. Apply requires
the same committed tool source. An unrelated branch move or configuration change
must be reviewed before using a newly generated plan; do not edit a saved plan to
make its hash pass. Native publication completion is separate from D1 acceptance.
Verify the affected Sheets/Form effects through their supported consumers before
calling an operational change fully visible.

## Bulk Attendance selection

Use `plan-bulk` with a specification containing the same context fields and a
`selection` object. For example:

```json
{
  "termId": "CURRENT_TERM_ID",
  "events": {"include": {"field":"eventType","op":"in","values":["llab"]}},
  "cadets": {
    "include": {"and":[
      {"field":"flight","op":"in","values":["Alpha"]},
      {"field":"asYear","op":"in","values":["AS100","AS200"]}
    ]},
    "excludeIds": ["EXPLICIT_EXCLUDED_PERSON_ID"]
  },
  "abroad": "exclude",
  "outsideRoster": "reject",
  "code": "T"
}
```

Each selector requires `include`, using `{all:true}`, an `and`/`or` group, or a
field predicate. Optional `includeIds` adds exact IDs; optional `exclude` and
`excludeIds` always win. Label predicates support `in`, `startsWith`, `endsWith`
and `contains`, case-insensitively. Stable-ID predicates permit exact `in` only.
Cadet fields are person ID, name, Flight ID/label, Squadron ID/label, university
and AS year. Event fields are event ID, label, column label, type, term, status and
training week. Expressions are bounded; no executable code or regular expressions
are accepted.

Only the explicit current term and operationally active cadets are eligible for
this current-matrix workflow. `abroad` must explicitly be `include`, `exclude` or
`only`. `outsideRoster` must explicitly reject the plan or exclude those pairs;
excluded counts appear in the review. Unknown eligibility or ambiguous facts stop
the plan. Unchanged cells produce no command. A blank correction is JSON `null`,
not the attendance code `N/A`.

The saved plan freezes person/event IDs, displayed review context and expected
versions. Apply never reevaluates the selector against a changed Directory or
silently applies it to newcomers. Corrections preserve original observations,
requests and audit history. A new event version or causal cell revision conflicts
rather than overwriting intervening work.

## Recovery and free-tier bounds

Each individual D1 command is atomic. A multirow plan is deliberately resumable,
not one transaction spanning many provider requests. The private journal persists
`dispatching` before IO and the exact receipt afterward. A lost response retries
the same immutable command ID and payload. An unchanged accepted retry returns its
original receipt. A conflict/rejection stops subsequent work for review; it does
not silently rebase versions or roll back already accepted rows.

A process crash may leave `journal.lock`. `recover-lock --plan ... --review-sha ...
--private-dir ...` removes it only when it belongs to this plan and host and its
recorded process is no longer running. It leaves the journal unchanged. An empty,
foreign-host or unexplained lock requires maintainer inspection, not blind removal.

Plans are bounded to 25,000 commands and 64 MiB; the source capture is bounded to
512 pages and 16 MiB. Each command still satisfies the existing 64-KiB request
limit. The planning row estimate includes explicit event roster size. It is not
hosted billing evidence or permission to exhaust the daily free allowance. Review
current usage and publication backlog between bounded steps; spread large work
across available quota windows. No loop automatically drains a large plan and no
paid limit increase is requested.

## Canonical Data Legend changes

`export-legend --private-dir ...` reads the actual supported literal arrays from
`src/utils/arrays.ts` through the TypeScript parser. `plan-legend --csv ... --spec
... --private-dir ...` creates an exact proposed source file, a hash-bound change
plan and the complete legend values. Optional `--forms-config ...` additionally
creates a proposed private managed-Forms config, checking every affected bound
choice list against its original values before replacing it.

Existing choices must remain. Attendance/decision/status codes, AS-year policy and
Flight/Squadron identity lists cannot be changed through this import. Those require
a specific domain-policy or catalog change. Other lists can be extended or
reordered in a reviewed source change. The plan does not write the source, private
config or Sheets automatically. Review its patch, run the normal builds/tests,
then publish its corresponding protected legend ranges and native dropdown styles
through the normal staging release process. No production deployment is implied.

## Validation boundary

Targeted tests cover all five operational CSV roundtrips, malformed input,
explicit replacement, linked identity, date/roster preservation, selectors,
Abroad, immutable corrections, interrupted delivery, duplicate prevention,
revoked authority and private file handling. A disposable local D1 test creates
Directory/Events through the actual APIs, captures coherent pages, loses an ACK
after a real correction commit, resumes exactly once and verifies refresh effects.
Live staging CSV operations and the resulting Google publication still require
release-specific evidence. This tool does not establish successor account custody
or authorize production cutover.
