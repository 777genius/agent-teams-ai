import { killProcessByPid } from '@main/utils/processKill';
import { type UnixProcessIdentity, tryReadUnixProcessTable } from '@main/utils/unixProcessTable';

/**
 * Ends a process tree this app never spawned, addressed by pid alone.
 *
 * `killProcessByPid` is not this. On Windows it shells out to `taskkill /T`,
 * which does reap the tree; on POSIX it is a bare `process.kill(pid, SIGTERM)`,
 * which reaches exactly one process. A sweep that reaps an external lead to free
 * the port the lead's tree is holding gets nothing from that on macOS or Linux:
 * the socket handle the port is held by was inherited, so it lives in the
 * children too, and they are reparented rather than signalled.
 *
 * `killProcessTreeAndWait` in `childProcess.ts` does walk the tree, but it takes
 * a `ChildProcess` and reads the process-group ownership this app recorded when
 * it spawned it. Neither exists for a process another program started, so the
 * walk is repeated here from the process table alone.
 *
 * Killing by process group is deliberately NOT how this works. `kill(-pgid)` is
 * one syscall instead of a walk, but a pgid is only safe to address when this
 * app is the one that created the group: an external process that never called
 * `setsid` sits in the group of whoever launched it, and on a lead launched from
 * a terminal that group can contain this app's own process. The walk costs one
 * `ps` and cannot make that mistake.
 */

export interface ExternalProcessTreeKillResult {
  /** Signalled in this call, deepest first. Excludes what was already gone. */
  killed: number[];
  /**
   * The tree was not fully reaped: the table could not be read, an identity
   * check refused a pid, or a signal failed. The caller may not report the
   * cleanup as complete - what survives still holds whatever it was reaped for.
   */
  incomplete: boolean;
  diagnostics: string[];
}

export interface ExternalProcessTreeKillOptions {
  signal?: NodeJS.Signals;
  platform?: NodeJS.Platform;
  /** Process table reader. Defaults to the shared `ps` probe. */
  readProcessTable?: () => Map<number, UnixProcessIdentity> | null;
  /** Single-pid terminator. Defaults to the cross-platform helper. */
  killPid?: (pid: number, signal?: NodeJS.Signals) => void;
  /** This app's own pid, so the walk can refuse to reach it. */
  selfPid?: number;
}

/**
 * Every pid in `root`'s tree, deepest first, so a caller signals children before
 * the parent that would otherwise orphan them.
 *
 * The walk refuses to descend into `selfPid`. A tree that contains this app is
 * not a tree this app may reap: it means the root is an ancestor of this
 * process - a shell that launched both - and reaping it takes the app down with
 * it. Refusing is reported, never silent, because the caller's whole reason to
 * be here was that the tree is holding something.
 */
export function collectExternalProcessTreeIdentities(
  processes: Map<number, UnixProcessIdentity>,
  rootPid: number,
  selfPid: number
): { identities: UnixProcessIdentity[] } | { refusal: string } {
  const root = processes.get(rootPid);
  if (!root) {
    return { identities: [] };
  }
  if (rootPid === selfPid) {
    return { refusal: `pid ${rootPid} is this app's own process` };
  }

  const childrenByParent = new Map<number, number[]>();
  for (const identity of processes.values()) {
    const siblings = childrenByParent.get(identity.parentPid);
    if (siblings) {
      siblings.push(identity.pid);
    } else {
      childrenByParent.set(identity.parentPid, [identity.pid]);
    }
  }

  // Breadth-first, recording depth, so the caller can signal the deepest first
  // without a second pass over the tree.
  const ordered: UnixProcessIdentity[] = [root];
  const seen = new Set<number>([rootPid]);
  let frontier = [...(childrenByParent.get(rootPid) ?? [])];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const pid of frontier) {
      if (seen.has(pid)) continue;
      if (pid === selfPid) {
        return { refusal: `tree of pid ${rootPid} contains this app's own process` };
      }
      const identity = processes.get(pid);
      if (!identity) continue;
      seen.add(pid);
      ordered.push(identity);
      next.push(...(childrenByParent.get(pid) ?? []));
    }
    frontier = next;
  }
  return { identities: ordered.reverse() };
}

/**
 * Reaps the tree rooted at `rootPid`.
 *
 * On Windows the walk is skipped: `taskkill /T /F` is given the root and reaps
 * the tree in one call, and reading another process's parentage there costs a
 * PowerShell per probe for an answer the OS already acts on.
 *
 * On POSIX each pid is checked against the identity the table reported before it
 * is signalled. A pid whose start identity moved between the read and the signal
 * was recycled, and the process now holding it is somebody else's.
 */
export function killExternalProcessTree(
  rootPid: number,
  options: ExternalProcessTreeKillOptions = {}
): ExternalProcessTreeKillResult {
  const platform = options.platform ?? process.platform;
  const killPid = options.killPid ?? defaultKillPid;
  const result: ExternalProcessTreeKillResult = { killed: [], incomplete: false, diagnostics: [] };

  if (platform === 'win32') {
    try {
      killPid(rootPid, options.signal);
      result.killed.push(rootPid);
    } catch (error) {
      result.incomplete = true;
      result.diagnostics.push(`tree kill failed pid=${rootPid}: ${describeError(error)}`);
    }
    return result;
  }

  const selfPid = options.selfPid ?? process.pid;
  const readProcessTable = options.readProcessTable ?? tryReadUnixProcessTable;
  const processes = readProcessTable();
  if (!processes) {
    // No table means no tree, and a bare root kill here would be the very
    // single-process signal this module exists to replace.
    result.incomplete = true;
    result.diagnostics.push(
      `tree kill skipped pid=${rootPid}: the process table could not be read, so descendants are unknown`
    );
    return result;
  }

  const collected = collectExternalProcessTreeIdentities(processes, rootPid, selfPid);
  if ('refusal' in collected) {
    result.incomplete = true;
    result.diagnostics.push(`tree kill refused: ${collected.refusal}`);
    return result;
  }

  for (const identity of collected.identities) {
    // Re-read rather than consult the snapshot the tree was collected from.
    // Checking a record against itself is not a check: the pid was captured and
    // compared in the same instant, so a recycle happening between the scan and
    // this signal - the only recycle that matters here - would pass every time.
    // This is the same per-pid re-read `killProcessTreeAndWait` does for the
    // trees this app spawned, and it costs one `ps` per pid on a sweep that
    // runs at most twice in a session.
    const currentTable = readProcessTable();
    if (!currentTable) {
      // A table that cannot be re-read is not a confirmation. Falling back to
      // the scan snapshot would compare the identity against itself, which is
      // not a check at all: a pid recycled since the scan would pass it and take
      // the signal meant for its predecessor.
      result.incomplete = true;
      result.diagnostics.push(
        `tree kill skipped pid=${identity.pid}: process identity could not be re-checked`
      );
      continue;
    }
    const current = currentTable.get(identity.pid);
    if (!current) {
      // Gone between the scan and the signal, which is the outcome this call
      // wanted. Not a failure, and nothing left to signal.
      continue;
    }
    if (current.startIdentity !== identity.startIdentity) {
      result.incomplete = true;
      result.diagnostics.push(
        `tree kill skipped pid=${identity.pid}: process identity changed before the signal`
      );
      continue;
    }
    try {
      killPid(identity.pid, options.signal);
      result.killed.push(identity.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        // Already gone, which is the outcome this call wanted.
        continue;
      }
      result.incomplete = true;
      result.diagnostics.push(`tree kill failed pid=${identity.pid}: ${describeError(error)}`);
    }
  }
  return result;
}

/**
 * The root kill on Windows goes through `killProcessByPid`, which is
 * `taskkill /T /F` there and reaps the tree by itself. On POSIX the signal is
 * sent directly, because this module has already decided which pid it is
 * addressing and `killProcessByPid` would only re-derive the same call.
 */
function defaultKillPid(pid: number, signal?: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    killProcessByPid(pid);
    return;
  }
  process.kill(pid, signal ?? 'SIGTERM');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
