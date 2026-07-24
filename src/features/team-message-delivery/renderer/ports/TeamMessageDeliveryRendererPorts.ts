import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import type {
  AttachmentPayload,
  CrossTeamSendRequest,
  CrossTeamSendResult,
  InboxMessage,
  OpenCodeRuntimeDeliveryStatus,
  SendMessageRequest,
  SendMessageResult,
} from '@shared/types';

export interface TeamMessageDeliveryTarget {
  teamName: string;
  displayName: string;
  description?: string;
  color?: string;
  leadName?: string;
  leadColor?: string;
  isOnline?: boolean;
}

export interface TeamMessageDeliveryRendererSliceState {
  sendingMessage: boolean;
  sendMessageError: string | null;
  sendMessageWarning: string | null;
  sendMessageDebugDetails: OpenCodeRuntimeDeliveryDebugDetails | null;
  lastSendMessageResult: SendMessageResult | null;
  crossTeamTargets: TeamMessageDeliveryTarget[];
  crossTeamTargetsLoading: boolean;
}

export interface TeamMessageDeliveryRendererSliceActions {
  clearSendMessageRuntimeDiagnostics(messageId?: string | null): void;
  fetchCrossTeamTargets(): Promise<boolean>;
  refreshSendMessageRuntimeDeliveryStatus(
    teamName: string,
    input: string | { messageId: string; statusMessageId?: string | null }
  ): Promise<void>;
  sendCrossTeamMessage(request: CrossTeamSendRequest): Promise<void>;
  sendTeamMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult>;
}

export type TeamMessageDeliveryRendererSlice = TeamMessageDeliveryRendererSliceState &
  TeamMessageDeliveryRendererSliceActions;

export interface TeamMessageDeliveryStatePort<
  TState extends TeamMessageDeliveryRendererSliceState,
> {
  getState(): TState;
  setState(
    update:
      | Partial<TeamMessageDeliveryRendererSliceState>
      | ((state: TState) => Partial<TState> | Partial<TeamMessageDeliveryRendererSliceState>)
  ): void;
}

export interface TeamMessageDeliveryTransportPort {
  getRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null>;
  send(teamName: string, request: SendMessageRequest): Promise<SendMessageResult>;
}

export interface CrossTeamMessageDeliveryTransportPort {
  listTargets(): Promise<TeamMessageDeliveryTarget[]>;
  send(request: CrossTeamSendRequest): Promise<CrossTeamSendResult>;
}

export interface TeamMessageDeliveryRefreshPort {
  refreshMessageHead(teamName: string): Promise<unknown>;
}

export interface TeamMessageDeliveryRequestScopePort<TScope> {
  capture(): TScope;
  isCurrent(scope: TScope): boolean;
}

export interface TeamMessageDeliveryOptimisticMessagePort<TState> {
  project(state: TState, teamName: string, message: InboxMessage): Partial<TState>;
}

export interface TeamMessageDeliveryDiagnosticsProjection {
  warning: string | null;
  debugDetails: OpenCodeRuntimeDeliveryDebugDetails | null;
}

export interface TeamMessageDeliveryDiagnosticsPort {
  build(result: SendMessageResult): TeamMessageDeliveryDiagnosticsProjection;
  isHardFailure(runtimeDelivery: SendMessageResult['runtimeDelivery'] | null | undefined): boolean;
}

export interface TeamMessageAttachmentAnalyticsInput {
  attachments: readonly AttachmentPayload[];
  success: boolean;
  errorClass: string;
}

export interface CrossTeamMessageAnalyticsInput {
  source: 'user' | 'runtime';
  success: boolean;
  hasReplyTo: boolean;
  conversationDepth: number | null;
  hasTaskRefs: boolean;
  errorClass: string;
}

export interface TeamMessageDeliveryAnalyticsPort {
  classifyError(error: unknown): string;
  recordAttachment(input: TeamMessageAttachmentAnalyticsInput): void;
  recordCrossTeamMessage(input: CrossTeamMessageAnalyticsInput): void;
}

export interface TeamMessageDeliveryErrorPolicyPort {
  mapSendError(error: unknown): string;
}

export interface TeamMessageDeliveryClockPort {
  nowIso(): string;
}

export interface TeamMessageDeliveryDiagnosticsLogPort {
  recordCrossTeamTargetsFailure(error: unknown): void;
}
