// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthAccountUsage } from "./OAuthAccountUsage";

const mockGet = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/oauthAccountUsage", () => ({
  oauthAccountUsageApi: { get: mockGet },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("OAuthAccountUsage", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGet.mockResolvedValue({
      checkedAt: "2026-06-13T00:00:00.000Z",
      accounts: [
        {
          provider: "google",
          tool: "Antigravity agy",
          accountIdentifier: "agy@example.test",
          authSourceType: "Antigravity OAuth/keyring",
          selectedModel: "Gemini 3.5 Flash (High)",
          availableModelInfo: "Selected model evidence: Gemini 3.5 Flash (High)",
          usabilityStatus: "quota_exhausted",
          quotaState: "exhausted",
          quotaWindows: [],
          quotaResetInfo: "Resets in 2h14m17s",
          quotaDetail: "RESOURCE_EXHAUSTED (code 429): Individual quota reached.",
          recentLocalUsage: null,
          lastCheckedAt: "2026-06-13T00:00:00.000Z",
          evidenceSources: ["~/.gemini/antigravity-cli/log/cli.log: RESOURCE_EXHAUSTED"],
          notes: ["Exact remaining OAuth quota is not exposed locally."],
        },
        {
          provider: "openai",
          tool: "Codex CLI",
          accountIdentifier: "codex@example.test",
          authSourceType: "Codex OAuth (plus)",
          selectedModel: null,
          availableModelInfo: "Codex model selection is read from runtime config.",
          usabilityStatus: "usable",
          quotaState: "available",
          quotaWindows: [{ label: "5h limit", usedPercent: 42, resetsAt: null, valueLabel: null }],
          quotaResetInfo: null,
          quotaDetail: "Quota reported by codex-rpc.",
          recentLocalUsage: null,
          lastCheckedAt: "2026-06-13T00:00:00.000Z",
          evidenceSources: ["quota source: codex-rpc"],
          notes: [],
        },
      ],
      limitations: ["Exact remaining OAuth quota is only shown when exposed."],
    });
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("renders account usage rows and quota evidence", async () => {
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <OAuthAccountUsage />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("OAuth account usage");
    expect(container.textContent).toContain("Antigravity agy");
    expect(container.textContent).toContain("agy@example.test");
    expect(container.textContent).toContain("Gemini 3.5 Flash (High)");
    expect(container.textContent).toContain("Quota exhausted");
    expect(container.textContent).toContain("Codex CLI");
    expect(container.textContent).toContain("42% used");
    expect(container.textContent).toContain("Exact remaining OAuth quota is only shown when exposed.");
  });
});
