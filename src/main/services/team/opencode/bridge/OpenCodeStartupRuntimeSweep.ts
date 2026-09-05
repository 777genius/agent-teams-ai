import { cleanupManagedOpenCodeServeProcesses } from './OpenCodeManagedHostProcessCleanup';

import type {
  OpenCodeManagedHostCleanupMode,
  OpenCodeManagedHostCleanupResult,
  OpenCodeManagedHostProcessCleanupOptions,
} from './OpenCodeManagedHostProcessCleanup';

/**
 * Tail of the startup host cleanup: reap the managed host the orchestrator's
 * own registry sweep leaves running.
 *
 * The registry sweep is executed without a project path, which boots a managed
 * host in the app's process directory. That host then owns the loopback port
 * the runtime proxy is pinned to, and every lane launched afterwards is routed
 * through it: wrong workspace, wrong profile, none of the user's own MCP
 * servers. Nothing else reaps it, because it is not in the registry the sweep
 * just cleaned.
 *
 * Every step here is destructive, so every step is fenced twice. A start time
 * keeps out anything younger than the fence: without it the sweep reaped the
 * `opencode serve` host of a readiness probe a user launch had just started,
 * and refused that launch before its first state-changing bridge command. And
 * this app instance's own ownership markers keep out every host it did not
 * start, so a second install, or an orchestrator a user runs themselves, is
 * never a candidate for the reap however old it is.
 */

/** How long the orchestrator may still be booting its sweep host. */
export const OPEN_CODE_STARTUP_SWEEP_HOST_SETTLE_MS = 8_000;

/**
 * The reap itself, injectable so the fence can be tested without a process
 * table. Whatever is handed in inherits the proof the scan demands: only a
 * process whose own command line - and, off Windows, its own environment -
 * names it an app-managed OpenCode host is ever signalled, so nothing reached
 * from here is a host this app merely recorded a pid for.
 */
export type OpenCodeManagedHostSweep = (
  input: OpenCodeManagedHostOwnershipMarkers & {
    startedBeforeMs: number;
    /**
     * `force` reaps a confirmed-managed host outright; `orphaned` additionally
     * spares one whose parent is still alive. Defaults to `force`.
     */
    mode?: OpenCodeManagedHostCleanupMode;
  }
) => Promise<OpenCodeManagedHostCleanupResult>;

/**
 * Strings only a host this app instance started carries: its own environment
 * off Windows, and - because Windows forbids reading another process's
 * environment - its own answer over loopback there.
 */
export type OpenCodeManagedHostOwnershipMarkers = Pick<
  OpenCodeManagedHostProcessCleanupOptions,
  'requiredDetailsMarkers' | 'requiredServeConfigMarkersAny'
>;

const sweepManagedHostsByProcessScan: OpenCodeManagedHostSweep = (input) =>
  cleanupManagedOpenCodeServeProcesses({
    mode: input.mode ?? 'force',
    startedBeforeMs: input.startedBeforeMs,
    ...(input.requiredDetailsMarkers
      ? { requiredDetailsMarkers: input.requiredDetailsMarkers }
      : {}),
    ...(input.requiredServeConfigMarkersAny
      ? { requiredServeConfigMarkersAny: input.requiredServeConfigMarkersAny }
      : {}),
  });

export interface OpenCodeStartupRuntimeSweepPorts {
  /**
   * The instant the registry sweep command SETTLED, and the fence for the reap
   * below. The host this tail exists to reap is booted by that command, so it
   * is younger than the moment the command was issued and older than the moment
   * it returned; fencing by either app start or the issue instant keeps it
   * every time and makes the whole tail a no-op. A host younger than the
   * settled command may belong to an in-flight launch and is still kept, and
   * the startup sweep gate parks a launch requested inside the window rather
   * than letting it race the reap.
   */
  sweepCommandSettledAtMs: number;
  /**
   * Proof of ownership the reap adds to the scan's own command-line check. The
   * host booted by the registry sweep command inherits this instance's bridge
   * environment, so it carries them; a host of another install, or one a user
   * started, does not and is kept.
   */
  ownershipMarkers?: OpenCodeManagedHostOwnershipMarkers;
  sweepManagedHosts?: OpenCodeManagedHostSweep;
  /** Durable counter for the app's most destructive startup action. */
  logSweepResult(message: string): void;
  logWarning(message: string): void;
  /**
   * The reap failed outright, which is a caught main-process failure and not a
   * warning about one host. `warn` reaches the durable sinks either way, but
   * its console line is filtered out at the production log level, so the one
   * failure that explains why nothing was reaped is the one nobody sees.
   */
  logError(message: string): void;
  /**
   * Declared as a property rather than a method so the default below reads it
   * unbound without borrowing `ports` as `this`.
   */
  waitMs?: (ms: number) => Promise<void>;
}

export async function runOpenCodeStartupRuntimeSweepTail(
  ports: OpenCodeStartupRuntimeSweepPorts
): Promise<void> {
  const sweepManagedHosts = ports.sweepManagedHosts ?? sweepManagedHostsByProcessScan;

  // The orchestrator may still be booting its sweep host when the sweep
  // command returns, so give it a moment to appear before reaping. It cannot
  // outrun the fence by waiting: the fence is the moment the command was
  // issued, which is already in the past.
  const waitMs =
    ports.waitMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await waitMs(OPEN_CODE_STARTUP_SWEEP_HOST_SETTLE_MS);

  // Never throws, for the same reason the preflight reap does not: this runs
  // inside the startup host cleanup and the stale-lock purge comes after it.
  // A scan that could not read the process table would otherwise take the
  // purge with it, and the locks of the hosts it did not reach are exactly the
  // ones the next launch then queues behind.
  try {
    const sweep = await sweepManagedHosts({
      startedBeforeMs: ports.sweepCommandSettledAtMs,
      ...(ports.ownershipMarkers ?? {}),
    });
    ports.logSweepResult(
      `opencode_managed_hosts_killed sweep=startup count=${sweep.killed} scanned=${sweep.scanned}`
    );
    for (const diagnostic of sweep.diagnostics) {
      ports.logWarning(`[OpenCode] startup sweep host cleanup: ${diagnostic}`);
    }
  } catch (error) {
    ports.logError(`[OpenCode] Startup sweep host cleanup failed: ${String(error)}`);
  }
}

/**
 * Reaps `opencode serve` hosts a previous app instance left behind. It runs
 * before the runtime adapter registry exists, because an orphan still holds
 * the fixed loopback ports a new host needs and whoever gets there first wins:
 * reaping afterwards would mean this session's first launch races a host it
 * cannot see.
 *
 * `orphaned` rather than `force`, and fenced by this instance's start, so it
 * only reaches a host that is both older than this app and no longer parented
 * by anything alive - on top of the command-line and environment proof the
 * scan itself demands. Never throws: the app has to start even when it cannot
 * clean up first.
 */
export async function reapOrphanedOpenCodeHostsBeforeRuntimeRegistry(ports: {
  appStartedAtMs: number;
  sweepManagedHosts?: OpenCodeManagedHostSweep;
  logSweepResult(message: string): void;
  logWarning(message: string): void;
  /** As above: a sweep that could not run at all is a failure, not a warning. */
  logError(message: string): void;
}): Promise<void> {
  const sweepManagedHosts = ports.sweepManagedHosts ?? sweepManagedHostsByProcessScan;
  try {
    const sweep = await sweepManagedHosts({
      mode: 'orphaned',
      startedBeforeMs: ports.appStartedAtMs,
    });
    ports.logSweepResult(
      `opencode_managed_hosts_killed sweep=startup_preflight count=${sweep.killed} scanned=${sweep.scanned}`
    );
    for (const diagnostic of sweep.diagnostics) {
      ports.logWarning(`[OpenCode] startup preflight cleanup: ${diagnostic}`);
    }
  } catch (error) {
    ports.logError(`[OpenCode] Startup preflight host cleanup failed: ${String(error)}`);
  }
}
