# AGENTS.md

This file is the first stop for AI agents working in this repository. Follow it unless a more specific instruction file in a subdirectory overrides it.

## Project Summary

SHAMROCK is a Google Apps Script system written in TypeScript. It provisions and operates Google Sheets workbooks and Google Forms for cadet directory, attendance, excusals, audit, and operator workflows.

The production runtime is Apps Script V8. Local development compiles `src/**/*.ts` into `dist/` with `tsc`, then deploys with `clasp`.

SHAMROCK is now an established operational system, not a greenfield scaffold. Treat the current checked-in source and docs as the supported baseline. Historical implementation notes and old compatibility paths are not requirements unless a task explicitly preserves them.

## Operating Contract

When you are dropped into this repo:

1. Read this file first.
2. Check `git status --short --branch` before editing.
3. Read the task context and the relevant docs before changing code.
4. Keep changes scoped to the requested goal.
5. Never commit secrets, raw workbook/form IDs, personal emails, phone numbers, personal data, `.clasp.json`, `.env*`, `dist/`, `node_modules/`, or local tool settings.
6. Prefer small, reviewable commits with clear messages.
7. Run `npm run build` before marking implementation work complete.
8. Update docs when behavior, operator workflow, data schema, setup, or deployment steps change.

If the request is ambiguous, make the safest reasonable assumption and document it in the final response. Ask only when the missing answer would make the change unsafe.

## Canonical References

Read the smallest set that applies to the task:

- `README.md`: quickstart and repository map.
- `docs/AI_CONTRIBUTION_GUIDE.md`: AI workflow and contribution process.
- `docs/ai/FEATURE_CHANGE_CHECKLIST.md`: feature-change checklist.
- `docs/ai/TASK_BRIEF_TEMPLATE.md`: task handoff template for agents.
- `docs/ai/COMMIT_AND_PR_GUIDELINES.md`: commit, PR, and review expectations.
- `docs/system/SYSTEM_SPEC.md`: system invariants and data model expectations.
- `docs/runbooks/OPERATOR_RUNBOOK.md`: deploy and operator procedures.
- `docs/public/README.md`: public/operator-facing feature catalog.
- `docs/templates/FEATURE_PUBLIC_DOC_TEMPLATE.md`: feature doc template.

## Current Source Layout

- `src/index.ts`: Apps Script global entry points, custom menus, triggers, and callable wrappers.
- `src/config/`: script property keys, schemas, resource names, and configuration helpers.
- `src/forms/`: form submit handlers and response parsing.
- `src/services/`: business workflows, setup/provisioning, sync, formatting, protections, audit, attendance, directory, excusals, and admin tooling.
- `src/utils/`: reusable helpers for arrays, env access, headers, logging, and Sheets table operations.
- `src/types.ts`: shared TypeScript contracts.
- `appsscript.json`: Apps Script manifest, advanced services, timezone, and OAuth scopes.
- `dist/`: generated build output. Do not edit or commit generated files.

There are currently no `src/sheets/` or `src/triggers/` directories. Put sheet helpers in `src/utils/sheets.ts` unless a larger refactor creates a dedicated module, and keep Apps Script trigger entry points in `src/index.ts`.

## Build And Deploy Commands

- Install dependencies: `npm install`
- Type-check/build: `npm run build`
- Clean generated output: `npm run clean`
- Deploy to Apps Script: `npm run push`
- Pull remote Apps Script changes: `npm run pull`
- Check clasp status: `npm run status`

Do not run `npm run push`, `npm run pull`, or deployment-affecting commands unless the user asks for deployment or the task explicitly requires it.

## System Invariants

These are non-negotiable unless the user explicitly asks to change the system design and the docs are updated:

- Setup/provisioning must be idempotent and safe to re-run.
- Script properties hold environment-specific IDs and flags. Source control must not contain real workbook/form IDs.
- Row 1 contains stable machine headers.
- Row 2 contains display headers where applicable.
- Code must read/write by header name, not by hardcoded column position, except where Apps Script APIs require temporary positional operations and the mapping is local and obvious.
- Data Legend ranges drive dropdowns and validation lists.
- Backend/admin workbook data is authoritative; frontend/main workbook is protected and user-facing.
- Forms must require verified responder emails where Apps Script supports it.
- Admin menu actions should be auditable through `AuditService` when they mutate data or affect operator state.
- Every operator-invoked menu action must run through `runMenuAction(...)` so it receives the shared live-progress, audit, cancellation, and failure behavior. New workflows must add plain-language `ProgressService` stages and hints at meaningful boundaries; use stage-based progress when exact row-level progress is unavailable rather than inventing precision.
- Changes that affect operator workflow must update docs and validation steps.

## Baseline And Compatibility

- Use the current schemas, script properties, menu structure, and service boundaries as the baseline.
- Do not add backwards compatibility for older CSV layouts, retired property names, or old sheet structures unless current production data still needs it or the user asks for it.
- When a task establishes a new baseline, remove obsolete migration checks in the same change when safe.
- For major rewrites, document what is supported after the change and how operators validate the new baseline.
- Version user-callable Apps Script entry points or workflows when the old and new behaviors must coexist.

## Safety And Privacy

Before staging or committing, scan for:

- Raw Google Sheet/Form/Drive IDs.
- Personal names added for one-off operational fixes.
- Personal emails or phone numbers.
- Secrets, tokens, API keys, private keys, cookies, or OAuth data.
- Local files such as `.clasp.json`, `.env*`, `.claude/`, `.DS_Store`, `dist/`, `node_modules/`, and `data/*`.

Use placeholders and runtime prompts for operational data. If a one-time admin action needs real people or real IDs, supply them through the UI, Script Properties, or an ignored local file rather than source code.

## Implementation Guidance

- Follow existing namespace style. This project uses Apps Script-compatible TypeScript namespaces rather than module imports.
- Keep Apps Script global functions in `src/index.ts` so menus and triggers can call them.
- Keep orchestration in `src/services/`.
- Keep raw Apps Script IO localized and make business rules easy to read.
- Use `ProgressService.report(...)`, `ProgressService.waiting(...)`, and `ProgressService.background(...)` for operator-visible milestones, prompts, and saved continuations. Progress copy must be non-technical and must not expose resource IDs, emails, personal data, or stack details.
- Prefer existing helpers:
  - `Config.getScriptProperty`, `Config.setScriptProperty`, and related property helpers.
  - `Config.getBackendId`, `Config.getFrontendId`, `Config.getBackendSheet`, `Config.getFrontendSheet`.
  - `SheetUtils.readTable`, `SheetUtils.appendRows`, `SheetUtils.ensureSchemaColumns`.
  - `AuditService.log` for auditable operations.
  - `Log.info`, `Log.warn`, `Log.error` for logging.
- Avoid adding dependencies unless the repo clearly needs them.
- Do not reformat unrelated files or churn generated output.

## Documentation Rules

Update documentation in the same change when you alter:

- Menu labels or operator entry points.
- Form questions, branching, or submission behavior.
- Sheet schemas, tab names, or key columns.
- Script properties or setup behavior.
- Deploy, auth, trigger, or recovery steps.
- Security, privacy, or audit behavior.

Use:

- `docs/public/README.md` for operational feature behavior.
- `docs/system/SYSTEM_SPEC.md` for system invariants and architecture.
- `docs/runbooks/OPERATOR_RUNBOOK.md` for deployment and recovery steps.
- `docs/ai/FEATURE_CHANGE_CHECKLIST.md` for feature readiness criteria.

## Git Workflow

Before editing:

```sh
git status --short --branch
```

Before committing:

```sh
npm run build
git diff --check
git status --short
```

Recommended commit shape:

```text
<type>(<scope>): <short imperative summary>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`.

See `docs/ai/COMMIT_AND_PR_GUIDELINES.md` for commit and PR details.

## Delivery Workflow

For code or behavior changes, the expected lifecycle is:

1. Develop locally.
2. Update documentation and operator notes in the same change.
3. Validate locally with `npm run build`, `git diff --check`, and a privacy/secret scan.
4. Commit with a clear message.
5. Push the branch to GitHub.
6. Open/update a PR or merge only when requested.
7. Deploy to production SHAMROCK with `npm run push` only when explicitly requested or approved.
8. Run post-deploy validation and report the result.

The GitHub history is the source edit log for Apps Script changes. Do not deploy uncommitted local code.

## Completion Checklist

For implementation tasks, finish with:

- Code changed only where needed.
- Docs updated where behavior changed.
- Build passes with `npm run build`.
- Working tree reviewed with `git status --short`.
- Privacy/secret scan completed for staged or changed files.
- Final response lists what changed, validation run, and any remaining risk.
