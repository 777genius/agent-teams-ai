import type { CursorAgentAttributionRecord } from './CursorAgentAttributionRecords';
import type { RuntimeProcessTableRow } from '@features/tmux-installer/main';

/**
 * Whether the runtime that spawned a `cursor-agent` tree recorded THIS root as
 * one of its own.
 *
 * The sweep beside this file can observe one thing about a tree by itself: a
 * JOINED command line, whose argument boundaries are gone. A record is the other
 * half - written by the spawned process, before its entry module loads, so the
 * pid, the start time and the `--workspace` argument are the ones the process
 * received. That is the ownership proof Windows and macOS have never had, since
 * neither exposes a process environment at all.
 *
 * It lives in its own file because it is the only part of the decision that is
 * evidence rather than a reading, and because the sweep answers what is owned
 * while this answers who started it: the caller hands in the workspace
 * comparison and the start-time reader it is already using, so nothing here
 * reaches back into the sweep.
 */

/**
 * The floor under a record's own tolerance, because the app reads a live start
 * time through `ps -o lstart=` off Windows and that answer is whole SECONDS. A
 * process the runtime recorded at `X.123` therefore reads back as `X.000` here,
 * up to a second below what the record says, and a tolerance narrower than that
 * would reject every POSIX record.
 */
const ATTRIBUTION_START_TIME_TOLERANCE_FLOOR_MS = 2_000;

/**
 * And the ceiling over it, because the tolerance arrives inside the record.
 *
 * The record is a file, and the fence it widens is the one that polices the pid
 * that same file names: a record declaring a tolerance of a thousand years would
 * make the start-time comparison answer yes for whatever process holds that pid
 * now, which is precisely the recycled-pid mistake the comparison exists to
 * prevent. The runtime clamps what it writes to this same bound; this clamps
 * again on the reading side, because a reader that cannot import the writer's
 * constant must not depend on the writer having applied it either.
 */
const ATTRIBUTION_START_TIME_TOLERANCE_CEILING_MS = 10_000;

export type CursorAgentAttributionVerdict =
  | { outcome: 'proven'; record: CursorAgentAttributionRecord }
  | { outcome: 'declined'; reason: string }
  | { outcome: 'unproven' };

export const UNPROVEN_BY_ATTRIBUTION: CursorAgentAttributionVerdict = { outcome: 'unproven' };

/**
 * How a record reaches the ROOT of the tree it was written in.
 *
 * Off Windows the generated shim `exec`s, so the recorded process is the root
 * itself. On Windows the shim is a `cmd.exe` / PowerShell hop that stays alive
 * as the parent, so the record - written by the agent - names the root as its
 * parent. That hop is only accepted when the same snapshot agrees: a record
 * whose pid is not standing in the table as a child of this row is a leftover,
 * not a hop.
 */
function matchAttributionRecordToRoot(
  record: CursorAgentAttributionRecord,
  row: RuntimeProcessTableRow,
  rowsByPid: ReadonlyMap<number, RuntimeProcessTableRow>
): 'self' | 'parent' | null {
  if (record.pid === row.pid) return 'self';
  if (record.parentPid !== row.pid) return null;
  return rowsByPid.get(record.pid)?.ppid === row.pid ? 'parent' : null;
}

/**
 * Whether the runtime recorded this root as an agent it started for a workspace
 * the caller owns.
 *
 * The record supplies identity; every check here is made against the LIVE
 * process, because a record outlives the process it was written for. A pid the
 * record names is only that process while its start time still matches, and the
 * comparison is against the app's own start-time reader rather than against
 * anything the record could assert about liveness.
 *
 * The workspace is the record's exact `--workspace` argument, compared exactly.
 * That is the whole point of the record: `/work/app - backup` is a directory
 * name no parse of a joined command line can tell from `/work/app` plus
 * arguments, and here it is simply a string the spawned process wrote down.
 */
export async function proveCursorAgentRootFromAttributionRecords(input: {
  row: RuntimeProcessTableRow;
  rowsByPid: ReadonlyMap<number, RuntimeProcessTableRow>;
  records: readonly CursorAgentAttributionRecord[];
  /** The caller's own exact workspace comparison, over the workspaces it owns. */
  ownsWorkspacePath: (workspacePath: string) => boolean;
  readStartTimeMs: (pid: number) => Promise<number | null>;
}): Promise<CursorAgentAttributionVerdict> {
  for (const record of input.records) {
    // A writer that recorded an exit is describing history. `exitedAtMs` is set
    // only where the unlink at exit failed, so the process this record was
    // written for has already gone and the pid in it belongs to whoever holds it
    // now. A record like that is not weaker identity - it is the writer stating
    // it is no longer identity at all.
    if (record.exitedAtMs !== null) continue;
    const hop = matchAttributionRecordToRoot(record, input.row, input.rowsByPid);
    if (hop === null) continue;
    const toleranceMs = Math.min(
      Math.max(record.startTimeToleranceMs ?? 0, ATTRIBUTION_START_TIME_TOLERANCE_FLOOR_MS),
      ATTRIBUTION_START_TIME_TOLERANCE_CEILING_MS
    );
    const liveStartedAtMs = await input.readStartTimeMs(record.pid);
    // An unreadable start time is "unproven", never "proven": the pid may have
    // been recycled since the record was written, and a recycled pid is the one
    // mistake this check exists to prevent.
    if (liveStartedAtMs === null || Math.abs(liveStartedAtMs - record.startedAtMs) > toleranceMs) {
      continue;
    }
    if (hop === 'parent') {
      // A parent cannot be younger than its own child. When it reads as younger,
      // this row is a new process holding a recycled pid that the record's
      // agent happens to name.
      const rootStartedAtMs = await input.readStartTimeMs(input.row.pid);
      if (rootStartedAtMs === null || rootStartedAtMs > record.startedAtMs + toleranceMs) continue;
    }
    if (record.kind === 'readiness-probe') {
      // The one `cursor-agent` the runtime spawns for itself. The sweep has
      // always documented it as a tree it must never reap; with a record that
      // stops being a comment and becomes a decline this loop can state.
      return {
        outcome: 'declined',
        reason: `the runtime records pid=${record.pid} as its own readiness probe`,
      };
    }
    const workspacePath = record.workspacePath ?? record.cwd;
    if (workspacePath === null) continue;
    if (!input.ownsWorkspacePath(workspacePath)) continue;
    return { outcome: 'proven', record };
  }
  return UNPROVEN_BY_ATTRIBUTION;
}
