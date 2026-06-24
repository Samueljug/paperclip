# Components

PrimeVue 3 throughout. Auto-imported. SCSS scoped only. `<script setup lang="ts">` only.

## Component Inventory

| Component | Responsibility |
|---|---|
| `ConnectButton.vue` | One-click OAuth round-trip. Disabled while in flight. |
| `DisconnectButton.vue` | Confirm dialog → mutation. Opens dialog on click. |
| `ConnectionStatus.vue` | Pill / banner showing "connected as X" or "not connected". |
| `MatterBrowser.vue` | Two-pane: clients on left, matters on right. Search box top. |
| `MatterTree.vue` | PrimeVue Tree with checkbox selection. Feeds ImportModal. |
| `ImportModal.vue` | PrimeVue Dialog wrapping the selection → confirmation → progress flow. |
| `ImportProgress.vue` | Real-time progress: `ProgressBar` + per-doc list + cancel. |
| `SyncHistoryTable.vue` | PrimeVue DataTable; expandable rows show `processingSteps`. |
| `WebhookKeyAdmin.vue` | Form to view/set webhook signing key. Per-user. |

## ConnectButton.vue (skeleton)

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { use<Partner>Connection } from '@/composables/<partner>/use<Partner>Connection'

const { startConnect } = use<Partner>Connection()
const connecting = ref(false)
const error = ref<string | null>(null)

const handleConnect = async () => {
  connecting.value = true
  error.value = null
  try {
    await startConnect()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Connect failed'
  } finally {
    connecting.value = false
  }
}
</script>

<template>
  <div class="connect-button">
    <Button
      :label="connecting ? 'Connecting...' : 'Connect <Partner>'"
      icon="pi pi-link"
      :loading="connecting"
      severity="primary"
      @click="handleConnect"
    />
    <Message v-if="error" severity="error" :closable="false" class="mt-2">
      {{ error }}
    </Message>
  </div>
</template>

<style scoped lang="scss">
.connect-button {
  display: inline-flex;
  flex-direction: column;
  gap: 0.5rem;
}
</style>
```

## MatterBrowser.vue (skeleton)

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  use<Partner>Clients, use<Partner>Matters, use<Partner>Search,
} from '@/composables/<partner>/use<Partner>Browse'
import type { I<Partner>Client, I<Partner>Matter } from '@/types/<partner>.types'

const search = ref('')
const selectedClient = ref<I<Partner>Client | null>(null)
const clientsParams = ref({ search: '', page: 1, pageSize: 50 })
const mattersParams = computed(() => ({
  clientId: selectedClient.value?.externalId,
  page: 1,
  pageSize: 50,
}))

const { data: clients, isLoading: clientsLoading } = use<Partner>Clients(clientsParams)
const { data: matters, isLoading: mattersLoading } = use<Partner>Matters(mattersParams)
const { data: searchResults, isLoading: searching } = use<Partner>Search(search)

const emit = defineEmits<{ select: [matter: I<Partner>Matter] }>()

watch(search, (q) => {
  clientsParams.value = { ...clientsParams.value, search: q, page: 1 }
})
</script>

<template>
  <div class="matter-browser">
    <InputText
      v-model="search"
      placeholder="Search clients and matters..."
      class="w-full mb-3"
    />
    <div v-if="search.length >= 2 && searchResults" class="search-results">
      <DataTable :value="searchResults.matters" :loading="searching" @row-click="(e) => emit('select', e.data)">
        <Column field="displayNumber" header="Number" />
        <Column field="name" header="Matter" />
        <Column field="status" header="Status" />
      </DataTable>
    </div>
    <div v-else class="two-pane">
      <DataTable
        :value="clients?.items ?? []"
        :loading="clientsLoading"
        v-model:selection="selectedClient"
        selection-mode="single"
        :scroll-height="'500px'"
        scrollable
        class="clients-table"
      >
        <Column field="number" header="#" />
        <Column field="name" header="Client" />
      </DataTable>
      <DataTable
        :value="matters?.items ?? []"
        :loading="mattersLoading"
        :scroll-height="'500px'"
        scrollable
        class="matters-table"
        @row-click="(e) => emit('select', e.data)"
      >
        <Column field="displayNumber" header="Number" />
        <Column field="name" header="Matter" />
        <Column field="status" header="Status" />
      </DataTable>
    </div>
  </div>
</template>

<style scoped lang="scss">
.matter-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.two-pane {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 1rem;
  flex: 1;
  overflow: hidden;
}
</style>
```

## ImportModal.vue (skeleton)

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import { use<Partner>Import } from '@/composables/<partner>/use<Partner>Import'
import ImportProgress from './ImportProgress.vue'
import type { I<Partner>Matter, I<Partner>ImportRequest } from '@/types/<partner>.types'

const props = defineProps<{ visible: boolean; matter: I<Partner>Matter | null; selectedDocumentIds: string[] }>()
const emit = defineEmits<{ 'update:visible': [boolean]; complete: [] }>()

const { start } = use<Partner>Import()
const jobId = ref<string | null>(null)
const error = ref<string | null>(null)

const handleStart = async () => {
  if (!props.matter) return
  error.value = null
  try {
    const request: I<Partner>ImportRequest = {
      matters: [{
        matterId: props.matter.externalId,
        items: props.selectedDocumentIds.map(id => ({ documentId: id })),
        importAll: props.selectedDocumentIds.length === 0,
      }],
      source: 'user_initiated',
    }
    const response = await start.mutateAsync(request)
    jobId.value = response.jobId
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Import failed to start'
  }
}

watch(() => props.visible, (v) => {
  if (!v) {
    jobId.value = null
    error.value = null
  }
})
</script>

<template>
  <Dialog
    :visible="visible"
    :header="`Import from ${matter?.name ?? '...'}`"
    modal
    :closable="!start.isPending.value"
    style="width: 60rem"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <div v-if="!jobId" class="confirm-stage">
      <p>{{ selectedDocumentIds.length }} documents selected.</p>
      <Message v-if="error" severity="error">{{ error }}</Message>
    </div>
    <ImportProgress
      v-else
      :job-id="jobId"
      @complete="() => emit('complete')"
    />

    <template #footer>
      <Button
        v-if="!jobId"
        label="Start import"
        icon="pi pi-download"
        :loading="start.isPending.value"
        @click="handleStart"
      />
      <Button
        v-else
        label="Close"
        severity="secondary"
        @click="emit('update:visible', false)"
      />
    </template>
  </Dialog>
</template>
```

## ImportProgress.vue (skeleton)

```vue
<script setup lang="ts">
import { computed, toRef } from 'vue'
import { use<Partner>ImportProgress } from '@/composables/<partner>/use<Partner>ImportProgress'
import { use<Partner>Import } from '@/composables/<partner>/use<Partner>Import'

const props = defineProps<{ jobId: string }>()
const emit = defineEmits<{ complete: [] }>()

const { progress, status, error } = use<Partner>ImportProgress(toRef(props, 'jobId'))
const { cancel } = use<Partner>Import()

const percent = computed(() => {
  const s = progress.value?.summary
  if (!s || s.total === 0) return 0
  return Math.round(((s.completed + s.failed + s.skipped) / s.total) * 100)
})

const isTerminal = computed(() => ['completed', 'failed', 'cancelled'].includes(status.value ?? ''))

watch(isTerminal, (v) => { if (v) emit('complete') })
</script>

<template>
  <div class="import-progress">
    <ProgressBar :value="percent" :show-value="true" />
    <div class="summary">
      <Tag :value="`Total: ${progress?.summary?.total ?? 0}`" />
      <Tag :value="`Imported: ${progress?.summary?.completed ?? 0}`" severity="success" />
      <Tag :value="`Failed: ${progress?.summary?.failed ?? 0}`" severity="danger" />
      <Tag :value="`Skipped: ${progress?.summary?.skipped ?? 0}`" />
    </div>
    <Message v-if="error" severity="error">{{ error }}</Message>
    <DataTable :value="progress?.documents ?? []" :scroll-height="'300px'" scrollable>
      <Column field="name" header="Document" />
      <Column field="status" header="Status">
        <template #body="{ data }">
          <Tag
            :value="data.status"
            :severity="data.status === 'imported' ? 'success' : data.status === 'failed' ? 'danger' : 'info'"
          />
        </template>
      </Column>
      <Column field="error" header="Error" />
    </DataTable>
    <Button
      v-if="!isTerminal"
      label="Cancel import"
      icon="pi pi-times"
      severity="danger"
      :loading="cancel.isPending.value"
      @click="cancel.mutate(props.jobId)"
    />
  </div>
</template>
```

## SyncHistoryTable.vue (skeleton)

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { use<Partner>SyncHistory } from '@/composables/<partner>/use<Partner>SyncHistory'

const params = ref({ page: 1, pageSize: 25 })
const { data, isLoading } = use<Partner>SyncHistory(params)
const expandedRows = ref({})
</script>

<template>
  <DataTable
    :value="data?.items ?? []"
    :loading="isLoading"
    v-model:expanded-rows="expandedRows"
    data-key="id"
    paginator
    :rows="params.pageSize"
    :total-records="data?.total ?? 0"
    :first="(params.page - 1) * params.pageSize"
    @page="(e) => params = { ...params, page: e.page + 1 }"
  >
    <Column expander style="width: 3rem" />
    <Column field="createdAt" header="When" />
    <Column field="documentTitle" header="Document" />
    <Column field="action" header="Action">
      <template #body="{ data }">
        <Tag :value="data.action" :severity="data.action === 'imported' ? 'success' : data.action === 'failed' ? 'danger' : 'info'" />
      </template>
    </Column>
    <Column field="smartSyncReason" header="Reason" />
    <Column field="error" header="Error" />
    <template #expansion="slotProps">
      <div class="processing-steps">
        <h4>Processing steps</h4>
        <ol>
          <li v-for="step in slotProps.data.metadata?.processingSteps ?? []" :key="step.timestamp">
            <strong>{{ step.name }}</strong> ({{ step.status }}) — {{ step.durationMs?.toFixed(0) }}ms
            <pre v-if="step.detail">{{ JSON.stringify(step.detail, null, 2) }}</pre>
          </li>
        </ol>
      </div>
    </template>
  </DataTable>
</template>
```

## WebhookKeyAdmin.vue (skeleton)

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { use<Partner>WebhookKey } from '@/composables/<partner>/use<Partner>WebhookKey'

const { status, save } = use<Partner>WebhookKey()
const newKey = ref('')
const showInput = ref(false)
</script>

<template>
  <Card>
    <template #title>Webhook signing key</template>
    <template #content>
      <div v-if="!showInput && status.data?.value?.configured" class="status">
        <Tag value="Configured" severity="success" />
        <span class="preview">{{ status.data.value.preview }}…</span>
        <Button label="Rotate key" link @click="showInput = true" />
      </div>
      <div v-else class="form">
        <InputText v-model="newKey" placeholder="Paste signing key" class="w-full" />
        <div class="actions">
          <Button label="Cancel" severity="secondary" @click="showInput = false" />
          <Button
            label="Save"
            :loading="save.isPending.value"
            :disabled="!newKey"
            @click="async () => { await save.mutateAsync(newKey); newKey = ''; showInput = false }"
          />
        </div>
      </div>
    </template>
  </Card>
</template>

<style scoped lang="scss">
.status, .form, .actions { display: flex; gap: 0.5rem; align-items: center; }
.preview { font-family: monospace; opacity: 0.8; }
</style>
```

## Style Discipline

- Scoped SCSS only.
- No global styles unless reused across multiple integrations (then lift to `app/assets/scss/`).
- Use PrimeVue tokens / theme variables; do not hardcode colors.
- Responsive: `@media` rules; respect existing breakpoints.

## Accessibility

- Every button has accessible label or icon + label pair.
- Modals trap focus (PrimeVue `Dialog` does this by default).
- Live regions: `ProgressBar` announces percentage; ensure `aria-live` is set on dynamic-text containers.
