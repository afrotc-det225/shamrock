# AI Task Brief Template

Use this template when handing a task to an AI agent or recording enough context for another agent to continue safely.

## Goal

State the desired outcome in one or two sentences.

## Context

- Related feature or workflow:
- User/operator affected:
- Current behavior:
- Desired behavior:
- Known constraints:

## Files To Read First

- `AGENTS.md`
- `docs/AI_CONTRIBUTION_GUIDE.md`
- `docs/system/SYSTEM_SPEC.md`
- Add task-specific files here.

## Scope

In scope:

-

Out of scope:

-

## Safety Requirements

- Do not commit raw Sheet/Form/Drive IDs.
- Do not commit personal names, personal emails, phone numbers, or cadet data.
- Do not deploy with `npm run push` unless explicitly requested.
- Preserve unrelated working-tree changes.

## Expected Changes

- Code:
- Docs:
- Tests or validation:
- GitHub update:
- Production deployment:

## Delivery Workflow

Use this order unless the user explicitly asks for a different workflow:

1. Develop the code and documentation change locally.
2. Validate locally.
3. Review changed files for secrets, raw IDs, and personal data.
4. Commit the change with a clear message.
5. Push the branch to GitHub.
6. Open or update a PR when review is expected, or merge only when explicitly requested.
7. Deploy to production SHAMROCK only after approval or an explicit deployment request.
8. Run post-deploy validation and record results in the PR, final response, or follow-up commit.

## Validation Plan

Required:

- `npm run build`
- `git diff --check`
- Privacy/secret scan over changed files

Manual or environment validation:

-

## GitHub Plan

- Branch:
- Commit message:
- Push target:
- PR needed: yes/no
- Merge target:

## Production Deployment Plan

- Deploy requested/approved: yes/no
- Deployment command: `npm run push`
- Target SHAMROCK environment:
- Post-deploy setup/repair action needed:
- Post-deploy validation:

## Completion Notes

The agent should report:

- Files changed.
- Commands run.
- Privacy/secret scan result.
- Commit hash, branch pushed, and PR link if created.
- Deployment command and production validation result, if deployed.
- Any skipped validation and why.
- Follow-up tasks, if any.
