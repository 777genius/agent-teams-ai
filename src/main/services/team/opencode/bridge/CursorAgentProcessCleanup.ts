import {
  listRuntimeProcessTableForCurrentPlatform,
  type RuntimeProcessTableRow,
} from '@features/tmux-installer/main';
import {
  type ExternalProcessTreeKillResult,
  killExternalProcessTree,
} from '@main/utils/externalProcessTreeKill';
import { createProcessStartTimeCache, readProcessStartTimeMs } from '@main/utils/processStartTime';
import { listWindowsProcessTable } from '@main/utils/windowsProcessTable';
import { createLogger } from '@shared/utils/logger';

import { readNativeProcessCommandWithEnv } from './OpenCodeManagedHostProcessCleanup';

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
 * carries the proof down: what stands below a root this app can name belongs to
 * that root, so the whole tree is reaped with it.
 *
 * Reaping it is a walk, not one signal. `killExternalProcessTree` reads the
 * process table, orders the tree deepest-first and signals each pid in turn,
 * because on macOS and Linux a signal to the root reaches the root and nothing
 * else - and the port this sweep exists to free is held by an INHERITED socket
 * handle, which means the children hold it too. Signalling only the root leaves
 * the port in LISTEN and the sweep reporting success.
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
  /**
   * Env markers that prove the tree descends from something this app launched.
   *
   * A `--workspace` match says the tree works where a team of this app works. It
   * does NOT say the tree is this app's: a user running `cursor-agent --print`
   * in their own project, or a second copy of this app with a live team in the
   * same directory, produces a command line that is identical in every byte the
   * sweep can see. The environment is what tells them apart, because a lead this
   * app is responsible for inherits the orchestrator's env from the serve host
   * that spawned it.
   *
   * POSIX only. Windows does not let one process read another's environment. A
   * caller that also sets `requireOwnershipProof` therefore cannot be satisfied
   * there, and the sweep refuses outright rather than quietly falling back to
   * the command line - falling back would grant exactly the weaker fence the
   * caller was refusing to rely on.
   */
  requiredEnvMarkers?: readonly string[];
  /**
   * Refuse to reap when ownership could not be proven, instead of falling back
   * to the command line. A startup sweep wants this: it runs while another copy
   * of this app may be mid-run, and a tree it cannot attribute may be that
   * copy's live lead.
   */
  requireOwnershipProof?: boolean;
  /**
   * Only reap a tree whose parent is gone. This is what keeps a startup sweep
   * off a LIVE tree: a lead of a running app instance still has its serve host
   * as a parent, while a lead left behind by a crashed instance has been
   * reparented to init. It is wrong for a stop sweep, where the team's own host
   * may still be shutting down alongside the lead it owns.
   */
  orphanedOnly?: boolean;
  readProcessDetails?: (pid: number) => Promise<string | null>;
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>;
  listProcessRows?: () => Promise<RuntimeProcessTableRow[]>;
  /**
   * Reaps one whole tree. It reports rather than throws, because a tree that
   * could only be partly reaped is neither a success nor an exception: the
   * sweep has to record it and go on to the trees behind it.
   */
  killTree?: (pid: number) => ExternalProcessTreeKillResult;
  platform?: NodeJS.Platform;
}

export interface CursorAgentProcessCleanupResult {
  scanned: number;
  killed: number[];
  keptRecent: number[];
  /**
   * A tree this sweep decided to reap is still standing. `keptRecent` is not
   * this: those are kept on purpose by the time fence. This is the sweep
   * failing to finish, and a caller that reports a cleanup as complete has to
   * know the difference - the tree still holds the workspace it was reaped for.
   */
  incomplete: boolean;
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
    requiredEnvMarkers?: readonly string[];
    requireOwnershipProof?: boolean;
    orphanedOnly?: boolean;
  }): Promise<CursorAgentProcessCleanupResult>;
}

/**
 * The env var this app's orchestrator sets on every OpenCode serve host it
 * starts. A `cursor-agent` lead is spawned BY that host and inherits it, so its
 * presence is what separates a lead this app is responsible for from an
 * identical-looking one a user started in the same directory.
 *
 * The value is deliberately not matched. A tree left behind by a previous app
 * instance carries that instance's id, and reaping it is the entire point of the
 * startup sweep; requiring the current id would keep exactly the trees the sweep
 * exists to clear.
 */
export const CURSOR_AGENT_APP_OWNERSHIP_ENV_MARKER = 'CLAUDE_TEAM_APP_INSTANCE_ID=';

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
 * trailing separator, separator direction, and - where the filesystem ignores
 * it - case. It deliberately does not resolve, relativize, or shorten, so
 * comparison stays exact - a prefix match would make a stop of `<workspace>`
 * reap the lead of `<workspace>-backup`.
 *
 * Separator direction and case are both Windows properties, and neither is
 * folded anywhere else. Off Windows a backslash is an ordinary filename
 * character, so `/work/a\b` is one directory and `/work/a/b` is another;
 * rewriting the first into the second lets a stop that owns `/work/a/b` reap
 * the lead tree standing in `/work/a\b`. Case is the same argument:
 * `/work/Team` and `/work/team` are two directories with two different teams in
 * them, and folding them together lets a stop of one reap the whole lead tree of
 * the other. Not folding costs the opposite mistake on a case-insensitive POSIX
 * volume: two spellings of one directory stop matching and a tree this app owns
 * is kept. For a sweep that kills whole trees, that is the direction to be wrong
 * in.
 */
function normalizeWorkspacePath(value: string, platform: NodeJS.Platform): string {
  const trimmed = value.trim();
  const separated = platform === 'win32' ? trimmed.replace(/\\/g, '/') : trimmed;
  const cased = platform === 'win32' ? separated.toLowerCase() : separated;
  let end = cased.length;
  while (end > 0 && cased[end - 1] === '/') {
    end -= 1;
  }
  return cased.slice(0, end);
}

/**
 * Whether two workspaces could produce the same command line once `ps` has
 * joined the argument vector.
 *
 * `left` is confusable with `right` when one is the other followed by a space:
 * `/work/app - backup` renders as `--workspace /work/app - backup`, which is
 * indistinguishable from `--workspace /work/app` plus arguments. The same holds
 * the other way round, so the test is symmetric.
 *
 * Callers use this to decline rather than to match. It is the only honest answer
 * available from a joined argv - the boundaries are gone, and no parsing rule
 * puts them back.
 */
export function isConfusableWorkspacePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const a = normalizeWorkspacePath(left, platform);
  const b = normalizeWorkspacePath(right, platform);
  if (a.length === 0 || b.length === 0 || a === b) return false;
  return a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

/** The same exact comparison the sweep uses, for callers that scope it. */
export function isSameWorkspacePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalizedLeft = normalizeWorkspacePath(left, platform);
  return normalizedLeft.length > 0 && normalizedLeft === normalizeWorkspacePath(right, platform);
}

/**
 * The `--workspace` value from a command line, in the spellings a process table
 * actually renders it in.
 *
 * The unquoted form is the hard one. `ps` prints the argument vector joined by
 * spaces and re-quotes nothing, so a real directory like
 * `/Users/me/My Projects/app` arrives as bare text with spaces in it, and a
 * `(\S+)` capture stops at `/Users/me/My`. That truncated value matches no owned
 * workspace, so the tree is silently never reaped - the fence looks like it is
 * working while the feature does nothing for every user whose project path
 * contains a space.
 *
 * The value therefore runs to the next argument rather than to the next space:
 * arguments start with `-`, so the capture ends at ` -` or at end of line. A
 * directory whose name genuinely contains ` -` is the residual ambiguity, and it
 * resolves toward the shorter path - which fails to match and keeps the tree,
 * the safe direction for a sweep that kills whole trees.
 */
/**
 * Whether this command line names `ownedWorkspace` as its `--workspace`.
 *
 * Asked this way round on purpose. `ps` joins the argument vector with spaces
 * and re-quotes nothing, so an unquoted path with spaces in it cannot be parsed
 * back unambiguously - there is no way to tell where the value ends and the next
 * argument begins. Extracting a value and comparing it is therefore a guess, and
 * guessing here reaps process trees: an earlier attempt stopped the capture at
 * the first ` -`, which turned `/work/My Team - backup` into `/work/My Team` and
 * made a stop of one directory match the lead of a different one.
 *
 * Starting from a workspace the caller can prove it owns removes the guess. The
 * remainder after the match has to be either nothing, or the start of a long
 * flag (` --`). A path that continues into ` - backup` leaves a remainder that
 * is neither, so it does not match, and the tree is kept. That is the direction
 * to be wrong in for a sweep that kills whole trees.
 */
export function commandNamesOwnedWorkspace(
  command: string,
  ownedWorkspace: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalizedOwned = normalizeWorkspacePath(ownedWorkspace, platform);
  if (normalizedOwned.length === 0) return false;

  // A quoted value is unambiguous; compare it exactly.
  const quoted =
    /--workspace[\s=]+"([^"]+)"/.exec(command)?.[1] ??
    /--workspace[\s=]+'([^']+)'/.exec(command)?.[1];
  if (quoted !== undefined) {
    return normalizeWorkspacePath(quoted, platform) === normalizedOwned;
  }

  const bare = /--workspace[\s=]+(.+)$/.exec(command)?.[1];
  if (bare === undefined) return false;
  const value = bare.trim();

  // An owned path with no spaces in it ends at the first space. The token has to
  // match, AND what follows has to look like the next argument rather than the
  // rest of a longer directory name - otherwise an owned `/Users/u/My` would
  // claim a process actually running in `/Users/u/My Projects/app`.
  if (!normalizedOwned.includes(' ')) {
    const firstSpace = value.indexOf(' ');
    const firstToken = firstSpace === -1 ? value : value.slice(0, firstSpace);
    if (normalizeWorkspacePath(firstToken, platform) !== normalizedOwned) return false;
    // A single leading dash is not enough: `/work/app - backup` is a perfectly
    // ordinary directory name, and accepting it lets a stop of `/work/app` reap
    // the tree of a live team working in that other directory. A long flag is
    // the narrowest thing that still admits the normal case.
    return firstSpace === -1 || value.slice(firstSpace).trimStart().startsWith('--');
  }

  // An owned path that DOES contain spaces is only recognisable when the value
  // is the whole remainder of the command line - i.e. `--workspace` was the last
  // argument.
  //
  // No heuristic is used to find where such a path ends, and this is deliberate.
  // An earlier attempt treated ` --` as the start of the next flag, which reads
  // `/work/My Team -- backup` as `/work/My Team` and matches a directory the
  // caller does not own; `/work/My Team --model backup` collides the same way. A
  // joined argv is genuinely ambiguous, and every rule that resolves it also
  // resolves some real directory name wrongly.
  //
  // The cost is that a spaced workspace followed by more arguments is never
  // matched, so its tree is kept. For a sweep that kills whole trees, a missed
  // reap is the acceptable failure and a wrong reap is not.
  return normalizeWorkspacePath(value, platform) === normalizedOwned;
}

/**
 * Whether the launcher of a tree is still running.
 *
 * pid 1 is never a launcher: a process reparented to init has lost the one that
 * started it, which is exactly the orphan this fence looks for. A ppid missing
 * from the scan is the same answer - the parent was not in the table.
 */
function isParentAlive(ppid: number, livePids: ReadonlySet<number>): boolean {
  return ppid > 1 && livePids.has(ppid);
}

function stringIncludesAnyMarker(value: string, markers: readonly string[]): boolean {
  return markers.some((marker) => value.includes(marker));
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
    incomplete: false,
    diagnostics: [],
  };

  const platform = options.platform ?? process.platform;
  const ownedWorkspaces = new Set(
    (options.ownedWorkspaceCwds ?? [])
      .map((entry) => normalizeWorkspacePath(entry ?? '', platform))
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

  const listProcessRows =
    options.listProcessRows ??
    (platform === 'win32'
      ? () => listWindowsProcessTable(4_000, { bypassCache: true })
      : () => listRuntimeProcessTableForCurrentPlatform({ bypassCache: true }));
  const killTree =
    options.killTree ?? ((pid: number) => killExternalProcessTree(pid, { platform }));
  // Windows cannot read another process's environment at all, so an env fence
  // there is not a weaker check - it is no check.
  const requestedEnvMarkers = options.requiredEnvMarkers ?? [];
  const requiredEnvMarkers = platform === 'win32' ? [] : requestedEnvMarkers;
  const requireOwnershipProof = options.requireOwnershipProof === true;
  if (platform === 'win32' && requireOwnershipProof && requestedEnvMarkers.length > 0) {
    // The caller asked to reap only what it can prove it owns, and on this
    // platform the proof it named is unobtainable. Dropping the marker list and
    // continuing would silently downgrade that to "reap on the command line
    // alone" - the exact fence the caller was trying not to rely on. A sweep
    // that cannot meet its own precondition does nothing and says so.
    result.diagnostics.push(
      'cursor-agent sweep skipped: ownership proof was required, and a process environment ' +
        'cannot be read on Windows'
    );
    return result;
  }
  const orphanedOnly = options.orphanedOnly === true;
  const readProcessDetails = options.readProcessDetails ?? readNativeProcessCommandWithEnv;
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
    // running, so the sweep reports and returns rather than guessing - and
    // says it did not finish, because every tree it would have reaped is
    // still standing behind a scan that never happened.
    result.incomplete = true;
    result.diagnostics.push(
      `cursor-agent process scan failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return result;
  }
  result.scanned = rows.length;

  const roots = rows.filter(isCursorAgentRootProcess);
  const rootPids = new Set(roots.map((row) => row.pid));
  // Liveness is read off the same table snapshot the roots came from. Probing
  // each parent separately would ask about a moment after the scan, and a
  // parent that exits between the two reads would flip a live tree into an
  // orphan - which is the one direction this fence must never be wrong in.
  const livePids = new Set(rows.map((row) => row.pid));
  for (const row of roots) {
    // Only the outermost process of each tree; children are reaped with it, and
    // killing an inner one first would orphan the rest. This is also where the
    // ownership proof reaches the rest of the tree: what is below a root this
    // app can name belongs to that root.
    if (rootPids.has(row.ppid)) continue;
    // Asked per owned workspace rather than by parsing the command's value:
    // an unquoted path with spaces cannot be split back unambiguously, and
    // guessing where it ends is how a stop of one directory reached the lead of
    // another.
    const command = row.command ?? '';
    if (![...ownedWorkspaces].some((owned) => commandNamesOwnedWorkspace(command, owned, platform)))
      continue;
    if (orphanedOnly && isParentAlive(row.ppid, livePids)) {
      result.keptRecent.push(row.pid);
      result.diagnostics.push(
        `Kept cursor-agent tree pid=${row.pid}: its parent (pid=${row.ppid}) is still running, ` +
          'so the tree belongs to a live launcher rather than to a crashed one'
      );
      continue;
    }
    if (requiredEnvMarkers.length > 0) {
      const details = await readProcessDetails(row.pid);
      const proven = details !== null && stringIncludesAnyMarker(details, requiredEnvMarkers);
      if (!proven) {
        // Unreadable env is not proof of a foreign process, but it is also not
        // proof of an owned one, and this sweep kills whole trees. Which way
        // that lands is the caller's call, not this loop's.
        if (requireOwnershipProof) {
          result.keptRecent.push(row.pid);
          result.diagnostics.push(
            `Kept cursor-agent tree pid=${row.pid}: ${
              details === null
                ? 'process environment could not be read, so ownership is unproven'
                : 'process environment carries no marker of this app'
            }`
          );
          continue;
        }
        result.diagnostics.push(
          `cursor-agent tree pid=${row.pid}: ownership marker unavailable, falling back to the ` +
            'command line and the time fence'
        );
      }
    }
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
    // The reap follows that check in the same turn: nothing is awaited between
    // them, and no other candidate is probed or signalled in between, so the
    // identity being reaped is the one just validated. A pid recycled before the
    // check reads as newer than the fence and is kept; what is left is the
    // probe's own round trip, and a second probe would only reproduce that same
    // gap rather than close it. Closing it needs a kernel handle taken while the
    // identity holds - OpenProcess/TerminateProcess, pidfd_send_signal - and
    // this runtime exposes neither. Inside the tree the walk re-checks each
    // descendant's identity against the table it just read, so a pid recycled
    // deeper down is skipped rather than signalled.
    try {
      const reaped = killTree(row.pid);
      // The root counts as killed only if the walk actually reached it. A tree
      // that refused - it contains this app, or the table could not be read -
      // reports nothing killed, and saying otherwise would let the caller
      // report a cleanup that never happened.
      if (reaped.killed.length > 0) {
        result.killed.push(row.pid);
      }
      if (reaped.incomplete) {
        // One tree that refuses to die is a diagnostic, not the end of the
        // sweep: the remaining trees are exactly the ones still holding the
        // proxy port. It is still a cleanup that did not complete, and it says
        // so.
        result.incomplete = true;
      }
      result.diagnostics.push(
        ...reaped.diagnostics.map((entry) => `cursor-agent ${entry} (root pid=${row.pid})`)
      );
    } catch (error) {
      result.incomplete = true;
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
