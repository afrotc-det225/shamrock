# Commit And PR Guidelines

These guidelines define the standard SHAMROCK change lifecycle from local development through GitHub and production deployment.

## Standard Change Lifecycle

Use this sequence for code or behavior changes:

1. Develop the change locally.
2. Update docs in the same change when behavior, schemas, menus, setup, deployment, or operator steps change.
3. Run local validation.
4. Review changed files for secrets, raw IDs, personal data, and local-only files.
5. Commit with a clear message.
6. Push the branch to GitHub.
7. Open or update a PR when review is expected.
8. Merge to `main` only when requested or explicitly approved.
9. Deploy to production SHAMROCK only when requested or explicitly approved.
10. Record post-deploy validation in the PR, final response, or a follow-up commit if docs need updating.

## Before Creating A Commit

Run:

```sh
git status --short --branch
npm run build
git diff --check
```

Review changed files for:

- Secrets, tokens, private keys, cookies, OAuth material.
- Raw Google Sheet/Form/Drive IDs.
- Personal names, personal emails, phone numbers, or cadet data.
- Local files such as `.clasp.json`, `.env*`, `.claude/`, `.DS_Store`, `dist/`, `node_modules/`, and `data/*`.
- Unrelated formatting or generated output churn.

## Commit Message Format

Use:

```text
<type>(<scope>): <short imperative summary>
```

Examples:

```text
feat(attendance): add deputy commander summary cc
fix(forms): ignore excusal navigation responses
docs(ai): add agent task brief template
chore(config): ignore local agent settings
```

Allowed common types:

- `feat`: user-visible or operator-visible capability.
- `fix`: bug fix.
- `docs`: documentation only.
- `refactor`: behavior-preserving code restructuring.
- `chore`: tooling, config, or maintenance.
- `test`: tests or validation helpers.

If the change is large, include a commit body:

```text
Why:
-

What:
-

Validation:
- npm run build
-
```

## Branch Expectations

- Keep feature work on `dev` unless the user asks otherwise.
- Merge into `main` only when requested or when following an explicit release/deploy instruction.
- Prefer a normal merge when preserving branch history matters.
- Do not rewrite public history unless the user explicitly asks for it.
- Push completed work to GitHub so the Apps Script edit history has a corresponding git trace.

## Pull Request Expectations

Each PR should include:

- Summary of the behavior change.
- Files or subsystems touched.
- Documentation updates.
- Validation commands and results.
- Privacy/secret scan result.
- Deployment plan and production validation notes, if deployment is required.

Use `.github/pull_request_template.md` when opening a PR.

## Production Deployment Expectations

Production deployment means pushing the built Apps Script project to the production SHAMROCK Apps Script project with:

```sh
npm run push
```

Deployment rules:

- Do not deploy from the Apps Script editor.
- Do not deploy uncommitted code.
- Do not deploy code that has not passed `npm run build`.
- Do not deploy without explicit approval or a user request.
- After deployment, run the relevant post-deploy validation from `docs/runbooks/OPERATOR_RUNBOOK.md`.
- If the deployment changes operator behavior, ensure docs were already updated before deployment.

## When Not To Commit

Do not commit if:

- Build fails and the task was not explicitly to preserve a failing state.
- The diff includes suspected secrets or personal data.
- The working tree contains unrelated user changes that cannot be cleanly separated.
- The user asked for analysis or review only.

## When Not To Deploy

Do not deploy if:

- The user did not request or approve deployment.
- The change is not committed.
- Local validation failed.
- The target Apps Script project is ambiguous.
- Required documentation or operator validation steps are missing.
