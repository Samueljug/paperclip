# Types (`<partner>.types.ts`)

Conventions per `frontend-legal/CLAUDE.md`.

## Rules

- All files end in `.types.ts` and live in `app/types/`.
- All interfaces start with `I` (e.g., `I<Partner>Matter`).
- Use `interface` for object shapes; use `type` for unions, enums, primitives.
- No `any`. Use `unknown` if truly unconstrained, then narrow.
- Optional fields with `?`. Nullable with `| null`.
- Keep types close to backend response shapes. If backend returns `snake_case`, keep `snake_case` in TS — don't transform.

## Skeleton

```ts
// app/types/<partner>.types.ts

// ----- Connection -----

export interface I<Partner>Credentials {
  ownerId: string
  status: 'connected' | 'disconnected'
  firmCloudId?: string | null
  apiBaseUrl?: string
  webhookKeyConfigured?: boolean
  webhookKeyPreview?: string
}

// ----- Canonical entities (mirror backend) -----

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

// ----- Pagination wrapper -----

export interface I<Partner>Page<T> {
  items: T[]
  total: number
  page: number
  totalPages: number
}

// ----- Search response -----

export interface I<Partner>SearchResponse {
  clients: I<Partner>Client[]
  matters: I<Partner>Matter[]
}

// ----- Import / Export -----

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
  status: '<Partner>JobStatus'
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

// ----- Sync events / audit log -----

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
```

## Naming Discipline

- Use `id` for AILA's internal ID (string), `externalId` for the partner's ID.
- Use `provider` literal type to keep cross-partner type unions narrow.
- Mirror backend field names exactly (incl. snake_case if backend returns it).
- Avoid TypeScript `enum` — prefer string literal unions for safer JSON serialisation.

## Cross-Type References

Composables, components, and the service all import from the same `.types.ts`. Never duplicate. If you find yourself defining `I<Partner>JobProgress` in two files, hoist to the shared types file.

## Updating Types

When backend changes a response shape:
1. Update `<partner>.types.ts`.
2. Update `<partner>.service.ts` generic.
3. Update consumers (composables, components).
4. `yarn typecheck` will catch every miss.
