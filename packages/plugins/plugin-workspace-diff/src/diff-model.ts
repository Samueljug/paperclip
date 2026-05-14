import type {
  WorkspaceDiffFile,
  WorkspaceDiffFilePatch,
  WorkspaceDiffResponse,
  WorkspaceDiffWarning,
} from "@paperclipai/plugin-sdk";

export type DiffRenderMode = "unified" | "split";

export interface DiffFileViewModel {
  path: string;
  oldPath: string | null;
  status: WorkspaceDiffFile["status"];
  additions: number;
  deletions: number;
  binary: boolean;
  oversized: boolean;
  truncated: boolean;
  warnings: WorkspaceDiffWarning[];
  patchKinds: WorkspaceDiffFilePatch["kind"][];
  patch: string | null;
}

export interface DiffSummaryViewModel {
  changedLabel: string;
  lineLabel: string;
  warningCount: number;
  truncated: boolean;
}

const STATUS_LABELS: Record<WorkspaceDiffFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type changed",
  untracked: "Untracked",
  unknown: "Changed",
};

export function statusLabel(status: WorkspaceDiffFile["status"]) {
  return STATUS_LABELS[status] ?? "Changed";
}

export function fileName(filePath: string) {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

export function buildFilePatch(file: WorkspaceDiffFile): string | null {
  const patches = file.patches
    .map((patch) => patch.patch?.trimEnd() ?? "")
    .filter(Boolean);
  if (patches.length === 0) return null;
  return patches.join("\n");
}

export function toFileViewModels(diff: WorkspaceDiffResponse | null | undefined): DiffFileViewModel[] {
  return (diff?.files ?? []).map((file) => {
    const patchWarnings = file.patches.flatMap((patch) => patch.warnings);
    return {
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      oversized: file.oversized,
      truncated: file.truncated,
      warnings: [...file.warnings, ...patchWarnings],
      patchKinds: file.patches.map((patch) => patch.kind),
      patch: buildFilePatch(file),
    };
  });
}

export function diffSummary(diff: WorkspaceDiffResponse | null | undefined): DiffSummaryViewModel {
  const stats = diff?.stats;
  const fileCount = stats?.fileCount ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const warningCount = (diff?.warnings.length ?? 0)
    + (diff?.files ?? []).reduce((count, file) => {
      return count + file.warnings.length + file.patches.reduce((patchCount, patch) => patchCount + patch.warnings.length, 0);
    }, 0);

  return {
    changedLabel: `${fileCount} ${fileCount === 1 ? "file" : "files"}`,
    lineLabel: `+${additions} / -${deletions}`,
    warningCount,
    truncated: Boolean(diff?.truncated),
  };
}

export function nextExpandedFileSet(
  current: ReadonlySet<string>,
  filePath: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(filePath)) next.delete(filePath);
  else next.add(filePath);
  return next;
}
