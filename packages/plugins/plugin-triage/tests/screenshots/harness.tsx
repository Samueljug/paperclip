import { createElement, useEffect, useState, type ReactElement } from "react";
import {
  SettingsPage,
  SidebarLink,
  TriagePage,
  TriageRouteSidebar,
} from "../../src/ui/app.js";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Bridge stubs.  The screenshot harness installs an alternate SDK runtime so
// the plugin UI renders with deterministic data without a live server.
// ---------------------------------------------------------------------------

const NOW = "2026-05-19T18:00:00.000Z";
const ONE_HOUR_AGO = "2026-05-19T17:00:00.000Z";
const COMPANY_ID = "00000000-0000-4000-8000-000000000001";

const HOST_CONTEXT: PluginHostContext = {
  companyId: COMPANY_ID,
  companyPrefix: "PAP",
  projectId: null,
  entityId: null,
  entityType: null,
  userId: "u-1",
};

const queues = [
  {
    id: "queue-content",
    companyId: COMPANY_ID,
    queueKey: "content-training",
    title: "Content training",
    description: "Triage incoming launch drafts and teach the assistant our voice.",
    status: "active",
    defaultStateKey: "new",
    activeItemCount: 12,
    archivedItemCount: 4,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "queue-inbox",
    companyId: COMPANY_ID,
    queueKey: "inbox",
    title: "Inbox",
    description: "Generic inbox for arbitrary item drops.",
    status: "active",
    defaultStateKey: "new",
    activeItemCount: 3,
    archivedItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "queue-drafts",
    companyId: COMPANY_ID,
    queueKey: "drafts",
    title: "Drafts",
    description: "Long-form drafts pending review.",
    status: "active",
    defaultStateKey: "new",
    activeItemCount: 7,
    archivedItemCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "queue-financial",
    companyId: COMPANY_ID,
    queueKey: "financial-approvals",
    title: "Financial approvals",
    description: "Review small purchases before issue creation.",
    status: "active",
    defaultStateKey: "new",
    activeItemCount: 2,
    archivedItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const items = [
  {
    id: "item-142",
    companyId: COMPANY_ID,
    queueId: "queue-content",
    itemKey: "ext-9210",
    idempotencyKey: null,
    title: "Draft launch post",
    contentFormat: "markdown",
    content: "# Draft launch post\n\nOur new bench cut p95 latency by half.\nHere's what changed and what's next.\n\n## What's new\n\n- Stream-first scheduling\n- Per-queue guidance\n- Reflection loop after every item\n\n## Closing\n\nMore to come on the next iteration.\n",
    properties: { upstreamId: "ext-9210-blog", sourceKind: "opaque-blog", priority: "medium" },
    stateKey: "new",
    status: "active",
    linkedQueueChatId: "chat-142",
    linkedWorkIssueId: null,
    revision: 3,
    lastIngestedAt: ONE_HOUR_AGO,
    createdAt: ONE_HOUR_AGO,
    updatedAt: NOW,
  },
  {
    id: "item-141",
    companyId: COMPANY_ID,
    queueId: "queue-content",
    itemKey: "ext-9209",
    idempotencyKey: null,
    title: "v2 pricing intro",
    contentFormat: "markdown",
    content: "Rewrite the pricing intro to highlight per-seat pricing.",
    properties: {},
    stateKey: "new",
    status: "active",
    linkedQueueChatId: null,
    linkedWorkIssueId: null,
    revision: 1,
    lastIngestedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "item-140",
    companyId: COMPANY_ID,
    queueId: "queue-content",
    itemKey: "ext-9208",
    idempotencyKey: null,
    title: "Team page rewrite",
    contentFormat: "markdown",
    content: "Update the team page with new joiners.",
    properties: {},
    stateKey: "approved",
    status: "active",
    linkedQueueChatId: null,
    linkedWorkIssueId: "issue-7732",
    revision: 2,
    lastIngestedAt: ONE_HOUR_AGO,
    createdAt: ONE_HOUR_AGO,
    updatedAt: ONE_HOUR_AGO,
  },
  {
    id: "item-139",
    companyId: COMPANY_ID,
    queueId: "queue-content",
    itemKey: null,
    idempotencyKey: null,
    title: "Q3 announce",
    contentFormat: "markdown",
    content: "",
    properties: {},
    stateKey: "rejected",
    status: "active",
    linkedQueueChatId: null,
    linkedWorkIssueId: null,
    revision: 1,
    lastIngestedAt: ONE_HOUR_AGO,
    createdAt: ONE_HOUR_AGO,
    updatedAt: ONE_HOUR_AGO,
  },
];

const guidance = [
  {
    id: "doc-guidance",
    companyId: COMPANY_ID,
    queueId: "queue-content",
    path: "guidance.md",
    title: "Guidance",
    status: "active",
    currentRevisionId: "rev-1",
    content: "# Content training guidance\n\n- Keep launch posts under 150 words.\n- Anchor every claim with at least one concrete number or benchmark.\n- Lead with the user benefit, not the system that produced it.\n",
    contentHash: null,
    summary: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "doc-style",
    companyId: COMPANY_ID,
    queueId: "queue-content",
    path: "style.md",
    title: "style",
    status: "active",
    currentRevisionId: "rev-2",
    content: "# Style\n\n- Sentence case headings.\n- Use plain English; spell out acronyms once.",
    contentHash: null,
    summary: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const proposals = [
  {
    id: "prop-7",
    companyId: COMPANY_ID,
    queueId: "queue-content",
    itemId: "item-142",
    targetDocId: "doc-guidance",
    status: "proposed",
    proposedContent: "# Content training guidance\n\n- Keep launch posts under 150 words.\n- Anchor every claim with at least one concrete number or benchmark.\n- Lead with the user benefit, not the system that produced it.\n- For launch posts, flag vague benefits (\"better\", \"faster\") before approving.\n",
    rationale: "Item #142 exposed a repeatable approval rule about vague benefit phrasing.",
    metadata: { path: "guidance.md" },
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const events = [
  { id: "evt-1", eventType: "item.ingested.created", fromStateKey: null, toStateKey: "new", actorType: "user", actorId: "u-1", metadata: {}, createdAt: ONE_HOUR_AGO },
  { id: "evt-2", eventType: "item.content.updated", fromStateKey: "new", toStateKey: "new", actorType: "user", actorId: "u-1", metadata: {}, createdAt: NOW },
];

const transitionActions = [
  {
    id: "act-1",
    queueId: "queue-content",
    actionKey: "create-work",
    fromStateKey: "new",
    toStateKey: "approved",
    actionType: "create_or_update_issue",
    enabled: true,
    action: {
      type: "create_or_update_issue",
      mode: "create_if_missing",
      template: {
        title: "{{item.title}}",
        description: "{{item.content}}\n\nMetadata:\n{{item.propertiesJson}}",
        comment: "Triage item moved to {{transition.toStateKey}}.",
        status: "todo",
        priority: "high",
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const managedHealth = {
  status: "ready",
  checkedAt: NOW,
  agent: { resourceKey: "agent", status: "ready", agentId: "a-1", name: "Triage Assistant", agentStatus: "active", adapterType: "claude_local" },
  project: { resourceKey: "project", status: "ready", projectId: "p-1", name: "Triage", projectStatus: "in_progress" },
  skills: [
    { resourceKey: "skill-1", status: "ready", skillId: "s-1", name: "Triage Assistant", key: "plugin/paperclipai-plugin-triage/triage-assistant" },
    { resourceKey: "skill-2", status: "ready", skillId: "s-2", name: "Triage Reflection", key: "plugin/paperclipai-plugin-triage/triage-reflection" },
    { resourceKey: "skill-3", status: "ready", skillId: "s-3", name: "Triage Workflow", key: "plugin/paperclipai-plugin-triage/triage-workflow" },
  ],
};

const dataMap: Record<string, unknown> = {
  queues,
  queue: (params: Record<string, unknown> | undefined) => queues.find((q) => q.queueKey === params?.queueKey) ?? queues[0],
  "queue-items": (params: Record<string, unknown> | undefined) => items.filter((it) => {
    const q = queues.find((q) => q.queueKey === params?.queueKey);
    return q ? it.queueId === q.id : true;
  }),
  "queue-item": (params: Record<string, unknown> | undefined) => items.find((it) => it.id === params?.itemId) ?? items[0],
  "queue-guidance": guidance,
  "guidance-proposals": proposals,
  "item-events": events,
  "queue-transition-actions": transitionActions,
  "managed-resource-health": managedHealth,
};

function dataResult<T>(value: T) {
  return { data: value as T, loading: false, error: null, refresh: () => undefined };
}

function resolveData(key: string, params: Record<string, unknown> | undefined) {
  if (!(key in dataMap)) return { data: null, loading: false, error: null, refresh: () => undefined };
  const value = dataMap[key];
  if (typeof value === "function") {
    return dataResult((value as (p?: Record<string, unknown>) => unknown)(params));
  }
  return dataResult(value);
}

function installBridge(pathname: string) {
  const sdkUi: Record<string, unknown> = {
    usePluginData: (key: string, params?: Record<string, unknown>) => resolveData(key, params),
    usePluginAction: () => async () => undefined,
    useHostContext: () => HOST_CONTEXT,
    useHostNavigation: () => ({
      navigate: (to: string) => {
        if (typeof window !== "undefined") {
          window.history.pushState({}, "", to);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
      },
      linkProps: (to: string) => ({
        href: to,
        onClick: (event: { preventDefault?: () => void }) => {
          event.preventDefault?.();
          if (typeof window !== "undefined") {
            window.history.pushState({}, "", to);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }
        },
      }),
    }),
    useHostLocation: () => ({ pathname, search: "", hash: "" }),
    usePluginStream: () => ({ events: [], lastEvent: null, connected: false, close: () => undefined }),
    usePluginToast: () => () => undefined,
    MarkdownBlock: ({ content }: { content: string }) => createElement("pre", { style: { whiteSpace: "pre-wrap", margin: 0, fontFamily: "ui-sans-serif, system-ui, sans-serif" } }, content),
    MarkdownEditor: ({ value, onChange, placeholder }: { value: string; onChange: (next: string) => void; placeholder?: string }) =>
      createElement("textarea", {
        value,
        placeholder,
        onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value),
        style: {
          padding: "10px 12px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 13,
          background: "var(--card)",
          color: "var(--foreground)",
          resize: "vertical",
          minHeight: 260,
          width: "100%",
          boxSizing: "border-box",
        },
      }),
  };
  (globalThis as { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } }).__paperclipPluginBridge__ = { sdkUi };
}

function readPath(): string {
  if (typeof window === "undefined") return "/PAP/triage";
  return window.location.pathname || "/PAP/triage";
}

function readHashView(): string {
  if (typeof window === "undefined") return "page";
  return (window.location.hash || "").replace(/^#/, "") || "page";
}

function ShellWithSidebar({ children }: { children: ReactElement }) {
  return createElement(
    "div",
    { className: "triage-shell" },
    createElement(
      "div",
      { className: "triage-shell-sidebar" },
      createElement(TriageRouteSidebar, { context: HOST_CONTEXT }),
    ),
    createElement("div", { className: "triage-shell-main" }, children),
  );
}

export function App() {
  const [pathname, setPathname] = useState(readPath());
  const [view, setView] = useState(readHashView());

  useEffect(() => {
    const update = () => {
      setPathname(readPath());
      setView(readHashView());
    };
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);

  installBridge(pathname);

  if (view === "sidebar") {
    return createElement("div", { style: { padding: 16, width: 220 } },
      createElement(SidebarLink, { context: HOST_CONTEXT }),
    );
  }
  if (view === "settings") {
    return createElement(SettingsPage, { context: HOST_CONTEXT });
  }
  if (view === "route-sidebar") {
    return createElement("div", { style: { width: 240, height: "100vh", borderRight: "1px solid var(--border)" } },
      createElement(TriageRouteSidebar, { context: HOST_CONTEXT }),
    );
  }
  return createElement(ShellWithSidebar, null, createElement(TriagePage, { context: HOST_CONTEXT }));
}
