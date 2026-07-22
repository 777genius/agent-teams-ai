import { buildCombinedLogs } from './TeamProvisioningCliExitPresentation';
import {
  buildStallProgressMessage,
  buildStallWarningText,
  extractApiErrorSnippet,
  hasApiError,
  isAuthFailureWarning,
} from './TeamProvisioningOutputErrorPolicy';
import {
  createTeamProvisioningOutputRecoveryHelper,
  type TeamProvisioningOutputRecoveryHelper,
  type TeamProvisioningOutputRecoveryPorts,
  type TeamProvisioningOutputRecoveryRun,
} from './TeamProvisioningOutputRecovery';
import {
  boundRunProvisioningOutputParts,
  boundStdoutParserCarry,
  buildProvisioningLiveOutput,
  type TeamProvisioningTraceRun,
} from './TeamProvisioningProgressBuffers';
import { looksLikeClaudeStdoutJsonFragment } from './TeamProvisioningProgressState';
import { PREFLIGHT_AUTH_RETRY_DELAY_MS } from './TeamProvisioningProviderDiagnostics';
import { extractCliLogsFromRun } from './TeamProvisioningRetainedLogs';

const STDERR_RING_LIMIT = 64 * 1024;
const STDOUT_RING_LIMIT = 64 * 1024;
const LOG_PROGRESS_THROTTLE_MS = 1000;
const STALL_CHECK_INTERVAL_MS = 10_000;
const STALL_WARNING_THRESHOLD_MS = 20_000;

export type TeamProvisioningOutputRecoveryBoundary<
  TRun extends TeamProvisioningOutputRecoveryBoundaryRun,
> = TeamProvisioningOutputRecoveryHelper<TRun>;

export type TeamProvisioningOutputRecoveryBoundaryRun = TeamProvisioningOutputRecoveryRun &
  TeamProvisioningTraceRun;

export type TeamProvisioningOutputRecoveryServiceAdapter<
  TRun extends TeamProvisioningOutputRecoveryBoundaryRun,
> = Pick<
  TeamProvisioningOutputRecoveryPorts<TRun>,
  | 'updateProgress'
  | 'emitLogsProgress'
  | 'killTeamProcess'
  | 'cleanupRun'
  | 'respawnAfterAuthFailure'
  | 'appendCliLogs'
  | 'handleStreamJsonMessage'
  | 'shiftProvisioningOutputIndexesAfterRemoval'
>;

export interface TeamProvisioningOutputRecoveryBoundaryDeps<
  TRun extends TeamProvisioningOutputRecoveryBoundaryRun,
> {
  service: TeamProvisioningOutputRecoveryServiceAdapter<TRun>;
  logger: TeamProvisioningOutputRecoveryPorts<TRun>['logger'];
  nowMs?: TeamProvisioningOutputRecoveryPorts<TRun>['nowMs'];
  nowIso?: TeamProvisioningOutputRecoveryPorts<TRun>['nowIso'];
  setInterval?: TeamProvisioningOutputRecoveryPorts<TRun>['setInterval'];
  clearInterval?: TeamProvisioningOutputRecoveryPorts<TRun>['clearInterval'];
}

export function createTeamProvisioningOutputRecoveryBoundary<
  TRun extends TeamProvisioningOutputRecoveryBoundaryRun,
>(
  deps: TeamProvisioningOutputRecoveryBoundaryDeps<TRun>
): TeamProvisioningOutputRecoveryBoundary<TRun> {
  return createTeamProvisioningOutputRecoveryHelper<TRun>(
    {
      logger: deps.logger,
      nowMs: deps.nowMs ?? (() => Date.now()),
      nowIso: deps.nowIso ?? (() => new Date().toISOString()),
      setInterval: deps.setInterval ?? ((callback, ms) => setInterval(callback, ms)),
      clearInterval: deps.clearInterval ?? ((handle) => clearInterval(handle)),
      buildCombinedLogs,
      extractApiErrorSnippet,
      hasApiError,
      isAuthFailureWarning,
      buildStallWarningText,
      buildStallProgressMessage,
      boundStdoutParserCarry,
      looksLikeClaudeStdoutJsonFragment,
      boundRunProvisioningOutputParts,
      buildProvisioningLiveOutput,
      extractCliLogsFromRun,
      updateProgress: (run, state, message, extras) =>
        deps.service.updateProgress(run, state, message, extras),
      emitLogsProgress: (run) => deps.service.emitLogsProgress(run),
      killTeamProcess: (child) => deps.service.killTeamProcess(child),
      cleanupRun: (run) => deps.service.cleanupRun(run),
      respawnAfterAuthFailure: (run) => deps.service.respawnAfterAuthFailure(run),
      appendCliLogs: (run, stream, text) => deps.service.appendCliLogs(run, stream, text),
      handleStreamJsonMessage: (run, msg) => deps.service.handleStreamJsonMessage(run, msg),
      shiftProvisioningOutputIndexesAfterRemoval: (run, removedIndex) =>
        deps.service.shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex),
    },
    {
      stderrRingLimit: STDERR_RING_LIMIT,
      stdoutRingLimit: STDOUT_RING_LIMIT,
      logProgressThrottleMs: LOG_PROGRESS_THROTTLE_MS,
      stallCheckIntervalMs: STALL_CHECK_INTERVAL_MS,
      stallWarningThresholdMs: STALL_WARNING_THRESHOLD_MS,
      preflightAuthRetryDelayMs: PREFLIGHT_AUTH_RETRY_DELAY_MS,
    }
  );
}
