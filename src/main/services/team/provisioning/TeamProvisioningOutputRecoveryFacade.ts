import {
  createTeamProvisioningAuthRetryRecoveryBoundary,
  type TeamProvisioningAuthRetryRecoveryBoundary,
  type TeamProvisioningAuthRetryRecoveryBoundaryDeps,
  type TeamProvisioningAuthRetryRecoveryServiceAdapter,
} from './TeamProvisioningAuthRetryRecoveryBoundaryFactory';
import {
  createTeamProvisioningOutputRecoveryBoundary,
  type TeamProvisioningOutputRecoveryBoundary,
  type TeamProvisioningOutputRecoveryBoundaryDeps,
  type TeamProvisioningOutputRecoveryBoundaryRun,
  type TeamProvisioningOutputRecoveryServiceAdapter,
} from './TeamProvisioningOutputRecoveryBoundaryFactory';
import { type TeamProvisioningProviderRuntimeFacade } from './TeamProvisioningProviderRuntimeFacade';

import type { TeamProvisioningAuthRetryRun } from './TeamProvisioningAuthRetryRecovery';

export type TeamProvisioningOutputRecoveryFacadeRun = TeamProvisioningOutputRecoveryBoundaryRun &
  TeamProvisioningAuthRetryRun;

type OutputRecoveryFacadeServiceAdapter<
  TRun extends TeamProvisioningOutputRecoveryFacadeRun,
> = Omit<TeamProvisioningOutputRecoveryServiceAdapter<TRun>, 'respawnAfterAuthFailure'>;

type AuthRetryFacadeServiceAdapter<
  TRun extends TeamProvisioningOutputRecoveryFacadeRun,
> = Omit<
  TeamProvisioningAuthRetryRecoveryServiceAdapter<TRun>,
  'stopStallWatchdog' | 'attachStdoutHandler' | 'attachStderrHandler' | 'startStallWatchdog'
>;

export type TeamProvisioningOutputRecoveryFacadeServiceAdapter<
  TRun extends TeamProvisioningOutputRecoveryFacadeRun,
> = OutputRecoveryFacadeServiceAdapter<TRun> & AuthRetryFacadeServiceAdapter<TRun>;

export interface TeamProvisioningOutputRecoveryFacadeDeps<
  TRun extends TeamProvisioningOutputRecoveryFacadeRun,
> {
  service: TeamProvisioningOutputRecoveryFacadeServiceAdapter<TRun>;
  logger: TeamProvisioningOutputRecoveryBoundaryDeps<TRun>['logger'] &
    TeamProvisioningAuthRetryRecoveryBoundaryDeps<TRun>['logger'];
  mcpConfigBuilder: TeamProvisioningAuthRetryRecoveryBoundaryDeps<TRun>['mcpConfigBuilder'];
  providerRuntime: Pick<TeamProvisioningProviderRuntimeFacade, 'validateAgentTeamsMcpRuntime'>;
  killTeamProcess: TeamProvisioningAuthRetryRecoveryBoundaryDeps<TRun>['killTeamProcess'];
  updateProgress: TeamProvisioningAuthRetryRecoveryBoundaryDeps<TRun>['updateProgress'];
  nowMs?: TeamProvisioningOutputRecoveryBoundaryDeps<TRun>['nowMs'];
  nowIso?: TeamProvisioningOutputRecoveryBoundaryDeps<TRun>['nowIso'];
  setInterval?: TeamProvisioningOutputRecoveryBoundaryDeps<TRun>['setInterval'];
  clearInterval?: TeamProvisioningOutputRecoveryBoundaryDeps<TRun>['clearInterval'];
}

export class TeamProvisioningOutputRecoveryFacade<
    TRun extends TeamProvisioningOutputRecoveryFacadeRun,
  >
  implements
    TeamProvisioningOutputRecoveryBoundary<TRun>,
    TeamProvisioningAuthRetryRecoveryBoundary<TRun>
{
  private readonly outputRecoveryBoundary: TeamProvisioningOutputRecoveryBoundary<TRun>;
  private readonly authRetryRecoveryBoundary: TeamProvisioningAuthRetryRecoveryBoundary<TRun>;

  constructor(deps: TeamProvisioningOutputRecoveryFacadeDeps<TRun>) {
    this.outputRecoveryBoundary = createTeamProvisioningOutputRecoveryBoundary<TRun>({
      service: {
        updateProgress: (run, state, message, extras) =>
          deps.service.updateProgress(run, state, message, extras),
        emitLogsProgress: (run) => deps.service.emitLogsProgress(run),
        killTeamProcess: (child) => deps.service.killTeamProcess(child),
        cleanupRun: (run) => deps.service.cleanupRun(run),
        respawnAfterAuthFailure: (run) => this.respawnAfterAuthFailure(run),
        appendCliLogs: (run, stream, text) => deps.service.appendCliLogs(run, stream, text),
        handleStreamJsonMessage: (run, msg) => deps.service.handleStreamJsonMessage(run, msg),
        shiftProvisioningOutputIndexesAfterRemoval: (run, removedIndex) =>
          deps.service.shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex),
      },
      logger: deps.logger,
      nowMs: deps.nowMs,
      nowIso: deps.nowIso,
      setInterval: deps.setInterval,
      clearInterval: deps.clearInterval,
    });

    this.authRetryRecoveryBoundary = createTeamProvisioningAuthRetryRecoveryBoundary<TRun>({
      service: {
        getStopAllTeamsGeneration: () => deps.service.getStopAllTeamsGeneration(),
        stopFilesystemMonitor: (run) => deps.service.stopFilesystemMonitor(run),
        stopStallWatchdog: (run) => this.stopStallWatchdog(run),
        cleanupRun: (run) => deps.service.cleanupRun(run),
        attachStdoutHandler: (run) => this.attachStdoutHandler(run),
        attachStderrHandler: (run) => this.attachStderrHandler(run),
        startStallWatchdog: (run) => this.startStallWatchdog(run),
        startFilesystemMonitor: (run, request) =>
          deps.service.startFilesystemMonitor(run, request),
        tryCompleteAfterTimeout: (run) => deps.service.tryCompleteAfterTimeout(run),
        handleProcessExit: (run, code) => deps.service.handleProcessExit(run, code),
      },
      logger: deps.logger,
      mcpConfigBuilder: deps.mcpConfigBuilder,
      providerRuntime: deps.providerRuntime,
      killTeamProcess: deps.killTeamProcess,
      updateProgress: deps.updateProgress,
    });
  }

  failProvisioningWithApiError(run: TRun, source: string): void {
    this.outputRecoveryBoundary.failProvisioningWithApiError(run, source);
  }

  emitApiErrorWarning(run: TRun, text: string): void {
    this.outputRecoveryBoundary.emitApiErrorWarning(run, text);
  }

  startStallWatchdog(run: TRun): void {
    this.outputRecoveryBoundary.startStallWatchdog(run);
  }

  stopStallWatchdog(run: TRun): void {
    this.outputRecoveryBoundary.stopStallWatchdog(run);
  }

  handleAuthFailureInOutput(
    run: TRun,
    text: string,
    source: Parameters<TeamProvisioningOutputRecoveryBoundary<TRun>['handleAuthFailureInOutput']>[2]
  ): void {
    this.outputRecoveryBoundary.handleAuthFailureInOutput(run, text, source);
  }

  async respawnAfterAuthFailure(run: TRun): Promise<void> {
    await this.authRetryRecoveryBoundary.respawnAfterAuthFailure(run);
  }

  attachStdoutHandler(run: TRun): void {
    this.outputRecoveryBoundary.attachStdoutHandler(run);
  }

  updateStdoutParserCarry(run: TRun, carry: string): void {
    this.outputRecoveryBoundary.updateStdoutParserCarry(run, carry);
  }

  flushStdoutParserCarry(run: TRun): void {
    this.outputRecoveryBoundary.flushStdoutParserCarry(run);
  }

  buildStdoutCarryDiagnostic(run: TRun): Record<string, unknown> {
    return this.outputRecoveryBoundary.buildStdoutCarryDiagnostic(run);
  }

  getUnconfirmedBootstrapMemberNames(run: TRun): string[] {
    return this.outputRecoveryBoundary.getUnconfirmedBootstrapMemberNames(run);
  }

  handleStdoutParserLine(run: TRun, trimmed: string): void {
    this.outputRecoveryBoundary.handleStdoutParserLine(run, trimmed);
  }

  handleParsedStdoutJsonMessage(run: TRun, msg: Record<string, unknown>): void {
    this.outputRecoveryBoundary.handleParsedStdoutJsonMessage(run, msg);
  }

  attachStderrHandler(run: TRun): void {
    this.outputRecoveryBoundary.attachStderrHandler(run);
  }
}
