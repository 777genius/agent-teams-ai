import { createLogger } from '@shared/utils/logger';

import {
  TeamProvisioningLiveMessageRelayCompatibilityFacade,
  type TeamProvisioningLiveMessageRelayCompatibilityRun,
} from './TeamProvisioningLiveMessageRelayCompatibilityFacade';
import { killTeamProcess, updateProgress } from './TeamProvisioningRunProgress';
import { type TeamProvisioningRunTrackingDeliveryHelper } from './TeamProvisioningRunTrackingDelivery';
import {
  createTeamProvisioningStreamEventPortsBoundary,
  type TeamProvisioningStreamEventOutputRecoveryAdapter,
  type TeamProvisioningStreamEventPersistentRuntimeCleanupAdapter,
  type TeamProvisioningStreamEventPortsFactoryRun,
  type TeamProvisioningStreamEventServiceAdapter,
} from './TeamProvisioningStreamEventPortsFactory';
import {
  handleTeamProvisioningStreamJsonMessage,
  type TeamProvisioningStreamEventPorts,
} from './TeamProvisioningStreamEvents';
import { captureTeamSpawnEvents as captureTeamSpawnEventsHelper } from './TeamProvisioningStreamSpawnEvents';
import { handleTeamProvisioningTurnComplete } from './TeamProvisioningTurnComplete';
import {
  createTeamProvisioningTurnCompletePorts,
  type TeamProvisioningTurnCompleteOutputRecoveryAdapter,
  type TeamProvisioningTurnCompletePortsFactoryRun,
  type TeamProvisioningTurnCompleteServiceAdapter,
} from './TeamProvisioningTurnCompletePortsFactory';

import type { InboxMessage, PersistedTeamLaunchSnapshot, TeamChangeEvent } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export type TeamProvisioningStreamTurnCompatibilityRun =
  TeamProvisioningLiveMessageRelayCompatibilityRun &
    TeamProvisioningStreamEventPortsFactoryRun &
    TeamProvisioningTurnCompletePortsFactoryRun;

export abstract class TeamProvisioningStreamTurnCompatibilityFacade<
  TRun extends TeamProvisioningStreamTurnCompatibilityRun =
    TeamProvisioningStreamTurnCompatibilityRun,
> extends TeamProvisioningLiveMessageRelayCompatibilityFacade<TRun> {
  protected abstract readonly persistentRuntimeCleanup: TeamProvisioningStreamEventPersistentRuntimeCleanupAdapter<TRun>;
  protected abstract readonly outputRecoveryFacade: TeamProvisioningStreamEventOutputRecoveryAdapter<TRun> &
    TeamProvisioningTurnCompleteOutputRecoveryAdapter<TRun, PersistedTeamLaunchSnapshot | null>;
  protected abstract readonly provisioningRunByTeam: { delete(teamName: string): boolean };
  protected abstract readonly runTracking: Pick<
    TeamProvisioningRunTrackingDeliveryHelper<TRun>,
    | 'canDeliverToOpenCodeRuntimeForTeam'
    | 'getAliveRunId'
    | 'getAliveTeamNames'
    | 'getTrackedRunId'
    | 'setAliveRunId'
  >;
  protected abstract teamChangeEmitter: ((event: TeamChangeEvent) => void) | null;

  /**
   * Intercept Task tool_use blocks that spawn team members.
   * Sets member spawn status to 'spawning' when the lead issues a Task call with team_name + name.
   */
  protected captureTeamSpawnEvents(run: TRun, content: Record<string, unknown>[]): void {
    captureTeamSpawnEventsHelper(run, content, {
      logger,
      setMemberSpawnStatus: (targetRun, memberName, status, error) =>
        this.setMemberSpawnStatus(targetRun as TRun, memberName, status, error),
      appendMemberBootstrapDiagnostic: (targetRun, memberName, detail) =>
        this.appendMemberBootstrapDiagnostic(targetRun as TRun, memberName, detail),
      updateProgress,
    });
  }

  /**
   * Intercept SendMessage tool_use blocks from the lead stream-json output.
   * Persisting them here keeps Messages accurate even if the provider resumes with stale team context.
   */
  protected captureSendMessages(run: TRun, content: Record<string, unknown>[]): void {
    this.liveLeadMessagePortsBoundary.captureSendMessages(run, content);
  }

  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void {
    this.liveLeadMessagePortsBoundary.pushLiveLeadProcessMessage(teamName, message);
  }

  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null {
    return this.liveLeadMessagePortsBoundary.resolveCrossTeamReplyMetadata(teamName, toTeam);
  }

  protected resetLiveLeadTextBuffer(run: TRun): void {
    this.liveLeadMessagePortsBoundary.resetLiveLeadTextBuffer(run);
  }

  /**
   * Create an InboxMessage from assistant text and push it into the live cache.
   * Used for both pre-ready provisioning and post-ready assistant text.
   */
  protected appendProvisioningAssistantText(
    run: TRun,
    msg: Record<string, unknown>,
    text: string
  ): void {
    this.liveLeadMessagePortsBoundary.appendProvisioningAssistantText(run, msg, text);
  }

  protected shiftProvisioningOutputIndexesAfterRemoval(run: TRun, removedIndex: number): void {
    this.liveLeadMessagePortsBoundary.shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex);
  }

  protected pushLiveLeadTextMessage(
    run: TRun,
    cleanText: string,
    stableMessageId?: string,
    messageTimestamp?: string,
    options?: { coalesceStreamChunk?: boolean }
  ): void {
    this.liveLeadMessagePortsBoundary.pushLiveLeadTextMessage(
      run,
      cleanText,
      stableMessageId,
      messageTimestamp,
      options
    );
  }

  /**
   * Process a parsed stream-json message from stdout.
   * Extracts assistant text for progress reporting and detects turn completion.
   */
  protected handleStreamJsonMessage(run: TRun, msg: Record<string, unknown>): void {
    handleTeamProvisioningStreamJsonMessage(run, msg, this.getStreamJsonEventPorts());
  }

  private getStreamJsonEventPorts(): TeamProvisioningStreamEventPorts<TRun> {
    return createTeamProvisioningStreamEventPortsBoundary({
      service: this as unknown as TeamProvisioningStreamEventServiceAdapter<TRun>,
      persistentRuntimeCleanup: this.persistentRuntimeCleanup,
      outputRecovery: this.outputRecoveryFacade,
      updateProgress,
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
    });
  }

  protected completeProvisioningFromSuccessfulResult(run: TRun): void {
    if (run.provisioningComplete || run.cancelRequested) {
      return;
    }

    void this.handleProvisioningTurnComplete(run).catch((err: unknown) => {
      logger.error(
        `[${run.teamName}] handleProvisioningTurnComplete threw unexpectedly: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }

  /**
   * Called once provisioning has a promotable readiness signal.
   * For deterministic runs with a deferred first task, that signal must be result.success.
   * Process stays alive for subsequent tasks.
   */
  protected async handleProvisioningTurnComplete(run: TRun): Promise<void> {
    await handleTeamProvisioningTurnComplete(run, this.getProvisioningTurnCompletePorts());
  }

  private getProvisioningTurnCompletePorts() {
    return createTeamProvisioningTurnCompletePorts<TRun, PersistedTeamLaunchSnapshot | null>({
      service: this as unknown as TeamProvisioningTurnCompleteServiceAdapter<
        TRun,
        PersistedTeamLaunchSnapshot | null
      >,
      outputRecovery: this.outputRecoveryFacade,
      config: {
        updateConfigPostLaunch: (teamName, cwd, detectedSessionId, color, options) =>
          this.updateConfigPostLaunch(teamName, cwd, detectedSessionId, color, options),
        cleanupPrelaunchBackup: (teamName) => this.cleanupPrelaunchBackup(teamName),
        persistMembersMeta: (teamName, request) => this.persistMembersMeta(teamName, request),
      },
      updateProgress,
      provisioningRunByTeam: this.provisioningRunByTeam,
      setAliveRunId: (teamName, runId) => this.runTracking.setAliveRunId(teamName, runId),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      killTeamProcess,
    });
  }
}
