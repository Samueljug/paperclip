---
name: api-integration
description: Full-stack frontend feature integration — creates types, service, composables, and component scaffolding for a new API-backed feature. Use when building a complete new feature end-to-end.
argument-hint: [feature-name] [base-endpoint]
allowed-tools: Read, Glob, Grep, Edit, MultiEdit, Write, Bash
---

# Full API Integration Builder

**SCOPE:** This skill targets a Vue 3 / Nuxt 3 / PrimeVue 3 / TanStack Query frontend. Detect the frontend root by looking for `nuxt.config.ts`, `vue.config.js`, or `package.json` with `nuxt`/`vue` in dependencies — at repo root or a subdirectory (common: `frontend/`, `frontend-legal/`, `web/`, `app/`). If a `CLAUDE.md` exists at the detected root, read it for conventions. All file paths you produce should be relative to the detected frontend root.

Build a complete frontend integration for **$ARGUMENTS[0]** with base endpoint `$ARGUMENTS[1]`.

## Execution Order

Follow this exact order to avoid import errors:

### Step 1: Types (`app/types/$0.types.ts`)

Create all interfaces needed for the feature. Read existing type files for conventions:

- Entity interface (main data model)
- Request interfaces (create, update, list/filter)
- Response interfaces (create, update, delete, list with pagination)
- Use `I` prefix on all interfaces
- Use `type` for unions/enums

### Step 2: Service (`app/services/$0.service.ts`)

Create the API service class extending `ApiService`:

- Import types from step 1
- `export default class` — not named export
- Arrow function methods: `public methodName = async () =>`
- Use generics on all HTTP methods: `this.get<IResponse>()`
- Wrap POST/PUT body with `{ request: data, notif: { url: '', status: false } }` when appropriate

### Step 3: Register Service (`app/plugins/03.service-provider.ts`)

- Add import at top
- Add to `IServiceProvider` interface
- Add to services object instantiation

### Step 4: Composables (`app/composables/$0/`)

Create composables for each operation:

- `use$0.ts` — single entity query (useQuery)
- `use$0List.ts` — list with filters (useQuery)
- `useCreate$0.ts` — create mutation (useMutation)
- `useUpdate$0.ts` — update mutation (useMutation)
- `useDelete$0.ts` — delete mutation (useMutation)

Each composable:

- Accesses service via `useNuxtApp()`
- Casts service: `$featureService as FeatureService`
- Uses descriptive query keys: `['$0']`, `['$0', id]`, `['$0-list', ...filters]`
- Accepts `Ref<T>` for reactive parameters

### Step 5: Verify

- Check all imports resolve correctly
- Ensure types are consistent between service, composables, and components
- Verify service is registered in plugin

## Real Project Examples

**Services**: `task.service.ts`, `folder.service.ts`, `tag.service.ts`
**Types**: `tasks.types.ts`, `folder.types.ts`, `tag.types.ts`
**Composables**: `composables/task/`, `composables/folder/`, `composables/tags/`

Read these files to match exact conventions before generating code.

## Checklist

- [ ] Types created with I prefix interfaces
- [ ] Service extends ApiService with typed methods
- [ ] Service registered in 03.service-provider.ts
- [ ] Query composables use useQuery with proper keys
- [ ] Mutation composables use useMutation
- [ ] No `any` types anywhere
- [ ] All imports use `import type` for type-only imports
