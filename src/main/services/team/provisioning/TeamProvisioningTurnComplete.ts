import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { TeamTaskReader } from '../TeamTaskReader';

import {
  buildTaskBoardSnapshot,
  isTaskBoardSnapshotWorkCandidate,
  shouldUseGeminiStagedLaunch,
} from './TeamProvisioningPromptBuilders';

import type {
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamCreateRequest,
  TeamProvisioningProgress,
  TeamProvisioningState,
} from '@shared/types';
import type { ChildProcess } from 'child_process';

const logger = createLogger('Service:TeamProvisioning');

const TEAM_JSON_READ_TIMEOUT_MS = 5_000;
const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;

interface ValidConfigProbeResultLike {
  ok: boolean;
  location?: 'configured' | 'default';
  configPath?: string;
}

interface FailedSpawnMember {
  name: string;
  error?: string;
  updatedAt?: string;
}

interface LaunchSummaryLike {
  confirmedCount: number;
  pendingCount: number;
  failedCount: number;
  runtimeAlivePendingCount: number;
  runtimeProcessPendingCount?: number;
}

export interface TeamProvisioningTurnCompleteRun {
  runId: string;
  teamName: string;
  provisioningComplete: boolean;
  cancelRequested: boolean;
  processKilled: boolean;
  progress: TeamProvisioningProgress;
  apiErrorWarningEmitted: boolean;
  timeoutHandle: NodeJS.Timeout | null;
  isLaunch: boolean;
  request: TeamCreateRequest;
  detectedSessionId: string | null;
  allEffectiveMembers: TeamCreateRequest['members'];
  deterministicBootstrap: boolean;
  pendingGeminiPostLaunchHydration: boolean;
  geminiPostLaunchHydrationInFlight: boolean;
  child: ChildProcess | null | undefined;
  onProgress: (progress: TeamProvisioningProgress) => void;
}

export interface TeamProvisioningTurnCompletePorts<
  TRun extends TeamProvisioningTurnCompleteRun,
  TSecondaryLaunchResult,
> {
  hasPendingDeterministicFirstRealTurn(run: TRun): boolean;
  isProvisioningRunStillPromotable(run: TRun): boolean;
  getPreCompleteCliErrorText(run: TRun): string;
  hasApiError(text: string): boolean;
  isAuthFailureWarning(text: string, source: 'pre-complete'): boolean;
  failProvisioningWithApiError(run: TRun, text: string): void;
  handleAuthFailureInOutput(run: TRun, text: string, source: 'pre-complete'): void;
  scheduleDeterministicBootstrapCompletionRecovery(run: TRun): void;
  resetRuntimeToolActivity(run: TRun, memberName?: string): void;
  getRunLeadName(run: TRun): string;
  setLeadActivity(run: TRun, state: 'active' | 'idle' | 'offline'): void;
  stopFilesystemMonitor(run: TRun): void;
  stopStallWatchdog(run: TRun): void;
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
  ): Promise<unknown>;
  cleanupPrelaunchBackup(teamName: string): Promise<unknown>;
  refreshMemberSpawnStatusesFromLeadInbox(run: TRun): Promise<unknown>;
  maybeAuditMemberSpawnStatuses(run: TRun, options: { force: true }): Promise<unknown>;
  finalizeMissingRegisteredMembersAsFailed(run: TRun): Promise<unknown>;
  launchMixedSecondaryLaneIfNeeded(run: TRun): Promise<TSecondaryLaunchResult>;
  reconcileFinalLaunchReportingSnapshot(
    run: TRun,
    secondaryLaunchResult: TSecondaryLaunchResult
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  getFailedSpawnMembers(run: TRun): FailedSpawnMember[];
  getMemberLaunchSummary(run: TRun): LaunchSummaryLike;
  hasPendingLaunchMembers(
    run: TRun,
    launchSummary: LaunchSummaryLike,
    snapshot: PersistedTeamLaunchSnapshot | null
  ): boolean;
  isProvisioningRunPromotedToAlive(run: TRun): boolean;
  buildAggregatePendingLaunchMessage(
    prefix: string,
    run: TRun,
    launchSummary: LaunchSummaryLike,
    snapshot: PersistedTeamLaunchSnapshot | null
  ): string;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<TeamProvisioningProgress, 'cliLogsTail' | 'messageSeverity' | 'error'>
  ): TeamProvisioningProgress;
  extractCliLogsFromRun(run: TRun): string | undefined;
  provisioningRunByTeam: { delete(teamName: string): boolean };
  setAliveRunId(teamName: string, runId: string): void;
  emitTeamChange(event: TeamChangeEvent): void;
  fireTeamLaunchedNotification(run: TRun): Promise<unknown>;
  fireTeamLaunchIncompleteNotification(
    run: TRun,
    failedMembers: readonly { name: string }[],
    launchSummary: LaunchSummaryLike,
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): Promise<unknown>;
  sendMessageToRun(run: TRun, message: string): Promise<unknown>;
  relayLeadInboxMessages(teamName: string): Promise<unknown>;
  injectGeminiPostLaunchHydration(run: TRun): Promise<unknown>;
  waitForValidConfig(run: TRun, timeoutMs: number): Promise<ValidConfigProbeResultLike>;
  persistMembersMeta(teamName: string, request: TeamCreateRequest): Promise<unknown>;
  writeLaunchFailureArtifactPackBestEffort(
    run: TRun,
    options: { reason: string; launchSnapshot?: PersistedTeamLaunchSnapshot | null }
  ): void;
  killTeamProcess(child: ChildProcess | null | undefined): void;
  cleanupRun(run: TRun): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function tryReadRegularFileUtf8(
  filePath: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }

  if (!stat.isFile() || stat.size > opts.maxBytes) {
    return null;
  }

  try {
    return await readFileUtf8WithTimeout(filePath, opts.timeoutMs);
  } catch (error) {
    if (error instanceof FileReadTimeoutError) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function warnOnPostLaunchSuffixedMembers(teamName: string): Promise<void> {
  try {
    const postLaunchConfigPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const raw = await tryReadRegularFileUtf8(postLaunchConfigPath, {
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_CONFIG_MAX_BYTES,
    });
    if (!raw) {
      return;
    }
    const config = JSON.parse(raw) as {
      members?: { name?: string; agentType?: string }[];
    };
    const suffixed = (config.members ?? []).filter(
      (member) =>
        typeof member.name === 'string' && /-\d+$/.test(member.name) && !isLeadMember(member)
    );
    if (suffixed.length > 0) {
      logger.warn(
        `[${teamName}] Post-launch: detected suffixed members: ` +
          `${suffixed.map((member) => member.name).join(', ')}. ` +
          'This usually means the team was launched with stale config.json.'
      );
    }
  } catch {
    /* best-effort */
  }
}

function getFailedSpawnMembers(
  run: TeamProvisioningTurnCompleteRun,
  snapshot: PersistedTeamLaunchSnapshot | null,
  ports: Pick<
    TeamProvisioningTurnCompletePorts<TeamProvisioningTurnCompleteRun, unknown>,
    'getFailedSpawnMembers'
  >
): FailedSpawnMember[] {
  return snapshot
    ? snapshot.expectedMembers
        .filter((memberName) => snapshot.members[memberName]?.launchState === 'failed_to_start')
        .map((memberName) => ({
          name: memberName,
          error: snapshot.members[memberName]?.hardFailureReason,
          updatedAt: snapshot.members[memberName]?.lastEvaluatedAt ?? nowIso(),
        }))
    : ports.getFailedSpawnMembers(run);
}

function buildFailureNotice(failedSpawnMembers: readonly FailedSpawnMember[]): string {
  return [
    `Системное замечание: часть команды не запустилась.`,
    `Не стартовали тиммейты: ${failedSpawnMembers.map((member) => `@${member.name}`).join(', ')}.`,
    `Не считай их доступными, пока их запуск не будет повторён успешно.`,
  ].join(' ');
}

async function sendFailureNoticeIfNeeded<TRun extends TeamProvisioningTurnCompleteRun>(
  run: TRun,
  failedSpawnMembers: readonly FailedSpawnMember[],
  ports: Pick<TeamProvisioningTurnCompletePorts<TRun, unknown>, 'sendMessageToRun'>
): Promise<void> {
  if (failedSpawnMembers.length === 0) {
    return;
  }

  await ports
    .sendMessageToRun(run, buildFailureNotice(failedSpawnMembers))
    .catch((error: unknown) =>
      logger.warn(
        `[${run.teamName}] failed to send teammate-start failure notice to lead: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    );
}

function scheduleSoloTaskResumption<TRun extends TeamProvisioningTurnCompleteRun>(
  run: TRun,
  ports: Pick<TeamProvisioningTurnCompletePorts<TRun, unknown>, 'sendMessageToRun'>
): void {
  if (run.request.members.length !== 0 || shouldUseGeminiStagedLaunch(run.request.providerId)) {
    return;
  }

  void (async () => {
    try {
      const taskReader = new TeamTaskReader();
      const tasks = await taskReader.getTasks(run.teamName);
      const active = tasks.filter(isTaskBoardSnapshotWorkCandidate);
      if (active.length === 0) return;

      const board = buildTaskBoardSnapshot(tasks);
      const message = [
        `Reconnected and ready. Begin executing tasks now.`,
        `Execute tasks sequentially and keep the board + user updated:`,
        `- Identify the next READY task (pending or needsFix, not blocked by incomplete dependencies).`,
        `- If the task is unassigned, set yourself as owner.`,
        `- BEFORE doing any work on a task: mark it started (in_progress).`,
        `- Immediately SendMessage "user" that you started task #<id> (what you're doing + next step).`,
        `- While working: after each meaningful milestone/decision/blocker, add a task comment on #<id>. If user-relevant, also SendMessage "user".`,
        `- On completion: add a final task comment with your full results (findings, report, analysis, code changes summary, or any deliverable), then mark the task completed, then SendMessage "user" with a brief summary of the outcome (2-4 sentences) and "Full details in task comment <first-8-chars-of-commentId>". The task comment is the primary delivery channel — the user reads results on the task board.`,
        `- Do NOT start the next task until the current task is completed (default: one task in_progress at a time).`,
        board.trim(),
      ]
        .filter(Boolean)
        .join('\n\n');

      await ports.sendMessageToRun(run, message);
    } catch (error) {
      logger.warn(
        `[${run.teamName}] Failed to kick off solo task resumption: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  })();
}

async function runFinalLaunchReporting<
  TRun extends TeamProvisioningTurnCompleteRun,
  TSecondaryLaunchResult,
>(
  run: TRun,
  ports: TeamProvisioningTurnCompletePorts<TRun, TSecondaryLaunchResult>
): Promise<{
  persistedLaunchSnapshot: PersistedTeamLaunchSnapshot | null;
  failedSpawnMembers: FailedSpawnMember[];
  launchSummary: LaunchSummaryLike;
  hasSpawnFailures: boolean;
  hasPendingBootstrap: boolean;
}> {
  await ports.refreshMemberSpawnStatusesFromLeadInbox(run);
  await ports.maybeAuditMemberSpawnStatuses(run, { force: true });
  await ports.finalizeMissingRegisteredMembersAsFailed(run);
  const persistedLaunchSnapshot = await ports.reconcileFinalLaunchReportingSnapshot(
    run,
    await ports.launchMixedSecondaryLaneIfNeeded(run)
  );
  const failedSpawnMembers = getFailedSpawnMembers(run, persistedLaunchSnapshot, ports);
  const launchSummary = persistedLaunchSnapshot?.summary ?? ports.getMemberLaunchSummary(run);
  const hasSpawnFailures = failedSpawnMembers.length > 0;
  const hasPendingBootstrap =
    !hasSpawnFailures && ports.hasPendingLaunchMembers(run, launchSummary, persistedLaunchSnapshot);

  return {
    persistedLaunchSnapshot,
    failedSpawnMembers,
    launchSummary,
    hasSpawnFailures,
    hasPendingBootstrap,
  };
}

function promoteRunToReady<TRun extends TeamProvisioningTurnCompleteRun>(
  run: TRun,
  message: string,
  messageSeverity: TeamProvisioningProgress['messageSeverity'],
  ports: TeamProvisioningTurnCompletePorts<TRun, unknown>
): void {
  const progress = ports.updateProgress(run, 'ready', message, {
    cliLogsTail: ports.extractCliLogsFromRun(run),
    messageSeverity,
  });
  run.onProgress(progress);
  ports.provisioningRunByTeam.delete(run.teamName);
  ports.setAliveRunId(run.teamName, run.runId);
}

async function maybeInjectGeminiPostLaunchHydration<TRun extends TeamProvisioningTurnCompleteRun>(
  run: TRun,
  ports: Pick<TeamProvisioningTurnCompletePorts<TRun, unknown>, 'injectGeminiPostLaunchHydration'>
): Promise<void> {
  if (
    run.pendingGeminiPostLaunchHydration &&
    !run.geminiPostLaunchHydrationInFlight &&
    !run.cancelRequested
  ) {
    void ports.injectGeminiPostLaunchHydration(run);
  }
}

function emitLeadSessionSync<TRun extends TeamProvisioningTurnCompleteRun>(
  run: TRun,
  ports: Pick<TeamProvisioningTurnCompletePorts<TRun, unknown>, 'emitTeamChange'>
): void {
  ports.emitTeamChange({
    type: 'lead-message',
    teamName: run.teamName,
    runId: run.runId,
    detail: 'lead-session-sync',
  });
}

export async function handleTeamProvisioningTurnComplete<
  TRun extends TeamProvisioningTurnCompleteRun,
  TSecondaryLaunchResult,
>(
  run: TRun,
  ports: TeamProvisioningTurnCompletePorts<TRun, TSecondaryLaunchResult>
): Promise<void> {
  if (
    run.provisioningComplete ||
    run.cancelRequested ||
    run.processKilled ||
    run.progress.state === 'failed'
  ) {
    return;
  }
  if (
    ports.hasPendingDeterministicFirstRealTurn(run) ||
    !ports.isProvisioningRunStillPromotable(run)
  ) {
    return;
  }

  const preCompleteText = ports.getPreCompleteCliErrorText(run);
  if (
    preCompleteText &&
    ports.hasApiError(preCompleteText) &&
    !ports.isAuthFailureWarning(preCompleteText, 'pre-complete') &&
    !run.apiErrorWarningEmitted
  ) {
    ports.failProvisioningWithApiError(run, preCompleteText);
    return;
  }
  if (preCompleteText && ports.isAuthFailureWarning(preCompleteText, 'pre-complete')) {
    ports.handleAuthFailureInOutput(run, preCompleteText, 'pre-complete');
    return;
  }

  run.provisioningComplete = true;
  ports.scheduleDeterministicBootstrapCompletionRecovery(run);
  ports.resetRuntimeToolActivity(run, ports.getRunLeadName(run));
  ports.setLeadActivity(run, 'idle');

  if (run.timeoutHandle) {
    clearTimeout(run.timeoutHandle);
    run.timeoutHandle = null;
  }
  ports.stopFilesystemMonitor(run);
  ports.stopStallWatchdog(run);

  if (run.isLaunch) {
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
    await ports.cleanupPrelaunchBackup(run.teamName);

    await warnOnPostLaunchSuffixedMembers(run.teamName);

    const {
      persistedLaunchSnapshot,
      failedSpawnMembers,
      launchSummary,
      hasSpawnFailures,
      hasPendingBootstrap,
    } = await runFinalLaunchReporting(run, ports);
    if (
      ports.isProvisioningRunPromotedToAlive(run) ||
      !ports.isProvisioningRunStillPromotable(run)
    ) {
      return;
    }
    const readyMessage = hasSpawnFailures
      ? `Launch completed with teammate errors — ${failedSpawnMembers
          .map((member) => member.name)
          .join(', ')} failed to start`
      : hasPendingBootstrap
        ? ports.buildAggregatePendingLaunchMessage(
            'Launch completed',
            run,
            launchSummary,
            persistedLaunchSnapshot
          )
        : 'Team launched — process alive and ready';
    promoteRunToReady(
      run,
      readyMessage,
      hasSpawnFailures || hasPendingBootstrap ? 'warning' : undefined,
      ports
    );
    logger.info(`[${run.teamName}] Launch complete. Process alive for subsequent tasks.`);

    if (!run.deterministicBootstrap && shouldUseGeminiStagedLaunch(run.request.providerId)) {
      run.pendingGeminiPostLaunchHydration = true;
    }

    emitLeadSessionSync(run, ports);

    if (!hasSpawnFailures && !hasPendingBootstrap) {
      void ports.fireTeamLaunchedNotification(run);
    } else {
      void ports.fireTeamLaunchIncompleteNotification(
        run,
        failedSpawnMembers,
        launchSummary,
        persistedLaunchSnapshot
      );
    }

    await sendFailureNoticeIfNeeded(run, failedSpawnMembers, ports);

    void ports
      .relayLeadInboxMessages(run.teamName)
      .catch((error: unknown) =>
        logger.warn(`[${run.teamName}] post-reconnect relay failed: ${String(error)}`)
      );

    scheduleSoloTaskResumption(run, ports);
    await maybeInjectGeminiPostLaunchHydration(run, ports);
    return;
  }

  const configProbe = await ports.waitForValidConfig(run, 5000);
  if (!configProbe.ok) {
    logger.warn(
      `[${run.teamName}] Provisioning turn completed but no config.json found — marking ready anyway`
    );
  }

  if (configProbe.ok && configProbe.location === 'default') {
    const configuredTeamsBasePath = getTeamsBasePath();
    const progress = ports.updateProgress(run, 'failed', 'Provisioning failed validation', {
      error:
        `TeamCreate produced config.json under a different Claude root (${configProbe.configPath}). ` +
        `This app is configured to read teams from ${configuredTeamsBasePath}. ` +
        'Align the app Claude root setting with the CLI, then retry.',
      cliLogsTail: ports.extractCliLogsFromRun(run),
    });
    run.onProgress(progress);
    run.processKilled = true;
    ports.killTeamProcess(run.child);
    ports.cleanupRun(run);
    return;
  }

  await ports.persistMembersMeta(run.teamName, run.request);
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

  const {
    persistedLaunchSnapshot,
    failedSpawnMembers,
    launchSummary,
    hasSpawnFailures,
    hasPendingBootstrap,
  } = await runFinalLaunchReporting(run, ports);
  if (ports.isProvisioningRunPromotedToAlive(run) || !ports.isProvisioningRunStillPromotable(run)) {
    return;
  }
  promoteRunToReady(
    run,
    hasSpawnFailures
      ? `Provisioning completed with teammate errors — ${failedSpawnMembers
          .map((member) => member.name)
          .join(', ')} failed to start`
      : hasPendingBootstrap
        ? ports.buildAggregatePendingLaunchMessage(
            'Team provisioned',
            run,
            launchSummary,
            persistedLaunchSnapshot
          )
        : 'Team provisioned — process alive and ready',
    hasSpawnFailures || hasPendingBootstrap ? 'warning' : undefined,
    ports
  );
  if (hasSpawnFailures) {
    ports.writeLaunchFailureArtifactPackBestEffort(run, {
      reason: run.isLaunch
        ? 'launch_completed_with_teammate_errors'
        : 'provisioning_completed_with_teammate_errors',
      launchSnapshot: persistedLaunchSnapshot,
    });
  }
  logger.info(`[${run.teamName}] Provisioning complete. Process alive for subsequent tasks.`);

  if (!run.deterministicBootstrap && shouldUseGeminiStagedLaunch(run.request.providerId)) {
    run.pendingGeminiPostLaunchHydration = true;
  }

  emitLeadSessionSync(run, ports);

  if (!hasSpawnFailures && !hasPendingBootstrap) {
    void ports.fireTeamLaunchedNotification(run);
  } else {
    void ports.fireTeamLaunchIncompleteNotification(
      run,
      failedSpawnMembers,
      launchSummary,
      persistedLaunchSnapshot
    );
  }

  await sendFailureNoticeIfNeeded(run, failedSpawnMembers, ports);

  void ports
    .relayLeadInboxMessages(run.teamName)
    .catch((error: unknown) =>
      logger.warn(`[${run.teamName}] post-provisioning relay failed: ${String(error)}`)
    );
  await maybeInjectGeminiPostLaunchHydration(run, ports);
}
