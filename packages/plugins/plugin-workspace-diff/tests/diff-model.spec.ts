import { describe, expect, it } from "vitest";
import {
  buildFilePatch,
  diffSummary,
  nextExpandedFileSet,
  statusLabel,
  toFileViewModels,
} from "../src/diff-model.js";
import { changedFile, diffResponse } from "./fixtures.js";

describe("workspace diff UI model", () => {
  it("summarizes changed files and line counts", () => {
    const diff = diffResponse();

    expect(diffSummary(diff)).toMatchObject({
      changedLabel: "1 file",
      lineLabel: "+1 / -1",
      warningCount: 0,
      truncated: false,
    });
    expect(toFileViewModels(diff)[0]).toMatchObject({
      path: "src/app.ts",
      status: "modified",
      patchKinds: ["unstaged"],
    });
  });

  it("represents empty workspace diffs", () => {
    const diff = diffResponse({ files: [] });

    expect(toFileViewModels(diff)).toEqual([]);
    expect(diffSummary(diff).changedLabel).toBe("0 files");
  });

  it("surfaces truncation and file warnings", () => {
    const file = changedFile({
      truncated: true,
      warnings: [{ code: "patch_truncated", message: "Patch was truncated.", path: "src/app.ts" }],
      patches: [],
    });
    const diff = diffResponse({ files: [file], truncated: true });

    expect(buildFilePatch(file)).toBeNull();
    expect(diffSummary(diff)).toMatchObject({
      warningCount: 1,
      truncated: true,
    });
  });

  it("toggles expanded file state without mutating the current set", () => {
    const current = new Set(["a.ts"]);
    const collapsed = nextExpandedFileSet(current, "a.ts");
    const expanded = nextExpandedFileSet(current, "b.ts");

    expect(current.has("a.ts")).toBe(true);
    expect(collapsed.has("a.ts")).toBe(false);
    expect(expanded.has("b.ts")).toBe(true);
  });

  it("labels file statuses for the sidebar", () => {
    expect(statusLabel("untracked")).toBe("Untracked");
    expect(statusLabel("type_changed")).toBe("Type changed");
  });
});
