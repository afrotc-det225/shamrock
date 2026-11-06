# Replacement frontend protection model

This is the local/staging protection planner for the replacement Main and Excusals workbooks. It does not change production protections, Drive sharing, Google actor identity or D1 command authorization. Successful metadata verification is required before opening a replacement workbook to operational editing. Local tests do not establish enforcement for an actual non-owner Google account.

## Operational field scopes

| Surface | Editable business inputs | Operational editors |
|---|---|---|
| Directory | Year, Rank, Role, Flight, Squadron, University, Phone, Dorm, CIP Broad Area, CIP, AFSC, Home Town, Home State, Class, DOB, Flight Path | Explicit Directory editors and operational support |
| Leadership | Last/First Name, Rank, Role, Reports To, Email, Cell/Office Phone, Office Location | Explicit Leadership editors and operational support |
| Attendance | Only event columns bound to stable event IDs, for occupied cadet rows | Explicit attendance-correction editors and operational support |
| Blue/Gold excusals | Only the Decision input, for occupied request rows | That squadron's current commander and operational support |
| Dashboard, legends, chart sources and archives | None | Automation only |

These fields come from the supported production `Schemas.FRONTEND_TABS`, `FrontendEditService.ALLOWED_FIELDS`, `ProtectionService` and `ExcusalsService.shareAndProtectManagementSpreadsheet`/`applyManagementSheetProtections`. The Directory list has sixteen fields; its identity names, email and photo are not direct propagated edit fields. Leadership's current broad business-edit capability is preserved as an explicit grant, not inferred from possession of the workbook. Current Main attendance corrections are leadership-wide; the planner does not silently narrow them to a flight or grant them to every workbook editor.

For excusals, the existing behavior gives each squadron commander Decision access for their own squadron. Wing commanders and flight commanders/deputies have monitoring access rather than automatic decision authority. Cadre are not automatically assigned extra privileges by their title: include an authorized person in the explicit support or relevant functional editor policy. Operational support replaces the existing backend-administrator allowance for supported business inputs. It does not confer permission to edit headers, generated results or internal identity/version fields.

Row 1 machine headers and row 2 display headers are always closed to operational editors. So are stable IDs, versions, draft state, receipt status, request context, recorded results and percentages. Spare rows/columns and unknown fields default to closed. Adding a new field never grants edits merely because it follows another input column. A new event needs an explicit header-to-event-ID binding; its displayed label is not its identity.

Google's workbook owner cannot be restricted by a cell protection. The owner and trusted automation identity are therefore explicit technical exceptions. Do not use the owner account for the non-owner enforcement rehearsal. Being a range editor also does not itself grant access to the Drive file. These are separate controls. Google protection editor lists, strict versus warning-only behavior and whole-sheet exceptions use the documented [ProtectedRange API](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets#ProtectedRange).

## API contract and application

`apps/google-adapter/src/frontend-protections.ts` exports:

- `planFrontendProtections(input)`: a bounded list of native Sheets requests and the desired protection requirements.
- `verifyFrontendProtections(input)`: exact read-back comparison returning `ready` and safe issue labels.
- `canEditFrontendCell(input, actor)`: an expected-policy model for tests. `actor.workbookEditor` is explicit. This is not proof of native enforcement and does not authorize a database mutation.

Supply every sheet in one workbook, including hidden helpers, as `surfaces`. Each surface identifies its kind, numeric sheet binding, machine headers, occupied final row and current grid dimensions. Read full `properties` and `protectedRanges` metadata with the trusted automation/owner account; editor lists are not visible to every reader. Bind squadron tabs with `squadronId`, never a mutable title. Attendance supplies `eventColumns: [{header, eventId}]`. A decision surface may explicitly choose `decision` or `draft_decision` as its input header.

Every sheet has a strict whole-sheet guard, permitting only owner/automation. Intended business-input blocks are exceptions to that guard **and have a second strict range protection with the exact named editors**. Thus a range exception never leaves a freely editable hole for an unrelated workbook editor. There are no warning-only, domain-wide or group grants. The planner merges adjacent fields with identical editor sets, while bounding row coverage to occupied records. It does not overwrite cells, validation rules, native colors, Tables or charts.

Apply the returned requests as **one atomic Sheets `spreadsheets.batchUpdate`** while operational intake is paused and under the same publication/provisioning lock. Do not split the batch, remove protections first, or treat request submission as verification. The planner returns a maximum of 1,000 requests; oversized policies fail before mutation. A repair updates existing managed protection IDs where possible and removes obsolete managed rules only after the replacements are present in the same batch. Unknown protection descriptions require explicit one-time `adoptProtectionIds` from a reviewed current snapshot; they are never silently deleted. Clear that adoption list after the first successful application.

Read fresh metadata and rerun verification. Any unexpected editor, group/domain grant, warning-only rule, missing input restriction, oversized hole, extra/missing protection, altered range or inaccessible rule leaves the workbook unverified. Changing a warning-only rule always includes an explicit editor field mask; otherwise the API can grant all workbook editors. The repair follows the documented [UpdateProtectedRange request](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#UpdateProtectedRangeRequest).

Provision protections before sharing a new workbook. For row/event growth, pause intake, publish stable rows/columns and reconcile the bounded protection policy before permitting edits. For structural reordering, use the latest header map and reconcile atomically under the same lock. Normal users use filter views; actual sort behavior against protected identity columns still needs its native rehearsal. The planner itself never sorts or decides which request an edit targeted.

## Revocation and command authorization

Editor lists come from trusted, current role/capability records. Role revocation replaces old lists; it does not append new users to stale grants. Reconcile Drive access separately, including former role occupants who should lose visibility. This module does not remove file sharing because a reader may legitimately retain monitoring access.

A successful edit remains only a proposed command. The Worker must recheck verified human identity, current capability, scope and expected version. Editing a Leadership role must not directly create the editor's own permissions: assignment changes require the corresponding authorized domain command and subsequent trusted role publication. Protected cells are an interface guard, not an authorization source. Missing `e.user` must retain the frozen draft for authenticated confirmation; the owner, trigger installer or a typed email must not be substituted as the human actor.

## Release evidence

Local tests compare emitted native protections against a separately evaluated cell-access model for each operational role, unrelated file editors, owner and automation. They cover both header rows, metadata, percentages, blank capacity, Directory's exact fields, per-squadron decisions, support permissions, editor turnover, row growth, reordered headers, adoption, unsafe drift, missing range restrictions and repeat repair.

Before production eligibility, stage actual non-owner users with writer access and verify allowed/denied cells on Main and both squadron tabs, including paste/bulk edits and native Table/filter interactions. Repeat repair, revoke one role, verify that the former holder loses edits and confirm the replacement retains only the intended scope. Inspect exact protection editor metadata using owner/automation and retain sanitized results. Cross-domain actor availability and command receipts must be tested separately. No local test or owner-account write satisfies these gates.
