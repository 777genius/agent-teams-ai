import { createLogger } from '@shared/utils/logger';

import { type OpenCodeRuntimeMessageAdapter } from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import {
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import { type OpenCodeVisibleReplyProof } from '../opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { type OpenCodePromptDeliveryWatchdogCoordinator } from '../opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { type OpenCodePromptDeliveryWatchdogScheduler } from '../opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import { type OpenCodeRuntimeDeliveryAdvisoryDecision } from '../opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';

import { TeamProvisioningMemberMcpLaunchConfigCompatibilityFacade } from './TeamProvisioningMemberMcpLaunchConfigCompatibilityFacade';
import { type TeamProvisioningOpenCodeRuntimeDeliveryAdvisory } from './TeamProvisioningOpenCodeRuntimeDeliveryAdvisory';
import {
  type OpenCodeRuntimePermissionSyncInput,
  type OpenCodeRuntimePermissionSyncServiceHost,
  syncOpenCodeRuntimePermissionsAfterDeliveryWithService,
} from './TeamProvisioningOpenCodeRuntimePermissions';
import {
  rememberOpenCodeRuntimePidFromBridge as rememberOpenCodeRuntimePidFromBridgeHelper,
  type RememberOpenCodeRuntimePidFromBridgeInput,
  type RememberOpenCodeRuntimePidFromBridgePorts,
} from './TeamProvisioningOpenCodeRuntimePidBridge';
import { type ProvisioningRun } from './TeamProvisioningRunModel';

import type { OpenCodeTeamRuntimeMessageInput, OpenCodeTeamRuntimeMessageResult } from '../runtime';
import type { AgentActionMode, InboxMessage, TaskRef } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

type OpenCodeDeliveryResponseState = NonNullable<
  OpenCodeTeamRuntimeMessageResult['responseObservation']
>['state'];

export abstract class TeamProvisioningOpenCodePromptDeliveryCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningMemberMcpLaunchConfigCompatibilityFacade<TRun> {
  protected abstract readonly openCodePromptDeliveryWatchdogCoordinator: OpenCodePromptDeliveryWatchdogCoordinator;
  protected abstract readonly openCodePromptDeliveryWatchdogScheduler: OpenCodePromptDeliveryWatchdogScheduler;
  protected abstract readonly openCodeRuntimeDeliveryAdvisory: Pick<
    TeamProvisioningOpenCodeRuntimeDeliveryAdvisory,
    | 'handleUserFacingSideEffects'
    | 'logPromptDeliveryEvent'
    | 'emitPromptDeliveryTaskLogChange'
    | 'decideUserFacingAdvisory'
    | 'emitRuntimeDeliveryReplyAdvisoryRefresh'
  >;
  protected abstract readonly openCodeRuntimePidBridgePorts: RememberOpenCodeRuntimePidFromBridgePorts;

  protected async handleOpenCodeRuntimeDeliveryUserFacingSideEffects(
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<void> {
    await this.openCodeRuntimeDeliveryAdvisory.handleUserFacingSideEffects(record);
  }

  protected async isOpenCodeDeliveryResponseReadCommitAllowed(input: {
    teamName?: string;
    memberName?: string;
    responseState?: OpenCodeDeliveryResponseState;
    actionMode?: AgentActionMode;
    taskRefs?: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  }): Promise<boolean> {
    return this.openCodePromptDeliveryWatchdogCoordinator.isDeliveryResponseReadCommitAllowed(
      input
    );
  }

  protected async isLegacyOpenCodeMemberWorkSyncReadCommitAllowed(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: OpenCodeTeamRuntimeMessageInput['workSyncIntent'];
    responseObservation?: NonNullable<OpenCodeTeamRuntimeMessageResult['responseObservation']>;
  }): Promise<boolean> {
    return this.openCodePromptDeliveryWatchdogCoordinator.isLegacyMemberWorkSyncReadCommitAllowed(
      input
    );
  }

  protected getOpenCodeDeliveryPendingReason(input: {
    responseState?: OpenCodeDeliveryResponseState;
    actionMode?: AgentActionMode | null;
    taskRefs?: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  }): string {
    return this.openCodePromptDeliveryWatchdogCoordinator.getDeliveryPendingReason(input);
  }

  protected async markOpenCodeAcceptedDeliveryMissingPromptProofForRetry(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return this.openCodePromptDeliveryWatchdogCoordinator.markAcceptedDeliveryMissingPromptProofForRetry(
      input
    );
  }

  protected async requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return this.openCodePromptDeliveryWatchdogCoordinator.requeueNoAssistantTerminalDeliveryIfNeeded(
      input
    );
  }

  protected async requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return this.openCodePromptDeliveryWatchdogCoordinator.requeueRuntimeManifestWatermarkDeliveryIfNeeded(
      input
    );
  }

  protected async markOpenCodePromptLedgerFailedTerminal(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    id: string;
    reason: string;
    diagnostics?: string[];
    failedAt: string;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return this.openCodePromptDeliveryWatchdogCoordinator.markLedgerFailedTerminal(input);
  }

  protected async observeOpenCodeDirectUserDeliveryInlineIfNeeded(input: {
    adapter: OpenCodeRuntimeMessageAdapter;
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    memberName: string;
    laneId: string;
    cwd: string;
    text: string;
    messageId: string;
    runtimeRunId?: string | null;
    replyRecipient?: string | null;
    actionMode?: AgentActionMode;
    messageKind?: OpenCodeTeamRuntimeMessageInput['messageKind'];
    workSyncIntent?: OpenCodeTeamRuntimeMessageInput['workSyncIntent'];
    workSyncReviewRequestEventIds?: string[];
    taskRefs?: TaskRef[];
    promptAccepted: boolean;
    visibleReply?: OpenCodeVisibleReplyProof | null;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }> {
    return this.openCodePromptDeliveryWatchdogCoordinator.observeDirectUserDeliveryInlineIfNeeded(
      input
    );
  }

  protected scheduleOpenCodePromptDeliveryWatchdog(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void {
    this.openCodePromptDeliveryWatchdogScheduler.schedule(input);
  }

  protected async rememberOpenCodeRuntimePidFromBridge(
    input: RememberOpenCodeRuntimePidFromBridgeInput
  ): Promise<void> {
    await rememberOpenCodeRuntimePidFromBridgeHelper(input, this.openCodeRuntimePidBridgePorts);
  }

  protected async maybeSyncOpenCodeRuntimePermissionsAfterDelivery(
    input: OpenCodeRuntimePermissionSyncInput
  ): Promise<void> {
    await syncOpenCodeRuntimePermissionsAfterDeliveryWithService(
      input,
      this as unknown as OpenCodeRuntimePermissionSyncServiceHost<TRun>,
      { logWarning: (message) => logger.warn(message) }
    );
  }

  protected logOpenCodePromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra: Record<string, unknown> = {}
  ): void {
    this.openCodeRuntimeDeliveryAdvisory.logPromptDeliveryEvent(event, record, extra);
  }

  protected emitOpenCodePromptDeliveryTaskLogChange(
    record: OpenCodePromptDeliveryLedgerRecord,
    detail: string
  ): void {
    this.openCodeRuntimeDeliveryAdvisory.emitPromptDeliveryTaskLogChange(record, detail);
  }

  protected async decideOpenCodeRuntimeDeliveryUserFacingAdvisory(
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<{
    record: OpenCodePromptDeliveryLedgerRecord;
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision;
  }> {
    return await this.openCodeRuntimeDeliveryAdvisory.decideUserFacingAdvisory(record);
  }

  protected emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void {
    this.openCodeRuntimeDeliveryAdvisory.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message);
  }

  async scanOpenCodePromptDeliveryWatchdog(teamName: string): Promise<number> {
    return await this.openCodePromptDeliveryWatchdogCoordinator.scan(teamName);
  }

  protected async scanOpenCodePromptDeliveryWatchdogForActiveLanes(
    teamName: string,
    laneIds: string[]
  ): Promise<number> {
    return await this.openCodePromptDeliveryWatchdogCoordinator.scanActiveLanes(teamName, laneIds);
  }
}
