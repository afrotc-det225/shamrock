# Copilot Instructions for SHAMROCK

Start with `AGENTS.md`. It is the repository-wide agent contract for Codex, Copilot, and other AI coding agents.

## What This Repo Is

SHAMROCK is an established Google Apps Script system written in TypeScript. It operates Google Sheets workbooks and Google Forms for directory, attendance, excusals, audit, and operator workflows.

The current code and docs are the baseline. Do not treat old implementation notes, one-off migration code, or historical compatibility paths as requirements unless the task explicitly says to preserve them.

## Read Before Changing Code

- `AGENTS.md`: agent operating contract.
- `docs/AI_CONTRIBUTION_GUIDE.md`: maintenance workflow.
- `docs/system/SYSTEM_SPEC.md`: system invariants and data model rules.
- `docs/runbooks/OPERATOR_RUNBOOK.md`: operational procedures.
- `docs/public/README.md`: operator-facing feature catalog.

## Critical Guardrails

- Build with `npm run build` before marking code work complete.
- Do not deploy with `npm run push` unless explicitly asked.
- Do not commit secrets, raw workbook/form IDs, personal data, `.clasp.json`, `.env*`, `dist/`, `node_modules/`, `.claude/`, or `data/*`.
- Keep Apps Script global entry points in `src/index.ts`.
- Keep orchestration in `src/services/`.
- Use existing helpers in `src/config/` and `src/utils/` before adding new patterns.
- Read/write sheet data by stable headers rather than hardcoded columns.
- Update docs when behavior, schema, menus, setup, deployment, or operator steps change.

## Useful Commands

```sh
npm run build
git diff --check
git status --short --branch
```

