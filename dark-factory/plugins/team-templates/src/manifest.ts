import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "darkfactory.team-templates",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Team Model Templates",
  description:
    "Preconfigured per-team model/CLI templates. Apply one to set every team's agents to a model (Codex/Claude/Gemini), each call routed through that LLM's CLI.",
  author: "dark-factory",
  categories: ["automation"],
  capabilities: [
    "plugin.state.read",
    "plugin.state.write",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "team-templates-sidebar",
        displayName: "Team Templates",
        exportName: "SidebarLink",
        order: 50,
      },
      {
        type: "page",
        id: "team-templates-page",
        displayName: "Team Model Templates",
        exportName: "TeamTemplatesPage",
        routePath: "team-templates",
      },
      {
        type: "dashboardWidget",
        id: "team-templates-widget",
        displayName: "Active Team Template",
        exportName: "DashboardWidget",
      },
    ],
  },
};

export default manifest;
