# Composables (`use<Partner>*`)

Pattern per `frontend-legal/CLAUDE.md`. Each composable owns one concern.

## File Layout

```
app/composables/<partner>/
├── use<Partner>Connection.ts       # connect, logout, status polling
├── use<Partner>Browse.ts           # clients, matters, search, tree
├── use<Partner>Recent.ts           # recent clients/matters MRU
├── use<Partner>Import.ts           # start import mutation, cancel mutation
├── use<Partner>ImportProgress.ts   # WebSocket subscription per job
├── use<Partner>SyncHistory.ts      # paginated audit log
└── use<Partner>WebhookKey.ts       # admin-only key management
```

## Query Keys

Centralise to avoid drift:

```ts
// app/composables/<partner>/keys.ts
export const <partner>Keys = {
  all: ['<partner>'] as const,
  connection: () => [...<partner>Keys.all, 'connection'] as const,
  clients: (params?: object) => [...<partner>Keys.all, 'clients', params] as const,
  matters: (params?: object) => [...<partner>Keys.all, 'matters', params] as const,
  matterTree: (matterId: string, params?: object) =>
    [...<partner>Keys.all, 'matterTree', matterId, params] as const,
  search: (q: string) => [...<partner>Keys.all, 'search', q] as const,
  recentClients: () => [...<partner>Keys.all, 'recent', 'clients'] as const,
  recentMatters: () => [...<partner>Keys.all, 'recent', 'matters'] as const,
  job: (jobId: string) => [...<partner>Keys.all, 'job', jobId] as const,
  syncStatus: () => [...<partner>Keys.all, 'syncStatus'] as const,
  syncHistory: (params?: object) => [...<partner>Keys.all, 'syncHistory', params] as const,
  webhookKey: () => [...<partner>Keys.all, 'webhookKey'] as const,
}
```

## `use<Partner>Connection`

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'
import { <partner>Keys } from './keys'

export function use<Partner>Connection() {
  const { $services } = useNuxtApp()
  const queryClient = useQueryClient()

  const status = useQuery({
    queryKey: <partner>Keys.connection(),
    queryFn: () => $services.<partner>.getSyncStatus(),  // proxy for "are we connected?"
    staleTime: 30 * 1000,
  })

  const startConnect = async () => {
    const { url } = await $services.<partner>.getAuthUrl()
    const popup = window.open(url, '_blank', 'width=600,height=700')
    if (!popup) throw new Error('Popup blocked')

    // Poll connection status until callback completes.
    return new Promise<void>((resolve, reject) => {
      let attempts = 0
      const timer = window.setInterval(async () => {
        attempts++
        try {
          await queryClient.invalidateQueries({ queryKey: <partner>Keys.connection() })
          const isConnected = (await $services.<partner>.getSyncStatus()) !== null
          if (isConnected || popup.closed) {
            window.clearInterval(timer)
            popup.close()
            resolve()
          }
        } catch {
          /* keep polling */
        }
        if (attempts > 60) {
          window.clearInterval(timer)
          reject(new Error('Connection timed out'))
        }
      }, 2000)
    })
  }

  const logout = useMutation({
    mutationFn: () => $services.<partner>.logout(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: <partner>Keys.all }),
  })

  return { status, startConnect, logout }
}
```

## `use<Partner>Browse`

```ts
export function use<Partner>Clients(params: Ref<IListParams>) {
  const { $services } = useNuxtApp()
  return useQuery({
    queryKey: computed(() => <partner>Keys.clients(params.value)),
    queryFn: () => $services.<partner>.listClients(params.value),
    keepPreviousData: true,
    staleTime: 60 * 1000,
  })
}

export function use<Partner>Matters(params: Ref<IMatterListParams>) {
  const { $services } = useNuxtApp()
  return useQuery({
    queryKey: computed(() => <partner>Keys.matters(params.value)),
    queryFn: () => $services.<partner>.listMatters(params.value),
    keepPreviousData: true,
    staleTime: 60 * 1000,
  })
}

export function use<Partner>Search(query: Ref<string>) {
  const { $services } = useNuxtApp()
  const debounced = refDebounced(query, 300)
  return useQuery({
    queryKey: computed(() => <partner>Keys.search(debounced.value)),
    queryFn: () => $services.<partner>.unifiedSearch(debounced.value),
    enabled: computed(() => debounced.value.length >= 2),
    staleTime: 30 * 1000,
  })
}

export function use<Partner>MatterTree(matterId: Ref<string>, params: Ref<ITreeParams>) {
  const { $services } = useNuxtApp()
  return useQuery({
    queryKey: computed(() => <partner>Keys.matterTree(matterId.value, params.value)),
    queryFn: () => $services.<partner>.getMatterTree(matterId.value, params.value),
    enabled: computed(() => !!matterId.value),
  })
}
```

## `use<Partner>Import`

```ts
export function use<Partner>Import() {
  const { $services } = useNuxtApp()
  const queryClient = useQueryClient()

  const start = useMutation({
    mutationFn: (request: I<Partner>ImportRequest) => $services.<partner>.startImport(request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: <partner>Keys.syncStatus() }),
  })

  const cancel = useMutation({
    mutationFn: (jobId: string) => $services.<partner>.cancelImport(jobId),
    onSuccess: (_data, jobId) => {
      queryClient.invalidateQueries({ queryKey: <partner>Keys.job(jobId) })
      queryClient.invalidateQueries({ queryKey: <partner>Keys.syncStatus() })
    },
  })

  return { start, cancel }
}
```

## `use<Partner>ImportProgress` (WebSocket)

This composable owns transient WebSocket state — NOT TanStack Query (invalidation cadence is wrong for live progress).

```ts
import { ref, onScopeDispose, watch } from 'vue'

export function use<Partner>ImportProgress(jobId: Ref<string | null>) {
  const progress = ref<I<Partner>JobProgress | null>(null)
  const status = ref<I<Partner>JobStatus | null>(null)
  const error = ref<string | null>(null)
  const connected = ref(false)
  let socket: WebSocket | null = null
  let pingTimer: number | null = null

  const teardown = () => {
    if (pingTimer) {
      window.clearInterval(pingTimer)
      pingTimer = null
    }
    if (socket) {
      socket.close()
      socket = null
    }
    connected.value = false
  }

  const open = (id: string) => {
    teardown()
    const token = useCookie('access_token').value || ''
    const url = `${useRuntimeConfig().public.wsBackendBase}/integrations/<partner>/ws/import-status/${id}?token=${token}`
    socket = new WebSocket(url)

    socket.onopen = () => {
      connected.value = true
      pingTimer = window.setInterval(() => {
        socket?.send(JSON.stringify({ type: 'ping' }))
      }, 25000)
    }

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'snapshot') {
          progress.value = msg.job?.progress ?? null
          status.value = msg.job?.status ?? null
        } else if (msg.type === 'progress' && msg.data) {
          progress.value = msg.data
          status.value = msg.data.status ?? status.value
          if (msg.data.error) error.value = msg.data.error
        } else if (msg.type === 'pong') {
          /* keepalive */
        }
      } catch (e) {
        console.error('[<partner>] bad WS payload', e)
      }
    }

    socket.onerror = () => {
      error.value = 'Connection lost'
    }

    socket.onclose = () => {
      connected.value = false
    }
  }

  watch(jobId, (id) => {
    if (id) open(id)
    else teardown()
  }, { immediate: true })

  onScopeDispose(teardown)

  return { progress, status, error, connected }
}
```

## `use<Partner>SyncHistory`

```ts
export function use<Partner>SyncHistory(params: Ref<I<Partner>SyncHistoryParams>) {
  const { $services } = useNuxtApp()
  return useQuery({
    queryKey: computed(() => <partner>Keys.syncHistory(params.value)),
    queryFn: () => $services.<partner>.listSyncHistory(params.value),
    keepPreviousData: true,
  })
}
```

## `use<Partner>WebhookKey`

```ts
export function use<Partner>WebhookKey() {
  const { $services } = useNuxtApp()
  const queryClient = useQueryClient()

  const status = useQuery({
    queryKey: <partner>Keys.webhookKey(),
    queryFn: () => $services.<partner>.getWebhookKey(),
  })

  const save = useMutation({
    mutationFn: (key: string) => $services.<partner>.saveWebhookKey(key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: <partner>Keys.webhookKey() }),
  })

  return { status, save }
}
```

## Composable Discipline

- Never call `$services.*` from a component directly — always via a composable. Components should only consume composable return values.
- Always invalidate the right query keys on mutation. The keys helper makes this discoverable.
- TanStack Query handles loading/error states. Components do not need their own `loading.value` refs except for non-Query operations (WebSocket, raw `fetch`).
- WebSocket teardown is critical. `onScopeDispose` covers component unmount; `watch` covers job ID changes within the same component.
