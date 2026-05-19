// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReflectionDiff,
  SidebarLink,
  SettingsPage,
  TriagePage,
  TriageRouteSidebar,
  parseTriageRoute,
} from "../src/ui/app.js";

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type BridgeGlobal = typeof globalThis & {
  __paperclipPluginBridge__?: {
    sdkUi?: Record<string, unknown>;
  };
};

type DataResult<T> = {
  data: T | null;
  loading: boolean;
  error: { message: string } | null;
  refresh: () => void;
};

type DataResolver<T> = (params: Record<string, unknown> | undefined) => DataResult<T>;

interface Bridge {
  data: Record<string, DataResolver<unknown>>;
  actions: Record<string, (params: Record<string, unknown> | undefined) => Promise<unknown> | unknown>;
  navigate: Array<{ to: string; options?: unknown }>;
  location: { pathname: string; search: string; hash: string };
  toasts: Array<unknown>;
  components: Array<{ key: string; props: unknown }>;
}

function installBridge(bridge: Bridge) {
  const sdkUi: Record<string, unknown> = {
    usePluginData: (key: string, params?: Record<string, unknown>) => {
      const resolver = bridge.data[key];
      if (!resolver) return { data: null, loading: false, error: null, refresh: () => undefined } satisfies DataResult<unknown>;
      return resolver(params);
    },
    usePluginAction: (key: string) => async (params?: Record<string, unknown>) => {
      const handler = bridge.actions[key];
      if (!handler) throw new Error(`Action ${key} not registered`);
      return handler(params);
    },
    useHostContext: () => ({ companyId: COMPANY_ID, companyPrefix: "PAP", projectId: null, entityId: null, entityType: null, userId: null }),
    useHostNavigation: () => ({
      navigate: (to: string, options?: unknown) => {
        bridge.navigate.push({ to, options });
      },
      linkProps: (to: string) => ({
        href: to,
        onClick: (event: { preventDefault?: () => void }) => {
          event.preventDefault?.();
          bridge.navigate.push({ to });
        },
      }),
    }),
    useHostLocation: () => ({ ...bridge.location }),
    usePluginStream: () => ({ events: [], lastEvent: null, connected: false, close: () => undefined }),
    usePluginToast: () => (payload: unknown) => {
      bridge.toasts.push(payload);
    },
    MarkdownBlock: ({ content }: { content: string }) => {
      bridge.components.push({ key: "MarkdownBlock", props: { content } });
      return createElement("pre", { "data-stub": "markdown-block" }, content);
    },
    MarkdownEditor: ({ value, onChange, placeholder }: { value: string; onChange: (next: string) => void; placeholder?: string }) => {
      bridge.components.push({ key: "MarkdownEditor", props: { value, placeholder } });
      return createElement("textarea", {
        "data-stub": "markdown-editor",
        value,
        placeholder,
        onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value),
      });
    },
  };
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = { sdkUi };
}

function emptyBridge(pathname: string): Bridge {
  return {
    data: {},
    actions: {},
    navigate: [],
    location: { pathname, search: "", hash: "" },
    toasts: [],
    components: [],
  };
}

function staticData<T>(value: T): DataResolver<T> {
  return () => ({ data: value, loading: false, error: null, refresh: () => undefined });
}

const baseQueue = {
  id: "queue-1",
  companyId: COMPANY_ID,
  queueKey: "content-training",
  title: "Content Training",
  description: "Triage incoming launch posts.",
  status: "active" as const,
  defaultStateKey: "new",
  activeItemCount: 2,
  archivedItemCount: 0,
  createdAt: "2026-05-19T10:00:00Z",
  updatedAt: "2026-05-19T10:00:00Z",
};

const baseItem = {
  id: "item-1",
  companyId: COMPANY_ID,
  queueId: "queue-1",
  itemKey: "ext-1",
  idempotencyKey: null,
  title: "Draft launch post",
  contentFormat: "markdown",
  content: "# Draft\n\nLaunching this week.",
  properties: { sourceKind: "opaque-blog", priority: "medium" },
  stateKey: "new",
  status: "active" as const,
  linkedQueueChatId: null,
  linkedWorkIssueId: null,
  revision: 1,
  lastIngestedAt: "2026-05-19T10:00:00Z",
  createdAt: "2026-05-19T10:00:00Z",
  updatedAt: "2026-05-19T10:00:00Z",
};

const PAGE_PROPS = {
  context: { companyId: COMPANY_ID, companyPrefix: "PAP", projectId: null, entityId: null, entityType: null, userId: null },
  bounds: { width: 1280, height: 800 },
  renderEnvironment: { id: "page", surface: "page" as const },
};

describe("parseTriageRoute", () => {
  it("recognizes home, queue, item, workflow, guidance, and transitions paths", () => {
    expect(parseTriageRoute("/PAP/triage")).toEqual({ kind: "home" });
    expect(parseTriageRoute("/PAP/triage/q/content-training")).toEqual({ kind: "queue", queueKey: "content-training" });
    expect(parseTriageRoute("/PAP/triage/q/content-training/i/item-7")).toEqual({ kind: "item", queueKey: "content-training", itemId: "item-7" });
    expect(parseTriageRoute("/PAP/triage/q/inbox/workflow")).toEqual({ kind: "workflow", queueKey: "inbox" });
    expect(parseTriageRoute("/PAP/triage/q/inbox/guidance")).toEqual({ kind: "guidance", queueKey: "inbox" });
    expect(parseTriageRoute("/PAP/triage/q/inbox/transitions")).toEqual({ kind: "transitions", queueKey: "inbox" });
  });
});

describe("ReflectionDiff", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("marks added, removed, and unchanged lines", () => {
    act(() => {
      root.render(
        createElement(ReflectionDiff, {
          baseContent: "Header\nKeep launch posts under 150 words.",
          proposedContent: "Header\nKeep launch posts under 150 words.\nFlag vague benefits before approving.",
        }),
      );
    });

    const adds = Array.from(container.querySelectorAll('[data-triage-diff-row="add"]'));
    const dels = Array.from(container.querySelectorAll('[data-triage-diff-row="del"]'));
    const eqs = Array.from(container.querySelectorAll('[data-triage-diff-row="eq"]'));
    expect(eqs.length).toBe(2);
    expect(dels.length).toBe(0);
    expect(adds.map((node) => node.textContent?.trim()).join("\n")).toContain("Flag vague benefits before approving.");

    act(() => {
      root.render(
        createElement(ReflectionDiff, {
          baseContent: "Keep posts short.",
          proposedContent: "Keep posts concise.",
        }),
      );
    });
    expect(container.querySelectorAll('[data-triage-diff-row="del"]').length).toBe(1);
    expect(container.querySelectorAll('[data-triage-diff-row="add"]').length).toBe(1);
  });
});

describe("SidebarLink", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: Bridge;
  beforeEach(() => {
    bridge = emptyBridge("/PAP/triage");
    installBridge(bridge);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("links to /triage with company-prefixed aria label", () => {
    act(() => {
      root.render(
        createElement(SidebarLink, {
          context: { companyId: COMPANY_ID, companyPrefix: "PAP", projectId: null, entityId: null, entityType: null, userId: null },
        }),
      );
    });
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/triage");
    expect(link?.getAttribute("aria-label")).toContain("PAP");
  });
});

describe("TriageRouteSidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: Bridge;
  beforeEach(() => {
    bridge = emptyBridge("/PAP/triage/q/content-training");
    bridge.data.queues = staticData([
      baseQueue,
      { ...baseQueue, id: "queue-2", queueKey: "drafts", title: "Drafts", activeItemCount: 7, status: "active" },
      { ...baseQueue, id: "queue-3", queueKey: "archive", title: "Archive", status: "archived", activeItemCount: 0, archivedItemCount: 4 },
    ]);
    installBridge(bridge);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the queue list and highlights the active queue", () => {
    act(() => {
      root.render(
        createElement(TriageRouteSidebar, {
          context: { companyId: COMPANY_ID, companyPrefix: "PAP", projectId: null, entityId: null, entityType: null, userId: null },
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Queues");
    expect(text).toContain("content-training");
    expect(text).toContain("drafts");
    expect(text).toContain("archive");
    const active = container.querySelector('[aria-current="page"]');
    expect(active?.textContent ?? "").toContain("content-training");
    expect(text).toContain("Workflow");
    expect(text).toContain("Guidance");
    expect(text).toContain("Transition actions");
  });
});

describe("TriagePage — queue list home", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: Bridge;
  beforeEach(() => {
    bridge = emptyBridge("/PAP/triage");
    bridge.data.queues = staticData([baseQueue]);
    installBridge(bridge);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the queue card with title, key, and item counts", () => {
    act(() => {
      root.render(createElement(TriagePage, PAGE_PROPS));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Content Training");
    expect(text).toContain("content-training");
    expect(text).toContain("2 active");
    expect(text).toContain("Triage incoming launch posts.");
    // Has + New queue button
    const createBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("New queue"));
    expect(createBtn).toBeTruthy();
  });
});

describe("TriagePage — queue overview lists items by state", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: Bridge;
  beforeEach(() => {
    bridge = emptyBridge("/PAP/triage/q/content-training");
    bridge.data.queues = staticData([baseQueue]);
    bridge.data.queue = staticData(baseQueue);
    bridge.data["queue-items"] = staticData([
      baseItem,
      { ...baseItem, id: "item-2", title: "Approved post", stateKey: "approved" },
    ]);
    installBridge(bridge);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("groups items by state and links each item to the workbench", () => {
    act(() => {
      root.render(createElement(TriagePage, PAGE_PROPS));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Draft launch post");
    expect(text).toContain("Approved post");
    expect(text).toContain("New");
    expect(text).toContain("Approved");

    const itemLinks = Array.from(container.querySelectorAll("a"))
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/triage/q/content-training/i/"));
    expect(itemLinks).toContain("/triage/q/content-training/i/item-1");
    expect(itemLinks).toContain("/triage/q/content-training/i/item-2");
  });
});

describe("TriagePage — item workbench two-column layout", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: Bridge;
  beforeEach(() => {
    bridge = emptyBridge("/PAP/triage/q/content-training/i/item-1");
    bridge.data.queues = staticData([baseQueue]);
    bridge.data.queue = staticData(baseQueue);
    bridge.data["queue-item"] = staticData(baseItem);
    bridge.data["queue-guidance"] = staticData([
      {
        id: "doc-1",
        companyId: COMPANY_ID,
        queueId: "queue-1",
        path: "guidance.md",
        title: "Guidance",
        status: "active" as const,
        currentRevisionId: "rev-1",
        content: "# Guidance\n\nKeep launch posts under 150 words.",
        contentHash: null,
        summary: null,
        metadata: {},
        createdAt: "2026-05-19T10:00:00Z",
        updatedAt: "2026-05-19T10:00:00Z",
      },
    ]);
    bridge.data["guidance-proposals"] = staticData([
      {
        id: "prop-1",
        companyId: COMPANY_ID,
        queueId: "queue-1",
        itemId: "item-1",
        targetDocId: "doc-1",
        status: "proposed" as const,
        proposedContent: "# Guidance\n\nKeep launch posts under 150 words.\nFlag vague benefits before approving.",
        rationale: "Exposes a repeatable rule.",
        metadata: { path: "guidance.md" },
        createdAt: "2026-05-19T10:00:00Z",
        updatedAt: "2026-05-19T10:00:00Z",
      },
    ]);
    bridge.data["item-events"] = staticData([
      { id: "evt-1", eventType: "item.ingested.created", fromStateKey: null, toStateKey: "new", actorType: "user", actorId: "u1", metadata: {}, createdAt: "2026-05-19T10:00:00Z" },
    ]);
    installBridge(bridge);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders chat pane (center/left) and document pane (right) with transition buttons and an open proposal", () => {
    act(() => {
      root.render(createElement(TriagePage, PAGE_PROPS));
    });

    const chatPane = container.querySelector('[data-triage-workbench-pane="chat"]');
    const documentPane = container.querySelector('[data-triage-workbench-pane="document"]');
    expect(chatPane).toBeTruthy();
    expect(documentPane).toBeTruthy();

    const text = container.textContent ?? "";
    expect(text).toContain("Assistant chat");
    expect(text).toContain("Triage Assistant");
    expect(text).toContain("Pinned item");
    expect(text).toContain("Draft launch post");
    expect(text).toContain("Item document");

    // The MarkdownEditor stub is rendered with the item content
    const editor = container.querySelector('textarea[data-stub="markdown-editor"]') as HTMLTextAreaElement | null;
    expect(editor?.value).toContain("Launching this week.");

    // Transition bar surfaces the default workflow transitions for state "new"
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.some((label) => label.includes("Approve"))).toBe(true);
    expect(buttons.some((label) => label.includes("Reject"))).toBe(true);

    // Guidance + open proposal show up
    expect(text).toContain("Queue guidance");
    expect(text).toContain("Open proposals");
    expect(text).toContain("Exposes a repeatable rule.");
    const proposal = container.querySelector('[data-triage-proposal-id="prop-1"]');
    expect(proposal).toBeTruthy();
    expect(proposal?.querySelector('[data-triage-diff]')).toBeTruthy();
  });
});

describe("TriagePage — transition action editor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: Bridge;
  beforeEach(() => {
    bridge = emptyBridge("/PAP/triage/q/content-training/transitions");
    bridge.data.queues = staticData([baseQueue]);
    bridge.data.queue = staticData(baseQueue);
    bridge.data["queue-transition-actions"] = staticData([
      {
        id: "act-1",
        queueId: "queue-1",
        actionKey: "create-work",
        fromStateKey: "new",
        toStateKey: "approved",
        actionType: "create_or_update_issue" as const,
        enabled: true,
        action: {
          type: "create_or_update_issue" as const,
          mode: "create_if_missing" as const,
          template: {
            title: "{{item.title}}",
            description: "{{item.content}}",
            comment: "Triage item moved to {{transition.toStateKey}}.",
            status: "todo",
            priority: "high",
          },
        },
        createdAt: "2026-05-19T10:00:00Z",
        updatedAt: "2026-05-19T10:00:00Z",
      },
    ]);
    installBridge(bridge);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists existing transition actions and their template fields", () => {
    act(() => {
      root.render(createElement(TriagePage, PAGE_PROPS));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Transition actions");
    expect(text).toContain("create-work");
    expect(text).toContain("create_if_missing");
    expect(text).toContain("{{item.title}}");
    expect(text).toContain("Triage item moved to {{transition.toStateKey}}.");
    const actionBlock = container.querySelector('[data-triage-action-key="create-work"]');
    expect(actionBlock).toBeTruthy();
  });
});

describe("SettingsPage — managed resource panel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: Bridge;
  beforeEach(() => {
    bridge = emptyBridge("/PAP/settings");
    bridge.data["managed-resource-health"] = staticData({
      status: "ready",
      checkedAt: "2026-05-19T10:00:00Z",
      agent: { resourceKey: "agent", status: "ready", agentId: "a-1", name: "Triage Assistant", agentStatus: "active", adapterType: "claude_local" },
      project: { resourceKey: "project", status: "ready", projectId: "p-1", name: "Triage", projectStatus: "in_progress" },
      skills: [
        { resourceKey: "skill-1", status: "ready", skillId: "s-1", name: "Triage Assistant", key: "plugin/paperclipai-plugin-triage/triage-assistant" },
      ],
    });
    installBridge(bridge);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the managed resource health rows and reconcile button", () => {
    act(() => {
      root.render(
        createElement(SettingsPage, {
          context: { companyId: COMPANY_ID, companyPrefix: "PAP", projectId: null, entityId: null, entityType: null, userId: null },
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Managed Resources");
    expect(text).toContain("Triage Project");
    expect(text).toContain("Triage Assistant");
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.some((label) => label.includes("Reconcile"))).toBe(true);
  });
});
