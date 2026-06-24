<!-- Drop into: frontend-legal/app/components/integrations/<partner>/MatterBrowser.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  use<Partner>Clients,
  use<Partner>Matters,
  use<Partner>Search,
} from '@/composables/<partner>/usePartner'
import type { I<Partner>Client, I<Partner>Matter } from '@/types/<partner>.types'

const emit = defineEmits<{ select: [matter: I<Partner>Matter] }>()

const search = ref('')
const selectedClient = ref<I<Partner>Client | null>(null)
const clientsParams = ref({ search: '', page: 1 })
const mattersParams = computed(() => ({
  clientId: selectedClient.value?.externalId,
  page: 1,
}))

const { data: clients, isLoading: clientsLoading } = use<Partner>Clients(clientsParams)
const { data: matters, isLoading: mattersLoading } = use<Partner>Matters(mattersParams)
const { data: searchResults, isLoading: searching } = use<Partner>Search(search)

watch(search, (q) => {
  clientsParams.value = { ...clientsParams.value, search: q, page: 1 }
})
</script>

<template>
  <div class="matter-browser">
    <InputText
      v-model="search"
      placeholder="Search clients and matters…"
      class="w-full mb-3"
    />
    <div v-if="search.length >= 2 && searchResults" class="search-results">
      <DataTable
        :value="searchResults.matters"
        :loading="searching"
        scroll-height="500px"
        scrollable
        @row-click="(e) => emit('select', e.data as I<Partner>Matter)"
      >
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
        scroll-height="500px"
        scrollable
        class="clients-table"
      >
        <Column field="number" header="#" style="width: 5rem" />
        <Column field="name" header="Client" />
      </DataTable>
      <DataTable
        :value="matters?.items ?? []"
        :loading="mattersLoading"
        scroll-height="500px"
        scrollable
        class="matters-table"
        @row-click="(e) => emit('select', e.data as I<Partner>Matter)"
      >
        <Column field="displayNumber" header="Number" style="width: 8rem" />
        <Column field="name" header="Matter" />
        <Column field="status" header="Status" style="width: 8rem" />
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
