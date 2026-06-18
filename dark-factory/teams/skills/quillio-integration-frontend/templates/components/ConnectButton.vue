<!-- Drop into: frontend-legal/app/components/integrations/<partner>/ConnectButton.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { use<Partner>Connection } from '@/composables/<partner>/usePartner'

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
      :label="connecting ? 'Connecting…' : 'Connect <Partner>'"
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
