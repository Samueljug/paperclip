// Drop into: frontend-legal/app/types/<partner>.types.ts
// After copying, search/replace `<partner>` (lowercase) and `<Partner>` (TitleCase).

// ----- Connection -----

export interface I<Partner>Credentials {
  ownerId: string
  status: 'connected' | 'disconnected'
  firmCloudId?: string | null
  apiBaseUrl?: string
  webhookKeyConfigured?: boolean
  webhookKeyPreview?: string
}

// ----- Canonical entities -----

export interface I<Partner>Client {
  id: string
  externalId: string
  provider: '<partner>'
  name: string
  number?: string | null
  email?: string | null
}

export interface I<Partner>Matter {
  id: string
  externalId: string
  provider: '<partner>'
  name: string
  displayNumber?: string | null
  status?: string | null
  clientId?: string | null
}

export interface I<Partner>Document {
  id: string
  externalId: string
  provider: '<partner>'
  name: string
  fileName?: string | null
  extension?: string | null
  mimeType?: string | null
  size?: number | null
  matterId?: string | null
  folderId?: string | null
  contentUrl?: string | null
  categories?: string[]
}

export interface I<Partner>TreeItem {
  id: string
  name: string
  type: 'folder' | 'document'
  parentId?: string | null
  selectable: boolean
  importStatus?: 'imported' | null
  contentUrl?: string | null
  categories?: string[]
  children: I<Partner>TreeItem[]
}

// ----- Pagination + search -----

export interface I<Partner>Page<T> {
  items: T[]
  total: number
  page: number
  totalPages: number
}

export interface I<Partner>SearchResponse {
  clients: I<Partner>Client[]
  matters: I<Partner>Matter[]
}

// ----- Import / export -----

export interface I<Partner>ImportItem {
  documentId: string
  documentName?: string
}

export interface I<Partner>MatterImportConfig {
  matterId: string
  items?: I<Partner>ImportItem[]
  importAll?: boolean
}

export interface I<Partner>ImportRequest {
  clientId?: string
  clientFiles?: I<Partner>ImportItem[]
  matters?: I<Partner>MatterImportConfig[]
  importAll?: boolean
  source?: 'user_initiated' | 'webhook' | 'bulk_import'
}

export interface I<Partner>ImportResponse {
  jobId: string
  status: I<Partner>JobStatus
  websocketUrl: string
  statusUrl: string
}

// ----- Job lifecycle -----

export type I<Partner>JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'

export interface I<Partner>JobProgressDocument {
  documentId: string
  name?: string
  status: 'pending' | 'downloading' | 'imported' | 'failed' | 'skipped'
  error?: string
}

export interface I<Partner>JobProgress {
  jobId: string
  status: I<Partner>JobStatus
  summary: {
    total: number
    completed: number
    failed: number
    skipped: number
    pending: number
  }
  documents: I<Partner>JobProgressDocument[]
  error?: string
}

// ----- Sync events -----

export interface I<Partner>SyncEvent {
  id: string
  ownerId: string
  documentId?: string | null
  documentTitle?: string | null
  spDocId?: string | null
  direction: 'import' | 'export'
  source: 'bulk_import' | 'webhook' | 'user_initiated'
  action: 'imported' | 'skipped' | 'reverse_synced' | 'failed'
  smartSyncReason?: string | null
  error?: string | null
  jobId?: string | null
  metadata?: {
    processingSteps?: Array<{
      name: string
      status: 'success' | 'failed'
      timestamp: string
      detail?: Record<string, unknown>
      durationMs?: number
    }>
    totalDurationMs?: number
  }
  createdAt: string
}

export interface I<Partner>SyncHistoryParams {
  folderId?: string
  page?: number
  pageSize?: number
}

// ----- Webhook key admin -----

export interface I<Partner>WebhookKey {
  configured: boolean
  preview: string | null
}
