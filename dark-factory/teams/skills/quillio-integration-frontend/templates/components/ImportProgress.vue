<!-- Drop into: frontend-legal/app/components/integrations/<partner>/ImportProgress.vue -->
<script setup lang="ts">
import { computed, toRef, watch } from 'vue'
import {
  use<Partner>ImportProgress,
  use<Partner>Import,
} from '@/composables/<partner>/usePartner'

const props = defineProps<{ jobId: string }>()
const emit = defineEmits<{ complete: [] }>()

const { progress, status, error, isTerminal } = use<Partner>ImportProgress(toRef(props, 'jobId'))
const { cancel } = use<Partner>Import()

const percent = computed(() => {
  const s = progress.value?.summary
  if (!s || s.total === 0) return 0
  return Math.round(((s.completed + s.failed + s.skipped) / s.total) * 100)
})

watch(isTerminal, (v) => {
  if (v) emit('complete')
})

const statusSeverity = (s: string): 'success' | 'danger' | 'info' | 'warning' => {
  if (s === 'imported') return 'success'
  if (s === 'failed') return 'danger'
  if (s === 'skipped') return 'warning'
  return 'info'
}
</script>

<template>
  <div class="import-progress">
    <ProgressBar :value="percent" :show-value="true" />
    <div class="summary">
      <Tag :value="`Total: ${progress?.summary?.total ?? 0}`" />
      <Tag :value="`Imported: ${progress?.summary?.completed ?? 0}`" severity="success" />
      <Tag :value="`Failed: ${progress?.summary?.failed ?? 0}`" severity="danger" />
      <Tag :value="`Skipped: ${progress?.summary?.skipped ?? 0}`" severity="warning" />
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <DataTable
      :value="progress?.documents ?? []"
      scroll-height="300px"
      scrollable
      data-key="documentId"
    >
      <Column field="name" header="Document" />
      <Column field="status" header="Status">
        <template #body="{ data }">
          <Tag :value="data.status" :severity="statusSeverity(data.status)" />
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

<style scoped lang="scss">
.import-progress {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.summary {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
