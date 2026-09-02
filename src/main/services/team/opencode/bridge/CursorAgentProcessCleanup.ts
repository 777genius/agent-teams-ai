import {
  listRuntimeProcessTableForCurrentPlatform,
  type RuntimeProcessTableRow,
} from '@features/tmux-installer/main';
import { killProcessByPid } from '@main/utils/processKill';
import { createProcessStartTimeCache, readProcessStartTimeMs } from '@main/utils/processStartTime';
import { listWindowsProcessTable } from '@main/utils/windowsProcessTable';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('CursorAgentProcessCleanup');

/**
 * A cursor-acp team lead is not an OpenCode host. It is an external
 * `cursor-agent` process the orchestrator spawns, and it brings a whole tree
 * with it: a shell wrapper, a node runtime, and whatever tool processes the
 * lead started. None of those are in the host registry, so stopping the team
 * reaches none of them.
 *
 * What survives is not idle. The lead keeps calling the Agent Teams MCP server
 * for a team that no longer exists, and an inherited socket handle keeps the
 * fixed cursor proxy port in LISTEN, so the next cursor-acp launch waits out its
 * readiness probe against a port that answers for a dead team.
 *
 * This sweep reaps whole trees, and it may only reap one it can prove belongs to
 * this app. The proof is the process itself, never a pid this app happens to
 * have written down: the command line has to carry `--print`, which is how the
 * orchestrator spawns a lead and not how a user runs the interactive agent, and
 * a `--workspace` that matches - exactly - a workspace the caller owns. Lineage
 * carries the proof down: only the outermost root is signalled, and the rest of
 * the tree goes with it as its children.
 */

export interface CursorAgentProcessCleanupOptions {
  /**
   * The workspaces the caller can prove are its own. This is the ownership
   * proof, not a convenience filter: an empty list reaps nothing at all, so a
   * caller that cannot name a workspace never widens onto a tree that may be
   * somebody else's lead - or a `cursor-agent --print` a user is running in
   * their own terminal against their own directory.
   */
  ownedWorkspaceCwds: readonly string[];
  /**
   * Only reap trees that started before this timestamp. A cursor-acp readiness
   * execution proof spawns its own `cursor-agent --print` tree and runs for tens
   * of seconds, so an unfenced sweep reaps it mid-probe and blocks the launch
   * before any state-changing bridge command runs. Omitted or `null` means no
   * time fence, which is only correct where the caller already knows every
   * matching tree is theirs.
   */
  startedBeforeMs?: number | null;
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>;
  listProcessRows?: () => Promise<RuntimeProcessTableRow[]>;
  killTree?: (pid: number) => void;
  platform?: NodeJS.Platform;
}

export interface CursorAgentProcessCleanupResult {
  scanned: number;
  killed: number[];
  keptRecent: number[];
  diagnostics: string[];
}

/**
 * Reaping a lead tree reaches a process this app never recorded a pid for, so
 * both callers go through a port rather than importing the sweep: a deployment
 * that would rather never touch an unattributed process hands in a port that
 * reports itself disabled, and the stop then confines itself to what it can
 * name.
 */
export interface CursorAgentTreeSweepPort {
  isEnabled(): boolean;
  sweepCursorAgentTrees(input: {
    ownedWorkspaceCwds: readonly string[];
    startedBeforeMs?: number | null;
  }): Promise<CursorAgentProcessCleanupResult>;
}

export const DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT: CursorAgentTreeSweepPort = {
  isEnabled: () => true,
  sweepCursorAgentTrees: (input) => cleanupCursorAgentProcessTrees(input),
};

// A lead is spawned with `--print`, and the flag is what separates it from the
// interactive `cursor-agent` a user may be running in their own terminal. The
// pattern never matches a bare `cursor` command for the same reason: an editor
// is not an agent.
const CURSOR_AGENT_COMMAND_PATTERN = /cursor-agent/i;
const CURSOR_AGENT_PRINT_FLAG = /--print\b/;

/**
 * Normalizes only what two spellings of the same directory may differ in: a
 * trailing separator, separator direction, and case. It deliberately does not
 * resolve, relativize, or shorten, so comparison stays exact - a prefix match
 * would make a stop of `<workspace>` reap the lead of `<workspace>-backup`.
 */
function normalizeWorkspacePath(value: string): string {
  const separated = value.trim().replace(/\\/g, '/').toLowerCase();
  let end = separated.length;
  while (end > 0 && separated[end - 1] === '/') {
    end -= 1;
  }
  return separated.slice(0, end);
}

/** The same exact comparison the sweep uses, for callers that scope it. */
export function isSameWorkspacePath(left: string, right: string): boolean {
  const normalizedLeft = normalizeWorkspacePath(left);
  return normalizedLeft.length > 0 && normalizedLeft === normalizeWorkspacePath(right);
}

export function extractCursorAgentWorkspace(command: string): string | null {
  const quoted = /--workspace\s+"([^"]+)"/.exec(command);
  if (quoted?.[1]) return quoted[1];
  const bare = /--workspace\s+(\S+)/.exec(command);
  return bare?.[1] ?? null;
}

export function isCursorAgentRootProcess(row: RuntimeProcessTableRow): boolean {
  const command = row.command ?? '';
  return CURSOR_AGENT_COMMAND_PATTERN.test(command) && CURSOR_AGENT_PRINT_FLAG.test(command);
}

export async function cleanupCursorAgentProcessTrees(
  options: CursorAgentProcessCleanupOptions
): Promise<CursorAgentProcessCleanupResult> {
  const result: CursorAgentProcessCleanupResult = {
    scanned: 0,
    killed: [],
    keptRecent: [],
    diagnostics: [],
  };

  const ownedWorkspaces = new Set(
    (options.ownedWorkspaceCwds ?? [])
      .map((entry) => normalizeWorkspacePath(entry ?? ''))
      .filter((entry) => entry.length > 0)
  );
  if (ownedWorkspaces.size === 0) {
    // The proof is missing, so there is nothing this sweep is allowed to do. It
    // does not even read the process table: a sweep with no owner cannot make a
    // decision about a single row of it.
    result.diagnostics.push(
      'cursor-agent sweep skipped: no owned workspace was given, and a tree is only reaped for a workspace this app owns'
    );
    return result;
  }

  const platform = options.platform ?? process.platform;
  const listProcessRows =
    options.listProcessRows ??
    (platform === 'win32'
      ? () => listWindowsProcessTable(4_000, { bypassCache: true })
      : () => listRuntimeProcessTableForCurrentPlatform({ bypassCache: true }));
  const killTree = options.killTree ?? killProcessByPid;
  const readStartTimeMs = createProcessStartTimeCache(
    options.readProcessStartTimeMs ?? ((pid: number) => readProcessStartTimeMs(pid, platform))
  );
  const startedBeforeMs =
    typeof options.startedBeforeMs === 'number' && Number.isFinite(options.startedBeforeMs)
      ? options.startedBeforeMs
      : null;

  let rows: RuntimeProcessTableRow[];
  try {
    rows = await listProcessRows();
  } catch (error) {
    // A process table this app cannot read is not evidence that nothing is
    // running, so the sweep reports and returns rather than guessing.
    result.diagnostics.push(
      `cursor-agent process scan failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return result;
  }
  result.scanned = rows.length;

  const roots = rows.filter(isCursorAgentRootProcess);
  const rootPids = new Set(roots.map((row) => row.pid));
  for (const row of roots) {
    // Only the outermost process of each tree; children are reaped with it, and
    // killing an inner one first would orphan the rest. This is also where the
    // ownership proof reaches the rest of the tree: what is below a root this
    // app can name belongs to that root.
    if (rootPids.has(row.ppid)) continue;
    const workspace = extractCursorAgentWorkspace(row.command ?? '');
    if (!workspace || !ownedWorkspaces.has(normalizeWorkspacePath(workspace))) continue;
    if (startedBeforeMs !== null) {
      const startedAtMs = await readStartTimeMs(row.pid);
      const verified = typeof startedAtMs === 'number' && Number.isFinite(startedAtMs);
      // Unverifiable start time keeps the process. The opposite default reads
      // "cannot prove it is new" as "safe to kill", which is how a live
      // readiness probe gets reaped by the sweep meant to clean up after it.
      if (!verified || startedAtMs >= startedBeforeMs) {
        result.keptRecent.push(row.pid);
        result.diagnostics.push(
          `Kept cursor-agent tree pid=${row.pid}: ${
            verified
              ? 'process started after this app instance began'
              : 'process start time could not be verified'
          }`
        );
        continue;
      }
    }
    try {
      killTree(row.pid);
      result.killed.push(row.pid);
    } catch (error) {
      // One tree that refuses to die is a diagnostic, not the end of the sweep:
      // the remaining trees are exactly the ones still holding the proxy port.
      result.diagnostics.push(
        `cursor-agent tree kill failed pid=${row.pid}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (result.killed.length > 0) {
    logger.diagnostic(
      `[OpenCode] opencode_cursor_agent_trees_reaped count=${result.killed.length} ` +
        `pids=${result.killed.join('/')} workspaces=${[...ownedWorkspaces].join('|')}`
    );
  }
  return result;
}
