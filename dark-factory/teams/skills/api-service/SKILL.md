---
name: api-service
description: Create or modify API services extending ApiService base class. Use when building new backend integrations or adding endpoints to existing services.
argument-hint: [service-name]
allowed-tools: Read, Glob, Grep, Edit, MultiEdit, Write, Bash
---

# API Service Creator

**SCOPE:** This skill targets a Vue 3 / Nuxt 3 / PrimeVue 3 / TanStack Query frontend. Detect the frontend root by looking for `nuxt.config.ts`, `vue.config.js`, or `package.json` with `nuxt`/`vue` in dependencies — at repo root or a subdirectory (common: `frontend/`, `frontend-legal/`, `web/`, `app/`). If a `CLAUDE.md` exists at the detected root, read it for conventions. All file paths you produce should be relative to the detected frontend root.

Create or extend an API service for `$ARGUMENTS`.

## Architecture

All services extend `ApiService` from `app/services/api.service.ts` which provides:

- `this.get<T>(url, config?)` — GET request
- `this.post<T>(url, data?, config?)` — POST request
- `this.put<T>(url, data?, config?)` — PUT request
- `this.delete<T>(url, config?)` — DELETE request
- `this.patch<T>(url, data?, config?)` — PATCH request
- Automatic token management via interceptors
- Error handling with notification store
- Response transformation (snake_case → camelCase for non-excluded URLs)

## Service Template

```typescript
// app/services/[feature].service.ts
import { ApiService } from "./api.service";
import type {
  IFeatureDetails,
  ICreateFeatureRequest,
  ICreateFeatureResponse,
  IUpdateFeatureRequest,
  IUpdateFeatureResponse,
  IDeleteFeatureResponse,
} from "@/types/[feature].types";

export default class FeatureService extends ApiService {
  public getAll = async () => await this.get<IFeatureDetails[]>("/endpoint/");

  public getById = async (id: string) =>
    await this.get<IFeatureDetails>(`/endpoint/${id}`);

  public create = async (data: ICreateFeatureRequest) =>
    await this.post<ICreateFeatureResponse>("/endpoint/", {
      request: data,
      notif: {
        url: "",
        status: false,
      },
    });

  public update = async (id: string, data: IUpdateFeatureRequest) =>
    await this.put<IUpdateFeatureResponse>(`/endpoint/${id}`, {
      request: data,
      notif: {
        url: "",
        status: false,
      },
    });

  public delete = async (id: string) =>
    await this.delete<IDeleteFeatureResponse>(`/endpoint/${id}`);
}
```

## Registration

After creating, register in `app/plugins/03.service-provider.ts`:

1. Import: `import FeatureService from '@/services/feature.service'`
2. Add to `IServiceProvider` interface: `featureService: FeatureService`
3. Instantiate in services object: `featureService: new FeatureService()`

## Important Patterns from Codebase

- **Wrap request body** with `{ request: data, notif: { url: '', status: false } }` for POST/PUT when the backend expects notification metadata
- **Use generics** on every axios method: `this.get<IResponse>()`, never raw
- **Export as default class**: `export default class FeatureService extends ApiService`
- **Arrow function methods**: Use `public methodName = async () =>` pattern
- **FormData support**: For file uploads, pass `FormData` directly — interceptors handle Content-Type
- **camelCase exclusions**: If your endpoint returns snake_case and you want to keep it, add URL to `camelCaseExcludeUrls` in `api.service.ts`

## Before Creating

1. Read `app/services/api.service.ts` for base class details
2. Read `app/plugins/03.service-provider.ts` to see all registered services
3. Create types FIRST in `app/types/[feature].types.ts`
4. Check if a similar service already exists
