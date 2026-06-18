import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "darkfactory.todo-autoassign",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "To-Do Auto-Assign",
  description:
    "Instantly assigns a card to the right manager lead the moment it lands unassigned in To Do (native issue.created/issue.updated event hook). Assigning auto-wakes the lead, so the card gets worked. Replaces the polling foreman.",
  author: "dark-factory",
  categories: ["automation"],
  capabilities: ["events.subscribe", "issues.read", "issues.update"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
