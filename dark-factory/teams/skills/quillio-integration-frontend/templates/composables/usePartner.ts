// Drop into: frontend-legal/app/composables/<partner>/usePartner.ts (or split per concern).
// Split when this file passes 250 lines.

import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import { useNuxtApp, useCookie, useRuntimeConfig } from '#app'
import type {
  I<Partner>ImportRequest,
  I<Partner>JobProgress,
  I<Partner>JobStatus,
} from '@/types/<partner>.types'

// ----------- Query keys -----------

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

// ----------- Connection -----------

export function use<Partner>Connection() {
  const { $services } = useNuxtApp()
  const queryClient = useQueryClient()

  const status = useQuery({
    queryKey: <partner>Keys.connection(),
    queryFn: () => $services.<partner>.getSyncStatus(),
    staleTime: 30 * 1000,
  })

  const startConnect = async (): Promise<void> => {
    const { url } = await $services.<partner>.getAuthUrl()
    const popup = window.open(url, '_blank', 'width=600,height=700')
    if (!popup) throw new Error('Popup blocked — allow popups for this site')

    return new Promise<void>((resolve, reject) => {
      let attempts = 0
      const timer = window.setInterval(async () => {
        attempts++
        try {
          const s = await $services.<partner>.getSyncStatus()
          if (s) {
            window.clearInterval(timer)
            if (!popup.closed) popup.close()
            await queryClient.invalidateQueries({ queryKey: <partner>Keys.all })
            resolve()
            return
          }
        } catch {
          /* still pending */
        }
        if (popup.closed) {
          window.clearInterval(timer)
          reject(new Error('Connection cancelled'))
          return
        }
        if (attempts > 30) {
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

// ----------- Browse -----------

export function use<Partner>Clients(params: Ref<{ search?: string; page?: number }>) {
  const { $services } = useNuxtApp()
  return useQuery({
    queryKey: computed(() => <partner>Keys.clients(params.value)),
    queryFn: () => $services.<partner>.listClients(params.value),
    keepPreviousData: true,
    staleTime: 60 * 1000,
  })
}

export function use<Partner>Matters(
  params: Ref<{ clientId?: string; search?: string; page?: number }>,
) {
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

export function use<Partner>MatterTree(
  matterId: Ref<string>,
  params: Ref<{ page?: number; pageSize?: number; categoryId?: string }>,
) {
  const { $services } = useNuxtApp()
  return useQuery({
    queryKey: computed(() => <partner>Keys.matterTree(matterId.value, params.value)),
    queryFn: () => $services.<partner>.getMatterTree(matterId.value, params.value),
    enabled: computed(() => !!matterId.value),
  })
}

// ----------- Import -----------

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

// ----------- WebSocket import progress -----------

const TERMINAL_STATES: I<Partner>JobStatus[] = ['completed', 'failed', 'cancelled']

export function use<Partner>ImportProgress(jobId: Ref<string | null>) {
  const progress = ref<I<Partner>JobProgress | null>(null)
  const status = ref<I<Partner>JobStatus | null>(null)
  const error = ref<string | null>(null)
  const connected = ref(false)
  let socket: WebSocket | null = null
  let pingTimer: number | null = null
  let teardownInitiated = false
  let reconnectAttempts = 0
  const MAX_RECONNECTS = 1

  const teardown = () => {
    teardownInitiated = true
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
    teardownInitiated = false
    reconnectAttempts = 0
    if (socket) socket.close()
    const token = useCookie('access_token').value || ''
    const config = useRuntimeConfig()
    const wsBase = (config.public as { wsBackendBase?: string }).wsBackendBase || ''
    const url = `${wsBase}/integrations/<partner>/ws/import-status/${id}?token=${token}`
    socket = new WebSocket(url)

    socket.onopen = () => {
      connected.value = true
      reconnectAttempts = 0
      pingTimer = window.setInterval(() => {
        socket?.send(JSON.stringify({ type: 'ping' }))
      }, 25000)
    }

    socket.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'snapshot' && msg.job) {
          progress.value = msg.job.progress ?? null
          status.value = msg.job.status ?? null
        } else if (msg.type === 'progress' && msg.data) {
          progress.value = msg.data as I<Partner>JobProgress
          status.value = (msg.data.status as I<Partner>JobStatus) ?? status.value
          if (msg.data.error) error.value = msg.data.error
        }
      } catch (e) {
        console.error('[<partner>] bad WS payload', e)
      }
    }

    socket.onerror = () => {
      error.value = 'Connection lost — refresh to see latest status'
    }

    socket.onclose = (event) => {
      connected.value = false
      if (event.wasClean || teardownInitiated || reconnectAttempts >= MAX_RECONNECTS) return
      reconnectAttempts++
      window.setTimeout(() => {
        if (jobId.value && !teardownInitiated) open(jobId.value)
      }, 2000)
    }
  }

  watch(
    jobId,
    (id) => {
      if (id) open(id)
      else teardown()
    },
    { immediate: true },
  )

  onScopeDispose(teardown)

  const isTerminal = computed(() =>
    status.value ? TERMINAL_STATES.includes(status.value) : false,
  )

  return { progress, status, error, connected, isTerminal }
}

// ----------- Sync history -----------

export function use<Partner>SyncHistory(
  params: Ref<{ folderId?: string; page?: number; pageSize?: number }>,
) {
  const { $services } = useNuxtApp()
  return useQuery({
    queryKey: computed(() => <partner>Keys.syncHistory(params.value)),
    queryFn: () => $services.<partner>.listSyncHistory(params.value),
    keepPreviousData: true,
  })
}

// ----------- Webhook key admin -----------

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
