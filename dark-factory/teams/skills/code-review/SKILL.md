---
name: code-review
description: Review Vue 3 components, services, composables, and types for quality, conventions, and potential issues. Read-only analysis.
allowed-tools: Read, Grep, Glob
argument-hint: [file-or-directory-path]
---

# Code Review

**SCOPE:** This skill targets a Vue 3 / Nuxt 3 / PrimeVue 3 / TanStack Query frontend. Detect the frontend root by looking for `nuxt.config.ts`, `vue.config.js`, or `package.json` with `nuxt`/`vue` in dependencies — at repo root or a subdirectory (common: `frontend/`, `frontend-legal/`, `web/`, `app/`). If a `CLAUDE.md` exists at the detected root, read it for conventions. All file paths you produce should be relative to the detected frontend root.

Review `$ARGUMENTS` against project conventions and best practices.

## Review Checklist

### TypeScript

- [ ] No `any` types — use proper types or `unknown`
- [ ] Interfaces use `I` prefix (`IUser`, `IDocument`)
- [ ] Type-only imports use `import type { ... }`
- [ ] Props/emits use TypeScript generics with `defineProps<T>()` and `defineEmits<T>()`

### Vue 3 Components

- [ ] Uses `<script setup lang="ts">` — no Options API
- [ ] Uses `<style scoped lang="scss">`
- [ ] PrimeVue 3 components used correctly (check v3 API, not v4)
- [ ] Template structure is clean, no excessive nesting
- [ ] Reactive state uses `ref()` / `computed()` / `reactive()` correctly
- [ ] Events properly typed with `defineEmits`

### API Services

- [ ] Extends `ApiService` base class
- [ ] Uses generics on HTTP methods: `this.get<IResponse>()`
- [ ] Exported as default class
- [ ] Arrow function methods
- [ ] Proper request body wrapping where needed

### Composables

- [ ] Uses TanStack Vue Query (`useQuery` / `useMutation`)
- [ ] Service accessed via `useNuxtApp()` with proper casting
- [ ] Query keys are descriptive and consistent
- [ ] Accepts `Ref<T>` for reactive parameters
- [ ] Supports `enabled` flag for conditional fetching

### Authorization

- [ ] CASL permissions checked where needed: `$ability.can('action', 'subject')`
- [ ] Sensitive actions gated behind permission checks

### Error Handling

- [ ] API errors handled gracefully
- [ ] Loading states shown during async operations
- [ ] User-friendly error messages via notification store

## Output Format

Organize findings by severity:

**Critical** (must fix):

- Security issues, runtime errors, broken functionality

**Warnings** (should fix):

- Convention violations, potential bugs, poor patterns

**Suggestions** (consider):

- Performance improvements, readability, better patterns
