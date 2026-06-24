---
name: type-definitions
description: Create TypeScript type definitions with I-prefix interfaces for API request/response types and domain models. Use when defining data structures.
argument-hint: [domain-name]
allowed-tools: Read, Glob, Grep, Edit, MultiEdit, Write, Bash
---

# TypeScript Type Definition Creator

**SCOPE:** This skill targets a Vue 3 / Nuxt 3 / PrimeVue 3 / TanStack Query frontend. Detect the frontend root by looking for `nuxt.config.ts`, `vue.config.js`, or `package.json` with `nuxt`/`vue` in dependencies — at repo root or a subdirectory (common: `frontend/`, `frontend-legal/`, `web/`, `app/`). If a `CLAUDE.md` exists at the detected root, read it for conventions. All file paths you produce should be relative to the detected frontend root.

Create type definitions for `$ARGUMENTS` domain.

## File Convention

- **Location**: `app/types/[domain].types.ts`
- **Interface prefix**: Always `I` — e.g., `IUser`, `IDocument`, `ITaskDetails`
- **Exports**: Named exports only, no default exports
- **No `any`**: Use proper types or `unknown` if truly unknown

## Type File Template

```typescript
// app/types/[domain].types.ts

// ─── Domain Entity ───────────────────────────────────────

export interface IFeature {
  id: string;
  title: string;
  description: string | null;
  status: FeatureStatus;
  created_at: number;
  updated_at: number;
}

// ─── Nested/Related Types ────────────────────────────────

export interface IFeatureOwner {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  picture: string | null;
}

// ─── Request Types ───────────────────────────────────────

export interface ICreateFeatureRequest {
  title: string;
  description?: string;
  status?: FeatureStatus;
}

export interface IUpdateFeatureRequest {
  title?: string;
  description?: string;
  status?: FeatureStatus;
}

export interface IGetFeaturesRequest {
  search?: string;
  status?: string[];
  page?: number;
  page_size?: number;
  sort_by?: string;
  sort_order?: string;
}

// ─── Response Types ──────────────────────────────────────

export interface ICreateFeatureResponse {
  success: boolean;
  id?: string;
  message?: string;
}

export interface IUpdateFeatureResponse {
  success: boolean;
  message?: string;
}

export interface IDeleteFeatureResponse {
  success: boolean;
  message?: string;
}

// ─── List/Pagination ─────────────────────────────────────

export interface IFeaturePagination {
  total_count: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface IFeaturesResponse {
  features: IFeature[];
  pagination: IFeaturePagination;
}

// ─── UI Types (filters, options) ─────────────────────────

export interface IFilterOption {
  label: string;
  value: string;
}

// ─── Enums/Unions ────────────────────────────────────────

export type FeatureStatus = "active" | "inactive" | "archived";
export type FeaturePriority = "none" | "low" | "medium" | "high";
```

## Patterns from Codebase

- **snake_case fields**: API responses use snake_case — keep them as-is in types (the interceptor handles camelCase conversion for some URLs but not all)
- **Nullable fields**: Use `string | null` not `string | undefined` for API nullables
- **Optional fields**: Use `field?: type` for optional request parameters
- **Timestamps**: Backend sends Unix timestamps as `number`
- **IDs**: Always `string` (UUID format from backend)
- **Bulk operations**: Create separate request/response types for bulk endpoints
- **Type-only imports**: Use `import type { ... }` everywhere

## Existing Type Files

Check these for patterns: `tasks.types.ts`, `chat.types.ts`, `folder.types.ts`, `agents.types.ts`, `members.types.ts`
