import {
  inspectCodexGoalProcessSnapshotRows,
  readCodexGoalProcessSnapshotRows,
  type CodexGoalProcessSnapshot,
  type CodexGoalProcessSnapshotRow,
} from "../codex-goal-process-snapshot";
import {
  gitWorkspaceStatus,
  type CodexGoalWorkspaceStatus,
} from "../codex-goal-status-files";

export type CodexGoalObservationContext = {
  readonly processSnapshot: (pid: number) => Promise<CodexGoalProcessSnapshot>;
  readonly workspaceStatus: (path: string) => Promise<CodexGoalWorkspaceStatus>;
};

export type CodexGoalObservationContextDeps = {
  readonly readProcessRows?: () => Promise<readonly CodexGoalProcessSnapshotRow[]>;
  readonly readWorkspaceStatus?: (path: string) => Promise<CodexGoalWorkspaceStatus>;
};

export function createCodexGoalObservationContext(
  deps: CodexGoalObservationContextDeps = {},
): CodexGoalObservationContext {
  const readProcessRows = deps.readProcessRows ?? readCodexGoalProcessSnapshotRows;
  const readWorkspaceStatus = deps.readWorkspaceStatus ?? gitWorkspaceStatus;
  const workspaceStatuses = new Map<string, Promise<CodexGoalWorkspaceStatus>>();
  let processRows: Promise<readonly CodexGoalProcessSnapshotRow[] | undefined> | undefined;

  return {
    async processSnapshot(pid) {
      processRows ??= readProcessRows().catch(() => undefined);
      const rows = await processRows;
      return rows ? inspectCodexGoalProcessSnapshotRows(pid, rows) : {};
    },
    workspaceStatus(path) {
      const cached = workspaceStatuses.get(path);
      if (cached) return cached;
      const status = readWorkspaceStatus(path);
      workspaceStatuses.set(path, status);
      return status;
    },
  };
}
