import { isAgentVideoMimeType } from '@features/agent-attachments/contracts';
import {
  getAgentVideoAttachmentRecipientRestriction,
  validateAgentAttachmentIpcPayload,
  validateAgentAttachmentSerializedIpcPayload,
} from '@features/agent-attachments/main';
import { MAX_TEXT_LENGTH } from '@shared/constants/teamLimits';
import { getErrorMessage } from '@shared/utils/errorHandling';

import {
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_RUNTIME_DELIVERY_STATUS,
  TEAM_SEND_MESSAGE,
} from '../../contracts/channels';
import { buildMessageDeliveryText } from '../../core/domain/leadMessagePresentation';

import {
  createTeamMessageDeliveryFeature,
  type TeamMessageDeliveryFeature,
  type TeamMessageDeliveryRepositoryPort,
} from './createTeamMessageDeliveryFeature';

import type { RuntimeDeliveryStatus } from '../../contracts/runtime-delivery';
import type {
  ActionModeInstructionsPort,
  ClockPort,
  DeadlinePort,
  DurableTeamRosterPort,
  MessageAttachmentStorePort,
  MessageDeliveryCompatibilityPort,
  MessageIdGeneratorPort,
  RuntimeDeliveryCompatibilityPort,
  RuntimeDeliveryImpactPort,
  RuntimeDeliveryWarningEvent,
  RuntimeRelayOptions,
  TeamMessageDeliveryResult,
  TeamMessageLoggerPort,
  TeamMessageTransportPort,
  TeamRuntimeStatusPort,
} from '../../core/application/ports/TeamMessageDeliveryPorts';
import type { SendTeamMessageCommand } from '../../core/application/SendTeamMessageCommand';
import type {
  RuntimeRelayDelivery,
  RuntimeRelayResult,
} from '../../core/domain/messageDeliveryModels';
import type { AttachmentSupportFailure } from '../../core/domain/messageDeliveryRoutePolicy';
import type {
  AttachmentFileData,
  AttachmentPayload,
  InboxMessage,
  IpcResult,
  OpenCodeRuntimeDeliveryStatus,
  SendMessageRequest,
  SendMessageResult,
  TaskRef,
  TeamProviderId,
} from '@shared/types';

const OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON =
  'opencode_runtime_delivery_ui_timeout_pending';
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MEMBER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
const FROM_FIELD_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RESERVED_MEMBER_NAMES = new Set<string>(['user']);
const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);
type ExecutionResult<T> = { success: true; data: T } | { success: false; error: string };
type ValidationResult<T> = { valid: true; value: T } | { valid: false; error: string };
export interface DesktopTeamMessageDeliveryCompatibilityHost {
  sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: AttachmentPayload[]
  ): Promise<void>;
  resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined>;
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options?: RuntimeRelayOptions
  ): Promise<RuntimeRelayResult>;
  relayLeadInboxMessages(teamName: string): Promise<number>;
  getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null>;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
}
export interface DesktopTeamMessageDeliveryFeatureDependencies {
  repository: TeamMessageDeliveryRepositoryPort;
  messaging: DesktopTeamMessageDeliveryCompatibilityHost;
  runtime: TeamRuntimeStatusPort;
  logger: TeamMessageLoggerPort;
  attachments: MessageAttachmentStorePort;
  roster: Pick<DurableTeamRosterPort, 'getMembers'>;
  actionModeInstructions: ActionModeInstructionsPort;
  runtimeDeliveryImpact: RuntimeDeliveryImpactPort;
  deadline?: DeadlinePort;
  ids?: MessageIdGeneratorPort;
  clock?: ClockPort;
}
export interface TeamMessageDeliveryIpcDependencies extends TeamMessageDeliveryFeature {
  presentSendMessageResult(result: TeamMessageDeliveryResult): SendMessageResult;
  presentRuntimeDeliveryStatus(status: RuntimeDeliveryStatus): OpenCodeRuntimeDeliveryStatus;
}
export type DesktopTeamMessageDeliveryFeature = TeamMessageDeliveryIpcDependencies;
export interface TeamMessageDeliveryIpcMainPort {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export function createDesktopTeamMessageDeliveryFeature(
  dependencies: DesktopTeamMessageDeliveryFeatureDependencies
): DesktopTeamMessageDeliveryFeature {
  const compatibility = new LegacyOpenCodeMessageTransportAdapter(
    dependencies.messaging,
    dependencies.repository
  );
  const feature = createTeamMessageDeliveryFeature({
    repository: dependencies.repository,
    messaging: compatibility,
    runtime: dependencies.runtime,
    logger: dependencies.logger,
    attachments: dependencies.attachments,
    roster: {
      getMembers: (teamName) => dependencies.roster.getMembers(teamName),
      getFallbackMembers: async (teamName) =>
        (await dependencies.repository.getTeamData(teamName)).members,
    },
    deadline: dependencies.deadline ?? new MainProcessDeadline(),
    ids: dependencies.ids ?? { createMessageId: () => globalThis.crypto.randomUUID() },
    clock: dependencies.clock ?? { nowIso: () => new Date().toISOString() },
    actionModeInstructions: dependencies.actionModeInstructions,
    runtimeDeliveryImpact: dependencies.runtimeDeliveryImpact,
    compatibility,
  });
  const executeSendMessage = feature.sendMessage.execute.bind(feature.sendMessage);
  feature.sendMessage.execute = (command, prevalidatedDelegate) => {
    if (!command.attachments?.some((attachment) => isAgentVideoMimeType(attachment.mimeType))) {
      return executeSendMessage(command, prevalidatedDelegate);
    }
    return compatibility
      .validateVideoAttachments(command)
      .then(() => executeSendMessage(command, prevalidatedDelegate))
      .finally(() => compatibility.clearPrimedRecipientProvider(command));
  };
  return {
    ...feature,
    presentSendMessageResult: (result) => compatibility.toLegacySendMessageResult(result),
    presentRuntimeDeliveryStatus: (status) => compatibility.toLegacyRuntimeDeliveryStatus(status),
  };
}
export function registerTeamMessageDeliveryIpc(
  ipcMain: TeamMessageDeliveryIpcMainPort,
  dependencies: TeamMessageDeliveryIpcDependencies
): void {
  const handlers = createTeamMessageDeliveryIpcHandlers(dependencies);
  ipcMain.handle(TEAM_SEND_MESSAGE, (event, ...args) =>
    handlers.sendMessage(event, args[0], args[1])
  );
  ipcMain.handle(TEAM_GET_RUNTIME_DELIVERY_STATUS, (event, ...args) =>
    handlers.getOpenCodeRuntimeDeliveryStatus(event, args[0], args[1])
  );
  ipcMain.handle(TEAM_GET_ATTACHMENTS, (event, ...args) =>
    handlers.getAttachments(event, args[0], args[1])
  );
}
export function removeTeamMessageDeliveryIpc(ipcMain: TeamMessageDeliveryIpcMainPort): void {
  ipcMain.removeHandler(TEAM_SEND_MESSAGE);
  ipcMain.removeHandler(TEAM_GET_RUNTIME_DELIVERY_STATUS);
  ipcMain.removeHandler(TEAM_GET_ATTACHMENTS);
}
export function createTeamMessageDeliveryIpcHandlers(
  dependencies: TeamMessageDeliveryIpcDependencies
): {
  sendMessage: (
    _event: unknown,
    teamName: unknown,
    request: unknown
  ) => Promise<IpcResult<SendMessageResult>>;
  getOpenCodeRuntimeDeliveryStatus: (
    _event: unknown,
    teamName: unknown,
    messageId: unknown
  ) => Promise<IpcResult<OpenCodeRuntimeDeliveryStatus | null>>;
  getAttachments: (
    _event: unknown,
    teamName: unknown,
    messageId: unknown
  ) => Promise<IpcResult<AttachmentFileData[]>>;
} {
  const execute = async <T>(
    operation: string,
    handler: () => Promise<T>
  ): Promise<ExecutionResult<T>> => {
    try {
      return { success: true, data: await handler() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.error(`[teams:${operation}] ${message}`);
      return { success: false, error: message };
    }
  };
  return {
    sendMessage: async (_event, teamName, request) => {
      const normalized = normalizeSendTeamMessageCommand(teamName, request);
      if (!normalized.valid) return { success: false, error: normalized.error };
      const prevalidation = await execute('sendMessage', () =>
        dependencies.sendMessage.prevalidateDelegate(normalized.value)
      );
      if (!prevalidation.success) return prevalidation;
      const prevalidatedDelegate = prevalidation.data;
      if (prevalidatedDelegate && !prevalidatedDelegate.isLeadRecipient) {
        return {
          success: false,
          error: 'Delegate mode is only supported when messaging the team lead',
        };
      }
      return execute('sendMessage', async () =>
        dependencies.presentSendMessageResult(
          await dependencies.sendMessage.execute(normalized.value, prevalidatedDelegate)
        )
      );
    },
    getOpenCodeRuntimeDeliveryStatus: async (_event, teamName, messageId) => {
      const validatedTeamName = validateRequiredTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error };
      }
      const validatedMessageId = validateMessageId(messageId);
      if (!validatedMessageId.valid) {
        return { success: false, error: validatedMessageId.error };
      }
      return execute('getOpenCodeRuntimeDeliveryStatus', async () => {
        const status = await dependencies.getRuntimeDeliveryStatus.execute(
          validatedTeamName.value,
          validatedMessageId.value
        );
        return status ? dependencies.presentRuntimeDeliveryStatus(status) : null;
      });
    },
    getAttachments: async (_event, teamName, messageId) => {
      const validatedTeamName = validateRequiredTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error };
      }
      const validatedMessageId = validateMessageId(messageId);
      if (!validatedMessageId.valid) {
        return { success: false, error: validatedMessageId.error };
      }
      return execute('getAttachments', () =>
        dependencies.getAttachments.execute(validatedTeamName.value, validatedMessageId.value)
      );
    },
  };
}
export class LegacyOpenCodeMessageTransportAdapter
  implements
    TeamMessageTransportPort,
    MessageDeliveryCompatibilityPort,
    RuntimeDeliveryCompatibilityPort
{
  private readonly primedRecipientProviders = new Map<string, TeamProviderId | undefined>();
  constructor(
    private readonly host: DesktopTeamMessageDeliveryCompatibilityHost,
    private readonly repository?: TeamMessageDeliveryRepositoryPort
  ) {}
  async validateVideoAttachments(command: SendTeamMessageCommand): Promise<void> {
    if (!command.attachments?.length || !this.repository) return;
    const [providerId, snapshot] = await Promise.all([
      this.host.resolveRuntimeRecipientProviderId(command.teamName, command.memberName),
      this.repository.getTeamData(command.teamName),
    ]);
    const members = snapshot.members as Array<
      (typeof snapshot.members)[number] & { model?: string; providerId?: TeamProviderId }
    >;
    const normalizedMemberName = command.memberName.trim().toLowerCase();
    const member = members.find(
      (candidate) => candidate.name.trim().toLowerCase() === normalizedMemberName
    );
    const videoRestriction = getAgentVideoAttachmentRecipientRestriction({
      attachments: command.attachments,
      providerId: providerId ?? member?.providerId ?? 'unknown',
      model: member?.model,
    });
    if (videoRestriction) throw new Error(videoRestriction);
    this.primedRecipientProviders.set(
      this.recipientRouteKey(command.teamName, command.memberName),
      providerId
    );
  }
  sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: AttachmentPayload[]
  ): Promise<void> {
    return this.host.sendMessageToTeam(teamName, message, attachments);
  }
  async resolveRecipientRoute(teamName: string, memberName: string) {
    const routeKey = this.recipientRouteKey(teamName, memberName);
    const hasPrimedProvider = this.primedRecipientProviders.has(routeKey);
    const providerId = hasPrimedProvider
      ? this.primedRecipientProviders.get(routeKey)
      : await this.host.resolveRuntimeRecipientProviderId(teamName, memberName);
    this.primedRecipientProviders.delete(routeKey);
    return {
      ...(providerId ? { providerId } : {}),
      requiresRuntimeDelivery: providerId === 'opencode',
    };
  }
  clearPrimedRecipientProvider(command: SendTeamMessageCommand): void {
    this.primedRecipientProviders.delete(
      this.recipientRouteKey(command.teamName, command.memberName)
    );
  }
  relayRuntimeRecipientInboxMessages(
    teamName: string,
    memberName: string,
    options?: RuntimeRelayOptions
  ): Promise<RuntimeRelayResult> {
    return this.host.relayOpenCodeMemberInboxMessages(teamName, memberName, options);
  }
  relayLeadInboxMessages(teamName: string): Promise<number> {
    return this.host.relayLeadInboxMessages(teamName);
  }

  async getRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<RuntimeDeliveryStatus | null> {
    const status = await this.host.getOpenCodeRuntimeDeliveryStatus(teamName, messageId);
    return status ? this.toRuntimeDeliveryStatus(status) : null;
  }
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void {
    this.host.pushLiveLeadProcessMessage(teamName, message);
  }

  requiresGeneratedMessageId(input: {
    providerId?: TeamProviderId;
    isLeadRecipient: boolean;
    replyRecipient: string;
  }): boolean {
    return this.resolveVisibleDirectReplyProtocol(input) === 'agent_teams_message_send';
  }
  buildRecipientDeliveryText(input: {
    actionModeBlock: string;
    baseText: string;
    isLeadRecipient: boolean;
    memberName: string;
    messageId?: string;
    providerId?: TeamProviderId;
    replyRecipient: string;
    teamName: string;
  }): string {
    return buildMessageDeliveryText(input.baseText, {
      actionModeBlock: input.actionModeBlock,
      isLeadRecipient: input.isLeadRecipient,
      memberName: input.memberName,
      protocol: this.resolveVisibleDirectReplyProtocol(input),
      replyRecipient: input.replyRecipient,
      teamName: input.teamName,
      ...(input.messageId ? { messageId: input.messageId } : {}),
    });
  }
  attachmentSupportError(failure: AttachmentSupportFailure): string {
    return failure === 'runtime-recipient-offline'
      ? 'Attachments for OpenCode teammates require the team to be online'
      : 'Attachments are supported for the online team lead and online OpenCode teammates only';
  }
  shouldLookupStatusAfterRelay(relay: RuntimeRelayResult): boolean {
    const delivery = relay.lastDelivery;
    if (!delivery?.delivered) return false;
    return (
      typeof delivery.accepted !== 'boolean' &&
      typeof delivery.responsePending !== 'boolean' &&
      !delivery.responseState &&
      !delivery.ledgerStatus &&
      !delivery.ledgerRecordId &&
      !delivery.laneId &&
      !delivery.userVisibleImpact
    );
  }
  statusToRelayResult(status: RuntimeDeliveryStatus): RuntimeRelayResult {
    const lastDelivery: RuntimeRelayDelivery = {
      delivered: status.delivered,
      ...(typeof status.accepted === 'boolean' ? { accepted: status.accepted } : {}),
      ...(typeof status.responsePending === 'boolean'
        ? { responsePending: status.responsePending }
        : {}),
      ...(typeof status.acceptanceUnknown === 'boolean'
        ? { acceptanceUnknown: status.acceptanceUnknown }
        : {}),
      ...(status.responseState ? { responseState: status.responseState } : {}),
      ...(status.ledgerStatus ? { ledgerStatus: status.ledgerStatus } : {}),
      ...(status.visibleReplyMessageId
        ? { visibleReplyMessageId: status.visibleReplyMessageId }
        : {}),
      ...(status.visibleReplyCorrelation
        ? { visibleReplyCorrelation: status.visibleReplyCorrelation }
        : {}),
      ...(status.ledgerRecordId ? { ledgerRecordId: status.ledgerRecordId } : {}),
      ...(status.laneId ? { laneId: status.laneId } : {}),
      ...(status.queuedBehindMessageId
        ? { queuedBehindMessageId: status.queuedBehindMessageId }
        : {}),
      ...(status.reason ? { reason: status.reason } : {}),
      ...(status.diagnostics ? { diagnostics: status.diagnostics } : {}),
      ...(this.shouldPreserveRuntimeDeliveryStatusImpact(status)
        ? { userVisibleImpact: status.userVisibleImpact }
        : {}),
    };
    return {
      relayed: 0,
      attempted: 1,
      delivered: status.delivered && status.responsePending !== true ? 1 : 0,
      failed: status.delivered ? 0 : 1,
      lastDelivery,
      diagnostics: status.diagnostics,
    };
  }

  buildTimeoutRelayResult(statusLookupError?: unknown): RuntimeRelayResult {
    const diagnostics = [OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON];
    if (arguments.length > 0) {
      diagnostics.push(
        `${OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON}: status lookup failed: ${getErrorMessage(statusLookupError)}`
      );
    }
    return {
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 1,
      lastDelivery: {
        delivered: true,
        accepted: false,
        responsePending: true,
        acceptanceUnknown: true,
        responseState: 'not_observed',
        reason: OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON,
        diagnostics,
      },
    };
  }

  buildMissingDelivery(relay: RuntimeRelayResult): RuntimeRelayDelivery {
    return {
      delivered: relay.relayed > 0,
      reason: relay.relayed > 0 ? undefined : 'opencode_message_delivery_not_attempted',
      diagnostics: undefined,
    };
  }

  formatWarning(event: RuntimeDeliveryWarningEvent): string | null {
    switch (event.kind) {
      case 'late-failure':
        if (event.delivery.reason === 'recipient_is_not_opencode') return null;
        return `OpenCode runtime delivery after sendMessage completed after UI timeout for teammate "${event.memberName}" with failure: ${
          event.delivery.reason ?? 'unknown error'
        }`;
      case 'late-rejection':
        return `OpenCode runtime delivery after sendMessage rejected after UI timeout for teammate "${event.memberName}": ${getErrorMessage(event.error)}`;
      case 'status-lookup-failure':
        return `OpenCode runtime delivery status after UI timeout failed for teammate "${event.memberName}": ${getErrorMessage(event.error)}`;
      case 'status-enrichment-failure':
        return `OpenCode runtime delivery status enrichment failed for teammate "${event.memberName}": ${getErrorMessage(event.error)}`;
      case 'delivery-failure':
        if (
          event.delivery.reason === 'recipient_is_not_opencode' ||
          event.delivery.reason === OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON
        ) {
          return null;
        }
        return `OpenCode runtime delivery after sendMessage failed for teammate "${event.memberName}": ${
          event.delivery.reason ?? 'unknown error'
        }`;
      case 'delivery-crash':
        return `OpenCode runtime delivery after sendMessage crashed for teammate "${event.memberName}": ${event.reason}`;
    }
  }

  toRuntimeDeliveryStatus(status: OpenCodeRuntimeDeliveryStatus): RuntimeDeliveryStatus {
    this.assertOpenCodeProvider(status);
    return status;
  }

  toLegacyRuntimeDeliveryStatus(status: RuntimeDeliveryStatus): OpenCodeRuntimeDeliveryStatus {
    this.assertOpenCodeProvider(status);
    return status;
  }

  toLegacySendMessageResult(result: TeamMessageDeliveryResult): SendMessageResult {
    const { runtimeDelivery, ...baseResult } = result;
    if (!runtimeDelivery) return baseResult;
    this.assertOpenCodeProvider(runtimeDelivery);
    return { ...baseResult, runtimeDelivery };
  }

  private assertOpenCodeProvider(
    status: Pick<RuntimeDeliveryStatus, 'providerId'>
  ): asserts status is Pick<RuntimeDeliveryStatus, 'providerId'> & { providerId: 'opencode' } {
    if (status.providerId !== 'opencode') {
      throw new Error(`Expected OpenCode runtime delivery status, received ${status.providerId}`);
    }
  }

  private recipientRouteKey(teamName: string, memberName: string): string {
    return `${teamName}\u0000${memberName}`;
  }

  private resolveVisibleDirectReplyProtocol(input: {
    providerId?: TeamProviderId;
    isLeadRecipient: boolean;
    replyRecipient: string;
  }): 'send_message' | 'agent_teams_message_send' {
    if (
      !input.isLeadRecipient &&
      input.replyRecipient.trim().toLowerCase() === 'user' &&
      input.providerId === 'codex'
    ) {
      return 'agent_teams_message_send';
    }
    return 'send_message';
  }

  private shouldPreserveRuntimeDeliveryStatusImpact(status: RuntimeDeliveryStatus): boolean {
    if (!status.userVisibleImpact) return false;
    if (
      status.userVisibleImpact.state === 'none' &&
      (status.responsePending === true ||
        status.acceptanceUnknown === true ||
        Boolean(status.queuedBehindMessageId))
    ) {
      return false;
    }
    return true;
  }
}

class MainProcessDeadline implements DeadlinePort {
  async raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void
  ): Promise<{ kind: 'value'; value: T } | { kind: 'timeout' }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const outcome = await Promise.race([
        promise.then(
          (value) => ({ kind: 'value' as const, value }),
          (error: unknown) => ({ kind: 'rejection' as const, error })
        ),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timer = setTimeout(() => {
            onTimeout();
            resolve({ kind: 'timeout' });
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (outcome.kind === 'rejection') throw outcome.error;
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async withTimeoutValue<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function normalizeSendTeamMessageCommand(
  teamName: unknown,
  request: unknown
): ValidationResult<SendTeamMessageCommand> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) return validatedTeamName;
  if (!request || typeof request !== 'object') {
    return { valid: false, error: 'Invalid send message request' };
  }

  const payload = request as Partial<SendMessageRequest>;
  const validatedMember = validateMemberName(payload.member);
  if (!validatedMember.valid) return validatedMember;
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    return { valid: false, error: 'text must be non-empty string' };
  }
  if (payload.text.length > MAX_TEXT_LENGTH) {
    return { valid: false, error: `Text exceeds ${MAX_TEXT_LENGTH} characters` };
  }
  if (payload.summary !== undefined && typeof payload.summary !== 'string') {
    return { valid: false, error: 'summary must be string' };
  }
  if (payload.from !== undefined) {
    const validatedFrom = validateFromField(payload.from);
    if (!validatedFrom.valid) return validatedFrom;
  }
  if (payload.actionMode !== undefined && !isAgentActionMode(payload.actionMode)) {
    return { valid: false, error: 'actionMode must be one of: do, ask, delegate' };
  }
  const validatedTaskRefs = validateTaskRefs(payload.taskRefs);
  if (!validatedTaskRefs.valid) return validatedTaskRefs;

  let attachments: AttachmentPayload[] | undefined;
  if (
    payload.attachments !== undefined &&
    Array.isArray(payload.attachments) &&
    payload.attachments.length > 0
  ) {
    const validated = validateAgentAttachmentIpcPayload(payload.attachments);
    if (!validated.valid) return validated;
    attachments = validated.value;
    const serialized = validateAgentAttachmentSerializedIpcPayload({
      text: payload.text,
      attachments,
    });
    if (!serialized.valid) return serialized;
  }

  return {
    valid: true,
    value: {
      teamName: validatedTeamName.value,
      memberName: validatedMember.value,
      text: payload.text,
      summary: payload.summary,
      from: payload.from,
      actionMode: payload.actionMode,
      taskRefs: validatedTaskRefs.value,
      attachments,
    },
  };
}

function validateRequiredTeamName(teamName: unknown): ValidationResult<string> {
  return validateTeamName(teamName);
}

function validateTeamName(teamName: unknown): ValidationResult<string> {
  const basic = validateString(teamName, 'teamName', 128);
  if (!basic.valid) return basic;
  if (!TEAM_NAME_PATTERN.test(basic.value)) {
    return { valid: false, error: 'teamName contains invalid characters' };
  }
  if (isWindowsReservedFileName(basic.value)) {
    return { valid: false, error: 'teamName is reserved on Windows' };
  }
  return basic;
}

function validateMemberName(memberName: unknown): ValidationResult<string> {
  const basic = validateString(memberName, 'member', 128);
  if (!basic.valid) return basic;
  if (!MEMBER_NAME_PATTERN.test(basic.value)) {
    return { valid: false, error: 'member contains invalid characters' };
  }
  if (/[. ]$/.test(basic.value)) {
    return { valid: false, error: 'member cannot end with a space or period' };
  }
  if (isWindowsReservedFileName(basic.value)) {
    return { valid: false, error: 'member is reserved on Windows' };
  }
  if (RESERVED_MEMBER_NAMES.has(basic.value.toLowerCase())) {
    return { valid: false, error: `member name "${basic.value}" is reserved` };
  }
  return basic;
}

function validateFromField(from: unknown): ValidationResult<string> {
  const basic = validateString(from, 'from', 128);
  if (!basic.valid) return basic;
  return FROM_FIELD_PATTERN.test(basic.value)
    ? basic
    : { valid: false, error: 'from contains invalid characters' };
}

function validateTaskId(taskId: unknown): ValidationResult<string> {
  const basic = validateString(taskId, 'taskId', 64);
  if (!basic.valid) return basic;
  if (!TASK_ID_PATTERN.test(basic.value)) {
    return { valid: false, error: 'taskId contains invalid characters' };
  }
  if (isWindowsReservedFileName(basic.value)) {
    return { valid: false, error: 'taskId is reserved on Windows' };
  }
  return basic;
}

function validateTaskRefs(value: unknown): ValidationResult<TaskRef[] | undefined> {
  if (value === undefined) return { valid: true, value: undefined };
  if (!Array.isArray(value)) {
    return { valid: false, error: 'taskRefs must be an array' };
  }

  const taskRefs: TaskRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return { valid: false, error: 'taskRefs entries must be objects' };
    }
    const row = entry as Partial<TaskRef>;
    const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
    const displayId = typeof row.displayId === 'string' ? row.displayId.trim() : '';
    const teamName = typeof row.teamName === 'string' ? row.teamName.trim() : '';
    if (!taskId || !displayId || !teamName) {
      return {
        valid: false,
        error: 'Each taskRef must include taskId, displayId, and teamName',
      };
    }
    const validatedTaskId = validateTaskId(taskId);
    if (!validatedTaskId.valid) return validatedTaskId;
    const validatedTeamName = validateTeamName(teamName);
    if (!validatedTeamName.valid) return validatedTeamName;
    taskRefs.push({
      taskId: validatedTaskId.value,
      displayId,
      teamName: validatedTeamName.value,
    });
  }
  return { valid: true, value: taskRefs };
}

function validateMessageId(messageId: unknown): ValidationResult<string> {
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    return { valid: false, error: 'messageId must be a non-empty string' };
  }
  const value = messageId.trim();
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    return { valid: false, error: 'Invalid messageId' };
  }
  return { valid: true, value };
}

function validateString(
  value: unknown,
  fieldName: string,
  maxLength: number
): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }
  if (trimmed.length > maxLength) {
    return { valid: false, error: `${fieldName} exceeds max length (${maxLength})` };
  }
  return { valid: true, value: trimmed };
}

function isAgentActionMode(value: unknown): value is SendTeamMessageCommand['actionMode'] {
  return value === 'do' || value === 'ask' || value === 'delegate';
}

function isWindowsReservedFileName(name: string): boolean {
  const normalized = name
    .trim()
    .replace(/[. ]+$/g, '')
    .toLowerCase();
  if (!normalized) return false;
  const stem = normalized.split('.')[0] ?? normalized;
  return WINDOWS_RESERVED_BASENAMES.has(stem);
}
