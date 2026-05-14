import { describe, expect, it } from "vitest";
import { workspaceDiffQuerySchema, workspaceDiffResponseSchema } from "./workspace-diff.js";

describe("workspace diff validators", () => {
  it("normalizes query options from route query strings", () => {
    expect(workspaceDiffQuerySchema.parse({
      view: "head",
      baseRef: " main ",
      includeUntracked: "false",
      path: ["server/src/index.ts", "ui/src/App.tsx,packages/shared/src/index.ts"],
    })).toEqual({
      view: "head",
      baseRef: "main",
      includeUntracked: false,
      paths: ["server/src/index.ts", "ui/src/App.tsx", "packages/shared/src/index.ts"],
    });
  });

  it("validates the response contract", () => {
    const response = workspaceDiffResponseSchema.parse({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      repoRoot: "/tmp/repo",
      cwd: "/tmp/repo",
      view: "working-tree",
      baseRef: null,
      headSha: "abc123",
      includeUntracked: true,
      paths: [],
      files: [{
        path: "README.md",
        oldPath: null,
        status: "modified",
        staged: true,
        unstaged: false,
        untracked: false,
        binary: false,
        oversized: false,
        truncated: false,
        additions: 1,
        deletions: 0,
        sizeBytes: 12,
        patches: [{
          kind: "staged",
          patch: "diff --git a/README.md b/README.md\n",
          additions: 1,
          deletions: 0,
          binary: false,
          oversized: false,
          truncated: false,
          warnings: [],
        }],
        warnings: [],
      }],
      stats: {
        fileCount: 1,
        stagedFileCount: 1,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        binaryFileCount: 0,
        oversizedFileCount: 0,
        truncatedFileCount: 0,
        additions: 1,
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

    expect(response.files[0]?.patches[0]?.kind).toBe("staged");
  });
});
