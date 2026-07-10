# AI Feature Change Checklist

This checklist standardizes how AI agents change SHAMROCK without reintroducing stale setup assumptions.

Goal: keep changes safe, documented, and consistent with system invariants.

## 1. Define the Feature Boundary
Before writing or changing any implementation:
- Write a one-sentence purpose.
- List surfaces touched (frontend tabs, backend tabs, forms).
- List who uses it (end user vs operator).
- Identify entry points (menu actions, triggers, form submit events).
- Use `docs/ai/TASK_BRIEF_TEMPLATE.md` for larger or handoff-prone tasks.

## 2. Confirm System Invariants
Every feature must comply with docs/system/SYSTEM_SPEC.md.

Confirm explicitly:
- Provisioning is idempotent ensure-exists (safe to re-run).
- Tables use row 1 machine headers and start data tables at row 2.
- Column access is header-driven (no hardcoded column indexes).
- Dropdowns and validations reference Data Legend ranges.
- Validation inside a Sheets Table is applied through cell-level Sheets API `setDataValidation` or validation-only `copyPaste` requests after table columns are reset to `COLUMN_TYPE_UNSPECIFIED`; do not apply a single `Range.setDataValidation(...)` rule across a table column.
- New tables use a minimal `addTable`, read back Google’s generated table ID, and then use `updateTable` for styling and unspecified column types; never treat visual fallback formatting as proof that a table exists.
- Smart-chip formatting must use an authoritative URL or resource ID. Never reconstruct a chip from its visible label text.
- Forms require verified responder emails.
- Frontend tables are protected; edits flow through forms/logic.
- Every new operator menu action uses `runMenuAction(...)` and the shared live-progress window.
- Long or prompt-driven operator workflows define meaningful plain-language progress stages, hints, waiting states, and continuation states without false row-level precision or sensitive details.
- Every useful operator-facing milestone added to technical logs is mirrored through an explicit progress report or a safe `captureTechnicalLog(...)` translation, including completion durations and recoverable warnings where helpful.
- The change targets the current supported baseline, not retired CSV/sheet/property formats.

## 3. Document The Operational Delta
Update docs/public/README.md when operator-visible behavior changes.

Required in the public entry:
- Overview and operators/end-users.
- User entry points (forms, menu actions, triggers).
- Data touched (tabs and key columns by header name).
- Setup/repair notes when setup behavior changes.
- Validation checklist (manual steps and expected visible outcomes).
- Rollback guidance (how to disable triggers or revert derived state).

Never include:
- Raw sheet IDs, form IDs, personal emails, or personal data.

## 4. Document Supporting Internal Changes
Update internal docs when applicable:
- Update docs/system/SYSTEM_SPEC.md if any system-wide invariant changes.
- Update docs/runbooks/OPERATOR_RUNBOOK.md if operator steps or recovery steps change.
- Remove or rewrite stale docs rather than adding a new competing explanation.

## 5. Segment the Implementation (Design-Only Guidance)
When implementation is created later, keep boundaries consistent:
- Parsing and validating form responses belongs in src/forms.
- Sheet read/write helpers belong in src/utils/sheets.ts unless a future refactor creates a dedicated folder.
- Orchestration and business rules belong in src/services.
- Apps Script global entry points, custom menus, prompts, and trigger-callable wrappers belong in src/index.ts.
- Shared contracts belong in src/types.ts.
- IDs, named ranges, and feature flags belong in src/config (no secrets committed).

Each feature should be explainable as:
- Entry point → service → sheet helpers → audit logging

## 6. Commit And Review Readiness
Follow docs/ai/COMMIT_AND_PR_GUIDELINES.md.

Before commit or PR:
- Run `npm run build`.
- Run `git diff --check`.
- Review changed files for secrets, raw IDs, and personal data.
- Confirm local-only files are not staged.

## 7. Safety Review
Before marking a feature “ready” in docs:
- Confirm the change is reversible.
- Confirm provisioning can be re-run without duplicates.
- Confirm the feature does not require direct sheet edits by end users.
- Confirm audit logging expectations are described.
- Confirm operator progress reaches the correct terminal state for success, cancellation, failure, and any saved background continuation.

## 8. Validation Expectations
Every feature doc must include:
- A short “happy path” validation.
- At least one failure/edge-case validation.
- A live-progress validation for every new or materially changed operator menu workflow.
- A post-deploy verification step (menus load, triggers present, forms functioning).
