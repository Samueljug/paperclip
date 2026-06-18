---
name: vue-component
description: Create Vue 3 components with PrimeVue 3, TypeScript, and SCSS following project conventions. Use when asked to build a new UI component.
argument-hint: [component-name]
allowed-tools: Read, Glob, Grep, Edit, MultiEdit, Write, Bash
---

# Vue 3 Component Creator

**SCOPE:** This skill targets a Vue 3 / Nuxt 3 / PrimeVue 3 / TanStack Query frontend. Detect the frontend root by looking for `nuxt.config.ts`, `vue.config.js`, or `package.json` with `nuxt`/`vue` in dependencies — at repo root or a subdirectory (common: `frontend/`, `frontend-legal/`, `web/`, `app/`). If a `CLAUDE.md` exists at the detected root, read it for conventions. All file paths you produce should be relative to the detected frontend root.

Create a Vue 3 SFC component for `$ARGUMENTS` following these exact project conventions.

## Rules

1. **File location**: `app/components/` — Nuxt auto-imports all components from here
2. **File naming**: PascalCase (e.g., `TaskCard.vue`, `DocumentFilter.vue`)
3. **Script**: Always `<script setup lang="ts">` — no Options API
4. **Styling**: `<style scoped lang="scss">` — always scoped, always SCSS
5. **PrimeVue 3**: Use PrimeVue v3 components (https://v3.primevue.org/) — they are auto-imported
6. **TypeScript**: Strict typing, interfaces use `I` prefix, no `any`
7. **Props/Emits**: Use `defineProps<T>()` and `defineEmits<T>()` with TypeScript generics

## Component Template

```vue
<template>
  <div class="component-name">
    <!-- PrimeVue components are auto-imported -->
    <Button label="Action" @click="handleClick" />
  </div>
</template>

<script setup lang="ts">
// Types — use I prefix for interfaces
interface IComponentProps {
  title: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<IComponentProps>(), {
  disabled: false,
});

const emit = defineEmits<{
  action: [value: string];
}>();

// Composables
const { data } = useFeature();

// Logic
const handleClick = () => {
  emit("action", props.title);
};
</script>

<style scoped lang="scss">
.component-name {
  // styles
}
</style>
```

## Key PrimeVue 3 Components

- **DataTable**: `<DataTable :value="items">` with `<Column>` children
- **Dialog**: `<Dialog v-model:visible="show" header="Title">`
- **Button**: `<Button label="Text" icon="pi pi-check" />`
- **InputText**: `<InputText v-model="value" />`
- **Dropdown**: `<Dropdown v-model="selected" :options="items" optionLabel="name" />`
- **Menu/Sidebar**: `<Menu :model="items" />`, `<Sidebar v-model:visible="show" />`

## Before Creating

1. Read existing similar components in `app/components/` for patterns
2. Check if types already exist in `app/types/`
3. Check if composables exist in `app/composables/`
4. Reuse existing utilities from `app/utils/`
