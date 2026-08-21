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
  invalidateRuntimeSnapshot(teamName: string): void;
}

export interface LeadRuntimeRestartFailure extends Error {
  lifecycleRestored: boolean;
}

function restartFailure(message: string, lifecycleRestored: boolean, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { lifecycleRestored });
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
): void {
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
  ports: LeadRuntimeRestartPorts
): Promise<ChildProcess> {
  const context = run.spawnContext;
  if (!context) throw new Error('Lead spawn context is unavailable');
  const child = ports.spawn(context.claudePath, args, {
    cwd: context.cwd,
    env: { ...context.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  attachReplacement(run, child, ports);
  return child;
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
    run.authRetryInProgress = false;
    ports.attachStdout(run);
    ports.attachStderr(run);
    attachReplacement(run, previousChild, ports);
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

  let replacement: ChildProcess | null = null;
  try {
    replacement = await spawnReplacement(run, newArgs, ports);
    await ports.syncPersistedMetadata({
      teamName: input.teamName,
      settings: input.after,
      launchIdentity: run.launchIdentity,
    });
  } catch (replacementError) {
    if (replacement) {
      detachChild(run, replacement, ports);
      try {
        await ports.killAndWait(replacement);
      } catch (killError) {
        ports.attachStdout(run);
        ports.attachStderr(run);
        attachReplacement(run, replacement, ports);
        throw restartFailure(
          'Replacement lead metadata failed and replacement termination is unconfirmed',
          false,
          new AggregateError([replacementError, killError])
        );
      }
    }
    try {
      await spawnReplacement(run, rollbackArgs, ports);
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
      if ((rollbackError as LeadRuntimeRestartFailure).lifecycleRestored) throw rollbackError;
      run.authRetryInProgress = false;
      run.processClosed = true;
      run.leadActivityState = 'offline';
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
