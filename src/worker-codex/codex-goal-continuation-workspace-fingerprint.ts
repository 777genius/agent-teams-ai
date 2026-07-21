export const CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA =
  "workspace-diff-sha256-v1" as const;

export type CodexGoalContinuationWorkspaceFingerprint = {
  readonly schema: typeof CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly sha256: string;
};
