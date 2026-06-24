# OAuth Round-Trip (Frontend)

## Sequence

```
User clicks "Connect"
        │
        ▼
ConnectButton calls $services.<partner>.getAuthUrl()
        │
        ▼
Backend returns { url: "https://partner-auth..." }
        │
        ▼
window.open(url, '_blank', 'width=600,height=700')
        │
        ▼
[User authenticates with partner in popup]
        │
        ▼
Partner redirects to backend /integrations/<partner>/auth/callback
        │
        ▼
Backend exchanges code, saves credentials, returns RedirectResponse
to {settings.base_url_user}?integration=<partner>&status=connected
        │
        ▼
Popup loads frontend URL with success param
        │
        ▼
Either:
  (a) Popup auto-closes via small JS in the redirect target
  (b) Original window polls connection status until success or timeout
```

## Polling Pattern (a)

The simplest UX: original window polls every 2s for up to 60s, popup remains user-controlled.

```ts
const startConnect = async () => {
  const { url } = await $services.<partner>.getAuthUrl()
  const popup = window.open(url, '_blank', 'width=600,height=700')
  if (!popup) throw new Error('Popup blocked — allow popups for this site')

  return new Promise<void>((resolve, reject) => {
    let attempts = 0
    const timer = window.setInterval(async () => {
      attempts++
      try {
        const status = await $services.<partner>.getSyncStatus()
        if (status) {
          window.clearInterval(timer)
          if (!popup.closed) popup.close()
          resolve()
        }
      } catch {
        /* still pending */
      }
      if (popup.closed) {
        window.clearInterval(timer)
        // Popup closed without callback — could be cancellation OR success.
        // Re-check once before failing.
        try {
          const status = await $services.<partner>.getSyncStatus()
          if (status) return resolve()
        } catch {
          /* fall through */
        }
        reject(new Error('Connection cancelled'))
      }
      if (attempts > 30) {
        window.clearInterval(timer)
        reject(new Error('Connection timed out'))
      }
    }, 2000)
  })
}
```

## Auto-Close Pattern (b)

Backend redirects to a dedicated frontend page that posts a message to the opener and self-closes.

`frontend-legal/app/pages/integrations/<partner>/connected.vue`:

```vue
<script setup lang="ts">
onMounted(() => {
  if (window.opener) {
    window.opener.postMessage({ type: '<partner>:connected' }, window.location.origin)
    window.close()
  } else {
    // Fallback: navigate to integrations page if not in popup.
    navigateTo('/integrations/<partner>')
  }
})
</script>

<template>
  <div class="connected-stub">
    <ProgressSpinner />
    <p>Connection established — closing window…</p>
  </div>
</template>
```

Then the connect composable listens for the message:

```ts
const startConnect = async () => {
  const { url } = await $services.<partner>.getAuthUrl()
  const popup = window.open(url, '_blank', 'width=600,height=700')
  if (!popup) throw new Error('Popup blocked')

  return new Promise<void>((resolve, reject) => {
    let timeout: number | null = null
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.data?.type === '<partner>:connected') {
        window.removeEventListener('message', handler)
        if (timeout) window.clearTimeout(timeout)
        resolve()
      }
    }
    window.addEventListener('message', handler)
    timeout = window.setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error('Connection timed out'))
    }, 120 * 1000)
  })
}
```

Pick (a) for simplicity, (b) for snappier UX. OneLaw uses (a). Either works.

## Backend Redirect Target

Update `<partner>_auth_redirect_uri` in settings to point at the page that handles the post-OAuth state. For (a), redirect to the integrations index (`/integrations/<partner>?integration=<partner>&status=connected`). For (b), redirect to `/integrations/<partner>/connected`.

## Disconnect

Mutation, no popup needed:

```ts
const logout = useMutation({
  mutationFn: () => $services.<partner>.logout(),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: <partner>Keys.all })
    toast.add({ severity: 'success', summary: '<Partner> disconnected' })
  },
})
```

Confirm before disconnect:

```vue
<ConfirmDialog />

<Button
  label="Disconnect"
  severity="danger"
  @click="confirm.require({
    message: 'Disconnect <Partner>? Your sync history will be retained but no further updates will be received.',
    accept: () => logout.mutate(),
  })"
/>
```

## Error UX

Common failures and what to show:

| Failure | UX |
|---|---|
| Popup blocked | Inline error: "Allow popups and click Connect again" |
| User closes popup before completing | Toast: "Connection cancelled" |
| Backend returns 500 (token exchange failed) | Toast: "Connection failed — check your <partner> account permissions" |
| Backend returns 401 (state expired) | Toast: "Connection expired — please try again" |
| Connection times out | Toast: "Connection timed out — please try again" |

Never echo raw backend error messages — sanitise.

## Reconnect Flow

If user is already connected and clicks Connect again, show:

```
"You're already connected to <Partner>. Disconnect first, then connect with a different account."
```

Or build a "Reconnect" path that:
1. Calls `logout` mutation
2. Immediately calls `startConnect` after success
3. Shows a single combined progress UI

Backend re-auth ALSO rotates the webhook signing key (per anti-pattern A15) — surface this in the success toast: "Reconnected. Webhook key rotated; copy from settings."
