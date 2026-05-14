export type WorkspaceDiffView = "working-tree" | "head";

export type WorkspaceDiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "untracked"
  | "unknown";

export type WorkspaceDiffPatchKind = "staged" | "unstaged" | "head" | "untracked";

export type WorkspaceDiffWarningCode =
  | "base_ref_missing"
  | "base_ref_invalid"
  | "binary_file"
  | "file_count_truncated"
  | "file_oversized"
  | "git_command_failed"
  | "missing_cwd"
  | "non_git_workspace"
  | "patch_truncated"
  | "path_filter_invalid"
  | "workspace_path_invalid";

export interface WorkspaceDiffQueryOptions {
  view: WorkspaceDiffView;
  baseRef: string | null;
  includeUntracked: boolean;
  paths: string[];
}

export interface WorkspaceDiffWarning {
  code: WorkspaceDiffWarningCode;
  message: string;
  path: string | null;
}

export interface WorkspaceDiffCaps {
  maxFiles: number;
  maxFileBytes: number;
  maxPatchBytes: number;
  maxTotalPatchBytes: number;
}

export interface WorkspaceDiffFilePatch {
  kind: WorkspaceDiffPatchKind;
  patch: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
  oversized: boolean;
  truncated: boolean;
  warnings: WorkspaceDiffWarning[];
}

export interface WorkspaceDiffFile {
  path: string;
  oldPath: string | null;
  status: WorkspaceDiffFileStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  binary: boolean;
  oversized: boolean;
  truncated: boolean;
  additions: number;
  deletions: number;
  sizeBytes: number | null;
  patches: WorkspaceDiffFilePatch[];
  warnings: WorkspaceDiffWarning[];
}

export interface WorkspaceDiffStats {
  fileCount: number;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
  binaryFileCount: number;
  oversizedFileCount: number;
  truncatedFileCount: number;
  additions: number;
  deletions: number;
}

export interface WorkspaceDiffResponse {
  workspaceId: string;
  companyId: string;
  repoRoot: string;
  cwd: string;
  view: WorkspaceDiffView;
  baseRef: string | null;
  headSha: string | null;
  includeUntracked: boolean;
  paths: string[];
  files: WorkspaceDiffFile[];
  stats: WorkspaceDiffStats;
  warnings: WorkspaceDiffWarning[];
  caps: WorkspaceDiffCaps;
  truncated: boolean;
}
