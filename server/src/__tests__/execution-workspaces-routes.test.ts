import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceDiffService = vi.hoisted(() => ({
  getDiff: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: mockLogActivity,
  workspaceDiffService: () => mockWorkspaceDiffService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function createApp(companyIds = ["company-1"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds,
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockWorkspaceDiffService.getDiff.mockResolvedValue({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      repoRoot: "/tmp/repo",
      cwd: "/tmp/repo",
      view: "working-tree",
      baseRef: null,
      headSha: "abc123",
      includeUntracked: true,
      paths: [],
      files: [],
      stats: {
        fileCount: 0,
        stagedFileCount: 0,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        binaryFileCount: 0,
        oversizedFileCount: 0,
        truncatedFileCount: 0,
        additions: 0,
        deletions: 0,
      },
      warnings: [],
      caps: {
        maxFiles: 200,
        maxFileBytes: 524288,
        maxPatchBytes: 262144,
        maxTotalPatchBytes: 1048576,
      },
      truncated: false,
    });
  });

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces?summary=true&reuseEligible=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    expect(mockExecutionWorkspaceService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorkspaceService.list).not.toHaveBeenCalled();
  });

  it("parses diff query options after enforcing workspace company access", async () => {
    const workspace = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: null,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Feature workspace",
      status: "active",
      cwd: "/tmp/repo",
      repoUrl: null,
      baseRef: null,
      branchName: "feature",
      providerType: "git_worktree",
      providerRef: "/tmp/repo",
      derivedFromExecutionWorkspaceId: null,
      lastUsedAt: new Date(),
      openedAt: new Date(),
      closedAt: null,
      cleanupEligibleAt: null,
      cleanupReason: null,
      config: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(workspace);

    const res = await request(createApp())
      .get("/api/execution-workspaces/11111111-1111-4111-8111-111111111111/diff?view=head&baseRef=main&includeUntracked=false&path=server/src/index.ts&path=ui/src/App.tsx");

    expect(res.status).toBe(200);
    expect(mockWorkspaceDiffService.getDiff).toHaveBeenCalledWith(workspace, {
      view: "head",
      baseRef: "main",
      includeUntracked: false,
      paths: ["server/src/index.ts", "ui/src/App.tsx"],
    });
  });

  it("denies diff access when the workspace belongs to another company", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-2",
    });

    const res = await request(createApp(["company-1"]))
      .get("/api/execution-workspaces/11111111-1111-4111-8111-111111111111/diff");

    expect(res.status).toBe(403);
    expect(mockWorkspaceDiffService.getDiff).not.toHaveBeenCalled();
  });
});
