---
name: quillio-integration-frontend
description: Build the frontend (Vue 3 + PrimeVue + TanStack Query + TypeScript) for a new AILA legal-practice-management integration. Use when the developer needs the connect button, OAuth round-trip handling, matter/client browser, document tree view, import modal with WebSocket progress, sync history page, and webhook key admin UI for a new partner integration. Mirrors the OneLaw frontend pattern. Trigger words: "build the {partner} frontend", "add the connect UI", "wire the import progress modal", "create the matter browser for {partner}". Always invoke quillio-integration master skill FIRST and quillio-integration-backend at least one step ahead so the API contract exists.
---

# Quillio Integration — Frontend Builder

**SCOPE:** `frontend-legal/app/`. Backend lives in `backend-legal/` and is consumed via `ApiService`-extending services.

## Strict Task Scope (NON-NEGOTIABLE)

Only create or modify frontend integration files, behaviour, tests, copy, and design explicitly authorised by the accepted task/plan. Adjacent UI improvements, refactors, cleanup, or extra partner capabilities become follow-up items for Samuel unless explicitly approved.

**TECH STACK** (per `frontend-legal/CLAUDE.md`):
- Nuxt 3 (file-based routing, SSR-aware composables)
- Vue 3 `<script setup lang="ts">` only
- PrimeVue 3 components (DataTable, Dialog, ProgressBar, Toast)
- TanStack Vue Query (`useQuery`, `useMutation`)
- TypeScript strict mode
- SCSS modules, scoped styles only

**CANONICAL REFERENCE:** OneLaw frontend lives in `frontend-legal/app/{services,composables,components,pages}/onelaw*`. Inspect that first.

---

## Mandatory Sequence

### Step 1: Types

Create `frontend-legal/app/types/<partner>.types.ts`:

- `I<Partner>Credentials` — connection status shape
- `I<Partner>Client`, `I<Partner>Matter`, `I<Partner>Document`, `I<Partner>TreeItem`
- `I<Partner>ImportRequest`, `I<Partner>ImportResponse`
- `I<Partner>SyncEvent`
- `I<Partner>JobProgress`
- All interfaces use `I` prefix; unions/enums use `type`.

### Step 2: Service

Create `frontend-legal/app/services/<partner>.service.ts`:

```ts
export default class <Partner>Service extends ApiService {
  public getAuthUrl = async () => this.get<{ url: string }>('/integrations/<partner>/auth/login')
  public listClients = async (params: I<Partner>ListParams) => this.get<I<Partner>ClientPage>('/integrations/<partner>/clients', { params })
  public listMatters = async (params: I<Partner>ListParams) => this.get<I<Partner>MatterPage>('/integrations/<partner>/matters', { params })
  public unifiedSearch = async (q: string) => this.get<I<Partner>SearchResponse>('/integrations/<partner>/search', { params: { q } })
  public getMatterTree = async (matterId: string, params?: I<Partner>TreeParams) => this.get<I<Partner>TreeResponse>(`/integrations/<partner>/matters/${matterId}/tree`, { params })
  public startImport = async (request: I<Partner>ImportRequest) => this.post<I<Partner>ImportResponse>('/integrations/<partner>/import', { request, notif: { url: '', status: false } })
  public cancelImport = async (jobId: string) => this.delete<I<Partner>JobResponse>(`/integrations/<partner>/cancel-import/${jobId}`)
  public getJob = async (jobId: string) => this.get<I<Partner>JobResponse>(`/integrations/<partner>/jobs/${jobId}`)
  public listSyncHistory = async (params: I<Partner>SyncHistoryParams) => this.get<I<Partner>SyncHistoryPage>('/integrations/<partner>/sync-history', { params })
  public saveWebhookKey = async (key: string) => this.put<{ status: string }>('/integrations/<partner>/webhook-key', { request: { key }, notif: { url: '', status: true } })
  public getWebhookKey = async () => this.get<{ configured: boolean; preview: string }>('/integrations/<partner>/webhook-key')
}
```

Register in `frontend-legal/app/plugins/03.service-provider.ts`.

### Step 3: Composables

Create `frontend-legal/app/composables/use<Partner>.ts` and split per concern if it grows:

| Composable | Purpose |
|---|---|
| `use<Partner>Connection` | Connection status, OAuth login start, logout |
| `use<Partner>Browse` | Clients, matters, search, tree (TanStack Query) |
| `use<Partner>Import` | Start import mutation, cancel mutation, WebSocket progress stream |
| `use<Partner>SyncHistory` | Paginated sync events |

Pattern: use `useQuery` for reads, `useMutation` for writes. Invalidate keys on mutation success. Pagination via `useInfiniteQuery` or page-based `useQuery` with `keepPreviousData: true`.

WebSocket progress: separate `use<Partner>ImportProgress(jobId)` composable that opens `WebSocket('/integrations/<partner>/ws/import-status/<jobId>?token=<jwt>')`, parses progress messages, exposes reactive `progress`, `status`, `error`. Tear down on `onScopeDispose`.

### Step 4: Pages

Create `frontend-legal/app/pages/integrations/<partner>/index.vue`:

- Wraps connection state + browse + import in a single page
- If not connected: ConnectButton
- If connected: MatterBrowser + sync history link + webhook key admin (collapsed)

Optional: `/pages/integrations/<partner>/sync-history.vue` for full audit log.

### Step 5: Components

Create under `frontend-legal/app/components/integrations/<partner>/`:

| Component | Purpose |
|---|---|
| `ConnectButton.vue` | Calls `getAuthUrl`, opens partner OAuth in new tab; on return polls connection status |
| `MatterBrowser.vue` | PrimeVue DataTable for clients/matters; left panel = clients, right panel = matters; search box top |
| `MatterTree.vue` | PrimeVue Tree showing matter document hierarchy; checkbox selection feeds ImportModal |
| `ImportModal.vue` | PrimeVue Dialog; opens on selection; calls `startImport`; embeds `ImportProgress` |
| `ImportProgress.vue` | Real-time progress UI fed by `use<Partner>ImportProgress`; per-document status, cancel button |
| `SyncHistoryTable.vue` | PrimeVue DataTable showing `<Partner>SyncEvent` rows; expandable for `processingSteps` |
| `WebhookKeyAdmin.vue` | Form to view/save webhook signing key (per-user by default) |

Mirror the existing OneLaw components for layout and styling. Read those before writing new ones.

### Step 6: Routing & Navigation

Add a sidebar/menu entry pointing to `/integrations/<partner>`. Pattern lives in `frontend-legal/app/components/layout/Sidebar.vue` (or wherever the project's nav lives — search first).

### Step 7: Verify

```bash
cd frontend-legal
yarn typecheck
yarn lint
yarn test
```

All three must pass before PR.

---

## Reference Docs

| File | Purpose |
|---|---|
| `references/architecture.md` | FE module layout, data flow, OneLaw mirror |
| `references/types.md` | Type-definition conventions, `I` prefix, interface vs type |
| `references/service.md` | `ApiService` extension, request envelope, notif config |
| `references/composables.md` | TanStack Query patterns, query keys, invalidation, WebSocket lifecycle |
| `references/components.md` | PrimeVue conventions, scoped SCSS, accessibility |
| `references/oauth-flow.md` | Connect button → new tab → callback → connection-status polling |
| `references/import-progress.md` | WebSocket connection, reconnection, progress reduction |

## Templates

| Template | Drops to |
|---|---|
| `templates/types/<partner>.types.ts` | `frontend-legal/app/types/` |
| `templates/services/<partner>.service.ts` | `frontend-legal/app/services/` |
| `templates/composables/use<Partner>.ts` | `frontend-legal/app/composables/` |
| `templates/components/ConnectButton.vue` | `frontend-legal/app/components/integrations/<partner>/` |
| `templates/components/MatterBrowser.vue` | same |
| `templates/components/ImportProgress.vue` | same |
| `templates/components/ImportModal.vue` | same |
| `templates/components/SyncHistoryTable.vue` | same |
| `templates/components/WebhookKeyAdmin.vue` | same |
| `templates/pages/index.vue` | `frontend-legal/app/pages/integrations/<partner>/` |

Search/replace `<partner>` (lowercase) and `<Partner>` (title case) before saving.

## Stop Conditions

Pause and ask the developer if:

- The integration has unusual connect flow (not OAuth in new tab, e.g. embedded credential form).
- The partner cannot be browsed by user (e.g. system-wide single-tenant connection) — UI shape changes.
- Backend is not yet built — frontend depends on contract; build backend skeleton first.
