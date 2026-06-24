---
name: quality-checks
description: Run the repo's real linters, type-checkers, and tests as deterministic evidence during the build loop — not vibes, not "looks right". Use while implementing or verifying any Quillio change so type/lint/test failures are caught mid-build, before the gate. Keywords - lint, ruff, flake8, mypy, eslint, vue-tsc, typecheck, pytest, vitest, coverage, CI.
allowed-tools: Bash, Read
---

# Quality Checks (deterministic, in the loop)

Don't claim a change is correct — prove it with the repo's own tooling, and run
it as you build, not only at the gate. Always run the real commands and report
exact output (pass/fail counts and failures verbatim). Confirm script names in
`package.json` or the backend scripts before asserting a command.

## Backend (FastAPI / Python)

- Lint: `ruff check <changed paths>` then `flake8 <changed paths>`.
- Types (if configured): `mypy <changed paths>`.
- Tests: `python -m pytest tests/unit/ -x --tb=short`; scope to the touched area
  first (`-k <pattern>` or a path), then widen. Markers: `unit`, `integration`,
  `slow`, `auth`, `api`. Integration tests use Docker Compose.
- Pre-commit hygiene exists (ruff, flake8, gitleaks, custom pii-log / jwt-exposure
  / redis-ttl checks) — run it where available rather than reinventing it.

## Frontend (Nuxt 3 / Vue 3 / TS)

- Lint: `npm run lint` (ESLint flat config, `eslint.config.mjs`).
- Types: the TypeScript check — `vue-tsc` / `nuxi typecheck` (use the script in
  `package.json`).
- Tests: Vitest — `npx vitest run` (or the `package.json` test script). Scope to
  the changed component/composable first.

## Discipline

- Run the **changed-code** checks first for a fast loop; run the broader suite
  before handing off a token.
- Know the real CI contract: read the pipeline file (`bitbucket-pipelines.yml`)
  and treat targeted green as incomplete if CI will run more.
- A failing check is a finding to fix or report, never something to silence. Do
  not weaken a lint rule, skip a test, or `--no-verify` to get green.
- If a tool isn't installed in the work area, report that as a setup gap rather
  than installing anything global.
