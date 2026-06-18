<!-- Drop into: frontend-legal/app/components/integrations/<partner>/ImportModal.vue -->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { use<Partner>Import } from '@/composables/<partner>/usePartner'
import ImportProgress from './ImportProgress.vue'
import type { I<Partner>Matter, I<Partner>ImportRequest } from '@/types/<partner>.types'

const props = defineProps<{
  visible: boolean
  matter: I<Partner>Matter | null
  selectedDocumentIds: string[]
}>()
const emit = defineEmits<{
  'update:visible': [boolean]
  complete: []
}>()

const { start } = use<Partner>Import()
const jobId = ref<string | null>(null)
const error = ref<string | null>(null)

const handleStart = async () => {
  if (!props.matter) return
  error.value = null
  try {
    const request: I<Partner>ImportRequest = {
      matters: [
        {
          matterId: props.matter.externalId,
          items: props.selectedDocumentIds.map((id) => ({ documentId: id })),
          importAll: props.selectedDocumentIds.length === 0,
        },
      ],
      source: 'user_initiated',
    }
    const response = await start.mutateAsync(request)
    jobId.value = response.jobId
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Import failed to start'
  }
}

watch(
  () => props.visible,
  (v) => {
    if (!v) {
      jobId.value = null
      error.value = null
    }
  },
)
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
