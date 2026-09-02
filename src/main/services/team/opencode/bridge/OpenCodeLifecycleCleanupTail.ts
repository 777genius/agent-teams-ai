import {
  purgeStaleOpenCodeHostStartupLocks,
  resolveStartupStaleLockMinAgeMs,
} from './OpenCodeHostStartupLockCleanup';
import { cleanupManagedOpenCodeServeProcesses } from './OpenCodeManagedHostProcessCleanup';
import { buildOpenCodeAppScopedMcpOwnershipMarker } from './OpenCodeMcpBridgeEnv';
import { runOpenCodeStartupRuntimeSweepTail } from './OpenCodeStartupRuntimeSweep';

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
  /** Registry hosts the sweep decided to keep; a startup fallback spares them. */
  registryHostPids: ReadonlySet<number>;
  /** False when the registry sweep itself failed, which voids its keep list. */
  registryCleanupAvailable: boolean;
  appStartedAtMs: number;
  /** The instant the registry sweep command settled; the fence for the reap. */
  sweepCommandSettledAtMs: number;
  managedHostInstanceId: string;
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

  if (reason === 'startup' && !input.registryCleanupAvailable) {
    ports.logWarning(
      '[OpenCode] Startup fallback cleanup skipped because host registry cleanup is unavailable'
    );
    return;
  }

  await cleanupOpenCodeHostProcessFallback(
    `${reason} fallback`,
    {
      mode: reason === 'shutdown' ? 'force' : 'orphaned',
      excludePids: reason === 'startup' ? input.registryHostPids : undefined,
      ...(reason === 'shutdown'
        ? buildOpenCodeProcessOwnershipMarkers(input.managedHostInstanceId)
        : {}),
      startedBeforeMs: reason === 'startup' ? input.appStartedAtMs : null,
    },
    ports
  );

  if (reason === 'startup') {
    await runOpenCodeStartupRuntimeSweepTail({
      sweepCommandSettledAtMs: input.sweepCommandSettledAtMs,
      ownershipMarkers: buildOpenCodeProcessOwnershipMarkers(input.managedHostInstanceId),
      logSweepResult: (message) => ports.logSweepResult(`[OpenCode] ${message}`),
      logWarning: (message) => ports.logWarning(message),
      logError: (message) => ports.logError(message),
    });
    // A host that was killed never released its orchestrator startup lock, and
    // the next launch readiness probe waits on every leftover in turn. The
    // reap above has just run, so a lock still held open belongs to a live
    // host: on Windows its unlink fails harmlessly, and where the OS unlinks
    // an open file instead the floor alone has to keep a host that is starting
    // right now out of scope.
    const lockPurge = await purgeStaleOpenCodeHostStartupLocks({
      minAgeMs: resolveStartupStaleLockMinAgeMs(),
    });
    if (lockPurge.removed > 0) {
      ports.logSweepResult(
        `opencode_startup_locks_purged phase=startup removed=${lockPurge.removed} kept=${lockPurge.kept} dir=${lockPurge.locksDir}`
      );
    }
    for (const diagnostic of lockPurge.diagnostics) {
      ports.logWarning(`[OpenCode] startup lock purge: ${diagnostic}`);
    }
  }
}
