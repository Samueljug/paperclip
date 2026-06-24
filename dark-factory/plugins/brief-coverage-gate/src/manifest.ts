import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "darkfactory.brief-coverage-gate",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Brief Coverage Gate",
  description:
    "Keeps an issue from advancing unless its brief-artifact-manifest is complete (every media artifact transcribed) and its coverage-matrix has no uncovered required items or unwaived off-track rows. Enforced via the host's own blocker semantics; no Paperclip core edits.",
  author: "dark-factory",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issues.create",
    "issue.documents.read",
    "issue.relations.read",
    "issue.relations.write",
    "issue.comments.create",
    "ui.dashboardWidget.register",
  ],
  // Operator config: ships in DRY-RUN (observe + comment, never block) by default.
  // Flip `enforce` to true only once the gate has been seen judging correctly.
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enforce: {
        type: "boolean",
        title: "Enforce (block issues)",
        description:
          "When true, the gate adds a host blocker to an issue whose manifest is incomplete or coverage is unclean, so the host refuses to advance it. When false (default), the gate only observes and comments.",
        default: false,
      },
      comment: {
        type: "boolean",
        title: "Post findings as comments",
        description:
          "When true (default), the gate posts a comment when a verdict changes.",
        default: true,
      },
    },
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Brief Coverage Gate",
        exportName: "DashboardWidget",
      },
    ],
  },
};

export default manifest;
