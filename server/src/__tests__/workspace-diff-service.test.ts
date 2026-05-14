import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionWorkspace, WorkspaceDiffQueryOptions } from "@paperclipai/shared";
import { WORKSPACE_DIFF_CAPS, workspaceDiffService } from "../services/workspace-diff.js";

const execFileAsync = promisify(execFile);
const tempDirs = new Set<string>();

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-diff-"));
  tempDirs.add(repoRoot);
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "tracked-staged.txt"), "alpha\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "tracked-unstaged.txt"), "bravo\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "delete-me.txt"), "charlie\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "rename-me.txt"), "delta\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

function createWorkspace(cwd: string | null, overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  const now = new Date();
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    projectId: randomUUID(),
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Diff workspace",
    status: "active",
    cwd,
    repoUrl: null,
    baseRef: null,
    branchName: "feature",
    providerType: "git_worktree",
    providerRef: cwd,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: now,
    openedAt: now,
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function workingTreeQuery(overrides: Partial<WorkspaceDiffQueryOptions> = {}): WorkspaceDiffQueryOptions {
  return {
    view: "working-tree",
    baseRef: null,
    includeUntracked: true,
    paths: [],
    ...overrides,
  };
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("workspaceDiffService", () => {
  it("returns staged, unstaged, renamed, deleted, untracked, binary, and oversized working-tree changes", async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, "tracked-staged.txt"), "alpha\nstaged\n", "utf8");
    await runGit(repoRoot, ["add", "tracked-staged.txt"]);
    await fs.writeFile(path.join(repoRoot, "tracked-unstaged.txt"), "bravo\nunstaged\n", "utf8");
    await runGit(repoRoot, ["mv", "rename-me.txt", "renamed.txt"]);
    await fs.rm(path.join(repoRoot, "delete-me.txt"));
    await fs.writeFile(path.join(repoRoot, "binary.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
    await fs.writeFile(path.join(repoRoot, "untracked.txt"), "brand new\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "oversized.txt"), "x".repeat(WORKSPACE_DIFF_CAPS.maxFileBytes + 1), "utf8");

    const diff = await workspaceDiffService().getDiff(createWorkspace(repoRoot), workingTreeQuery());
    const byPath = new Map(diff.files.map((file) => [file.path, file]));

    expect(diff.view).toBe("working-tree");
    expect(byPath.get("tracked-staged.txt")).toMatchObject({
      staged: true,
      unstaged: false,
      status: "modified",
      additions: 1,
    });
    expect(byPath.get("tracked-staged.txt")?.patches.map((patch) => patch.kind)).toEqual(["staged"]);
    expect(byPath.get("tracked-unstaged.txt")).toMatchObject({
      staged: false,
      unstaged: true,
      status: "modified",
      additions: 1,
    });
    expect(byPath.get("renamed.txt")).toMatchObject({
      oldPath: "rename-me.txt",
      staged: true,
      status: "renamed",
    });
    expect(byPath.get("delete-me.txt")).toMatchObject({
      unstaged: true,
      status: "deleted",
      deletions: 1,
    });
    expect(byPath.get("untracked.txt")).toMatchObject({
      untracked: true,
      status: "untracked",
      additions: 1,
    });
    expect(byPath.get("untracked.txt")?.patches[0]?.patch).toContain("+brand new");
    expect(byPath.get("binary.bin")).toMatchObject({
      binary: true,
      unstaged: true,
    });
    expect(byPath.get("oversized.txt")).toMatchObject({
      oversized: true,
      untracked: true,
    });
    expect(diff.warnings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "binary_file",
      "file_oversized",
    ]));
  }, 20_000);

  it("returns head diffs against the requested base ref", async () => {
    const repoRoot = await createTempRepo();
    await runGit(repoRoot, ["checkout", "-b", "feature"]);
    await fs.writeFile(path.join(repoRoot, "tracked-staged.txt"), "alpha\ncommitted\n", "utf8");
    await runGit(repoRoot, ["add", "tracked-staged.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Feature change"]);

    const diff = await workspaceDiffService().getDiff(
      createWorkspace(repoRoot, { baseRef: "main" }),
      workingTreeQuery({ view: "head", includeUntracked: false }),
    );

    expect(diff.baseRef).toBe("main");
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({
      path: "tracked-staged.txt",
      staged: false,
      unstaged: false,
      untracked: false,
      additions: 1,
      deletions: 0,
    });
    expect(diff.files[0]?.patches.map((patch) => patch.kind)).toEqual(["head"]);
  }, 20_000);

  it("surfaces missing cwd, non-git, invalid base refs, and unsafe path filters as 422 errors", async () => {
    const svc = workspaceDiffService();
    await expect(svc.getDiff(createWorkspace(null), workingTreeQuery()))
      .rejects.toMatchObject({ status: 422, details: { code: "missing_cwd" } });

    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-diff-non-git-"));
    tempDirs.add(nonGitDir);
    await expect(svc.getDiff(createWorkspace(nonGitDir), workingTreeQuery()))
      .rejects.toMatchObject({ status: 422, details: { code: "non_git_workspace" } });

    const repoRoot = await createTempRepo();
    await expect(svc.getDiff(createWorkspace(repoRoot), workingTreeQuery({ paths: ["../secret"] })))
      .rejects.toMatchObject({ status: 422, details: { code: "path_filter_invalid" } });
    await expect(svc.getDiff(createWorkspace(repoRoot), workingTreeQuery({ view: "head", baseRef: "missing-ref" })))
      .rejects.toMatchObject({ status: 422, details: { code: "base_ref_invalid" } });
  }, 20_000);
});
