# Import Progress (WebSocket)

## Why Not TanStack Query

Import progress fires per-document during a job (could be 100s of updates per minute). TanStack `refetchInterval` would be too coarse and would re-fetch the entire job state instead of accepting deltas.

WebSocket is the right primitive. The composable owns reactive state directly; components consume it.

## Connection Lifecycle

```
1. ImportModal opens; user clicks "Start Import"
2. startImport mutation → returns { jobId, websocketUrl }
3. Component passes jobId to ImportProgress component
4. ImportProgress mounts, calls use<Partner>ImportProgress(jobId)
5. Composable opens WebSocket(websocketUrl + ?token=<jwt>)
6. Backend authenticates token, accepts connection, sends snapshot message
7. Backend forwards every progress publish to socket
8. Composable updates reactive `progress` / `status` refs
9. Component re-renders on every update
10. On terminal status (completed/failed/cancelled), composable still listens until component unmounts
11. On unmount (or jobId change): teardown closes socket and clears keepalive timer
```

## Message Schema

Server → Client:

```ts
type ServerMessage =
  | { type: 'snapshot'; job: { progress: I<Partner>JobProgress; status: I<Partner>JobStatus } }
  | { type: 'progress'; data: I<Partner>JobProgress }
  | { type: 'pong' }
  | { type: 'ping' }  // backend heartbeat — client doesn't need to respond
```

Client → Server:

```ts
type ClientMessage =
  | { type: 'ping' }      // client heartbeat
  | { type: 'get_status' } // request fresh snapshot
```

## Keepalive

Browsers and proxies (nginx, Cloudflare) close idle WebSockets after ~60s. Two-sided pings:

- Client sends `{type: 'ping'}` every 25s.
- Backend sends `{type: 'ping'}` every 25s.
- Either side responds to the other's ping with `{type: 'pong'}` (optional; ignoring is fine if both sides are sending their own).

## Reconnection

On `socket.onclose` (excluding intentional teardown), attempt one reconnect after 2s. If that fails, surface error to user. Do not infinite-loop reconnect — the user's WiFi might be off.

```ts
let reconnectAttempts = 0
const MAX_RECONNECTS = 1

socket.onclose = (event) => {
  connected.value = false
  if (event.wasClean || teardownInitiated || reconnectAttempts >= MAX_RECONNECTS) return
  reconnectAttempts++
  window.setTimeout(() => open(jobId.value!), 2000)
}
```

Reset `reconnectAttempts` on successful `onopen`.

## Auth

WebSocket cannot use HTTP `Authorization` header in browsers. Use `?token=<jwt>` query param. Backend reads it manually (see backend skill `router-wiring.md`).

```ts
const token = useCookie('access_token').value || ''
const url = `${useRuntimeConfig().public.wsBackendBase}/integrations/<partner>/ws/import-status/${id}?token=${token}`
```

`wsBackendBase` is the backend WebSocket base (e.g., `wss://api.aila.app`). Set in `nuxt.config.ts` runtime config.

## Snapshot Then Diff

The first message after auth should be a snapshot of the current job state. This catches up any progress that happened between job creation and WebSocket open. After the snapshot, all messages are progress updates that should REPLACE (not merge into) the local state.

If the partner-side progress publisher sends partial diffs, merge in the composable. OneLaw publishes full state every time, so REPLACE is sufficient.

## Cancel Flow

Cancel is a separate REST mutation, not a WebSocket message:

```
User clicks "Cancel"
    │
    ▼
ImportProgress component calls cancel.mutate(jobId)
    │
    ▼
DELETE /integrations/<partner>/cancel-import/{jobId}
    │
    ▼
Backend sets cancellation flag in Redis, publishes "cancelled" event
    │
    ▼
WebSocket receives progress message with status="cancelled"
    │
    ▼
Composable updates `status.value = "cancelled"`
    │
    ▼
Component shows terminal state and unmounts WebSocket
```

The cancel button should disable while `cancel.isPending.value`. The component should not optimistically set status — wait for the WebSocket message so we don't disagree with backend reality.

## Terminal States

```ts
const TERMINAL_STATES = ['completed', 'failed', 'cancelled'] as const
const isTerminal = computed(() => TERMINAL_STATES.includes(status.value as any))
```

When terminal, emit a `complete` event so the parent ImportModal can change footer buttons (replace "Cancel" with "Close"). The composable can keep listening for late messages (some backends send a final summary after the terminal state).

## Multiple Concurrent Jobs

If the user starts two imports in different tabs (or in the same tab from a list), each ImportProgress mounts its own composable instance with its own WebSocket. Backend's pub/sub is keyed by job_id so cross-talk is impossible.

If you want a global "active jobs" indicator, build a separate `use<Partner>ActiveJobs` composable that polls a list endpoint via TanStack — don't open a WebSocket per job for the indicator.

## Error UX

```ts
const error = ref<string | null>(null)

socket.onerror = () => {
  error.value = 'Lost connection to import — refresh to see latest status'
}

socket.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.data?.error) {
    error.value = msg.data.error
  }
}
```

The component shows the error in a `<Message>` PrimeVue banner. Errors do NOT close the WebSocket — the import may still finish.

## Network Considerations

- WSS (TLS) only. Never `ws://` in production.
- Allow time for slow networks: 30s initial connect timeout, 25s ping interval.
- Behind a proxy that rewrites `Connection: upgrade`? Confirm WebSocket upgrade headers pass through.
- If the user's network blocks WebSockets (corporate firewall), fall back to polling. The composable should expose a `mode: 'websocket' | 'polling'` flag and the component should not care which.

## Polling Fallback (optional)

```ts
const tryWebSocket = (id: string): Promise<void> => new Promise((resolve, reject) => {
  const socket = new WebSocket(...)
  socket.onopen = () => resolve()
  socket.onerror = () => reject()
  // ...
})

const open = async (id: string) => {
  try {
    await tryWebSocket(id)
  } catch {
    // Fallback to polling.
    pollTimer = window.setInterval(async () => {
      const job = await $services.<partner>.getJob(id)
      progress.value = job
      status.value = job.status
      if (TERMINAL_STATES.includes(job.status)) window.clearInterval(pollTimer!)
    }, 3000)
  }
}
```

Polling at 3s for a long-running import is acceptable, especially since the FE only renders the most recent state.
