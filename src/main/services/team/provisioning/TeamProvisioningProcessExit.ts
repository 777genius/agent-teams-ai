import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  buildCliExitFailurePresentation,
  buildCombinedLogs,
  type CliExitPresentationRun,
} from './TeamProvisioningCliExitPresentation';
import { type TeamsBaseLocation } from './TeamProvisioningRuntimeLaunchSelection';

import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types';

type ProgressState = TeamProvisioningProgress['state'];

type ProgressExtras = Pick<
  TeamProvisioningProgress,
  'error' | 'warnings' | 'cliLogsTail' | 'messageSeverity'
>;

export type ValidConfigProbeResultLike =
  | { ok: false }
  | { ok: true; location: TeamsBaseLocation; configPath: string };

export interface WaitForValidConfigRun {
  teamName: string;
  cancelRequested: boolean;
  teamsBasePathsToProbe: readonly { location: TeamsBaseLocation; basePath: string }[];
}

export interface WaitForValidConfigPorts {
  readRegularFileUtf8(
    filePath: string,
    opts: { timeoutMs: number; maxBytes: number }
  ): Promise<string | null>;
  timeoutMs: number;
  pollMs: number;
  teamJsonReadTimeoutMs: number;
  teamConfigMaxBytes: number;
  sleep?(ms: number): Promise<void>;
}

export interface TeamProvisioningProcessExitRun extends CliExitPresentationRun {
  runId: string;
  teamName: string;
  progress: TeamProvisioningProgress;
  stdoutParserCarry: string;
  stdoutParserCarryIsCompleteJson: boolean;
  stdoutParserCarryLooksLikeClaudeJson: boolean;
  processKilled: boolean;
  finalizingByTimeout: boolean;
  cancelRequested: boolean;
  provisioningComplete: boolean;
  processClosed: boolean;
  authRetryInProgress: boolean;
  isLaunch: boolean;
  teamsBasePathsToProbe: WaitForValidConfigRun['teamsBasePathsToProbe'];
  expectedMembers: string[];
  request: TeamCreateRequest;
  allEffectiveMembers: TeamCreateRequest['members'];
  detectedSessionId: string | null;
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface WaitForTeamInListPorts {
  listTeams(): Promise<readonly { teamName: string }[]>;
  timeoutMs: number;
  pollMs: number;
  isCancelled?(): boolean;
  sleep?(ms: number): Promise<void>;
}

export interface WaitForMissingInboxesRun {
  teamName: string;
  expectedMembers: readonly string[];
  cancelRequested: boolean;
  progress: Pick<TeamProvisioningProgress, 'state'>;
}

export interface WaitForMissingInboxesPorts {
  getTeamsBasePath(): string;
  pathExists(filePath: string): Promise<boolean>;
  timeoutMs: number;
  pollMs: number;
  sleep?(ms: number): Promise<void>;
}

export interface TeamProvisioningTimeoutCompletionPorts<
  TRun extends TeamProvisioningProcessExitRun,
> {
  waitForValidConfig(run: TRun): Promise<ValidConfigProbeResultLike>;
  waitForTeamInList(teamName: string, run?: TRun): Promise<boolean>;
  waitForMissingInboxes(run: TRun): Promise<string[]>;
  persistMembersMeta(teamName: string, request: TeamCreateRequest): Promise<void>;
  updateConfigPostLaunch(
    teamName: string,
    cwd: string,
    detectedSessionId: string | null,
    color: string | undefined,
    options: {
      providerId: TeamCreateRequest['providerId'];
      model: TeamCreateRequest['model'];
      effort: TeamCreateRequest['effort'];
      members: TeamCreateRequest['members'];
    }
  ): Promise<void>;
  refreshMemberSpawnStatusesFromLeadInbox(run: TRun): Promise<void>;
  maybeAuditMemberSpawnStatuses(run: TRun, options: { force: true }): Promise<void>;
  finalizeMissingRegisteredMembersAsFailed(run: TRun): Promise<void>;
  persistLaunchStateSnapshot(run: TRun, phase: 'finished'): Promise<unknown>;
  updateProgress(
    run: TRun,
    state: Exclude<ProgressState, 'idle'>,
    message: string,
    extras?: ProgressExtras
  ): TeamProvisioningProgress;
  cleanupRun(run: TRun): void;
}

type TeamProvisioningProcessExitTimeoutPortKey =
  | 'waitForValidConfig'
  | 'waitForTeamInList'
  | 'waitForMissingInboxes'
  | 'persistMembersMeta'
  | 'updateProgress'
  | 'cleanupRun';

export interface TeamProvisioningProcessExitPorts<
  TRun extends TeamProvisioningProcessExitRun,
> extends Pick<
  TeamProvisioningTimeoutCompletionPorts<TRun>,
  TeamProvisioningProcessExitTimeoutPortKey
> {
  logger: {
    info(message: string): void;
    warn(message: string, details?: unknown): void;
  };
  buildStdoutCarryDiagnostic(run: TRun): Record<string, unknown>;
  flushStdoutParserCarry(run: TRun): void;
  stopStallWatchdog(run: TRun): void;
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void>;
  getTeamsBasePath(): string;
  getAutoDetectedClaudeBasePath(): string;
  getConfiguredCliCommandLabel(): string;
  getRunRuntimeFailureLabel(run: TRun): string;
  getVerificationTimeoutMs(): number;
  extractCliLogsFromRun(run: TRun): string | undefined;
  logsSuggestShutdownOrCleanup(logs: string): boolean;
  finalizeIncompleteLaunchStateBeforeCleanup(run: TRun, fallbackReason?: string): Promise<void>;
}

export type ProcessExitSkipBeforeParserFlushReason =
  | 'finalizing_by_timeout'
  | 'failed_or_cancelled'
  | 'auth_retry_in_progress';

export type ProcessExitSkipAfterParserFlushReason =
  | 'failed'
  | 'cancelled'
  | 'process_killed'
  | 'auth_retry_in_progress';

export interface ProcessExitGuardInput {
  finalizingByTimeout: boolean;
  progressState: ProgressState;
  cancelRequested: boolean;
  authRetryInProgress: boolean;
}

export interface ProcessExitAfterParserFlushInput {
  progressState: ProgressState;
  cancelRequested: boolean;
  processKilled: boolean;
  authRetryInProgress: boolean;
}

export type ProcessExitGuardDecision<TReason extends string> =
  | { action: 'continue' }
  | { action: 'ignore'; reason: TReason };

export interface CodeZeroProvisioningValidationErrorInput {
  configFound: boolean;
  configuredTeamsBasePath: string;
  configuredConfigPath: string;
  defaultTeamsBasePath: string;
  defaultConfigPath: string;
  timeoutMs: number;
  cleanupHint?: string;
}

export type TimeoutCompletionSkipReason =
  | 'cancelled'
  | 'config_missing'
  | 'config_not_configured_root'
  | 'team_not_visible';

export type TimeoutCompletionDecision =
  | { action: 'skip'; reason: TimeoutCompletionSkipReason }
  | { action: 'complete'; warnings: string[] };

export interface TimeoutCompletionDecisionInput {
  cancelRequested: boolean;
  configProbe: ValidConfigProbeResultLike;
  visibleInList: boolean;
  missingInboxes: readonly string[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProvisioningRunFailed(run: {
  progress: Pick<TeamProvisioningProgress, 'state'>;
}): boolean {
  return run.progress.state === 'failed';
}

export function decideProcessExitBeforeParserFlush(
  input: ProcessExitGuardInput
): ProcessExitGuardDecision<ProcessExitSkipBeforeParserFlushReason> {
  if (input.finalizingByTimeout) {
    return { action: 'ignore', reason: 'finalizing_by_timeout' };
  }
  if (input.progressState === 'failed' || input.cancelRequested) {
    return { action: 'ignore', reason: 'failed_or_cancelled' };
  }
  if (input.authRetryInProgress) {
    return { action: 'ignore', reason: 'auth_retry_in_progress' };
  }
  return { action: 'continue' };
}

export function decideProcessExitAfterParserFlush(
  input: ProcessExitAfterParserFlushInput
): ProcessExitGuardDecision<ProcessExitSkipAfterParserFlushReason> {
  if (input.progressState === 'failed') {
    return { action: 'ignore', reason: 'failed' };
  }
  if (input.cancelRequested) {
    return { action: 'ignore', reason: 'cancelled' };
  }
  if (input.processKilled) {
    return { action: 'ignore', reason: 'process_killed' };
  }
  if (input.authRetryInProgress) {
    return { action: 'ignore', reason: 'auth_retry_in_progress' };
  }
  return { action: 'continue' };
}

export function hasIncompleteClaudeStdoutCarry(
  run: Pick<
    TeamProvisioningProcessExitRun,
    'stdoutParserCarry' | 'stdoutParserCarryIsCompleteJson' | 'stdoutParserCarryLooksLikeClaudeJson'
  >
): boolean {
  return Boolean(
    (typeof run.stdoutParserCarry === 'string' ? run.stdoutParserCarry.trim() : '') &&
    !run.stdoutParserCarryIsCompleteJson &&
    run.stdoutParserCarryLooksLikeClaudeJson
  );
}

export function buildCompletedProcessExitMessage(code: number | null): string {
  return code === 0
    ? 'Team process exited normally'
    : `Team process exited unexpectedly (code ${code ?? 'unknown'})`;
}

export function buildProvisionedButNotAliveWarnings(
  code: number | null,
  missingInboxes: readonly string[] = []
): string[] {
  const warnings = [
    `CLI process exited (code ${code ?? 'unknown'}) — team provisioned but not alive`,
  ];
  if (missingInboxes.length > 0) {
    warnings.push('Some inboxes not created yet');
  }
  return warnings;
}

export function buildTimeoutCompletionWarnings(missingInboxes: readonly string[] = []): string[] {
  const warnings = ['CLI timed out after config was created — team provisioned but process killed'];
  if (missingInboxes.length > 0) {
    warnings.push('Some inboxes not created yet');
  }
  return warnings;
}

export function buildCodeZeroProvisioningValidationError(
  input: CodeZeroProvisioningValidationErrorInput
): string {
  if (input.configFound) {
    return 'Team did not appear in team:list after provisioning';
  }

  const alsoCheckedDefault =
    path.resolve(input.defaultTeamsBasePath) === path.resolve(input.configuredTeamsBasePath)
      ? ''
      : ` (also checked ${input.defaultConfigPath})`;
  return `No valid config.json found at ${input.configuredConfigPath}${alsoCheckedDefault} within ${Math.round(
    input.timeoutMs / 1000
  )}s.${input.cleanupHint ?? ''}`;
}

export function decideTimeoutCompletion(
  input: TimeoutCompletionDecisionInput
): TimeoutCompletionDecision {
  if (input.cancelRequested) {
    return { action: 'skip', reason: 'cancelled' };
  }
  if (!input.configProbe.ok) {
    return { action: 'skip', reason: 'config_missing' };
  }
  if (input.configProbe.location !== 'configured') {
    return { action: 'skip', reason: 'config_not_configured_root' };
  }
  if (!input.visibleInList) {
    return { action: 'skip', reason: 'team_not_visible' };
  }
  return { action: 'complete', warnings: buildTimeoutCompletionWarnings(input.missingInboxes) };
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function waitForValidConfig(
  run: WaitForValidConfigRun,
  ports: WaitForValidConfigPorts
): Promise<ValidConfigProbeResultLike> {
  const probes = run.teamsBasePathsToProbe.map((probe) => ({
    ...probe,
    configPath: path.join(probe.basePath, run.teamName, 'config.json'),
  }));
  const sleep = ports.sleep ?? defaultSleep;
  const deadline = Date.now() + ports.timeoutMs;

  while (Date.now() < deadline) {
    if (run.cancelRequested) {
      return { ok: false };
    }
    for (const probe of probes) {
      try {
        const raw = await ports.readRegularFileUtf8(probe.configPath, {
          timeoutMs: ports.teamJsonReadTimeoutMs,
          maxBytes: ports.teamConfigMaxBytes,
        });
        if (!raw) {
          continue;
        }
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') {
          const candidate = parsed as { name?: unknown };
          if (typeof candidate.name === 'string' && candidate.name.trim().length > 0) {
            return { ok: true, location: probe.location, configPath: probe.configPath };
          }
        }
      } catch {
        // Best-effort polling until deadline.
      }
    }
    await sleep(ports.pollMs);
  }

  return { ok: false };
}

export async function waitForTeamInList(
  teamName: string,
  ports: WaitForTeamInListPorts
): Promise<boolean> {
  const sleep = ports.sleep ?? defaultSleep;
  const deadline = Date.now() + ports.timeoutMs;
  while (Date.now() < deadline) {
    if (ports.isCancelled?.()) {
      return false;
    }
    try {
      const teams = await ports.listTeams();
      if (teams.some((team) => team.teamName === teamName)) {
        return true;
      }
    } catch {
      // Keep polling until deadline.
    }
    await sleep(ports.pollMs);
  }
  return false;
}

export async function waitForMissingInboxes(
  run: WaitForMissingInboxesRun,
  ports: WaitForMissingInboxesPorts
): Promise<string[]> {
  if (run.expectedMembers.length === 0) {
    return [];
  }
  const sleep = ports.sleep ?? defaultSleep;
  const inboxDir = path.join(ports.getTeamsBasePath(), run.teamName, 'inboxes');
  const deadline = Date.now() + ports.timeoutMs;
  let missing = new Set(run.expectedMembers);

  while (Date.now() < deadline && missing.size > 0) {
    if (run.cancelRequested || run.progress.state === 'cancelled') {
      return Array.from(missing);
    }
    const nextMissing = new Set<string>();
    for (const member of missing) {
      const inboxPath = path.join(inboxDir, `${member}.json`);
      if (!(await ports.pathExists(inboxPath))) {
        nextMissing.add(member);
      }
    }
    missing = nextMissing;
    if (missing.size === 0) {
      break;
    }
    await sleep(ports.pollMs);
  }

  return Array.from(missing);
}

export async function tryCompleteAfterTimeout<TRun extends TeamProvisioningProcessExitRun>(
  run: TRun,
  ports: TeamProvisioningTimeoutCompletionPorts<TRun>
): Promise<boolean> {
  if (run.cancelRequested) {
    return false;
  }

  const configProbe = await ports.waitForValidConfig(run);
  if (!configProbe.ok || configProbe.location !== 'configured') {
    return false;
  }

  const visibleInList = await ports.waitForTeamInList(run.teamName);
  if (!visibleInList) {
    return false;
  }

  const missingInboxes = await ports.waitForMissingInboxes(run);
  const decision = decideTimeoutCompletion({
    cancelRequested: run.cancelRequested,
    configProbe,
    visibleInList,
    missingInboxes,
  });
  if (decision.action === 'skip') {
    return false;
  }

  if (!run.isLaunch) {
    await ports.persistMembersMeta(run.teamName, run.request);
  }
  await ports.updateConfigPostLaunch(
    run.teamName,
    run.request.cwd,
    run.detectedSessionId,
    run.request.color,
    {
      providerId: run.request.providerId,
      model: run.request.model,
      effort: run.request.effort,
      members: run.allEffectiveMembers,
    }
  );
  await ports.refreshMemberSpawnStatusesFromLeadInbox(run);
  await ports.maybeAuditMemberSpawnStatuses(run, { force: true });
  await ports.finalizeMissingRegisteredMembersAsFailed(run);
  await ports.persistLaunchStateSnapshot(run, 'finished');
  const progress = ports.updateProgress(
    run,
    'disconnected',
    'Team provisioned but process timed out',
    {
      warnings: decision.warnings,
    }
  );
  run.onProgress(progress);
  ports.cleanupRun(run);
  return true;
}

export async function handleProvisioningProcessExit<TRun extends TeamProvisioningProcessExitRun>(
  run: TRun,
  code: number | null,
  ports: TeamProvisioningProcessExitPorts<TRun>
): Promise<void> {
  const beforeFlushDecision = decideProcessExitBeforeParserFlush({
    finalizingByTimeout: run.finalizingByTimeout,
    progressState: run.progress.state,
    cancelRequested: run.cancelRequested,
    authRetryInProgress: run.authRetryInProgress,
  });
  if (beforeFlushDecision.action === 'ignore') {
    if (beforeFlushDecision.reason === 'auth_retry_in_progress') {
      ports.logger.info(
        `[${run.teamName}] Process exited (code ${code ?? '?'}) during auth-failure respawn — ignoring`
      );
    }
    return;
  }

  if (hasIncompleteClaudeStdoutCarry(run)) {
    ports.logger.warn(
      `[${run.teamName}] Process closed with incomplete stream-json stdout carry`,
      ports.buildStdoutCarryDiagnostic(run)
    );
  }
  ports.flushStdoutParserCarry(run);
  run.processClosed = true;

  const afterFlushDecision = decideProcessExitAfterParserFlush({
    progressState: run.progress.state,
    cancelRequested: run.cancelRequested,
    processKilled: run.processKilled,
    authRetryInProgress: run.authRetryInProgress,
  });
  if (afterFlushDecision.action === 'ignore') {
    return;
  }

  // Keep this after the auth-retry guards. During respawn, the old process exit
  // can fire after run.stallCheckHandle has already been replaced by the new process.
  ports.stopStallWatchdog(run);

  // A dead lead no longer owns its OpenCode secondary lanes. Mirror the cancel
  // and stop flows and stop the lanes before cleanup wipes their tracking —
  // otherwise the external runtime keeps orphan lane sessions that nothing in
  // the UI can stop any more.
  if (ports.hasSecondaryRuntimeRuns(run.teamName)) {
    await ports.stopMixedSecondaryRuntimeLanes(run.teamName);
  }

  if (run.provisioningComplete) {
    const message = buildCompletedProcessExitMessage(code);
    ports.logger.info(`[${run.teamName}] ${message}`);
    const progress = ports.updateProgress(run, 'disconnected', message, {
      cliLogsTail: ports.extractCliLogsFromRun(run),
    });
    run.onProgress(progress);
    ports.cleanupRun(run);
    return;
  }

  const verifyingProgress = ports.updateProgress(
    run,
    'verifying',
    'Process exited — verifying provisioning results'
  );
  run.onProgress(verifyingProgress);

  if (run.cancelRequested) {
    return;
  }

  const configProbe = await ports.waitForValidConfig(run);
  if (run.cancelRequested) {
    return;
  }

  if (configProbe.ok && configProbe.location === 'default') {
    const configuredTeamsBasePath = ports.getTeamsBasePath();
    const progress = ports.updateProgress(run, 'failed', 'Provisioning failed validation', {
      error:
        `TeamCreate produced config.json under a different Claude root (${configProbe.configPath}). ` +
        `This app is configured to read teams from ${configuredTeamsBasePath}. ` +
        'Align the app Claude root setting with the CLI, then retry.',
      cliLogsTail: ports.extractCliLogsFromRun(run),
    });
    run.onProgress(progress);
    ports.cleanupRun(run);
    return;
  }

  const visibleInList =
    configProbe.ok && configProbe.location === 'configured'
      ? await ports.waitForTeamInList(run.teamName, run)
      : false;
  if (run.cancelRequested) {
    return;
  }

  if (configProbe.ok && visibleInList) {
    const missingInboxes = await ports.waitForMissingInboxes(run);
    if (run.cancelRequested) {
      return;
    }
    const warnings = buildProvisionedButNotAliveWarnings(code, missingInboxes);
    if (!run.isLaunch) {
      await ports.persistMembersMeta(run.teamName, run.request);
    }
    const progress = ports.updateProgress(
      run,
      'disconnected',
      'Team provisioned but process is no longer alive',
      {
        warnings,
        cliLogsTail: ports.extractCliLogsFromRun(run),
      }
    );
    await ports.finalizeIncompleteLaunchStateBeforeCleanup(run, warnings[0]);
    run.onProgress(progress);
    ports.cleanupRun(run);
    return;
  }

  if (code === 0) {
    const configuredTeamsBasePath = ports.getTeamsBasePath();
    const configuredConfigPath = path.join(configuredTeamsBasePath, run.teamName, 'config.json');
    const defaultTeamsBasePath = path.join(ports.getAutoDetectedClaudeBasePath(), 'teams');
    const defaultConfigPath = path.join(defaultTeamsBasePath, run.teamName, 'config.json');
    const combinedLogs = buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer);
    const cleanupHint = ports.logsSuggestShutdownOrCleanup(combinedLogs)
      ? ' CLI output suggests the team was shut down / cleaned up, so no persisted config was left on disk.'
      : '';

    const progress = ports.updateProgress(run, 'failed', 'Provisioning failed validation', {
      error: buildCodeZeroProvisioningValidationError({
        configFound: configProbe.ok,
        configuredTeamsBasePath,
        configuredConfigPath,
        defaultTeamsBasePath,
        defaultConfigPath,
        timeoutMs: ports.getVerificationTimeoutMs(),
        cleanupHint,
      }),
      cliLogsTail: ports.extractCliLogsFromRun(run),
    });
    run.onProgress(progress);
    ports.cleanupRun(run);
    return;
  }

  const failurePresentation = buildCliExitFailurePresentation(run, code, {
    cliCommandLabel: ports.getConfiguredCliCommandLabel(),
  });
  const runtimeFailureLabel = ports.getRunRuntimeFailureLabel(run);
  const progress = ports.updateProgress(
    run,
    'failed',
    failurePresentation.message ?? `${runtimeFailureLabel} exited with an error`,
    {
      error: failurePresentation.error,
      cliLogsTail: ports.extractCliLogsFromRun(run),
    }
  );
  run.onProgress(progress);
  ports.cleanupRun(run);
  ports.logger.warn(
    `Provisioning failed for ${run.teamName}: ${progress.error ?? failurePresentation.error}`
  );
}
