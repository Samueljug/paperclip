# Service (`<partner>.service.ts`)

## Pattern

Extend `ApiService` (lives at `app/services/api.service.ts`). Use generics on every HTTP method. Wrap mutating bodies in `{ request, notif }` envelope where the `notif` flag controls whether the global toast surfaces success/error.

## Skeleton

```ts
// app/services/<partner>.service.ts

import ApiService from '@/services/api.service'
import type {
  I<Partner>Page,
  I<Partner>Client,
  I<Partner>Matter,
  I<Partner>SearchResponse,
  I<Partner>TreeItem,
  I<Partner>ImportRequest,
  I<Partner>ImportResponse,
  I<Partner>JobProgress,
  I<Partner>SyncEvent,
  I<Partner>SyncHistoryParams,
  I<Partner>WebhookKey,
} from '@/types/<partner>.types'

interface IListParams {
  search?: string
  page?: number
  pageSize?: number
}

interface IMatterListParams extends IListParams {
  clientId?: string
}

interface ITreeParams {
  page?: number
  pageSize?: number
  categoryId?: string
}

export default class <Partner>Service extends ApiService {
  private readonly base = '/integrations/<partner>'

  // --- Auth ---
  public getAuthUrl = async () =>
    this.get<{ url: string }>(`${this.base}/auth/login`)

  public logout = async () =>
    this.post<{ status: string }>(`${this.base}/auth/logout`, {
      request: {},
      notif: { url: '', status: true },
    })

  // --- Browse ---
  public listClients = async (params: IListParams = {}) =>
    this.get<I<Partner>Page<I<Partner>Client>>(`${this.base}/clients`, { params })

  public listMatters = async (params: IMatterListParams = {}) =>
    this.get<I<Partner>Page<I<Partner>Matter>>(`${this.base}/matters`, { params })

  public unifiedSearch = async (q: string) =>
    this.get<I<Partner>SearchResponse>(`${this.base}/search`, { params: { q } })

  public getMatterTree = async (matterId: string, params: ITreeParams = {}) =>
    this.get<{ items: I<Partner>TreeItem[]; total: number; page: number }>(
      `${this.base}/matters/${matterId}/tree`,
      { params },
    )

  public getRecentClients = async () =>
    this.get<I<Partner>Client[]>(`${this.base}/recent/clients`)

  public getRecentMatters = async () =>
    this.get<I<Partner>Matter[]>(`${this.base}/recent/matters`)

  // --- Import / Export ---
  public startImport = async (request: I<Partner>ImportRequest) =>
    this.post<I<Partner>ImportResponse>(`${this.base}/import`, {
      request,
      notif: { url: '', status: false },
    })

  public getJob = async (jobId: string) =>
    this.get<I<Partner>JobProgress>(`${this.base}/jobs/${jobId}`)

  public cancelImport = async (jobId: string) =>
    this.delete<{ jobId: string; status: string }>(`${this.base}/cancel-import/${jobId}`)

  // --- Sync history ---
  public getSyncStatus = async () =>
    this.get<{ items: { id: string; title: string; status: string }[] }>(
      `${this.base}/sync-status`,
    )

  public listSyncHistory = async (params: I<Partner>SyncHistoryParams = {}) =>
    this.get<I<Partner>Page<I<Partner>SyncEvent>>(`${this.base}/sync-history`, { params })

  public getSyncEvent = async (eventId: string) =>
    this.get<I<Partner>SyncEvent>(`${this.base}/sync-history/${eventId}`)

  // --- Webhook key (skip if no webhooks) ---
  public getWebhookKey = async () =>
    this.get<I<Partner>WebhookKey>(`${this.base}/webhook-key`)

  public saveWebhookKey = async (key: string) =>
    this.put<{ status: string }>(`${this.base}/webhook-key`, {
      request: { key },
      notif: { url: '', status: true },
    })
}
```

## Conventions Recap

- `export default class` — never named export. Plugin imports default.
- Arrow-function method bindings (`public foo = async () =>`) preserve `this` if methods are passed as callbacks.
- Generics on every HTTP call. Type the response, not the request.
- Mutating endpoints (POST/PUT/DELETE) take `{ request, notif }` envelope.
  - `notif.status: true` shows a toast on success/error.
  - `notif.status: false` suppresses (use for live operations like import start where the modal owns the UX).
  - `notif.url` is the navigation target on success — usually empty.
- `params` go in axios `params` object; URLs never embed query strings manually.
- Path parameters interpolated via template literals (`${this.base}/jobs/${jobId}`).

## Plugin Registration

Edit `frontend-legal/app/plugins/03.service-provider.ts`:

```ts
import <Partner>Service from '@/services/<partner>.service'

// Inside IServiceProvider interface:
<partner>: <Partner>Service

// Inside the services object:
<partner>: new <Partner>Service(),
```

After registration:

```ts
const { $services } = useNuxtApp()
const url = await $services.<partner>.getAuthUrl()
```

## Error Surface

`ApiService` throws on non-2xx. Catch in composables (TanStack Query handles it). Do not catch inside the service — let the error bubble.

## Testing

Mock `ApiService` HTTP layer at the test level. See `quillio-integration-tests/references/frontend-tests.md`.
