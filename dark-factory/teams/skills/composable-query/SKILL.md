---
name: composable-query
description: Create Vue composables using TanStack Vue Query for data fetching and mutations. Use when building reactive data layers for features.
argument-hint: [feature-name]
allowed-tools: Read, Glob, Grep, Edit, MultiEdit, Write, Bash
---

# Composable Creator (TanStack Vue Query)

**SCOPE:** This skill targets a Vue 3 / Nuxt 3 / PrimeVue 3 / TanStack Query frontend. Detect the frontend root by looking for `nuxt.config.ts`, `vue.config.js`, or `package.json` with `nuxt`/`vue` in dependencies — at repo root or a subdirectory (common: `frontend/`, `frontend-legal/`, `web/`, `app/`). If a `CLAUDE.md` exists at the detected root, read it for conventions. All file paths you produce should be relative to the detected frontend root.

Create composables for `$ARGUMENTS` using TanStack Vue Query.

## Service Access Pattern

```typescript
const { $featureService } = useNuxtApp();
const featureService = $featureService as FeatureService;
```

Services are provided via `app/plugins/03.service-provider.ts` and accessed through `useNuxtApp()`.

## Query Composable (READ operations)

```typescript
// app/composables/[feature]/use[Feature].ts
import type { Ref } from "vue";
import type FeatureService from "@/services/feature.service";
import type { IFeatureDetails } from "@/types/feature.types";
import { useQuery } from "@tanstack/vue-query";

export const useFeature = ({
  id,
  enabled = ref(true),
}: {
  id: Ref<string>;
  enabled?: Ref<boolean>;
}) => {
  const { $featureService } = useNuxtApp();
  const featureService = $featureService as FeatureService;

  return useQuery({
    queryKey: ["feature", id],
    queryFn: () => featureService.getById(id.value),
    enabled,
  });
};
```

## Mutation Composable (WRITE operations)

```typescript
// app/composables/[feature]/useCreate[Feature].ts
import type FeatureService from "@/services/feature.service";
import type { ICreateFeatureRequest } from "@/types/feature.types";
import { useMutation } from "@tanstack/vue-query";

export const useCreateFeature = () => {
  const { $featureService } = useNuxtApp();
  const featureService = $featureService as FeatureService;

  return useMutation({
    mutationFn: async (data: ICreateFeatureRequest) => {
      return featureService.create(data);
    },
  });
};
```

## List Query with Filters (complex pattern)

```typescript
// app/composables/[feature]/use[Feature]List.ts
import type { Ref } from "vue";
import type FeatureService from "@/services/feature.service";
import { useQuery } from "@tanstack/vue-query";

export const useFeatureList = ({
  search = ref(""),
  status = ref<string[]>([]),
  page = ref(1),
  limit = ref(25),
  enabled = ref(true),
}: {
  search?: Ref<string>;
  status?: Ref<string[]>;
  page?: Ref<number>;
  limit?: Ref<number>;
  enabled?: Ref<boolean>;
}) => {
  const { $featureService } = useNuxtApp();
  const featureService = $featureService as FeatureService;

  return useQuery({
    queryKey: ["feature-list", search, status, page, limit],
    queryFn: () =>
      featureService.getAll({
        search: search.value,
        status: status.value,
        page: page.value,
        page_size: limit.value,
      }),
    enabled,
  });
};
```

## Conventions

- **File location**: `app/composables/[feature]/use[Action][Feature].ts`
- **Naming**: `useFeature`, `useCreateFeature`, `useUpdateFeature`, `useDeleteFeature`
- **Query keys**: Descriptive arrays — `['feature']`, `['feature', id]`, `['feature-list', filters...]`
- **Service casting**: Always cast service: `$featureService as FeatureService`
- **Reactive params**: Accept `Ref<T>` for parameters that may change — TanStack Query auto-refetches
- **Enabled flag**: Always support `enabled?: Ref<boolean>` for conditional fetching
- **No `any`**: Strict TypeScript throughout

## Before Creating

1. Check `app/composables/` for existing composables in same domain
2. Verify the service and types exist
3. Use consistent query key prefixes matching the feature domain
