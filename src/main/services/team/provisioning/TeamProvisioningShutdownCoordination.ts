import type { TeamProvisioningProgress } from '@shared/types';

interface ShutdownLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface TeamProvisioningShutdownCoordinationState<TProbeProcess> {
  provisioningRunByTeam: ReadonlyMap<string, unknown>;
  aliveRunByTeam: ReadonlyMap<string, unknown>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, unknown>;
  secondaryRuntimeRunByTeam: ReadonlyMap<string, unknown>;
  teamOpLocks: ReadonlyMap<string, Promise<void>>;
  runtimeAdapterProgressByRunId: ReadonlyMap<string, TeamProvisioningProgress>;
  transientProbeProcesses: ReadonlySet<TProbeProcess>;
}

export interface TeamProvisioningShutdownCoordinationPorts<TProbeProcess> {
  isCancellableRuntimeAdapterProgress(progress: TeamProvisioningProgress): boolean;
  getOpenCodeAggregatePrimaryRestartTeamNames(): Iterable<string>;
  getOpenCodeRuntimeAdapterStopInFlightTeamNames(): Iterable<string>;
  stopTeam(teamName: string): Promise<void>;
  cancelRuntimeAdapterProvisioning(
    runId: string,
    progress: TeamProvisioningProgress
  ): Promise<void>;
  killProcessTree(child: TProbeProcess): void;
  /** Only consulted for teams that are known here through a held team lock alone. */
  isManagedByThisProfile(teamName: string): Promise<boolean>;
  logger: ShutdownLogger;
}

export interface TeamProvisioningShutdownCoordination {
  getShutdownTrackedTeamNames(): string[];
  getShutdownRunningTeamNames(): string[];
  stopTrackedTeamsForShutdown(label: string): Promise<string[]>;
  cancelPendingRuntimeAdapterLaunchesForShutdown(): Promise<void>;
  waitForInFlightTeamOperationsForShutdown(timeoutMs?: number): Promise<void>;
  killTransientProbeProcessesForShutdown(): void;
}

export function getPendingRuntimeAdapterLaunchesForShutdown(
  state: Pick<TeamProvisioningShutdownCoordinationState<unknown>, 'runtimeAdapterProgressByRunId'>,
  ports: Pick<
    TeamProvisioningShutdownCoordinationPorts<unknown>,
    'isCancellableRuntimeAdapterProgress'
  >
): TeamProvisioningProgress[] {
  return Array.from(state.runtimeAdapterProgressByRunId.values()).filter((progress) =>
    ports.isCancellableRuntimeAdapterProgress(progress)
  );
}

export function getShutdownTrackedTeamNames(
  state: Pick<
    TeamProvisioningShutdownCoordinationState<unknown>,
    | 'provisioningRunByTeam'
    | 'aliveRunByTeam'
    | 'runtimeAdapterRunByTeam'
    | 'secondaryRuntimeRunByTeam'
    | 'teamOpLocks'
    | 'runtimeAdapterProgressByRunId'
  >,
  ports: Pick<
    TeamProvisioningShutdownCoordinationPorts<unknown>,
    | 'isCancellableRuntimeAdapterProgress'
    | 'getOpenCodeAggregatePrimaryRestartTeamNames'
    | 'getOpenCodeRuntimeAdapterStopInFlightTeamNames'
  >
): string[] {
  const teamNames = new Set<string>();
  for (const teamName of state.provisioningRunByTeam.keys()) teamNames.add(teamName);
  for (const teamName of state.aliveRunByTeam.keys()) teamNames.add(teamName);
  for (const teamName of state.runtimeAdapterRunByTeam.keys()) teamNames.add(teamName);
  for (const teamName of state.secondaryRuntimeRunByTeam.keys()) teamNames.add(teamName);
  for (const teamName of state.teamOpLocks.keys()) teamNames.add(teamName);
  for (const teamName of ports.getOpenCodeAggregatePrimaryRestartTeamNames()) {
    teamNames.add(teamName);
  }
  for (const teamName of ports.getOpenCodeRuntimeAdapterStopInFlightTeamNames()) {
    teamNames.add(teamName);
  }
  for (const progress of getPendingRuntimeAdapterLaunchesForShutdown(state, ports)) {
    teamNames.add(progress.teamName);
  }
  return Array.from(teamNames);
}

/**
 * Teams with a run, lane, restart, stop or pending launch of this process.
 * Unlike getShutdownTrackedTeamNames it leaves out teams known only through a
 * held team lock: background reads and deliveries can lock a team of another
 * app profile, so a lock alone proves nothing about ownership.
 */
export function getShutdownRunningTeamNames(
  state: Pick<
    TeamProvisioningShutdownCoordinationState<unknown>,
    | 'provisioningRunByTeam'
    | 'aliveRunByTeam'
    | 'runtimeAdapterRunByTeam'
    | 'secondaryRuntimeRunByTeam'
    | 'runtimeAdapterProgressByRunId'
  >,
  ports: Pick<
    TeamProvisioningShutdownCoordinationPorts<unknown>,
    | 'isCancellableRuntimeAdapterProgress'
    | 'getOpenCodeAggregatePrimaryRestartTeamNames'
    | 'getOpenCodeRuntimeAdapterStopInFlightTeamNames'
  >
): string[] {
  return getShutdownTrackedTeamNames({ ...state, teamOpLocks: new Map() }, ports);
}

function stopTeamsForShutdown(
  teamNames: readonly string[],
  ports: Pick<TeamProvisioningShutdownCoordinationPorts<unknown>, 'stopTeam' | 'logger'>
): Promise<void>[] {
  return teamNames.map((teamName) =>
    ports.stopTeam(teamName).catch((error) => {
      ports.logger.warn(
        `[${teamName}] Failed to stop team during shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    })
  );
}

export async function stopTrackedTeamsForShutdown(
  label: string,
  state: Pick<
    TeamProvisioningShutdownCoordinationState<unknown>,
    | 'provisioningRunByTeam'
    | 'aliveRunByTeam'
    | 'runtimeAdapterRunByTeam'
    | 'secondaryRuntimeRunByTeam'
    | 'teamOpLocks'
    | 'runtimeAdapterProgressByRunId'
  >,
  ports: Pick<
    TeamProvisioningShutdownCoordinationPorts<unknown>,
    | 'isCancellableRuntimeAdapterProgress'
    | 'getOpenCodeAggregatePrimaryRestartTeamNames'
    | 'getOpenCodeRuntimeAdapterStopInFlightTeamNames'
    | 'isManagedByThisProfile'
    | 'stopTeam'
    | 'logger'
  >
): Promise<string[]> {
  // Started synchronously: the quit path may not wait for any I/O.
  const runningTeamNames = getShutdownRunningTeamNames(state, ports);
  if (runningTeamNames.length > 0) {
    ports.logger.info(`${label}: stopping tracked team processes: ${runningTeamNames.join(', ')}`);
  }
  const stops = stopTeamsForShutdown(runningTeamNames, ports);

  const running = new Set(runningTeamNames);
  const lockedTeamNames: string[] = [];
  for (const teamName of [...state.teamOpLocks.keys()]) {
    if (!running.has(teamName) && (await ports.isManagedByThisProfile(teamName))) {
      lockedTeamNames.push(teamName);
    }
  }
  if (lockedTeamNames.length > 0) {
    ports.logger.info(
      `${label}: stopping teams with in-flight operations: ${lockedTeamNames.join(', ')}`
    );
    stops.push(...stopTeamsForShutdown(lockedTeamNames, ports));
  }
  await Promise.all(stops);
  return [...runningTeamNames, ...lockedTeamNames];
}

export async function cancelPendingRuntimeAdapterLaunchesForShutdown(
  state: Pick<TeamProvisioningShutdownCoordinationState<unknown>, 'runtimeAdapterProgressByRunId'>,
  ports: Pick<
    TeamProvisioningShutdownCoordinationPorts<unknown>,
    'isCancellableRuntimeAdapterProgress' | 'cancelRuntimeAdapterProvisioning' | 'logger'
  >
): Promise<void> {
  const pendingRuntimeLaunches = getPendingRuntimeAdapterLaunchesForShutdown(state, ports);
  if (pendingRuntimeLaunches.length === 0) {
    return;
  }

  ports.logger.info(
    `Cancelling pending OpenCode runtime adapter launches on shutdown: ${pendingRuntimeLaunches
      .map((progress) => progress.teamName)
      .join(', ')}`
  );
  await Promise.all(
    pendingRuntimeLaunches.map((progress) =>
      ports.cancelRuntimeAdapterProvisioning(progress.runId, progress).catch((error) => {
        ports.logger.warn(
          `[${progress.teamName}] Failed to cancel pending OpenCode runtime adapter launch on shutdown: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      })
    )
  );
}

export async function waitForInFlightTeamOperationsForShutdown(
  state: Pick<TeamProvisioningShutdownCoordinationState<unknown>, 'teamOpLocks'>,
  ports: Pick<TeamProvisioningShutdownCoordinationPorts<unknown>, 'logger'>,
  timeoutMs = 2_000
): Promise<void> {
  const locks = Array.from(state.teamOpLocks.values());
  if (locks.length === 0) {
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    Promise.allSettled(locks).then(() => undefined),
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (timedOut) {
    ports.logger.warn(
      `Timed out after ${timeoutMs}ms waiting for in-flight team operations during shutdown`
    );
  }
}

export function killTransientProbeProcessesForShutdown<TProbeProcess>(
  state: Pick<TeamProvisioningShutdownCoordinationState<TProbeProcess>, 'transientProbeProcesses'>,
  ports: Pick<
    TeamProvisioningShutdownCoordinationPorts<TProbeProcess>,
    'killProcessTree' | 'logger'
  >
): void {
  for (const child of Array.from(state.transientProbeProcesses)) {
    try {
      ports.killProcessTree(child);
    } catch (error) {
      ports.logger.debug(
        `Failed to kill transient probe process during shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

export function createTeamProvisioningShutdownCoordination<TProbeProcess>(
  state: TeamProvisioningShutdownCoordinationState<TProbeProcess>,
  ports: TeamProvisioningShutdownCoordinationPorts<TProbeProcess>
): TeamProvisioningShutdownCoordination {
  return {
    getShutdownTrackedTeamNames: () => getShutdownTrackedTeamNames(state, ports),
    getShutdownRunningTeamNames: () => getShutdownRunningTeamNames(state, ports),
    stopTrackedTeamsForShutdown: (label) => stopTrackedTeamsForShutdown(label, state, ports),
    cancelPendingRuntimeAdapterLaunchesForShutdown: () =>
      cancelPendingRuntimeAdapterLaunchesForShutdown(state, ports),
    waitForInFlightTeamOperationsForShutdown: (timeoutMs) =>
      waitForInFlightTeamOperationsForShutdown(state, ports, timeoutMs),
    killTransientProbeProcessesForShutdown: () =>
      killTransientProbeProcessesForShutdown(state, ports),
  };
}
