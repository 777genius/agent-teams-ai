import type { ActionMode } from './ActionModeSelector';
import type { CapturedCrossTeamReply, ComposerCrossTeamSend } from './capturedCrossTeamReply';
import type { ComposerDraftDestination } from './composerDraftDestination';
import type { MessageRevisionTargetController } from './messageRevisionTarget';
import type { ComposerDraftAddressRequest } from './useComposerDraftAddressRequest';
import type { TeamGroupChatDTO } from '@features/team-group-chats/contracts';
import type {
  ComposerDraftAddress,
  ComposerWorkingSummary,
  MessageRevisionContext,
} from '@renderer/types/composerDraft';
import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import type {
  AttachmentPayload,
  ResolvedTeamMember,
  SendMessageResult,
  TaskRef,
} from '@shared/types';
import type React from 'react';

export interface MemberMessageComposerProps {
  teamName: string;
  members: ResolvedTeamMember[];
  layout?: 'default' | 'compact';
  widthMode?: 'full' | 'floating-adaptive';
  isTeamAlive?: boolean;
  sending: boolean;
  sendError: string | null;
  sendWarning?: string | null;
  sendDebugDetails?: OpenCodeRuntimeDeliveryDebugDetails | null;
  lastResult?: SendMessageResult | null;
  revisionRequest?: MessageRevisionRequest | null;
  revisionPreparation?: { kind: 'preparing' | 'occupied'; recipient: string } | null;
  revisableMessageId?: string | null;
  cornerActionPrefix?: React.ReactNode;
  lockedRecipient?: string;
  initialRecipient?: string;
  onSelectAll?: () => void;
  groupBroadcast?: { group?: TeamGroupChatDTO };
  /** Ref to the underlying textarea element for external focus management. */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  suggestionPlacement?: 'above';
  /** Bump this when a chat thread is opened so the composer steals keyboard focus. */
  autoFocusKey?: number;
  draftAddressRequest?: ComposerDraftAddressRequest | null;
  crossTeamReply?: CapturedCrossTeamReply | null;
  workingDraftSummaries?: readonly ComposerWorkingSummary[];
  onSend: (
    recipient: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[],
    actionMode?: ActionMode,
    taskRefs?: TaskRef[],
    messageId?: string
  ) => Promise<SendMessageResult>;
  onCrossTeamSend?: ComposerCrossTeamSend;
  onSubmitIntent?: () => void;
  onDraftMutation?: () => void;
  onRecoveryDestinationChange?: (destination: ComposerDraftDestination | null) => void;
  onRevisionPreparationChange?: (controller: MessageRevisionTargetController | null) => void;
  onRevisionCancel?: (
    revision?: MessageRevisionContext | null,
    address?: ComposerDraftAddress
  ) => boolean | void | Promise<boolean>;
  onRevisionComplete?: (requestId: string, address: ComposerDraftAddress) => void;
}

export interface MessageRevisionRequest {
  requestId: string;
  originalMessageId: string;
  originalText: string;
  recipient: string;
  actionMode?: ActionMode;
}
