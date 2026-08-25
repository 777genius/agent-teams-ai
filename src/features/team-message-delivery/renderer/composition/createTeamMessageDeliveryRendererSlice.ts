import type {
  CrossTeamMessageDeliveryTransportPort,
  TeamMessageDeliveryAnalyticsPort,
  TeamMessageDeliveryClockPort,
  TeamMessageDeliveryDiagnosticsLogPort,
  TeamMessageDeliveryDiagnosticsPort,
  TeamMessageDeliveryErrorPolicyPort,
  TeamMessageDeliveryOptimisticMessagePort,
  TeamMessageDeliveryRefreshPort,
  TeamMessageDeliveryRendererSlice,
  TeamMessageDeliveryRendererSliceState,
  TeamMessageDeliveryRequestScopePort,
  TeamMessageDeliveryStatePort,
  TeamMessageDeliveryTransportPort,
} from '../ports/TeamMessageDeliveryRendererPorts';
import type { InboxMessage, SendMessageRequest } from '@shared/types';

export interface TeamMessageDeliveryRendererSliceDependencies<
  TState extends TeamMessageDeliveryRendererSliceState,
  TScope,
> {
  analytics: TeamMessageDeliveryAnalyticsPort;
  clock: TeamMessageDeliveryClockPort;
  crossTeamTransport: CrossTeamMessageDeliveryTransportPort;
  diagnostics: TeamMessageDeliveryDiagnosticsPort;
  errors: TeamMessageDeliveryErrorPolicyPort;
  log: TeamMessageDeliveryDiagnosticsLogPort;
  optimisticMessages: TeamMessageDeliveryOptimisticMessagePort<TState>;
  refresh: TeamMessageDeliveryRefreshPort;
  requestScope: TeamMessageDeliveryRequestScopePort<TScope>;
  state: TeamMessageDeliveryStatePort<TState>;
  transport: TeamMessageDeliveryTransportPort;
}

function buildOptimisticMessage(
  request: SendMessageRequest,
  resultMessageId: string,
  deliveredViaStdin: boolean,
  nowIso: () => string
): InboxMessage {
  return {
    from: request.from ?? 'user',
    to: request.to ?? request.member,
    text: request.text,
    timestamp: request.timestamp ?? nowIso(),
    read: deliveredViaStdin,
    taskRefs: request.taskRefs?.length ? request.taskRefs : undefined,
    actionMode: request.actionMode,
    summary: request.summary,
    color: request.color,
    messageId: resultMessageId,
    relayOfMessageId: request.relayOfMessageId,
    source: request.source ?? 'user_sent',
    attachments: request.attachments?.length ? request.attachments : undefined,
    leadSessionId: request.leadSessionId,
    conversationId: request.conversationId,
    replyToConversationId: request.replyToConversationId,
    toolSummary: request.toolSummary,
    toolCalls: request.toolCalls,
    messageKind: request.messageKind,
    slashCommand: request.slashCommand,
    commandOutput: request.commandOutput,
  };
}

export function createTeamMessageDeliveryRendererSlice<
  TState extends TeamMessageDeliveryRendererSliceState,
  TScope,
>(
  dependencies: TeamMessageDeliveryRendererSliceDependencies<TState, TScope>
): TeamMessageDeliveryRendererSlice {
  return {
    sendingMessage: false,
    sendMessageError: null,
    sendMessageWarning: null,
    sendMessageDebugDetails: null,
    lastSendMessageResult: null,
    crossTeamTargets: [],
    crossTeamTargetsLoading: false,

    sendTeamMessage: async (teamName, request) => {
      dependencies.state.setState({
        sendingMessage: true,
        sendMessageError: null,
        sendMessageWarning: null,
        sendMessageDebugDetails: null,
        lastSendMessageResult: null,
      });
      try {
        const result = await dependencies.transport.send(teamName, request);
        const runtimeDeliveryFailed = dependencies.diagnostics.isHardFailure(
          result.runtimeDelivery
        );
        const runtimeDeliveryDiagnostics = dependencies.diagnostics.build(result);
        if (request.attachments?.length) {
          dependencies.analytics.recordAttachment({
            attachments: request.attachments,
            success: !runtimeDeliveryFailed,
            errorClass: runtimeDeliveryFailed ? 'runtime_missing' : 'none',
          });
        }
        const optimisticMessage = buildOptimisticMessage(
          request,
          result.messageId,
          result.deliveredViaStdin === true,
          () => dependencies.clock.nowIso()
        );
        dependencies.state.setState((state) => ({
          sendingMessage: false,
          sendMessageError: null,
          sendMessageWarning: runtimeDeliveryDiagnostics.warning,
          sendMessageDebugDetails: runtimeDeliveryDiagnostics.debugDetails,
          lastSendMessageResult: runtimeDeliveryFailed ? null : result,
          ...dependencies.optimisticMessages.project(state, teamName, optimisticMessage),
        }));
        await dependencies.refresh.refreshMessageHead(teamName);
        return result;
      } catch (error) {
        if (request.attachments?.length) {
          dependencies.analytics.recordAttachment({
            attachments: request.attachments,
            success: false,
            errorClass: dependencies.analytics.classifyError(error),
          });
        }
        dependencies.state.setState({
          sendingMessage: false,
          lastSendMessageResult: null,
          sendMessageWarning: null,
          sendMessageDebugDetails: null,
          sendMessageError: dependencies.errors.mapSendError(error),
        });
        throw error;
      }
    },

    clearSendMessageRuntimeDiagnostics: (messageId) => {
      dependencies.state.setState((state) => {
        if (messageId && state.sendMessageDebugDetails?.messageId !== messageId) {
          return {};
        }
        if (!state.sendMessageWarning && !state.sendMessageDebugDetails) {
          return {};
        }
        return {
          sendMessageWarning: null,
          sendMessageDebugDetails: null,
        };
      });
    },

    refreshSendMessageRuntimeDeliveryStatus: async (teamName, input) => {
      const normalizedMessageId = typeof input === 'string' ? input.trim() : input.messageId.trim();
      const statusMessageId =
        typeof input === 'string'
          ? normalizedMessageId
          : input.statusMessageId?.trim() || normalizedMessageId;
      if (!normalizedMessageId) return;
      if (
        dependencies.state.getState().sendMessageDebugDetails?.messageId !== normalizedMessageId
      ) {
        return;
      }
      let status = await dependencies.transport.getRuntimeDeliveryStatus(teamName, statusMessageId);
      if (!status) return;
      if (statusMessageId !== normalizedMessageId) {
        const blockerUserVisibleState = status.userVisibleImpact?.state;
        const blockerStillChecking =
          blockerUserVisibleState !== undefined
            ? blockerUserVisibleState === 'checking'
            : status.responsePending === true;
        if (!blockerStillChecking) {
          const ownStatus = await dependencies.transport.getRuntimeDeliveryStatus(
            teamName,
            normalizedMessageId
          );
          if (!ownStatus) return;
          status = ownStatus;
        }
      }
      const diagnostics = dependencies.diagnostics.build({
        deliveredToInbox: true,
        messageId: normalizedMessageId,
        runtimeDelivery: status,
      });
      dependencies.state.setState((state) => {
        if (state.sendMessageDebugDetails?.messageId !== normalizedMessageId) {
          return {};
        }
        return {
          sendMessageWarning: diagnostics.warning,
          sendMessageDebugDetails: diagnostics.debugDetails,
        };
      });
    },

    fetchCrossTeamTargets: async () => {
      const requestScope = dependencies.requestScope.capture();
      dependencies.state.setState({ crossTeamTargetsLoading: true });
      try {
        const targets = await dependencies.crossTeamTransport.listTargets();
        if (!dependencies.requestScope.isCurrent(requestScope)) {
          return false;
        }
        dependencies.state.setState({
          crossTeamTargets: targets,
          crossTeamTargetsLoading: false,
        });
        return true;
      } catch (error) {
        if (!dependencies.requestScope.isCurrent(requestScope)) {
          return false;
        }
        dependencies.log.recordCrossTeamTargetsFailure(error);
        dependencies.state.setState({
          crossTeamTargets: [],
          crossTeamTargetsLoading: false,
        });
        return false;
      }
    },

    sendCrossTeamMessage: async (request) => {
      dependencies.state.setState({
        sendingMessage: true,
        sendMessageError: null,
        sendMessageWarning: null,
        sendMessageDebugDetails: null,
        lastSendMessageResult: null,
      });
      try {
        const result = await dependencies.crossTeamTransport.send(request);
        dependencies.analytics.recordCrossTeamMessage({
          source: request.fromMember === 'user' ? 'user' : 'runtime',
          success: true,
          hasReplyTo: Boolean(request.replyToConversationId),
          conversationDepth: request.chainDepth ?? null,
          hasTaskRefs: (request.taskRefs?.length ?? 0) > 0,
          errorClass: 'none',
        });
        dependencies.state.setState({
          sendingMessage: false,
          sendMessageError: null,
          sendMessageWarning: null,
          sendMessageDebugDetails: null,
          lastSendMessageResult: {
            messageId: result.messageId,
            deliveredToInbox: result.deliveredToInbox,
            deduplicated: result.deduplicated,
          },
        });
        await dependencies.refresh.refreshMessageHead(request.fromTeam);
      } catch (error) {
        dependencies.analytics.recordCrossTeamMessage({
          source: request.fromMember === 'user' ? 'user' : 'runtime',
          success: false,
          hasReplyTo: Boolean(request.replyToConversationId),
          conversationDepth: request.chainDepth ?? null,
          hasTaskRefs: (request.taskRefs?.length ?? 0) > 0,
          errorClass: dependencies.analytics.classifyError(error),
        });
        dependencies.state.setState({
          sendingMessage: false,
          lastSendMessageResult: null,
          sendMessageWarning: null,
          sendMessageDebugDetails: null,
          sendMessageError: dependencies.errors.mapSendError(error),
        });
      }
    },
  };
}
