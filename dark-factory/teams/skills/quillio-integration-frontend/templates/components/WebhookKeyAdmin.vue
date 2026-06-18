<!-- Drop into: frontend-legal/app/components/integrations/<partner>/WebhookKeyAdmin.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { use<Partner>WebhookKey } from '@/composables/<partner>/usePartner'

const { status, save } = use<Partner>WebhookKey()
const newKey = ref('')
const showInput = ref(false)

const handleSave = async () => {
  await save.mutateAsync(newKey.value)
  newKey.value = ''
  showInput.value = false
}
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
        <InputText
          v-model="newKey"
          placeholder="Paste signing key from <Partner>"
          class="w-full"
        />
        <div class="actions">
          <Button label="Cancel" severity="secondary" @click="showInput = false" />
          <Button
            label="Save"
            :loading="save.isPending.value"
            :disabled="!newKey"
            @click="handleSave"
          />
        </div>
      </div>
    </template>
  </Card>
</template>

<style scoped lang="scss">
.status,
.form,
.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.form {
  flex-direction: column;
  align-items: stretch;
}
.actions {
  justify-content: flex-end;
}
.preview {
  font-family: monospace;
  opacity: 0.8;
}
</style>
