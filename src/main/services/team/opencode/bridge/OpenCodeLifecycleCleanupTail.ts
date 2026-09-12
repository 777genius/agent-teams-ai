import { listTeamProjectWorkspaces } from '@main/services/team/TeamProjectWorkspaces';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import {
  type CursorAgentAtomicReapPort,
  DEFAULT_CURSOR_AGENT_ATOMIC_REAP_PORT,
} from './CursorAgentAtomicReapBridge';
import {
  type CursorAgentAttributionPort,
  type CursorAgentAttributionRecord,
  DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT,
  summarizeAttributedCursorAgentProcesses,
} from './CursorAgentAttributionRecords';
import {
  purgeStaleOpenCodeHostStartupLocks,
  resolveStartupStaleLockMinAgeMs,
} from './OpenCodeHostStartupLockCleanup';
import { cleanupManagedOpenCodeServeProcesses } from './OpenCodeManagedHostProcessCleanup';
import { buildOpenCodeAppScopedMcpOwnershipMarker } from './OpenCodeMcpBridgeEnv';
import { runOpenCodeStartupRuntimeSweepTail } from './OpenCodeStartupRuntimeSweep';

import type { CursorAgentTreeSweepPort } from './CursorAgentProcessCleanup';

/**
 * Everything the app does about OpenCode hosts after the host registry has
 * answered, for both lifecycle reasons: the process-level fallback sweep the
 * registry cannot reach, and the startup-only tail behind it.
 *
 * It sits beside the sweeps it drives rather than in the entry point because
 * this is the destructive half of the lifecycle, and the entry point is the one
 * module in `main` a test cannot import without an Electron runtime. What stays
 * in the entry point is what only the entry point knows: the app instance
 * identity, its start time, and which sink a message reaches.
 */

export interface OpenCodeLifecycleCleanupTailPorts {
  /**
   * Durable, not a warning: this is the app's most destructive lifecycle
   * action, and the count has to still be readable when someone asks why a
   * host they expected is gone. `info` never reaches a sink at all.
   */
  logSweepResult(message: string): void;
  logWarning(message: string): void;
  /** A cleanup step that could not run at all is a caught failure, not a warning. */
  logError(message: string): void;
}

export interface OpenCodeLifecycleCleanupTailInput {
  reason: 'startup' | 'shutdown';
  canAdmitStartupWork?: () => boolean;
  /** Registry hosts the sweep decided to keep; a startup fallback spares them. */
  registryHostPids: ReadonlySet<number>;
  /** False when the registry sweep itself failed, which voids its keep list. */
  registryCleanupAvailable: boolean;
  appStartedAtMs: number;
  /** The instant the registry sweep command settled; the fence for the reap. */
  sweepCommandSettledAtMs: number;
  managedHostInstanceId: string;
  /** Persistent application profile ownership retained across restarts. */
  profileScope?: string;
  /** @deprecated Ignored; only the runtime may reap cursor-agent trees. */
  cursorAgentTreeSweep?: CursorAgentTreeSweepPort;
  cursorAgentAtomicReap?: CursorAgentAtomicReapPort;
  /** Diagnostic snapshot and no-record optimization; never cleanup authority. */
  cursorAgentAttribution?: CursorAgentAttributionPort;
  /**
   * The workspaces this app has teams for. It is the ownership proof the
   * startup lead-tree reap runs on, so it defaults to the teams on disk rather
   * than to "everything": a tree whose workspace this app cannot name is a tree
   * it has no claim to.
   */
  listOwnedLeadWorkspaces?: () => Promise<readonly string[]>;
  /**
   * Shutdown only, and optional in the same sense the force-stop flow's port is:
   * a deployment whose members share a runtime this app can ask to stand down
   * hands one in, and everywhere else its absence means the step does not
   * exist. It never rejects; a runtime that cannot be reached is its own
   * business to report.
   */
  releaseSharedRuntime?: () => Promise<void>;
  ports: OpenCodeLifecycleCleanupTailPorts;
}

/**
 * The markers that prove a serve host belongs to this app instance, in the only
 * spelling each platform can read back from a running process. Both destructive
 * sweeps below carry them, so neither can reach a host of another install or
 * one a user started themselves.
 */
export function buildOpenCodeProcessOwnershipMarkers(
  managedHostInstanceId: string
): Pick<
  Parameters<typeof cleanupManagedOpenCodeServeProcesses>[0],
  'requiredDetailsMarkers' | 'requiredServeConfigMarkersAny'
> {
  return process.platform === 'win32'
    ? {
        requiredServeConfigMarkersAny: [
          buildOpenCodeAppScopedMcpOwnershipMarker(managedHostInstanceId),
        ],
      }
    : { requiredDetailsMarkers: [`CLAUDE_TEAM_APP_INSTANCE_ID=${managedHostInstanceId}`] };
}

export async function cleanupOpenCodeHostProcessFallback(
  label: string,
  options: Parameters<typeof cleanupManagedOpenCodeServeProcesses>[0],
  ports: OpenCodeLifecycleCleanupTailPorts
): Promise<void> {
  const fallback = await cleanupManagedOpenCodeServeProcesses(options);
  if (fallback.killed > 0) {
    ports.logSweepResult(
      `[OpenCode] opencode_managed_hosts_killed sweep=${label} count=${fallback.killed}`
    );
  }
  for (const diagnostic of fallback.diagnostics) {
    ports.logWarning(`[OpenCode] ${label} cleanup: ${diagnostic}`);
  }
}

export async function runOpenCodeLifecycleCleanupTail(
  input: OpenCodeLifecycleCleanupTailInput
): Promise<void> {
  const { reason, ports } = input;

  // The keep list is the only thing that spares a live registry host from the
  // startup fallback, so a registry sweep that failed disqualifies the fallback
  // - and nothing else. The steps behind it do not consult that list: the lock
  // purge is fenced by file age and the cursor-agent sweep by the workspaces
  // this app owns. Skipping those too left the next launch queued behind
  // exactly the stale locks this tail exists to clear.
  if (reason === 'startup' && !input.registryCleanupAvailable) {
    ports.logWarning(
      '[OpenCode] Startup fallback cleanup skipped because host registry cleanup is unavailable'
    );
  } else {
    await runIndependentStep(`${reason} fallback`, ports, () =>
      cleanupOpenCodeHostProcessFallback(
        `${reason} fallback`,
        {
          mode: reason === 'shutdown' ? 'force' : 'orphaned',
          excludePids: reason === 'startup' ? input.registryHostPids : undefined,
          ...(reason === 'shutdown'
            ? buildOpenCodeProcessOwnershipMarkers(input.managedHostInstanceId)
            : { requiredProfileScope: input.profileScope }),
          startedBeforeMs: reason === 'startup' ? input.appStartedAtMs : null,
        },
        ports
      )
    );
  }

  if (reason === 'shutdown' && input.releaseSharedRuntime) {
    // After the hosts are dead, not before: while one is still up it is a
    // process of this app that may yet send the runtime a request.
    await runIndependentStep('shutdown shared runtime release', ports, input.releaseSharedRuntime);
  }

  if (reason === 'startup') {
    // Never rejects on its own account, and is run through the same guard as
    // the rest so that stays a property of this sequence rather than of one
    // module's internals.
    await runIndependentStep('startup runtime sweep', ports, () =>
      runOpenCodeStartupRuntimeSweepTail({
        sweepCommandSettledAtMs: input.sweepCommandSettledAtMs,
        ownershipMarkers: buildOpenCodeProcessOwnershipMarkers(input.managedHostInstanceId),
        logSweepResult: (message) => ports.logSweepResult(`[OpenCode] ${message}`),
        logWarning: (message) => ports.logWarning(message),
        logError: (message) => ports.logError(message),
      })
    );
    await runOpenCodeStartupCleanupMaintenance(input);
  }
}

/** Non-host maintenance shared by both startup paths. */
export async function runOpenCodeStartupCleanupMaintenance(
  input: Pick<
    OpenCodeLifecycleCleanupTailInput,
    | 'ports'
    | 'appStartedAtMs'
    | 'cursorAgentTreeSweep'
    | 'cursorAgentAtomicReap'
    | 'cursorAgentAttribution'
    | 'listOwnedLeadWorkspaces'
    | 'canAdmitStartupWork'
  >
): Promise<void> {
  const { ports } = input;
  if (input.canAdmitStartupWork?.() === false) return;
  await runIndependentStep('startup lock purge', ports, async () => {
    const lockPurge = await purgeStaleOpenCodeHostStartupLocks({
      minAgeMs: resolveStartupStaleLockMinAgeMs(),
      canRemove: input.canAdmitStartupWork,
    });
    if (lockPurge.removed > 0) {
      ports.logSweepResult(
        `opencode_startup_locks_purged phase=startup removed=${lockPurge.removed} kept=${lockPurge.kept} dir=${lockPurge.locksDir}`
      );
    }
    for (const diagnostic of lockPurge.diagnostics) {
      ports.logWarning(`[OpenCode] startup lock purge: ${diagnostic}`);
    }
  });
  if (input.canAdmitStartupWork?.() === false) return;
  await runIndependentStep('startup cursor-agent sweep', ports, () =>
    reapOrphanedCursorAgentLeadTrees(input)
  );
}

/**
 * Every step of this tail is best effort, and none of them is a precondition of
 * the next: the process table a sweep reads can refuse to answer, and a
 * rejection that leaves this function takes the steps behind it with it. The
 * stale-lock purge is the one that matters most, because the locks a failed
 * reap could not clear are exactly what the next launch queues behind - which
 * is the same failure the startup runtime sweep already guards internally, one
 * step earlier in the sequence.
 */
async function runIndependentStep(
  label: string,
  ports: OpenCodeLifecycleCleanupTailPorts,
  step: () => Promise<void>
): Promise<void> {
  try {
    await step();
  } catch (error) {
    ports.logWarning(
      `[OpenCode] ${label} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Runtime leases and process identity are checked atomically by the runtime. */
async function reapOrphanedCursorAgentLeadTrees(
  input: Pick<
    OpenCodeLifecycleCleanupTailInput,
    | 'ports'
    | 'appStartedAtMs'
    | 'cursorAgentTreeSweep'
    | 'cursorAgentAtomicReap'
    | 'cursorAgentAttribution'
    | 'listOwnedLeadWorkspaces'
    | 'canAdmitStartupWork'
  >
): Promise<void> {
  if (input.canAdmitStartupWork?.() === false) return;
  const records = await reportAttributedCursorAgentProcesses(input);
  if (input.canAdmitStartupWork?.() === false) return;
  if (!records.some((record) => record.kind === 'cursor-agent')) {
    input.ports.logSweepResult(
      'opencode_cursor_agent_trees_reaped sweep=startup count=0 skipped=no_attribution_record'
    );
    return;
  }
  const listOwnedLeadWorkspaces =
    input.listOwnedLeadWorkspaces ?? (() => listTeamProjectWorkspaces(getTeamsBasePath()));
  const ownedWorkspaceCwds = await listOwnedLeadWorkspaces();
  if (input.canAdmitStartupWork?.() === false) return;
  if (ownedWorkspaceCwds.length === 0) {
    input.ports.logSweepResult(
      'opencode_cursor_agent_trees_reaped sweep=startup count=0 skipped=no_owned_workspace'
    );
    return;
  }
  const result = await (
    input.cursorAgentAtomicReap ?? DEFAULT_CURSOR_AGENT_ATOMIC_REAP_PORT
  ).reapUnleasedCursorAgentTrees({
    contractVersion: 1,
    reason: 'startup',
    ownedWorkspaceCwds,
    startedBeforeMs: input.appStartedAtMs,
    canDispatch: input.canAdmitStartupWork,
  });
  input.ports.logSweepResult(
    `opencode_cursor_agent_trees_reaped sweep=startup count=${result.killedPids.length} status=${result.status}`
  );
  for (const diagnostic of result.diagnostics) {
    input.ports.logWarning(`[OpenCode] startup cursor-agent sweep: ${diagnostic}`);
  }
  if (result.status !== 'completed' && result.status !== 'kept') {
    input.ports.logWarning(`[OpenCode] startup cursor-agent reap incomplete: ${result.status}`);
  }
}

/** Reports snapshot counts only; these records never authorize runtime cleanup. */
async function reportAttributedCursorAgentProcesses(
  input: Pick<OpenCodeLifecycleCleanupTailInput, 'ports' | 'cursorAgentAttribution'>
): Promise<readonly CursorAgentAttributionRecord[]> {
  const port = input.cursorAgentAttribution ?? DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT;
  const attributed = await port.readAttributedProcesses();
  const { total, withRecordedOwner } = summarizeAttributedCursorAgentProcesses(attributed);
  if (total > 0) {
    input.ports.logSweepResult(
      `opencode_cursor_agent_attribution_records sweep=startup count=${total} owned=${withRecordedOwner}`
    );
  }
  return attributed.map((entry) => entry.record);
}
