<!-- Drop into: frontend-legal/app/pages/integrations/<partner>/index.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { use<Partner>Connection } from '@/composables/<partner>/usePartner'
import ConnectButton from '@/components/integrations/<partner>/ConnectButton.vue'
import MatterBrowser from '@/components/integrations/<partner>/MatterBrowser.vue'
import ImportModal from '@/components/integrations/<partner>/ImportModal.vue'
import WebhookKeyAdmin from '@/components/integrations/<partner>/WebhookKeyAdmin.vue'
import type { I<Partner>Matter } from '@/types/<partner>.types'

const { status, logout } = use<Partner>Connection()

const isConnected = computed(() => !!status.data.value)
const importVisible = ref(false)
const selectedMatter = ref<I<Partner>Matter | null>(null)
const selectedDocumentIds = ref<string[]>([])

const openImport = (matter: I<Partner>Matter) => {
  selectedMatter.value = matter
  selectedDocumentIds.value = []
  importVisible.value = true
}
</script>

<template>
  <div class="<partner>-page">
    <header class="page-header">
      <h1><Partner></h1>
      <Button
        v-if="isConnected"
        label="Disconnect"
        severity="secondary"
        :loading="logout.isPending.value"
        @click="logout.mutate()"
      />
    </header>

    <section v-if="!isConnected" class="not-connected">
      <p>Connect your <Partner> account to browse and import documents.</p>
      <ConnectButton />
    </section>

    <section v-else class="connected">
      <MatterBrowser @select="openImport" />
      <details class="webhook-admin">
        <summary>Webhook settings</summary>
        <WebhookKeyAdmin />
      </details>
      <NuxtLink :to="`/integrations/<partner>/sync-history`">View sync history</NuxtLink>
    </section>

    <ImportModal
      v-model:visible="importVisible"
      :matter="selectedMatter"
      :selected-document-ids="selectedDocumentIds"
      @complete="importVisible = false"
    />
  </div>
</template>

<style scoped lang="scss">
.<partner>-page {
  padding: 2rem;
  max-width: 1400px;
  margin: 0 auto;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
}
.connected {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.webhook-admin summary {
  cursor: pointer;
  font-weight: 600;
  padding: 0.5rem 0;
}
</style>
