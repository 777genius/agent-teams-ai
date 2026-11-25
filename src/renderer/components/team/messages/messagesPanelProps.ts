import type { CollapsibleTeamSectionVariant } from '../CollapsibleTeamSection';
import type { ExpandedChatHost } from './MessagesThreadPlacement';
import type { MessageTaskSeed } from '@renderer/types/messageTaskSeed';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { TaskIdClickHandler } from '@renderer/utils/taskReferenceUtils';
import type { InboxMessage, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';
import type { RefObject } from 'react';

interface TimeWindow {
  start: number;
  end: number;
}

export interface MessagesPanelProps {
  isActive?: boolean;
  teamName: string;
  position: TeamMessagesPanelMode;
  onPositionChange: (position: TeamMessagesPanelMode) => void;
  mountPoint?: Element | null;
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  isTeamAlive?: boolean;
  leadActivity?: string;
  leadContextUpdatedAt?: string;
  timeWindow: TimeWindow | null;
  /** Current lead session ID. */
  currentLeadSessionId?: string;
  /** Pending replies tracker (shared with parent for MemberList). */
  pendingRepliesByMember: Record<string, number>;
  /** Update pending replies tracker. */
  onPendingReplyChange: (updater: (prev: Record<string, number>) => Record<string, number>) => void;
  /** Callback when a member is clicked in the timeline. */
  onMemberClick?: (member: ResolvedTeamMember) => void;
  /** Callback when a task is clicked from timeline or status block. */
  onTaskClick?: (task: TeamTaskWithKanban) => void;
  /** Callback to open create task dialog from a message. */
  onCreateTaskFromMessage?: (seed: MessageTaskSeed) => void;
  /** Callback to open reply dialog for a message. */
  onReplyToMessage?: (message: InboxMessage, recipientHint?: string) => void;
  /** Callback when "Restart team" is clicked. */
  onRestartTeam?: () => void;
  onTaskIdClick?: TaskIdClickHandler;
  /** Reports the rendered floating composer height so the parent can reserve scroll space. */
  onFloatingComposerHeightChange?: (height: number) => void;
  /** Parent-owned scroll viewport for the unchanged inline activity presentation. */
  inlineScrollContainerRef?: RefObject<HTMLDivElement | null>;
  /** Visual treatment for the inline section header. */
  sectionVariant?: CollapsibleTeamSectionVariant;
  /** Main-region host available only to the native team sidebar. */
  expandedChatHost?: ExpandedChatHost;
}
