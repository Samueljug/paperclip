---
name: quillio-house
description: Quillio house knowledge — the codebase map, stack, conventions, tenancy, data-sovereignty, repos, and commands for the quillio-backend and quillio-frontend repos. Load this before reading, planning, building, testing, reviewing, or verifying any Quillio code so you navigate by the real layout instead of guessing. Keywords - quillio, backend, frontend, modular monolith, firm_id, FastAPI, Nuxt, PrimeVue, tenancy, ap-southeast-2.
---

# Quillio House Knowledge

This is the shared map every agent loads before touching Quillio code. Use it to
navigate by the real structure; confirm exact paths in the live clone with the
grep anchors below rather than assuming.

## Repos and branches

- Backend: `aila-quillio/quillio-backend` — work on and PR to `stage`.
- Frontend: `aila-quillio/quillio-frontend` — work on and PR to `stage`.
- One fresh work folder per task under `/Users/samuelimini/Development/*`. Never
  mix repos or tasks in one folder.

## Backend stack and layout

FastAPI (Python), MongoDB via **MongoEngine**, Redis, Weaviate (vector search),
Celery (background jobs). Alembic is present for SQL-side migrations.

Current top-level under `app/`:

- `app/api/` — FastAPI routers / endpoints.
- `app/services/` — business logic. **Logic belongs here**, not in routers or tasks.
- `app/models/` — MongoEngine documents.
- `app/schemas/` — Pydantic request/response models.
- `app/integrations/<partner>/` — third-party PMS integrations (Clio, Smokeball,
  Actionstep, OneLaw, iManage, LEAP).
- `app/core/`, `app/utils/`, `app/prompts/` — cross-cutting.
- `app/tasks.py` + `app/<domain>_tasks.py` (e.g. `clio_tasks.py`,
  `smokeball_tasks.py`, `user_tasks.py`) — Celery tasks.

**Architecture direction (Modular Monolith):** the target is domain modules under
`app/modules/<domain>/` with the standard split (router / service / schemas /
models / tasks). New integrations and domains follow that module pattern. Hold
the boundaries: no cross-domain imports (go through a service interface), no new
circular dependencies, keep files under ~500 lines, model the domain explicitly
(DDD). Report a needed restructure as a separate ticket rather than smuggling it
into a feature change.

Find things fast:

- A domain's endpoints: `grep -rn "APIRouter" app/api`
- Where logic lives: look in `app/services/<domain>*.py`
- Celery tasks: `grep -rn "@shared_task\|@celery" app`

## Frontend stack and layout

**Nuxt 3 + Vue 3** (Composition API), **PrimeVue** components, **TanStack Query**
(`@tanstack/vue-query`), TypeScript, **Vitest** tests, ESLint flat config
(`eslint.config.mjs`), lefthook git hooks. App code lives under **`app/`** (not
`src/`).

- HTTP goes through the **`ApiService`** base-class pattern — extend it, do not
  hand-roll axios calls. Find it: `grep -rn "class .*ApiService\|extends ApiService" app`
- Data fetching uses TanStack Query composables (`useQuery`/`useMutation`);
  invalidate the right query keys after a mutation.
- Preserve responsiveness, accessibility, and text-fit; the design source of
  truth is `aila-website` `DESIGN.md`.

## Tenancy — non-negotiable

Quillio is multi-tenant by **firm**. Cross-firm leakage is an existential breach.
Every DB query, response, cache key, and background job must be scoped to the
caller's firm.

- Tenant key: `firm_id` (also seen as `tenant_id` / `organisation_id`).
- Current firm: `grep -rn "get_current_firm\|current_firm\|current_tenant" app`
- Never return or look up an object by id without also scoping it to the firm.

## Data sovereignty — non-negotiable

Australian law-firm data and its derivatives (embeddings, prompts, logs, backups)
must stay in **ap-southeast-2 (Sydney)**. LLM inference routes through the
approved in-region path (Bedrock). Any new external call, SDK, cloud resource, or
model endpoint must be proven in-region before it ships.

## Commands

Backend:

- Tests: `python -m pytest tests/unit/ -x --tb=short` (markers: `unit`,
  `integration`, `slow`, `auth`, `api`; integration uses Docker Compose).
- Lint: `ruff check .` and `flake8`.
  Frontend:
- Tests: the Vitest config (`vitest.config.mjs`) — `npm run test` / `npx vitest run`.
- Lint/type: `npm run lint` (ESLint) and the TypeScript check (`vue-tsc` / `nuxi typecheck`).

Always run the repo's real commands and report exact output. Confirm the precise
script names in `package.json` / the backend scripts before claiming a command.
