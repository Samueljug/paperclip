<!-- Drop into: frontend-legal/app/components/integrations/<partner>/SyncHistoryTable.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { use<Partner>SyncHistory } from '@/composables/<partner>/usePartner'

const params = ref({ page: 1, pageSize: 25 })
const expandedRows = ref<Record<string, boolean>>({})
const { data, isLoading } = use<Partner>SyncHistory(params)

const actionSeverity = (a: string): 'success' | 'danger' | 'info' | 'warning' => {
  if (a === 'imported') return 'success'
  if (a === 'failed') return 'danger'
  if (a === 'reverse_synced') return 'info'
  return 'warning'
}
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
    @page="(e) => (params = { ...params, page: e.page + 1 })"
  >
    <Column expander style="width: 3rem" />
    <Column field="createdAt" header="When" />
    <Column field="documentTitle" header="Document" />
    <Column field="action" header="Action">
      <template #body="{ data }">
        <Tag :value="data.action" :severity="actionSeverity(data.action)" />
      </template>
    </Column>
    <Column field="smartSyncReason" header="Reason" />
    <Column field="error" header="Error" />
    <template #expansion="{ data }">
      <div class="processing-steps">
        <h4>Processing steps</h4>
        <ol>
          <li
            v-for="step in data.metadata?.processingSteps ?? []"
            :key="step.timestamp"
          >
            <strong>{{ step.name }}</strong> ({{ step.status }})
            — {{ step.durationMs?.toFixed(0) }}ms
            <pre v-if="step.detail">{{ JSON.stringify(step.detail, null, 2) }}</pre>
          </li>
        </ol>
      </div>
    </template>
  </DataTable>
</template>

<style scoped lang="scss">
.processing-steps pre {
  font-size: 0.85rem;
  background: var(--surface-100);
  padding: 0.5rem;
  border-radius: 4px;
}
</style>
