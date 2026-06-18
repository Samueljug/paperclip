# Frontend Architecture

## Stack

- **Nuxt 3** SPA mode (SSR disabled). File-based routing.
- **Vue 3** `<script setup lang="ts">` only.
- **PrimeVue 3** (https://v3.primevue.org/) auto-imported.
- **TanStack Vue Query** for reads/mutations.
- **Pinia** for app-wide state (rare; prefer composables).
- **Axios** wrapped by `ApiService` base class.
- **CASL** for authorization.
- **SCSS** scoped styles only.
- **Yarn** package manager (do NOT use npm; do NOT generate `package-lock.json`).

## Module Layout for a New Integration

```
frontend-legal/app/
├── types/<partner>.types.ts                 # interfaces (I-prefixed)
├── services/<partner>.service.ts            # extends ApiService
├── composables/<partner>/
│   ├── use<Partner>Connection.ts
│   ├── use<Partner>Browse.ts
│   ├── use<Partner>Import.ts
│   ├── use<Partner>ImportProgress.ts
│   └── use<Partner>SyncHistory.ts
├── components/integrations/<partner>/
│   ├── ConnectButton.vue
│   ├── DisconnectButton.vue
│   ├── ConnectionStatus.vue
│   ├── MatterBrowser.vue
│   ├── MatterTree.vue
│   ├── ImportModal.vue
│   ├── ImportProgress.vue
│   ├── SyncHistoryTable.vue
│   └── WebhookKeyAdmin.vue
└── pages/integrations/<partner>/
    ├── index.vue
    └── sync-history.vue
```

## Data Flow

```
Component
   │  uses
   ▼
Composable (use<Partner>*)
   │  calls
   ▼
TanStack Vue Query (useQuery / useMutation)
   │  fn calls
   ▼
$services.<partner> (injected via Nuxt plugin)
   │  HTTP via Axios
   ▼
Backend /integrations/<partner>/* endpoints
```

## Service Registration

Every new service must be registered in `frontend-legal/app/plugins/03.service-provider.ts`:

```ts
import <Partner>Service from '@/services/<partner>.service'

interface IServiceProvider {
  // ... existing services
  <partner>: <Partner>Service
}

export default defineNuxtPlugin(() => {
  const services: IServiceProvider = {
    // ... existing
    <partner>: new <Partner>Service(),
  }
  return { provide: { services } }
})
```

After registration, components access via:

```ts
const { $services } = useNuxtApp()
const url = await $services.<partner>.getAuthUrl()
```

## Routing

File-based — `pages/integrations/<partner>/index.vue` is auto-mapped to `/integrations/<partner>`. Add the route to the sidebar nav (look for the existing list of integrations in the sidebar component and append).

## OneLaw as Mirror

OneLaw frontend lives in `frontend-legal/app/`. Search for `onelaw` as you work; copy patterns wherever possible. If OneLaw doesn't have a pattern (e.g., new partner exposes a feature OneLaw lacks), invent it cleanly and add to this skill afterward.

## State Ownership

- **Connection status, recent items, search results, document tree** — TanStack Vue Query.
- **Import job progress (real-time)** — local reactive state in `use<Partner>ImportProgress` composable, fed by WebSocket. Do not put live job state in TanStack — invalidation is too coarse.
- **Selected items in matter browser** — local component state. Lift to composable only if shared across siblings.
- **Connected partner credentials** — never on client. Backend owns.

## File Size Budget

| Type | Soft cap | Hard cap |
|---|---|---|
| Component `.vue` | 200 lines | 350 lines |
| Composable `.ts` | 250 lines | 400 lines |
| Service `.ts` | 200 lines | 300 lines |
| Type file `.ts` | 200 lines | 350 lines |

If a component exceeds 200 lines, split into sub-components. If a composable exceeds 250 lines, split by concern.

## Linting

`eslint` + `prettier` enforced. Run `yarn lint` before commit. Pre-commit hook in the repo.

## TypeScript

Strict mode on. No `any`. No `@ts-ignore` without a comment explaining why.
