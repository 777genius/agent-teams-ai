import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import type { TeamMetaFile } from '../TeamMetaStore';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { spawnCli } from '@main/utils/childProcess';
import type { EffortLevel, ProviderModelLaunchIdentity, TeamProviderId } from '@shared/types';
import type { ChildProcess } from 'node:child_process';

const VALUE_FLAGS = new Set([
  '--team-bootstrap-spec',
  '--team-bootstrap-user-prompt-file',
  '--model',
  '--effort',
  '--resume',
  '--session-id',
]);

export type LeadRuntimeRestartAvailability =
  | { outcome: 'ready'; runId: string }
  | { outcome: 'busy'; reason: string }
  | { outcome: 'relaunch_required'; reason: string };

export interface LeadRuntimeSettings {
  providerId: TeamProviderId;
  model: string | null;
  effort: EffortLevel | null;
}

export interface LeadRuntimeRestartPorts {
  spawn: typeof spawnCli;
  killAndWait(child: ChildProcess): Promise<void>;
  attachStdout(run: ProvisioningRun): void;
  attachStderr(run: ProvisioningRun): void;
  startStallWatchdog(run: ProvisioningRun): void;
  stopStallWatchdog(run: ProvisioningRun): void;
  handleProcessExit(run: ProvisioningRun, code: number | null): Promise<void>;
  getAliveRunId(teamName: string): string | null;
  getRun(runId: string): ProvisioningRun | undefined;
  syncPersistedMetadata(input: {
    teamName: string;
    settings: LeadRuntimeSettings;
    launchIdentity: ProviderModelLaunchIdentity | null;
  }): Promise<void>;
  stopPersistentTeamMembers(teamName: string): boolean;
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void>;
  invalidateRuntimeSnapshot(teamName: string): void;
}

export interface LeadRuntimeRestartFailure extends Error {
  lifecycleRestored: boolean;
}

function restartFailure(message: string, lifecycleRestored: boolean, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { lifecycleRestored });
}

function isLeadRuntimeRestartFailure(error: unknown): error is LeadRuntimeRestartFailure {
  return (
    error instanceof Error &&
    typeof (error as Partial<LeadRuntimeRestartFailure>).lifecycleRestored === 'boolean'
  );
}

function stripOwnedValueFlags(args: readonly string[]): string[] {
  const next: string[] = [];
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    const flag = value.split('=', 1)[0];
    if (flag !== value && VALUE_FLAGS.has(flag)) {
      index += 1;
      continue;
    }
    if (VALUE_FLAGS.has(value)) {
      index += 2;
      continue;
    }
    next.push(value);
    index += 1;
  }
  return next;
}

export function buildLeadRuntimeResumeArgs(input: {
  previousArgs: readonly string[];
  sessionId: string;
  model: string | null;
  effort: EffortLevel | null;
}): string[] {
  return [
    ...stripOwnedValueFlags(input.previousArgs),
    '--resume',
    input.sessionId,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
  ];
}

export function applyLeadRuntimeSettingsToLaunchIdentity(
  identity: ProviderModelLaunchIdentity | null | undefined,
  settings: LeadRuntimeSettings
): ProviderModelLaunchIdentity | null {
  if (!identity) return null;
  return {
    ...identity,
    selectedModel: settings.model,
    selectedModelKind: settings.model ? 'explicit' : 'default',
    resolvedLaunchModel: settings.model,
    catalogId: settings.model,
    selectedEffort: settings.effort,
    resolvedEffort: settings.effort,
  };
}

export function applyLeadRuntimeSettingsToTeamMeta(
  meta: TeamMetaFile,
  settings: LeadRuntimeSettings,
  fallbackLaunchIdentity: ProviderModelLaunchIdentity | null
): Omit<TeamMetaFile, 'version'> {
  const { version, ...persisted } = meta;
  if (version !== 1) throw new Error('Unsupported team metadata version');
  return {
    ...persisted,
    model: settings.model ?? undefined,
    effort: settings.effort ?? undefined,
    launchIdentity:
      applyLeadRuntimeSettingsToLaunchIdentity(
        meta.launchIdentity ?? fallbackLaunchIdentity,
        settings
      ) ?? undefined,
  };
}

function isSupportedProvider(providerId: TeamProviderId): boolean {
  return providerId === 'anthropic' || providerId === 'codex' || providerId === 'gemini';
}

export function assessLeadRuntimeRestart(
  teamName: string,
  settings: LeadRuntimeSettings,
  ports: Pick<LeadRuntimeRestartPorts, 'getAliveRunId' | 'getRun'>
): LeadRuntimeRestartAvailability {
  const runId = ports.getAliveRunId(teamName);
  const run = runId ? ports.getRun(runId) : undefined;
  if (!runId || run?.runId !== runId || run.teamName !== teamName) {
    return { outcome: 'relaunch_required', reason: 'No exact app-owned live lead run' };
  }
  if (resolveTeamProviderId(run.request.providerId) !== settings.providerId) {
    return { outcome: 'relaunch_required', reason: 'Lead provider ownership changed' };
  }
  if (!isSupportedProvider(settings.providerId)) {
    return { outcome: 'relaunch_required', reason: 'Provider does not support lead-only resume' };
  }
  if (!run.provisioningComplete || run.processClosed || run.processKilled || run.cancelRequested) {
    return { outcome: 'busy', reason: 'Lead run is not in a stable live state' };
  }
  if (
    run.leadActivityState !== 'idle' ||
    run.activeToolCalls.size > 0 ||
    run.pendingApprovals.size > 0 ||
    run.authRetryInProgress
  ) {
    return { outcome: 'busy', reason: 'Lead has an active turn, tool call, or approval' };
  }
  if (!run.detectedSessionId?.trim() || !run.spawnContext || !run.child?.stdin?.writable) {
    return { outcome: 'relaunch_required', reason: 'Lead resume ownership is unproven' };
  }
  return { outcome: 'ready', runId };
}

async function confirmSpawn(child: ChildProcess): Promise<void> {
  if (!child.pid || !child.stdin?.writable) {
    throw new Error('Replacement lead process did not expose a writable runtime');
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('error', onError);
      child.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error('Replacement lead process exited during startup'));
    const timer = setTimeout(() => finish(), 250);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function attachReplacement(
  run: ProvisioningRun,
  child: ChildProcess,
  ports: LeadRuntimeRestartPorts
): (code: number | null) => void {
  let exitHandled = false;
  const handleExit = (code: number | null): void => {
    if (run.child !== child || exitHandled) return;
    exitHandled = true;
    void ports.handleProcessExit(run, code);
  };
  run.processClosed = false;
  run.processKilled = false;
  run.authRetryInProgress = false;
  ports.startStallWatchdog(run);
  child.once('error', () => handleExit(1));
  child.once('close', (code) => handleExit(code));
  return handleExit;
}

interface CandidateExitObserver {
  hasExited(): boolean;
  exitCode(): number | null;
  dispose(): void;
}

function observeCandidateExit(child: ChildProcess): CandidateExitObserver {
  let exited =
    child.exitCode !== null && child.exitCode !== undefined
      ? true
      : child.signalCode !== null && child.signalCode !== undefined;
  let code = typeof child.exitCode === 'number' ? child.exitCode : null;
  const onError = (): void => {
    exited = true;
    code = 1;
  };
  const onExit = (nextCode: number | null): void => {
    exited = true;
    code = nextCode;
  };
  const onClose = (nextCode: number | null): void => {
    exited = true;
    code = nextCode;
  };
  child.once('error', onError);
  child.once('exit', onExit);
  child.once('close', onClose);
  return {
    hasExited: () => exited,
    exitCode: () => code,
    dispose: () => {
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('close', onClose);
    },
  };
}

function detachChild(
  run: ProvisioningRun,
  child: ChildProcess,
  ports: LeadRuntimeRestartPorts
): void {
  run.authRetryInProgress = true;
  ports.stopStallWatchdog(run);
  child.stdout?.removeAllListeners();
  child.stderr?.removeAllListeners();
  child.removeAllListeners('error');
  child.removeAllListeners('exit');
  child.removeAllListeners('close');
}

async function spawnReplacement(
  run: ProvisioningRun,
  args: string[],
  ports: LeadRuntimeRestartPorts,
  onSpawn: (child: ChildProcess) => void = () => undefined,
  attachLifecycle = true
): Promise<ChildProcess> {
  const context = run.spawnContext;
  if (!context) throw new Error('Lead spawn context is unavailable');
  const child = ports.spawn(context.claudePath, args, {
    cwd: context.cwd,
    env: { ...context.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  onSpawn(child);
  run.child = child as ProvisioningRun['child'];
  ports.attachStdout(run);
  ports.attachStderr(run);
  try {
    await confirmSpawn(child);
  } catch (error) {
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    throw error;
  }
  if (attachLifecycle) attachReplacement(run, child, ports);
  return child;
}

function hasExactRestartOwnership(
  teamName: string,
  expectedRunId: string,
  run: ProvisioningRun,
  ports: LeadRuntimeRestartPorts
): boolean {
  return (
    ports.getAliveRunId(teamName) === expectedRunId &&
    ports.getRun(expectedRunId) === run &&
    !run.cancelRequested &&
    !run.processKilled &&
    !run.processClosed
  );
}

function retainDegradedCandidate(
  run: ProvisioningRun,
  child: ChildProcess,
  ports: LeadRuntimeRestartPorts
): void {
  run.child = child as ProvisioningRun['child'];
  run.authRetryInProgress = false;
  run.processKilled = false;
  run.processClosed = true;
  run.leadActivityState = 'offline';
  ports.attachStdout(run);
  ports.attachStderr(run);
  try {
    ports.invalidateRuntimeSnapshot(run.teamName);
  } catch {
    // Tracked degraded ownership remains authoritative until explicit stop.
  }
}

async function terminateCandidate(
  run: ProvisioningRun,
  child: ChildProcess,
  ports: LeadRuntimeRestartPorts
): Promise<void> {
  detachChild(run, child, ports);
  try {
    await ports.killAndWait(child);
  } catch (error) {
    retainDegradedCandidate(run, child, ports);
    throw error;
  }
  if (run.child === child) run.child = null;
}

async function stopRemainingOwnedRuntimes(
  teamName: string,
  ports: LeadRuntimeRestartPorts
): Promise<void> {
  const cleanupErrors: Error[] = [];
  if (!ports.stopPersistentTeamMembers(teamName)) {
    cleanupErrors.push(new Error('Persistent teammate cleanup is unconfirmed'));
  }
  if (ports.hasSecondaryRuntimeRuns(teamName)) {
    try {
      await ports.stopMixedSecondaryRuntimeLanes(teamName);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors);
}

export async function restartLeadRuntime(
  input: {
    teamName: string;
    expectedRunId: string;
    before: LeadRuntimeSettings;
    after: LeadRuntimeSettings;
  },
  ports: LeadRuntimeRestartPorts
): Promise<void> {
  const admission = assessLeadRuntimeRestart(input.teamName, input.after, ports);
  if (admission.outcome !== 'ready' || admission.runId !== input.expectedRunId) {
    throw restartFailure(
      admission.outcome === 'ready' ? 'Lead run owner changed' : admission.reason,
      true
    );
  }
  const run = ports.getRun(input.expectedRunId);
  if (!run?.spawnContext || !run.detectedSessionId || !run.child) {
    throw restartFailure('Lead restart ownership became stale', true);
  }
  const previousChild = run.child;
  const previousArgs = [...run.spawnContext.args];
  const newArgs = buildLeadRuntimeResumeArgs({
    previousArgs,
    sessionId: run.detectedSessionId,
    model: input.after.model,
    effort: input.after.effort,
  });
  const rollbackArgs = buildLeadRuntimeResumeArgs({
    previousArgs,
    sessionId: run.detectedSessionId,
    model: input.before.model,
    effort: input.before.effort,
  });

  detachChild(run, previousChild, ports);
  try {
    await ports.killAndWait(previousChild);
  } catch (error) {
    retainDegradedCandidate(run, previousChild, ports);
    throw restartFailure('Previous lead termination could not be confirmed', false, error);
  }

  if (
    ports.getAliveRunId(input.teamName) !== input.expectedRunId ||
    ports.getRun(input.expectedRunId) !== run ||
    run.cancelRequested ||
    run.processKilled ||
    run.processClosed
  ) {
    throw restartFailure('Lead restart was cancelled after termination', true);
  }

  let replacementCandidate: ChildProcess | null = null;
  let replacementExitObserver: CandidateExitObserver | null = null;
  let replacementMetadataSyncStarted = false;
  try {
    await spawnReplacement(
      run,
      newArgs,
      ports,
      (child) => {
        replacementCandidate = child;
        replacementExitObserver = observeCandidateExit(child);
      },
      false
    );
    const observedReplacementExit = replacementExitObserver as CandidateExitObserver | null;
    if (
      !replacementCandidate ||
      !observedReplacementExit ||
      observedReplacementExit.hasExited() ||
      !hasExactRestartOwnership(input.teamName, input.expectedRunId, run, ports)
    ) {
      throw new Error('Replacement lead ownership changed during startup');
    }
    replacementMetadataSyncStarted = true;
    await ports.syncPersistedMetadata({
      teamName: input.teamName,
      settings: input.after,
      launchIdentity: run.launchIdentity,
    });
    if (
      !replacementCandidate ||
      !observedReplacementExit ||
      observedReplacementExit.hasExited() ||
      !hasExactRestartOwnership(input.teamName, input.expectedRunId, run, ports)
    ) {
      throw new Error('Replacement lead ownership changed during metadata synchronization');
    }
    const handleReplacementExit = attachReplacement(run, replacementCandidate, ports);
    if (observedReplacementExit.hasExited()) {
      handleReplacementExit(observedReplacementExit.exitCode());
      throw new Error('Replacement lead exited during lifecycle handoff');
    }
    observedReplacementExit.dispose();
  } catch (replacementError) {
    (replacementExitObserver as CandidateExitObserver | null)?.dispose();
    if (replacementCandidate) {
      try {
        await terminateCandidate(run, replacementCandidate, ports);
      } catch (killError) {
        throw restartFailure(
          'Replacement lead failed and candidate termination is unconfirmed',
          false,
          new AggregateError([replacementError, killError])
        );
      }
    }
    if (!hasExactRestartOwnership(input.teamName, input.expectedRunId, run, ports)) {
      throw restartFailure(
        'Lead restart ownership changed; rollback was not started',
        false,
        replacementError
      );
    }
    let rollbackCandidate: ChildProcess | null = null;
    let rollbackExitObserver: CandidateExitObserver | null = null;
    try {
      await spawnReplacement(
        run,
        rollbackArgs,
        ports,
        (child) => {
          rollbackCandidate = child;
          rollbackExitObserver = observeCandidateExit(child);
        },
        false
      );
      const activeRollbackCandidate = rollbackCandidate as ChildProcess | null;
      const observedRollbackExit = rollbackExitObserver as CandidateExitObserver | null;
      if (!activeRollbackCandidate) {
        throw new Error('Rollback lead process ownership was not captured');
      }
      if (replacementMetadataSyncStarted) {
        try {
          await ports.syncPersistedMetadata({
            teamName: input.teamName,
            settings: input.before,
            launchIdentity: run.launchIdentity,
          });
        } catch (metadataRestoreError) {
          if (
            observedRollbackExit &&
            !observedRollbackExit.hasExited() &&
            hasExactRestartOwnership(input.teamName, input.expectedRunId, run, ports)
          ) {
            observedRollbackExit.dispose();
            detachChild(run, activeRollbackCandidate, ports);
            retainDegradedCandidate(run, activeRollbackCandidate, ports);
            throw restartFailure(
              'Previous lead runtime resumed but metadata restoration is unconfirmed',
              false,
              new AggregateError([replacementError, metadataRestoreError])
            );
          }
          throw new Error('Rollback lead ownership changed during metadata restoration', {
            cause: new AggregateError([replacementError, metadataRestoreError]),
          });
        }
      }
      if (
        !observedRollbackExit ||
        observedRollbackExit.hasExited() ||
        !hasExactRestartOwnership(input.teamName, input.expectedRunId, run, ports)
      ) {
        throw new Error('Rollback lead ownership changed during metadata restoration');
      }
      const handleRollbackExit = attachReplacement(run, activeRollbackCandidate, ports);
      if (observedRollbackExit.hasExited()) {
        handleRollbackExit(observedRollbackExit.exitCode());
        throw new Error('Rollback lead exited during lifecycle handoff');
      }
      observedRollbackExit.dispose();
      run.spawnContext.args = rollbackArgs;
      run.leadActivityState = 'idle';
      try {
        ports.invalidateRuntimeSnapshot(input.teamName);
      } catch {
        // The restored runtime is live; cache invalidation is best effort.
      }
      throw restartFailure(
        'Replacement lead failed; the previous runtime settings were restored',
        true,
        replacementError
      );
    } catch (rollbackError) {
      (rollbackExitObserver as CandidateExitObserver | null)?.dispose();
      if (isLeadRuntimeRestartFailure(rollbackError)) throw rollbackError;
      if (rollbackCandidate) {
        try {
          await terminateCandidate(run, rollbackCandidate, ports);
        } catch (killError) {
          throw restartFailure(
            'Rollback lead failed and candidate termination is unconfirmed',
            false,
            new AggregateError([replacementError, rollbackError, killError])
          );
        }
      }
      const degradedOwner = rollbackCandidate ?? replacementCandidate ?? previousChild;
      try {
        await stopRemainingOwnedRuntimes(input.teamName, ports);
      } catch (cleanupError) {
        retainDegradedCandidate(run, degradedOwner, ports);
        throw restartFailure(
          'Lead candidates stopped but team-owned runtime cleanup is unconfirmed',
          false,
          new AggregateError([replacementError, rollbackError, cleanupError])
        );
      }
      run.authRetryInProgress = false;
      run.child = null;
      run.processKilled = true;
      run.processClosed = true;
      run.leadActivityState = 'offline';
      try {
        ports.invalidateRuntimeSnapshot(input.teamName);
      } catch {
        // The failed runtime is already detached; cache invalidation is best effort.
      }
      throw restartFailure(
        'Replacement and rollback lead processes both failed to start',
        false,
        new AggregateError([replacementError, rollbackError])
      );
    }
  }

  run.spawnContext.args = newArgs;
  run.request.model = input.after.model ?? undefined;
  run.request.effort = input.after.effort ?? undefined;
  run.launchIdentity = applyLeadRuntimeSettingsToLaunchIdentity(run.launchIdentity, input.after);
  run.leadActivityState = 'idle';
  try {
    ports.invalidateRuntimeSnapshot(input.teamName);
  } catch {
    // Persisted metadata is authoritative; cache invalidation is best effort.
  }
}
