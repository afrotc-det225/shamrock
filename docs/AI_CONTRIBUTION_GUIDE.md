# AI Contribution Guide

Guidance for AI agents maintaining and evolving SHAMROCK as an established Apps Script system.

This guide explains how to work in the repository. System invariants live in `docs/system/SYSTEM_SPEC.md`; operational procedures live in `docs/runbooks/OPERATOR_RUNBOOK.md`.

## Repository Facts

- Target stack: Google Apps Script V8, TypeScript, local build with `tsc`, deployment with `clasp`.
- Runtime surfaces: backend/admin workbook, frontend/main workbook, Google Forms, installable triggers, Gmail notifications, and Apps Script logs.
- Current baseline: the checked-in source and docs define the supported SHAMROCK system. Historical migration code and old setup notes should be pruned or ignored when they no longer serve the current baseline.
- Safety: never commit secrets, personal data, raw workbook/form IDs, or local tool state.

## Canonical Documents

Read the smallest set that applies:

- `AGENTS.md`: agent operating instructions.
- `docs/system/SYSTEM_SPEC.md`: architecture and invariants.
- `docs/runbooks/OPERATOR_RUNBOOK.md`: operator procedures and deployment checks.
- `docs/public/README.md`: operator-facing feature catalog.
- `docs/ai/FEATURE_CHANGE_CHECKLIST.md`: readiness checklist for feature changes.
- `docs/ai/TASK_BRIEF_TEMPLATE.md`: handoff template for larger tasks.
- `docs/ai/COMMIT_AND_PR_GUIDELINES.md`: commit, PR, and review expectations.

## Source Layout

- `src/index.ts`: Apps Script global functions, custom menus, prompts, and trigger-callable wrappers.
- `src/config/`: script property keys, schemas, resource names, and config helpers.
- `src/forms/`: form response parsing and submit handlers.
- `src/services/`: business workflows, setup/provisioning, sync, formatting, protections, audit, attendance, directory, excusals, and admin actions.
- `src/utils/`: reusable helpers for arrays, environment access, headers, logging, and Sheets operations.
- `src/types.ts`: shared TypeScript contracts.

There are no active `src/sheets/` or `src/triggers/` directories. Do not recreate them unless a refactor is explicitly requested and documented.

## Maintenance Workflow

1. **Orient**
   - Check `git status --short --branch`.
   - Read the task and the relevant docs.
   - Inspect current code before assuming a pattern from older docs.

2. **Define Scope**
   - Identify the affected surfaces: backend tabs, frontend tabs, forms, triggers, menus, notifications, or docs.
   - Decide whether the change is operational behavior, internal refactor, documentation, or deployment support.
   - For large tasks, use `docs/ai/TASK_BRIEF_TEMPLATE.md`.

3. **Implement Against The Current Baseline**
   - Prefer current schemas and helpers.
   - Remove obsolete compatibility or one-off migration logic when the task establishes a new baseline.
   - Preserve compatibility only when the task, operator runbook, or current production state requires it.
   - Keep Apps Script entry points stable unless the task includes a migration/update plan.

4. **Document The Delta**
   - Update `docs/public/README.md` for operator-visible behavior.
   - Update `docs/system/SYSTEM_SPEC.md` for invariants, architecture, schemas, or supported baseline changes.
   - Update `docs/runbooks/OPERATOR_RUNBOOK.md` for deployment, recovery, or recurring operator steps.
   - Keep docs concise. Avoid restating full implementation details when code is clearer.

5. **Validate**
   - Run `npm run build`.
   - Run `git diff --check`.
   - Review changed files for secrets, raw IDs, and personal data.
   - Note any manual validation that could not be performed locally.

## Documentation Standards

- Prefer durable operational facts over initial-build commentary.
- Do not duplicate long schema lists in multiple files. Put canonical rules in `docs/system/SYSTEM_SPEC.md` or `src/config/schemas.ts`, and link from other docs.
- Public docs should help an operator use or validate SHAMROCK. They should not contain raw IDs, personal data, or developer-only history.
- Agent docs should explain how to work safely, not enumerate every workbook column.
- If a doc is stale, update or remove it rather than adding another competing note.

## Refactor And Rewrite Guidance

For significant rewrites:

- Parse the task into goals, requirements, risks, and implementation phases before editing.
- Use subagents or separate investigation passes when the task spans multiple subsystems.
- Make an explicit baseline decision: what remains supported, what becomes v2 behavior, and what old paths can be removed.
- Justify structural decisions in docs or final notes when they change a long-standing pattern.
- Keep destructive operations interactive, auditable, and resumable where possible.
