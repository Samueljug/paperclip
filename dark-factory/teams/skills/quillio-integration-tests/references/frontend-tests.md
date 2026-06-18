# Frontend Tests (Vitest)

## Tools

| Library | Purpose |
|---|---|
| `vitest` | Test runner |
| `@vue/test-utils` | Component mounting + interaction |
| `@vue/test-utils` `mount` / `shallowMount` | Component rendering |
| `@nuxt/test-utils` | Nuxt-aware `setup` |
| `@vitest/coverage-v8` | Coverage |
| `vi.fn()` / `vi.mock()` | Mocks |
| `msw` (Mock Service Worker) | HTTP mocking for service tests |
| `happy-dom` or `jsdom` | DOM environment |

`package.json` scripts:

```json
{
  "scripts": {
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "test:ui": "vitest --ui"
  }
}
```

## File Layout

Co-locate next to source:

```
app/
├── services/<partner>.service.ts
├── services/<partner>.service.test.ts
├── composables/<partner>/
│   ├── use<Partner>Connection.ts
│   ├── use<Partner>Connection.test.ts
│   ├── ...
└── components/integrations/<partner>/
    ├── ConnectButton.vue
    ├── ConnectButton.test.ts
    └── ...
```

## Service Tests

Mock the underlying axios layer (`ApiService` exposes `get`, `post`, `put`, `delete`).

```ts
// app/services/<partner>.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import <Partner>Service from './<partner>.service'

describe('<Partner>Service', () => {
  let service: <Partner>Service

  beforeEach(() => {
    service = new <Partner>Service()
  })

  it('calls correct URL for getAuthUrl', async () => {
    const getSpy = vi.spyOn(service as any, 'get').mockResolvedValue({ url: 'https://x' })
    const result = await service.getAuthUrl()
    expect(getSpy).toHaveBeenCalledWith('/integrations/<partner>/auth/login')
    expect(result.url).toBe('https://x')
  })

  it('passes pagination params to listMatters', async () => {
    const getSpy = vi.spyOn(service as any, 'get').mockResolvedValue({ items: [], total: 0 })
    await service.listMatters({ search: 'foo', page: 2, pageSize: 25 })
    expect(getSpy).toHaveBeenCalledWith('/integrations/<partner>/matters', {
      params: { search: 'foo', page: 2, pageSize: 25 },
    })
  })

  it('wraps startImport body in request envelope', async () => {
    const postSpy = vi.spyOn(service as any, 'post').mockResolvedValue({ jobId: 'j1' })
    const request = { matters: [{ matterId: 'm-1' }] }
    await service.startImport(request)
    expect(postSpy).toHaveBeenCalledWith('/integrations/<partner>/import', {
      request,
      notif: { url: '', status: false },
    })
  })

  it('saveWebhookKey enables success toast', async () => {
    const putSpy = vi.spyOn(service as any, 'put').mockResolvedValue({ status: 'saved' })
    await service.saveWebhookKey('secret')
    expect(putSpy).toHaveBeenCalledWith('/integrations/<partner>/webhook-key', {
      request: { key: 'secret' },
      notif: { url: '', status: true },
    })
  })
})
```

## Composable Tests

Use a test harness that wraps `setup()` in a Vue app:

```ts
// app/composables/<partner>/__test-utils__/withSetup.ts
import { createApp, defineComponent, h } from 'vue'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

export function withSetup<T>(composable: () => T) {
  let result!: T
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  const app = createApp(defineComponent({
    setup() {
      result = composable()
      return () => h('div')
    },
  }))
  app.use(VueQueryPlugin, { queryClient })
  app.mount(document.createElement('div'))
  return { result, app, queryClient }
}
```

Then write tests:

```ts
// app/composables/<partner>/use<Partner>Connection.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { use<Partner>Connection } from './use<Partner>Connection'
import { withSetup } from './__test-utils__/withSetup'

vi.mock('#app', () => ({
  useNuxtApp: () => ({
    $services: {
      <partner>: {
        getSyncStatus: vi.fn().mockResolvedValue({ items: [] }),
        getAuthUrl: vi.fn().mockResolvedValue({ url: 'https://partner/auth' }),
        logout: vi.fn().mockResolvedValue({ status: 'disconnected' }),
      },
    },
  }),
}))

describe('use<Partner>Connection', () => {
  it('exposes status query and mutations', () => {
    const { result } = withSetup(() => use<Partner>Connection())
    expect(result.status).toBeDefined()
    expect(result.startConnect).toBeInstanceOf(Function)
    expect(result.logout).toBeDefined()
  })

  it('logout invalidates queries on success', async () => {
    const { result, queryClient } = withSetup(() => use<Partner>Connection())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    await result.logout.mutateAsync()
    expect(invalidateSpy).toHaveBeenCalled()
  })
})
```

### WebSocket composable

WebSocket needs a mock:

```ts
// app/composables/<partner>/use<Partner>ImportProgress.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { use<Partner>ImportProgress } from './use<Partner>ImportProgress'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onopen: any
  onmessage: any
  onclose: any
  onerror: any
  readyState = 0
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.onclose?.({ wasClean: true }) })
  constructor(public url: string) {
    MockWebSocket.instances.push(this)
    setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0)
  }
}

describe('use<Partner>ImportProgress', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  it('opens WebSocket when jobId is set', async () => {
    const jobId = ref<string | null>('job-1')
    use<Partner>ImportProgress(jobId)
    await nextTick()
    expect(MockWebSocket.instances.length).toBe(1)
    expect(MockWebSocket.instances[0].url).toContain('job-1')
  })

  it('parses snapshot message', async () => {
    const jobId = ref<string | null>('job-2')
    const { progress, status } = use<Partner>ImportProgress(jobId)
    await nextTick()
    const ws = MockWebSocket.instances[0]
    ws.onmessage({ data: JSON.stringify({
      type: 'snapshot',
      job: { progress: { jobId: 'job-2', status: 'processing', summary: { total: 5, completed: 1 } }, status: 'processing' },
    })})
    await nextTick()
    expect(status.value).toBe('processing')
    expect(progress.value?.summary.completed).toBe(1)
  })

  it('closes socket on jobId clear', async () => {
    const jobId = ref<string | null>('job-3')
    use<Partner>ImportProgress(jobId)
    await nextTick()
    const ws = MockWebSocket.instances[0]
    jobId.value = null
    await nextTick()
    expect(ws.close).toHaveBeenCalled()
  })
})
```

## Component Tests

```ts
// app/components/integrations/<partner>/ConnectButton.test.ts
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ConnectButton from './ConnectButton.vue'

vi.mock('@/composables/<partner>/use<Partner>Connection', () => ({
  use<Partner>Connection: () => ({
    startConnect: vi.fn().mockResolvedValue(undefined),
  }),
}))

describe('ConnectButton', () => {
  it('renders default label', () => {
    const wrapper = mount(ConnectButton)
    expect(wrapper.text()).toContain('Connect <Partner>')
  })

  it('disables button while connecting', async () => {
    const wrapper = mount(ConnectButton)
    await wrapper.find('button').trigger('click')
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
  })

  it('shows error message on failure', async () => {
    vi.doMock('@/composables/<partner>/use<Partner>Connection', () => ({
      use<Partner>Connection: () => ({
        startConnect: vi.fn().mockRejectedValue(new Error('Popup blocked')),
      }),
    }))
    const { default: Comp } = await import('./ConnectButton.vue')
    const wrapper = mount(Comp)
    await wrapper.find('button').trigger('click')
    await new Promise(r => setTimeout(r, 0))
    expect(wrapper.text()).toContain('Popup blocked')
  })
})
```

## DataTable Component

```ts
// app/components/integrations/<partner>/MatterBrowser.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import MatterBrowser from './MatterBrowser.vue'

const matters = [
  { id: '1', externalId: 'm-1', provider: '<partner>', name: 'Smith vs Jones', displayNumber: '100.1', status: 'open', clientId: 'c-1' },
]

vi.mock('@/composables/<partner>/use<Partner>Browse', () => ({
  use<Partner>Clients: () => ({ data: ref({ items: [], total: 0 }), isLoading: ref(false) }),
  use<Partner>Matters: () => ({ data: ref({ items: matters, total: 1 }), isLoading: ref(false) }),
  use<Partner>Search: () => ({ data: ref(null), isLoading: ref(false) }),
}))

describe('MatterBrowser', () => {
  it('renders matter rows', () => {
    const wrapper = mount(MatterBrowser)
    expect(wrapper.text()).toContain('Smith vs Jones')
    expect(wrapper.text()).toContain('100.1')
  })

  it('emits select on row click', async () => {
    const wrapper = mount(MatterBrowser)
    await wrapper.find('.matters-table tbody tr').trigger('click')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual(matters[0])
  })
})
```

## Coverage

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    coverage: {
      provider: 'v8',
      include: ['app/**/*.{ts,vue}'],
      exclude: ['app/**/*.test.ts', 'app/**/*.d.ts'],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
})
```

Run:

```bash
yarn test:coverage
```

## Don'ts

- Don't import `useNuxtApp` from real `#app` in tests — mock it.
- Don't render a full router/layout for component tests — `mount(Component)` is enough.
- Don't await network in tests — mock the service layer.
- Don't snapshot-test PrimeVue components — they change between minor versions.
