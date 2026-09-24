import { Fragment, memo, useCallback, useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  CompactMarkdownPreview,
  MarkdownViewer,
} from '@renderer/components/chat/viewers/MarkdownViewer';
import { CopyButton } from '@renderer/components/common/CopyButton';
import { AttachmentDisplay } from '@renderer/components/team/attachments/AttachmentDisplay';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { TaskTooltip } from '@renderer/components/team/TaskTooltip';
import { ExpandableContent } from '@renderer/components/ui/ExpandableContent';
import {
  CARD_BG,
  CARD_BG_ZEBRA,
  CARD_BORDER_STYLE,
  CARD_ICON_MUTED,
  CARD_TEXT_LIGHT,
} from '@renderer/constants/cssVariables';
import { getTeamColorSet, getThemedBorder } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import {
  getMessageTypeLabel,
  getStructuredMessageSummary,
  parseMessageReply,
} from '@renderer/utils/agentMessageFormatting';
import {
  getBootstrapAcknowledgementDisplay,
  getBootstrapPromptDisplay,
  getSanitizedInboxMessageSummary,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { displayMemberName } from '@renderer/utils/memberHelpers';
import { linkifyAllMentionsInMarkdown } from '@renderer/utils/mentionLinkify';
import {
  areInboxMessagesEquivalentForRender,
  areStringArraysEqual,
  areStringMapsEqual,
} from '@renderer/utils/messageRenderEquality';
import { linkifyTaskIdsInMarkdown, parseTaskLinkHref } from '@renderer/utils/taskReferenceUtils';
import {
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
} from '@shared/constants/crossTeam';
import { isRateLimitMessage } from '@shared/utils/rateLimitDetector';
import {
  buildStandaloneSlashCommandMeta,
  getKnownSlashCommand,
  parseStandaloneSlashCommand,
} from '@shared/utils/slashCommands';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  isMemberWorkSyncNudgeMessage,
  isTaskStallRemediationMessage,
} from '@shared/utils/teamAutomationMessages';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  Command,
  Maximize2,
  MoveRight,
  RefreshCw,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ActivityMessageHoverCard } from './ActivityMessageHoverCard';
import {
  type ChatAppearance,
  classifyActivityMessagePresentation,
  classifyIdleNotificationCached,
  getCrossTeamSentMemberName,
  getCrossTeamSentTarget,
  getNoiseLabel,
  getStrippedActivityTextCached,
  getSystemMessageLabel,
  parseQualifiedRecipient,
  parseStructuredAgentMessageCached,
} from './activityMessagePresentation';
import { isDirectParticipantSender, shouldHideDirectMemberRoute } from './activityRecipientRoute';
import {
  encodeCacheParts,
  extractMarkdownPlainTextCached,
  getCachedString,
  stringArrayCacheSignature,
  stringMapCacheSignature,
  taskRefsCacheSignature,
} from './activityRenderCache';
import { formatActivityTimestamp } from './activityTimestamp';
import { BootstrapAcknowledgementRow, BootstrapSystemRow } from './BootstrapActivityRows';
import { ReplyQuoteBlock } from './ReplyQuoteBlock';
import {
  getTimelineCardBorderRadius,
  joinsPreviousTimelineCard,
  type TimelineCardPosition,
} from './timelineCardStack';
import { TimelineHeaderAccent } from './TimelineHeaderAccent';

import type { TeamColorSet } from '@renderer/constants/teamColors';
import type { InboxMessage } from '@shared/types';

export {
  getCrossTeamSentMemberName,
  getCrossTeamSentTarget,
  getSystemMessageLabel,
  isNoiseMessage,
  isQualifiedExternalRecipient,
} from './activityMessagePresentation';

const ACTIVITY_HEADER_BG_DARK = 'rgba(0, 0, 0, 0.18)';
const ACTIVITY_HEADER_BG_LIGHT = 'rgba(15, 23, 42, 0.055)';
const ACTIVITY_ERROR_HEADER_BG = 'rgba(248, 113, 113, 0.1)';

interface PermissionStatusIconProps {
  requestId: string;
}

const PermissionStatusIcon = memo(function PermissionStatusIcon({
  requestId,
}: PermissionStatusIconProps): React.JSX.Element {
  const pendingApprovals = useStore(useShallow((s) => s.pendingApprovals));
  const resolvedApprovals = useStore(useShallow((s) => s.resolvedApprovals));

  const resolved = resolvedApprovals.get(requestId);
  if (resolved === true) return <Check size={12} className="text-emerald-400" />;
  if (resolved === false) return <X size={12} className="text-red-400" />;
  const isPending = pendingApprovals.some((a) => a.requestId === requestId);
  if (isPending) return <Clock size={12} className="animate-pulse text-amber-400" />;
  return <Check size={12} className="text-emerald-400/50" />;
});

function getCommandOutputSummary(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

function parseIdlePeerSummaryRoute(summary: string): { recipient: string | null; body: string } {
  const trimmed = summary.trim();
  const match = /^\[to\s+([^\]]+)\]\s*(.*)$/i.exec(trimmed);
  if (!match) return { recipient: null, body: trimmed };

  const recipient = match[1]?.trim() || null;
  const body = match[2]?.trim() || trimmed;
  return { recipient, body };
}

const CrossTeamTeamBadge = ({
  teamName,
  onClick,
}: {
  teamName: string;
  onClick?: (teamName: string) => void;
}): React.JSX.Element => {
  if (onClick) {
    return (
      <button
        type="button"
        className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
        style={{
          backgroundColor: 'rgba(168, 85, 247, 0.15)',
          color: '#c084fc',
          cursor: 'pointer',
          border: 'none',
          padding: '1px 6px',
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClick(teamName);
        }}
      >
        {teamName}
      </button>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
      style={{ backgroundColor: 'rgba(168, 85, 247, 0.15)', color: '#c084fc' }}
    >
      {teamName}
    </span>
  );
};

interface ActivityItemProps {
  message: InboxMessage;
  teamName: string;
  localMemberNames?: Set<string>;
  teamNames?: string[];
  memberRole?: string;
  memberColor?: string;
  recipientColor?: string;
  /** When true, show a blue unread dot. */
  isUnread?: boolean;
  /** Briefly tint a newly arrived message using the sidebar unread color. */
  isNewMessageHighlighted?: boolean;
  /** Map of member name → color name for @mention badge rendering. */
  memberColorMap?: Map<string, string>;
  /** Team color mapping for team:// links rendered inside markdown. */
  teamColorByName?: ReadonlyMap<string, string>;
  /** Opens a team tab from cross-team badges or team:// links. */
  onTeamClick?: (teamName: string) => void;
  onMemberNameClick?: (memberName: string) => void;
  onCreateTask?: (subject: string, description: string) => void;
  onReply?: (message: InboxMessage) => void;
  canRevise?: boolean;
  onRevise?: (message: InboxMessage) => void;
  /** Called when a task ID link (e.g. #10) is clicked in message text. */
  onTaskIdClick?: (taskId: string) => void;
  /** Called when the user clicks "Restart team" on an auth error message. */
  onRestartTeam?: () => void;
  /** When true, apply a subtle lighter background for zebra-striped lists. */
  zebraShade?: boolean;
  /** Collapsed-mode primitives stabilized by ActivityTimeline. */
  collapseMode?: 'default' | 'managed';
  isCollapsed?: boolean;
  canToggleCollapse?: boolean;
  collapseToggleKey?: string;
  onToggleCollapse?: (key: string) => void;
  /** Compact header mode for narrow message lists. */
  compactHeader?: boolean;
  /** Callback to expand this item into a fullscreen dialog. */
  onExpand?: (key: string) => void;
  /** Stable key for expand identification. */
  expandItemKey?: string;
  /** Called when ExpandableContent is expanded via "Show more". */
  onExpandContent?: () => void;
  timelineCardPosition?: TimelineCardPosition;
  /** 1:1 participant; when set, hide redundant from→to member routes. */
  directParticipant?: string;
  appearance?: ChatAppearance;
  continuesPreviousAuthor?: boolean;
  continuesNextAuthor?: boolean;
}

function areMessagesEquivalentForActivityItem(prev: InboxMessage, next: InboxMessage): boolean {
  return areInboxMessagesEquivalentForRender(prev, next);
}

const EMPTY_MEMBER_COLOR_MAP = new Map<string, string>();
const activityDisplayTextCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Compact noise row (idle, shutdown, terminated) — minimal dot + name + label
// ---------------------------------------------------------------------------

const NoiseRow = ({
  name,
  label,
  colors,
  icon,
}: {
  name: string;
  label: string;
  colors: TeamColorSet;
  icon?: React.ReactNode;
}): React.JSX.Element => (
  <div className="flex items-center gap-2 px-3 py-1" style={{ opacity: 0.45 }}>
    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colors.border }} />
    <span className="text-[11px]" style={{ color: CARD_ICON_MUTED }}>
      {displayMemberName(name)}
    </span>
    <span className="text-[11px]" style={{ color: CARD_ICON_MUTED }}>
      {label}
    </span>
    {icon}
  </div>
);

const PassiveIdlePeerSummaryRow = ({
  teamName,
  senderName,
  senderColor,
  isLight,
  summary,
  timestamp,
  onMemberNameClick,
}: {
  teamName: string;
  senderName: string;
  senderColor?: string;
  isLight: boolean;
  summary: string;
  timestamp: string;
  onMemberNameClick?: (memberName: string) => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { recipient, body } = parseIdlePeerSummaryRoute(summary);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5" style={{ opacity: 0.78 }}>
      <span className="bg-sky-500/12 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-sky-300">
        {t('activity.badges.note')}
      </span>
      <MemberBadge
        name={senderName}
        color={senderColor}
        teamName={teamName}
        isLight={isLight}
        variant="text"
        hideAvatar={false}
        onClick={onMemberNameClick}
      />
      {recipient ? (
        <>
          <MoveRight size={10} style={{ color: CARD_ICON_MUTED }} className="shrink-0" />
          <span
            className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide"
            style={{
              backgroundColor: 'rgba(148, 163, 184, 0.12)',
              color: CARD_TEXT_LIGHT,
            }}
          >
            {displayMemberName(recipient)}
          </span>
        </>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-xs" style={{ color: CARD_TEXT_LIGHT }}>
        {body}
      </span>
      <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
        {timestamp}
      </span>
    </div>
  );
};

const TaskStallRemediationRow = ({
  teamName,
  recipientName,
  recipientColor,
  isLight,
  taskRef,
  timestamp,
  onMemberNameClick,
  onTaskIdClick,
}: {
  teamName: string;
  recipientName: string;
  recipientColor?: string;
  isLight: boolean;
  taskRef?: NonNullable<InboxMessage['taskRefs']>[number];
  timestamp: string;
  onMemberNameClick?: (memberName: string) => void;
  onTaskIdClick?: (taskId: string) => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const taskLabel = taskRef
    ? formatTaskDisplayLabel({ id: taskRef.taskId, displayId: taskRef.displayId })
    : null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5" style={{ opacity: 0.82 }}>
      <span
        className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-amber-300"
        style={{ backgroundColor: 'rgba(245, 158, 11, 0.12)' }}
      >
        {t('activity.badges.automation')}
      </span>
      <span className="text-[11px] tracking-wide" style={{ color: CARD_ICON_MUTED }}>
        {t('activity.badges.stallNudge')}
      </span>
      <MoveRight size={10} style={{ color: CARD_ICON_MUTED }} className="shrink-0" />
      <MemberBadge
        name={recipientName}
        color={recipientColor}
        teamName={teamName}
        isLight={isLight}
        variant="text"
        hideAvatar
        onClick={onMemberNameClick}
      />
      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: CARD_TEXT_LIGHT }}>
        {t('activity.automation.stallNudge')}
        {taskRef && taskLabel ? (
          <>
            {' '}
            <button
              type="button"
              className="font-medium text-blue-300 hover:text-blue-200"
              onClick={(event) => {
                event.stopPropagation();
                onTaskIdClick?.(taskRef.taskId);
              }}
            >
              {taskLabel}
            </button>
          </>
        ) : null}
      </span>
      <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
        {timestamp}
      </span>
    </div>
  );
};

const MemberWorkSyncNudgeRow = ({
  teamName,
  recipientName,
  recipientColor,
  isLight,
  taskRefs,
  intent,
  timestamp,
  onMemberNameClick,
  onTaskIdClick,
}: {
  teamName: string;
  recipientName: string;
  recipientColor?: string;
  isLight: boolean;
  taskRefs?: InboxMessage['taskRefs'];
  intent?: InboxMessage['workSyncIntent'];
  timestamp: string;
  onMemberNameClick?: (memberName: string) => void;
  onTaskIdClick?: (taskId: string) => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const primaryTaskRef = taskRefs?.[0];
  const taskLabel = primaryTaskRef
    ? formatTaskDisplayLabel({ id: primaryTaskRef.taskId, displayId: primaryTaskRef.displayId })
    : null;
  const extraTaskCount = Math.max((taskRefs?.length ?? 0) - 1, 0);
  const body =
    intent === 'review_pickup'
      ? t('activity.automation.reviewPickup')
      : t('activity.automation.workSyncBody');

  return (
    <div className="flex items-center gap-2 px-3 py-1.5" style={{ opacity: 0.82 }}>
      <span
        className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-amber-300"
        style={{ backgroundColor: 'rgba(245, 158, 11, 0.12)' }}
      >
        {t('activity.badges.automation')}
      </span>
      <span className="text-[11px] tracking-wide" style={{ color: CARD_ICON_MUTED }}>
        {t('activity.badges.workSync')}
      </span>
      <MoveRight size={10} style={{ color: CARD_ICON_MUTED }} className="shrink-0" />
      <MemberBadge
        name={recipientName}
        color={recipientColor}
        teamName={teamName}
        isLight={isLight}
        variant="text"
        hideAvatar
        onClick={onMemberNameClick}
      />
      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: CARD_TEXT_LIGHT }}>
        {body}
        {primaryTaskRef && taskLabel ? (
          <>
            {' '}
            <button
              type="button"
              className="font-medium text-blue-300 hover:text-blue-200"
              onClick={(event) => {
                event.stopPropagation();
                onTaskIdClick?.(primaryTaskRef.taskId);
              }}
            >
              {taskLabel}
            </button>
            {extraTaskCount > 0 ? ` +${extraTaskCount} more` : null}
          </>
        ) : null}
      </span>
      <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
        {timestamp}
      </span>
    </div>
  );
};

/** Labels to highlight in task assignment / review messages (bold in markdown). */
const TASK_MESSAGE_LABELS = [
  'New task assigned to you:',
  'Description:',
  'Task approved',
  'Task needs fixes',
  'Review changes requested',
  'Changes requested:',
  'Comments:',
  'Reviewer:',
  'Related:',
  'Blocked by:',
  'Blocks:',
];

/** Make known structural labels bold in system/task messages. */
function highlightSystemLabels(text: string, isSystem: boolean): string {
  if (!isSystem) return text;
  let result = text;
  for (const label of TASK_MESSAGE_LABELS) {
    // Escape any regex-special chars in the label, match at line start or after newline
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(^|\\n)(${escaped})`, 'g'), '$1**$2**');
  }
  return result;
}

const AUTH_ERROR_PATTERNS = [
  /OAuth token has expired/i,
  /API Error:\s*401/i,
  /authentication_error/i,
  /Failed to authenticate/i,
  /invalid.*api.key/i,
  /unauthorized/i,
];

function buildActivityDisplayText(
  strippedText: string,
  isSystem: boolean,
  taskRefs: InboxMessage['taskRefs'],
  memberColorMap: Map<string, string> | undefined,
  teamNames: readonly string[]
): string {
  const cacheKey = encodeCacheParts([
    strippedText,
    isSystem ? '1' : '0',
    taskRefsCacheSignature(taskRefs),
    stringMapCacheSignature(memberColorMap),
    stringArrayCacheSignature(teamNames),
  ]);

  return getCachedString(activityDisplayTextCache, cacheKey, () => {
    let result = highlightSystemLabels(strippedText, isSystem);
    result = linkifyTaskIdsInMarkdown(result, taskRefs);
    if ((memberColorMap && memberColorMap.size > 0) || teamNames.length > 0) {
      result = linkifyAllMentionsInMarkdown(
        result,
        memberColorMap ?? EMPTY_MEMBER_COLOR_MAP,
        teamNames
      );
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Full message card — left colored border, name badge, collapsible content
// ---------------------------------------------------------------------------

/** Render `#<task-display-id>` in plain text as clickable inline elements with TaskTooltip. */
function linkifyTaskIds(text: string, onClick: (taskId: string) => void): React.ReactNode[] {
  return text.split(/(#[A-Za-z0-9-]+\b)/g).map((part, i) => {
    const match = /^#([A-Za-z0-9-]+)$/.exec(part);
    if (!match) return <Fragment key={i}>{part}</Fragment>;
    const taskId = match[1];
    return (
      <TaskTooltip key={i} taskId={taskId}>
        <button
          type="button"
          className="inline cursor-pointer font-medium text-blue-600 hover:underline dark:text-blue-400"
          onClick={(e) => {
            e.stopPropagation();
            onClick(taskId);
          }}
        >
          {part}
        </button>
      </TaskTooltip>
    );
  });
}

/**
 * Render summary text with inline bold markdown and optional task-id linkification.
 * Splits on bold markers first, then linkifies task IDs within each segment.
 */
function renderInlineBoldSummary(
  text: string,
  onTaskIdClick?: (taskId: string) => void
): React.ReactNode {
  // Split by **bold** segments, keeping delimiters
  const boldPattern = /(\*\*[^*]+\*\*)/g;
  const parts = text.split(boldPattern);
  return parts.map((part, i) => {
    const boldContent = /^\*\*(.+)\*\*$/.exec(part);
    if (boldContent) {
      const inner = boldContent[1];
      return (
        <strong key={i} className="font-semibold">
          {onTaskIdClick ? linkifyTaskIds(inner, onTaskIdClick) : inner}
        </strong>
      );
    }
    return onTaskIdClick ? (
      <Fragment key={i}>{linkifyTaskIds(part, onTaskIdClick)}</Fragment>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    );
  });
}

const TaskRecipientBadge = ({
  taskId,
  displayId,
  teamName,
  onTaskIdClick,
}: Readonly<{
  taskId: string;
  displayId: string;
  teamName?: string;
  onTaskIdClick?: (taskId: string) => void;
}>): React.JSX.Element => {
  const content = (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
      style={{
        backgroundColor: 'rgba(96, 165, 250, 0.14)',
        color: '#60a5fa',
        border: '1px solid rgba(96, 165, 250, 0.3)',
      }}
    >
      {displayId}
    </span>
  );

  if (!onTaskIdClick) {
    return content;
  }

  return (
    <TaskTooltip taskId={taskId} teamName={teamName}>
      <button
        type="button"
        className="inline-flex rounded transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
        onClick={(e) => {
          e.stopPropagation();
          onTaskIdClick(taskId);
        }}
      >
        {content}
      </button>
    </TaskTooltip>
  );
};

export const ActivityItem = memo(
  ({
    message,
    teamName,
    localMemberNames,
    teamNames = [],
    memberRole,
    memberColor,
    recipientColor,
    isUnread,
    isNewMessageHighlighted,
    memberColorMap,
    teamColorByName,
    onTeamClick,
    onMemberNameClick,
    onCreateTask,
    onReply,
    canRevise,
    onRevise,
    onTaskIdClick,
    onRestartTeam,
    zebraShade,
    collapseMode = 'default',
    isCollapsed = false,
    canToggleCollapse = false,
    collapseToggleKey,
    onToggleCollapse,
    compactHeader = false,
    onExpand,
    expandItemKey,
    onExpandContent,
    timelineCardPosition = 'single',
    directParticipant,
    appearance = 'compact',
    continuesPreviousAuthor = false,
    continuesNextAuthor = false,
  }: Readonly<ActivityItemProps>): React.JSX.Element => {
    const { t } = useAppTranslation('team');
    const colors = getTeamColorSet(memberColor ?? message.color ?? '');
    const { isLight } = useTheme();
    // Hide role when it matches the sender name (avoids "lead" badge + "Team Lead" text duplication)
    const formattedRole =
      memberRole && memberRole !== message.from ? formatAgentRole(memberRole) : null;
    const timestamp = useMemo(
      () => formatActivityTimestamp(message.timestamp),
      [message.timestamp]
    );
    const structured = parseStructuredAgentMessageCached(message.text);
    const bootstrapDisplay = getBootstrapPromptDisplay(message);
    const bootstrapAcknowledgement = getBootstrapAcknowledgementDisplay(message);
    const hideDirectRoute = (to?: string): boolean =>
      shouldHideDirectMemberRoute(to, message.from, directParticipant);
    // Only flag agent messages as rate-limited, not user's own quotes
    const rateLimited = message.from !== 'user' && isRateLimitMessage(message.text);
    // Highlight messages containing API errors
    const isApiError = message.messageKind === 'agent_error' || message.text.includes('API Error');
    // Detect auth errors that may be resolved by restarting the team
    const isAuthError = isApiError && AUTH_ERROR_PATTERNS.some((p) => p.test(message.text));
    // Never collapse rate limit messages as noise — they must be visible
    const noiseLabel = structured && !rateLimited ? getNoiseLabel(structured) : null;
    const idleSemantic = classifyIdleNotificationCached(message);
    const systemLabel = !structured && !rateLimited ? getSystemMessageLabel(message.text) : null;
    const isManaged = collapseMode === 'managed';
    const isExpanded = isManaged ? !isCollapsed : true;
    const messagePresentation = classifyActivityMessagePresentation(
      message,
      teamName,
      localMemberNames
    );
    const isWideOrdinary = appearance === 'wide-chat' && messagePresentation.kind !== 'special';
    const isWideUser = isWideOrdinary && messagePresentation.kind === 'ordinary-user';
    const isWideAgent = isWideOrdinary && !isWideUser;
    const hideWideAuthor = isWideOrdinary && (isWideUser || continuesPreviousAuthor);
    const parsedCrossTeamPrefix = parseCrossTeamPrefix(message.text);
    const qualifiedRecipient = parseQualifiedRecipient(message.to);
    const crossTeamSentTarget = getCrossTeamSentTarget(message.to, teamName, localMemberNames);
    const crossTeamSentMemberName = getCrossTeamSentMemberName(message.to);
    const isCrossTeam = message.source === CROSS_TEAM_SOURCE || parsedCrossTeamPrefix !== null;
    const isCrossTeamSent =
      message.source === CROSS_TEAM_SENT_SOURCE || crossTeamSentTarget !== null;
    const isCrossTeamAny = isCrossTeam || isCrossTeamSent;
    const crossTeamOrigin = useMemo(() => {
      if (!isCrossTeam) return null;
      const fromValue = parsedCrossTeamPrefix?.from ?? message.from;
      const dot = fromValue.indexOf('.');
      if (dot <= 0 || dot === fromValue.length - 1) return null;
      return {
        teamName: fromValue.substring(0, dot),
        memberName: fromValue.substring(dot + 1),
      };
    }, [isCrossTeam, message.from, parsedCrossTeamPrefix]);
    const crossTeamTarget = useMemo(() => {
      if (!isCrossTeamSent) return null;
      if (crossTeamSentTarget) return crossTeamSentTarget;
      if (qualifiedRecipient) return qualifiedRecipient.teamName;
      if (!message.to) return null;
      const dot = message.to.indexOf('.');
      if (dot <= 0) return message.to;
      return message.to.substring(0, dot);
    }, [crossTeamSentTarget, isCrossTeamSent, message.to, qualifiedRecipient]);
    const senderName = crossTeamOrigin ? crossTeamOrigin.memberName : message.from;
    const senderColor = crossTeamOrigin ? undefined : (memberColor ?? message.color);
    const senderHideAvatar =
      message.from === 'user' ||
      message.from === 'system' ||
      crossTeamOrigin?.memberName === 'user' ||
      (isWideAgent && isDirectParticipantSender(senderName, directParticipant));
    const isUserSent = message.source === 'user_sent' || isCrossTeamSent;
    const isSystemMessage = message.from === 'system';

    // Strip agent-only blocks + normalize escape sequences (before linkification)
    const strippedText = useMemo(
      () =>
        getStrippedActivityTextCached({
          message,
          structured,
          hasBootstrapDisplay: bootstrapDisplay !== null,
          isCrossTeamAny,
        }),
      [structured, message, bootstrapDisplay, isCrossTeamAny]
    );
    const standaloneSlashCommand = useMemo(
      () => (strippedText ? parseStandaloneSlashCommand(strippedText) : null),
      [strippedText]
    );
    const slashCommandMeta = useMemo(
      () =>
        message.slashCommand ??
        (standaloneSlashCommand
          ? buildStandaloneSlashCommandMeta(standaloneSlashCommand.raw)
          : null),
      [message.slashCommand, standaloneSlashCommand]
    );
    const knownSlashCommand = useMemo(
      () => (slashCommandMeta?.name ? (getKnownSlashCommand(slashCommandMeta.name) ?? null) : null),
      [slashCommandMeta]
    );
    const isSlashCommandResult =
      message.messageKind === 'slash_command_result' && !!message.commandOutput;
    const isSlashCommandMessage =
      !isSlashCommandResult &&
      (message.messageKind === 'slash_command' || (isUserSent && standaloneSlashCommand !== null));
    const isCommandOutputError = isSlashCommandResult && message.commandOutput?.stream === 'stderr';
    // Parse reply BEFORE linkification — linkifyAllMentionsInMarkdown transforms @name
    // into markdown links which breaks the reply regex matcher
    const parsedReply = useMemo(
      () => (strippedText ? parseMessageReply(strippedText) : null),
      [strippedText]
    );
    // Linkify task IDs (always, for TaskTooltip) + @mentions for display
    const displayText = useMemo(() => {
      if (!strippedText) return null;
      return buildActivityDisplayText(
        strippedText,
        !!systemLabel,
        message.taskRefs,
        memberColorMap,
        teamNames
      );
    }, [strippedText, message.taskRefs, memberColorMap, teamNames, systemLabel]);
    const wideContent =
      isWideAgent &&
      !!displayText &&
      (displayText.length >= 600 || /```|^\s*\|.+\|\s*$/m.test(displayText));
    const showWideSender =
      !hideWideAuthor ||
      (isWideAgent && (wideContent || (!senderHideAvatar && !continuesNextAuthor)));
    const crossTeamPreview = useMemo(() => {
      if (!isCrossTeamAny || !strippedText) return '';
      const oneLine = strippedText.replace(/\n+/g, ' ').trim();
      if (!oneLine) return '';
      return oneLine;
    }, [isCrossTeamAny, strippedText]);
    const rawSummary = useMemo(() => {
      if (idleSemantic?.hasPeerSummary && idleSemantic.peerSummary) {
        return idleSemantic.peerSummary;
      }
      if (isSlashCommandResult && message.commandOutput) {
        return message.summary || getCommandOutputSummary(message.text);
      }
      if (isSlashCommandMessage && slashCommandMeta) {
        if (slashCommandMeta.args) {
          const oneLine = slashCommandMeta.args.replace(/\n+/g, ' ').trim();
          return `${slashCommandMeta.command} ${oneLine}`;
        }
        return slashCommandMeta.command;
      }
      if (crossTeamPreview) return crossTeamPreview;
      const s =
        getSanitizedInboxMessageSummary(message) ||
        (structured ? getStructuredMessageSummary(structured) : '') ||
        '';
      if (s) return s;
      // Fallback: use the beginning of message text as preview for plain-text messages
      const plain = getSanitizedInboxMessageText(message).trim();
      if (!plain) return '';
      return plain.replace(/\n+/g, ' ');
    }, [
      crossTeamPreview,
      isSlashCommandMessage,
      isSlashCommandResult,
      message.commandOutput,
      message,
      idleSemantic,
      slashCommandMeta,
      structured,
    ]);
    const summaryText = extractMarkdownPlainTextCached(rawSummary);
    const compactPreviewMarkdown = useMemo(() => {
      if (idleSemantic?.hasPeerSummary && idleSemantic.peerSummary) {
        return idleSemantic.peerSummary;
      }
      if (isSlashCommandResult && message.commandOutput) {
        return message.summary || getCommandOutputSummary(message.text);
      }
      if (isSlashCommandMessage && slashCommandMeta) {
        if (slashCommandMeta.args) {
          const oneLine = slashCommandMeta.args.replace(/\n+/g, ' ').trim();
          return `${slashCommandMeta.command} ${oneLine}`;
        }
        return slashCommandMeta.command;
      }
      if (crossTeamPreview) return crossTeamPreview;

      const formattedDisplayText = displayText?.trim() ?? '';
      if (formattedDisplayText) {
        return formattedDisplayText;
      }

      return summaryText || rawSummary;
    }, [
      crossTeamPreview,
      displayText,
      idleSemantic,
      isSlashCommandMessage,
      isSlashCommandResult,
      message,
      message.commandOutput,
      rawSummary,
      slashCommandMeta,
      summaryText,
    ]);
    const compactPreviewTooltipText = useMemo(() => {
      const normalized = extractMarkdownPlainTextCached(compactPreviewMarkdown)
        .replace(/\n+/g, ' ')
        .trim();
      return normalized || compactPreviewMarkdown;
    }, [compactPreviewMarkdown]);
    const commentTaskRef =
      message.messageKind === 'task_comment_notification' ? (message.taskRefs?.[0] ?? null) : null;
    const commentTaskDisplayId =
      commentTaskRef?.displayId ??
      (commentTaskRef?.taskId ? `#${commentTaskRef.taskId.slice(0, 6)}` : null);

    const permissionRequestId = useMemo(() => {
      if (!structured) return null;
      const type = typeof structured.type === 'string' ? structured.type : null;
      if (type !== 'permission_request') return null;
      const requestId = typeof structured.request_id === 'string' ? structured.request_id : null;
      return requestId || null;
    }, [structured]);
    const permissionIcon = permissionRequestId ? (
      <PermissionStatusIcon requestId={permissionRequestId} />
    ) : null;

    // Noise messages: minimal inline row
    if (noiseLabel) {
      return (
        <NoiseRow name={message.from} label={noiseLabel} colors={colors} icon={permissionIcon} />
      );
    }

    if (idleSemantic?.uiPresentation === 'peer_summary' && idleSemantic.peerSummary) {
      return (
        <PassiveIdlePeerSummaryRow
          teamName={teamName}
          senderName={senderName}
          senderColor={senderColor}
          isLight={isLight}
          summary={idleSemantic.peerSummary}
          timestamp={timestamp}
          onMemberNameClick={onMemberNameClick}
        />
      );
    }

    if (isTaskStallRemediationMessage(message)) {
      return (
        <TaskStallRemediationRow
          teamName={teamName}
          recipientName={message.to ?? 'teammate'}
          recipientColor={recipientColor}
          isLight={isLight}
          taskRef={message.taskRefs?.[0]}
          timestamp={timestamp}
          onMemberNameClick={onMemberNameClick}
          onTaskIdClick={onTaskIdClick}
        />
      );
    }

    if (isMemberWorkSyncNudgeMessage(message)) {
      return (
        <MemberWorkSyncNudgeRow
          teamName={teamName}
          recipientName={message.to ?? 'teammate'}
          recipientColor={recipientColor}
          isLight={isLight}
          taskRefs={message.taskRefs}
          intent={message.workSyncIntent}
          timestamp={timestamp}
          onMemberNameClick={onMemberNameClick}
          onTaskIdClick={onTaskIdClick}
        />
      );
    }

    if (bootstrapDisplay) {
      return (
        <BootstrapSystemRow
          teamName={teamName}
          eventKind={bootstrapDisplay.eventKind}
          senderName={senderName}
          recipientName={bootstrapDisplay.teammateName ?? message.to ?? 'teammate'}
          runtime={bootstrapDisplay.runtime}
          senderColor={senderColor}
          recipientColor={recipientColor}
          isLight={isLight}
          timestamp={timestamp}
          onMemberNameClick={onMemberNameClick}
          showRecipientRoute={!hideDirectRoute(bootstrapDisplay.teammateName ?? message.to)}
        />
      );
    }

    if (bootstrapAcknowledgement) {
      return (
        <BootstrapAcknowledgementRow
          teamName={teamName}
          senderName={senderName}
          recipientName={message.to ?? 'lead'}
          senderColor={senderColor}
          recipientColor={recipientColor}
          isLight={isLight}
          timestamp={timestamp}
          onMemberNameClick={onMemberNameClick}
          showRecipientRoute={!hideDirectRoute(message.to)}
        />
      );
    }

    const messageType =
      structured && typeof structured.type === 'string'
        ? getMessageTypeLabel(structured.type)
        : null;
    const autoSummary = structured ? getStructuredMessageSummary(structured) : null;

    const handleCreateTask = useCallback((): void => {
      const subject = message.summary || autoSummary || `Task from ${message.from}`;
      const plainText = structured
        ? JSON.stringify(structured, null, 2)
        : getSanitizedInboxMessageText(message);
      const description = `From: ${message.from}\nAt: ${timestamp}\n\n${plainText}`.slice(0, 2000);
      onCreateTask?.(subject, description);
    }, [autoSummary, message.from, message.summary, message, onCreateTask, structured, timestamp]);

    const isHeaderClickable = isManaged && canToggleCollapse;
    const showChevron = isHeaderClickable && !compactHeader;
    const handleHeaderToggle = useCallback(() => {
      if (isHeaderClickable && collapseToggleKey) {
        onToggleCollapse?.(collapseToggleKey);
      }
    }, [collapseToggleKey, isHeaderClickable, onToggleCollapse]);
    const useCompactCollapsedHeader = compactHeader && !isExpanded;
    const activityAccentColor =
      rateLimited || isApiError
        ? 'var(--tool-result-error-text)'
        : isSlashCommandResult || isSlashCommandMessage
          ? 'rgba(245, 158, 11, 0.85)'
          : isCrossTeamAny
            ? 'var(--cross-team-accent)'
            : isSystemMessage
              ? 'var(--system-activity-accent)'
              : getThemedBorder(colors, isLight);
    const headerStyle = {
      backgroundColor:
        rateLimited || isApiError
          ? ACTIVITY_ERROR_HEADER_BG
          : isLight
            ? ACTIVITY_HEADER_BG_LIGHT
            : ACTIVITY_HEADER_BG_DARK,
    };
    const headerAccent = <TimelineHeaderAccent color={activityAccentColor} />;

    const senderBadge = isSlashCommandResult ? (
      <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium tracking-wide text-amber-300">
        {t('activity.badges.result')}
      </span>
    ) : (
      <MemberBadge
        name={senderName}
        color={senderColor}
        teamName={teamName}
        isLight={isLight}
        size={isWideAgent ? 'md' : undefined}
        variant="text"
        hideAvatar={senderHideAvatar || compactHeader}
        onClick={onMemberNameClick}
        disableHoverCard={crossTeamOrigin != null}
      />
    );

    const messageTypeBadge = systemLabel ? (
      <span className="text-[10px] tracking-wide" style={{ color: CARD_ICON_MUTED }}>
        {systemLabel}
      </span>
    ) : commentTaskRef ? (
      <span className="text-[10px] tracking-wide" style={{ color: CARD_ICON_MUTED }}>
        {t('activity.badges.comment')}
      </span>
    ) : isSlashCommandResult && message.commandOutput ? (
      <span
        className={[
          'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] tracking-wide',
          isCommandOutputError ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300',
        ].join(' ')}
      >
        {message.commandOutput.stream}
      </span>
    ) : isSlashCommandMessage ? (
      <span className="text-[10px] tracking-wide text-amber-400">
        {t('activity.badges.command')}
      </span>
    ) : messageType ? (
      <span className="text-[10px] tracking-wide" style={{ color: CARD_ICON_MUTED }}>
        {messageType}
      </span>
    ) : null;

    const leadSourceBadge =
      message.source === 'lead_session' && !isSlashCommandResult ? (
        <span className="text-[10px] tracking-wide" style={{ color: CARD_ICON_MUTED }}>
          {t('activity.badges.session')}
        </span>
      ) : message.source === 'lead_process' && !isSlashCommandResult ? (
        <span className="text-[10px] tracking-wide" style={{ color: CARD_ICON_MUTED }}>
          {t('activity.badges.live')}
        </span>
      ) : null;

    const statusBadge = rateLimited ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
        <AlertTriangle size={10} />
        {t('activity.badges.rateLimited')}
      </span>
    ) : isApiError ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
        <AlertTriangle size={10} />
        {message.messageKind === 'agent_error'
          ? t('activity.badges.agentError')
          : t('activity.badges.apiError')}
      </span>
    ) : null;

    const hideMemberRoute = hideDirectRoute(message.to);
    const recipientMemberName =
      crossTeamSentMemberName ?? qualifiedRecipient?.memberName ?? message.to;
    const quotedRecipientAlreadyShown =
      isWideOrdinary &&
      parsedReply != null &&
      crossTeamTarget == null &&
      recipientMemberName?.trim().toLowerCase() === parsedReply.agentName.trim().toLowerCase();
    const recipientBadge =
      commentTaskRef && commentTaskDisplayId ? (
        <>
          <MoveRight size={10} style={{ color: CARD_ICON_MUTED }} className="shrink-0" />
          <TaskRecipientBadge
            taskId={commentTaskRef.taskId}
            displayId={commentTaskDisplayId}
            teamName={commentTaskRef.teamName}
            onTaskIdClick={onTaskIdClick}
          />
        </>
      ) : hideMemberRoute ||
        quotedRecipientAlreadyShown ||
        !(message.to && message.to !== message.from) ? null : (
        <>
          <MoveRight size={10} style={{ color: CARD_ICON_MUTED }} className="shrink-0" />
          {crossTeamTarget ? (
            <CrossTeamTeamBadge teamName={crossTeamTarget} onClick={onTeamClick} />
          ) : null}
          {crossTeamSentMemberName || !crossTeamTarget ? (
            <MemberBadge
              name={recipientMemberName ?? message.to}
              color={crossTeamTarget ? undefined : recipientColor}
              teamName={crossTeamTarget ? undefined : teamName}
              isLight={isLight}
              variant="text"
              hideAvatar={compactHeader || recipientMemberName === 'user'}
              onClick={onMemberNameClick}
              disableHoverCard={crossTeamTarget != null}
            />
          ) : null}
        </>
      );

    const summaryContent =
      isSlashCommandResult && message.commandOutput ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Command
            size={12}
            className={['shrink-0', isCommandOutputError ? 'text-rose-400' : 'text-amber-400'].join(
              ' '
            )}
          />
          <span
            className={[
              'shrink-0 font-mono text-[11px]',
              isCommandOutputError ? 'text-rose-300' : 'text-amber-300',
            ].join(' ')}
          >
            {message.commandOutput.commandLabel}
          </span>
          <span className="min-w-0 truncate text-[11px] text-[var(--color-text-secondary)]">
            {message.summary || getCommandOutputSummary(message.text) || rawSummary}
          </span>
        </span>
      ) : isSlashCommandMessage && slashCommandMeta ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Command size={12} className="shrink-0 text-amber-400" />
          <span className="shrink-0 font-mono text-[11px] text-amber-300">
            {slashCommandMeta.command}
          </span>
          {slashCommandMeta.args ? (
            <span className="min-w-0 truncate text-[11px] text-[var(--color-text-secondary)]">
              {slashCommandMeta.args.replace(/\n+/g, ' ')}
            </span>
          ) : (slashCommandMeta.knownDescription ?? knownSlashCommand?.description) ? (
            <span className="min-w-0 truncate text-[11px] text-[var(--color-text-secondary)]">
              {slashCommandMeta.knownDescription ?? knownSlashCommand?.description}
            </span>
          ) : null}
        </span>
      ) : onTaskIdClick ? (
        renderInlineBoldSummary(rawSummary, onTaskIdClick)
      ) : (
        renderInlineBoldSummary(rawSummary)
      );
    const showHoverToolbar = Boolean(displayText);
    /* eslint-disable jsx-a11y/no-noninteractive-tabindex -- wide chat rows expose hover metadata on keyboard focus without changing the nested control semantics */
    const card = (
      <article
        data-message-presentation={isWideOrdinary ? messagePresentation.kind : undefined}
        data-wide-agent={isWideAgent ? 'true' : undefined}
        data-wide-content={wideContent ? 'true' : undefined}
        data-hide-direct-avatar={isWideAgent && senderHideAvatar ? 'true' : undefined}
        data-continues-author={isWideOrdinary && continuesPreviousAuthor ? 'true' : undefined}
        data-continues-next-author={isWideOrdinary && continuesNextAuthor ? 'true' : undefined}
        data-expanded={isExpanded ? 'true' : 'false'}
        data-has-recipient-route={recipientBadge ? 'true' : 'false'}
        aria-label={isWideOrdinary ? `${displayMemberName(message.from)}, ${timestamp}` : undefined}
        tabIndex={isWideOrdinary && showHoverToolbar ? 0 : undefined}
        className={[
          'activity-timeline-card group relative overflow-hidden',
          isWideOrdinary ? 'wide-chat-message' : '',
          "after:pointer-events-none after:absolute after:inset-0 after:z-[1] after:bg-blue-500 after:transition-opacity after:duration-300 after:content-['']",
          isNewMessageHighlighted
            ? isLight
              ? 'after:opacity-[0.03]'
              : 'after:opacity-[0.05]'
            : 'after:opacity-0',
        ].join(' ')}
        style={{
          borderRadius: isWideOrdinary ? 8 : getTimelineCardBorderRadius(timelineCardPosition),
          marginLeft: isWideOrdinary
            ? undefined
            : isSlashCommandResult
              ? 26
              : isUserSent
                ? 15
                : undefined,
          backgroundColor:
            rateLimited || isApiError
              ? 'var(--tool-result-error-bg)'
              : isSlashCommandResult || isSlashCommandMessage
                ? 'rgba(245, 158, 11, 0.08)'
                : isCrossTeamAny
                  ? 'var(--cross-team-bg)'
                  : isSystemMessage
                    ? 'var(--system-activity-bg)'
                    : zebraShade
                      ? CARD_BG_ZEBRA
                      : CARD_BG,
          border:
            rateLimited || isApiError
              ? '1px solid var(--tool-result-error-border)'
              : isSlashCommandResult || isSlashCommandMessage
                ? '1px solid rgba(245, 158, 11, 0.22)'
                : isCrossTeamAny
                  ? '1px solid var(--cross-team-border)'
                  : isSystemMessage
                    ? '1px solid var(--system-activity-border)'
                    : CARD_BORDER_STYLE,
          borderTopWidth: joinsPreviousTimelineCard(timelineCardPosition) ? 0 : undefined,
        }}
      >
        {/* Header — div with role=button (cannot use <button> due to nested buttons inside) */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- role=button, tabIndex, onKeyDown below; nested buttons prevent using native button */}
        <div
          role={isHeaderClickable ? 'button' : undefined}
          tabIndex={isHeaderClickable ? 0 : undefined}
          className={[
            isExpanded ? 'relative flex min-w-0 items-center gap-2 px-2.5 py-1.5' : 'min-w-0',
            isHeaderClickable ? 'cursor-pointer select-none' : '',
            isWideOrdinary ? 'wide-chat-message-header' : '',
          ].join(' ')}
          style={isExpanded ? headerStyle : undefined}
          onClick={handleHeaderToggle}
          onKeyDown={
            isHeaderClickable
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleHeaderToggle?.();
                  }
                }
              : undefined
          }
        >
          {isExpanded && !isWideOrdinary ? headerAccent : null}
          {useCompactCollapsedHeader ? (
            <div className="min-w-0">
              <div
                className="relative flex min-w-0 items-start gap-3 px-2.5 py-1.5"
                style={headerStyle}
              >
                {headerAccent}
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  {isUnread ? (
                    <span
                      className="size-2 shrink-0 rounded-full bg-blue-500"
                      title={t('activity.unread')}
                      aria-hidden
                    />
                  ) : null}
                  {crossTeamOrigin ? (
                    <CrossTeamTeamBadge teamName={crossTeamOrigin.teamName} onClick={onTeamClick} />
                  ) : null}
                  {showWideSender ? senderBadge : null}
                  {messageTypeBadge}
                  {leadSourceBadge}
                  {statusBadge}
                  {recipientBadge}
                </div>
                <div className="relative flex shrink-0 items-center">
                  <span
                    data-chat-metadata="true"
                    className={
                      onExpand && expandItemKey
                        ? 'text-[10px] transition-opacity group-hover:opacity-0'
                        : 'text-[10px]'
                    }
                    style={{ color: CARD_ICON_MUTED }}
                  >
                    {timestamp}
                  </span>
                  {onExpand && expandItemKey && (
                    <button
                      type="button"
                      aria-label={t('activity.actions.expandMessage')}
                      className="absolute right-0 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50 group-hover:opacity-100"
                      style={{ color: CARD_ICON_MUTED }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onExpand(expandItemKey);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Maximize2 size={12} />
                    </button>
                  )}
                </div>
              </div>
              <div className="px-2.5 pb-1.5" title={compactPreviewTooltipText}>
                <CompactMarkdownPreview
                  content={compactPreviewMarkdown}
                  className="mt-1 line-clamp-2 w-full min-w-0 max-w-full break-words text-[11px] leading-4"
                  teamColorByName={teamColorByName}
                  onTeamClick={onTeamClick}
                />
              </div>
            </div>
          ) : !isExpanded ? (
            <div className="min-w-0 flex-1">
              <div
                className="relative flex min-w-0 items-center gap-2 px-2.5 py-1.5"
                style={headerStyle}
              >
                {headerAccent}
                {isUnread ? (
                  <span
                    className="size-2 shrink-0 rounded-full bg-blue-500"
                    title={t('activity.unread')}
                    aria-hidden
                  />
                ) : null}
                {showChevron ? (
                  <ChevronRight
                    className="size-3 shrink-0 transition-transform duration-150"
                    style={{
                      color: CARD_ICON_MUTED,
                      transform: isExpanded ? 'rotate(90deg)' : undefined,
                    }}
                  />
                ) : null}
                {crossTeamOrigin ? (
                  <CrossTeamTeamBadge teamName={crossTeamOrigin.teamName} onClick={onTeamClick} />
                ) : null}
                {showWideSender ? senderBadge : null}
                {!hideWideAuthor && !compactHeader && formattedRole && !isSlashCommandResult ? (
                  <span
                    data-chat-metadata={isWideOrdinary ? 'true' : undefined}
                    className="text-[10px]"
                    style={{ color: CARD_ICON_MUTED }}
                  >
                    {formattedRole}
                  </span>
                ) : null}
                {messageTypeBadge}
                {leadSourceBadge}
                {statusBadge}
                {recipientBadge}
                <div className="relative ml-auto flex shrink-0 items-center">
                  <span
                    data-chat-metadata="true"
                    className={
                      onExpand && expandItemKey
                        ? 'text-[10px] transition-opacity group-hover:opacity-0'
                        : 'text-[10px]'
                    }
                    style={{ color: CARD_ICON_MUTED }}
                  >
                    {timestamp}
                  </span>
                  {onExpand && expandItemKey && (
                    <button
                      type="button"
                      aria-label={t('activity.actions.expandMessage')}
                      className="absolute right-0 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50 group-hover:opacity-100"
                      style={{ color: CARD_ICON_MUTED }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onExpand(expandItemKey);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Maximize2 size={12} />
                    </button>
                  )}
                </div>
              </div>
              <div className="px-2.5 pb-1.5" title={compactPreviewTooltipText}>
                <CompactMarkdownPreview
                  content={compactPreviewMarkdown}
                  className="mt-1 line-clamp-2 w-full min-w-0 max-w-full break-words text-[11px] leading-4"
                  teamColorByName={teamColorByName}
                  onTeamClick={onTeamClick}
                />
              </div>
            </div>
          ) : (
            <>
              {isUnread ? (
                <span
                  className="size-2 shrink-0 rounded-full bg-blue-500"
                  title={t('activity.unread')}
                  aria-hidden
                />
              ) : null}
              {showChevron ? (
                <ChevronRight
                  className="size-3 shrink-0 transition-transform duration-150"
                  style={{
                    color: CARD_ICON_MUTED,
                    transform: isExpanded ? 'rotate(90deg)' : undefined,
                  }}
                />
              ) : null}
              {crossTeamOrigin ? (
                <CrossTeamTeamBadge teamName={crossTeamOrigin.teamName} onClick={onTeamClick} />
              ) : null}
              {showWideSender ? senderBadge : null}
              {!hideWideAuthor && !compactHeader && formattedRole && !isSlashCommandResult ? (
                <span
                  data-chat-metadata={isWideOrdinary ? 'true' : undefined}
                  className="text-[10px]"
                  style={{ color: CARD_ICON_MUTED }}
                >
                  {formattedRole}
                </span>
              ) : null}
              {messageTypeBadge}
              {leadSourceBadge}
              {statusBadge}
              {recipientBadge}
              {!isWideOrdinary ? (
                <span
                  className="min-w-0 flex-1 truncate text-xs"
                  style={{ color: CARD_TEXT_LIGHT }}
                >
                  {summaryContent}
                </span>
              ) : (
                <span className="min-w-0 flex-1" aria-hidden />
              )}
              <div className="relative flex shrink-0 items-center">
                <span
                  data-chat-metadata="true"
                  className={
                    onExpand && expandItemKey
                      ? 'text-[10px] transition-opacity group-hover:opacity-0'
                      : 'text-[10px]'
                  }
                  style={{ color: CARD_ICON_MUTED }}
                >
                  {timestamp}
                </span>
                {onExpand && expandItemKey && (
                  <button
                    type="button"
                    aria-label={t('activity.actions.expandMessage')}
                    className="absolute right-0 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50 group-hover:opacity-100"
                    style={{ color: CARD_ICON_MUTED }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onExpand(expandItemKey);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Maximize2 size={12} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Content — collapsed for system messages, expanded for others */}
        {isExpanded ? (
          <div className="wide-chat-message-body min-w-0 overflow-hidden px-2.5 pb-2.5">
            {structured ? (
              <div className="space-y-2">
                {autoSummary && autoSummary !== messageType ? (
                  <p className="text-xs text-[var(--color-text-secondary)]">{autoSummary}</p>
                ) : null}
                <details className="rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                  <summary className="cursor-pointer px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
                    {t('activity.rawJson')}
                  </summary>
                  <pre className="overflow-auto px-2 pb-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                    {JSON.stringify(structured, null, 2)}
                  </pre>
                </details>
              </div>
            ) : isSlashCommandResult && message.commandOutput ? (
              <div
                className={[
                  'rounded-md px-3 py-2',
                  isCommandOutputError
                    ? 'border border-rose-400/20 bg-rose-500/5'
                    : 'border border-amber-400/20 bg-amber-500/5',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <Command
                    size={14}
                    className={[
                      'shrink-0',
                      isCommandOutputError ? 'text-rose-400' : 'text-amber-400',
                    ].join(' ')}
                  />
                  <span
                    className={[
                      'font-mono text-xs',
                      isCommandOutputError ? 'text-rose-300' : 'text-amber-300',
                    ].join(' ')}
                  >
                    {message.commandOutput.commandLabel}
                  </span>
                  <span
                    className={[
                      'rounded-full px-1.5 py-0.5 text-[10px] tracking-wide',
                      isCommandOutputError
                        ? 'bg-rose-500/15 text-rose-300'
                        : 'bg-amber-500/15 text-amber-300',
                    ].join(' ')}
                  >
                    {message.commandOutput.stream}
                  </span>
                  <div className="ml-auto">
                    <CopyButton text={message.text} inline />
                  </div>
                </div>
                <ExpandableContent className="mt-2" collapsedHeight={160}>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                    {message.text}
                  </pre>
                </ExpandableContent>
              </div>
            ) : isSlashCommandMessage && slashCommandMeta ? (
              <div className="rounded-md border border-amber-400/20 bg-amber-500/5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Command size={14} className="shrink-0 text-amber-400" />
                  <span className="font-mono text-xs text-amber-300">
                    {slashCommandMeta.command}
                  </span>
                </div>
                {(slashCommandMeta.knownDescription ?? knownSlashCommand?.description) ? (
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                    {slashCommandMeta.knownDescription ?? knownSlashCommand?.description}
                  </p>
                ) : null}
                {slashCommandMeta.args ? (
                  <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-[11px] text-[var(--color-text-secondary)]">
                    {slashCommandMeta.args}
                  </div>
                ) : null}
              </div>
            ) : parsedReply ? (
              <ReplyQuoteBlock
                reply={parsedReply}
                appearance={isWideOrdinary ? 'wide-chat' : 'compact'}
                teamName={teamName}
                memberColor={memberColorMap?.get(parsedReply.agentName)}
                replyTaskRefs={message.taskRefs}
              />
            ) : displayText ? (
              <div
                className={isApiError ? '[&_code]:!text-red-400 [&_p]:!text-red-400' : undefined}
                style={isApiError ? { color: '#f87171' } : undefined}
              >
                <ExpandableContent
                  collapsedHeight={isWideOrdinary ? 400 : undefined}
                  fadeLengthPercent={isWideOrdinary ? 20 : undefined}
                  onExpand={onExpandContent}
                >
                  <span
                    onClickCapture={
                      onTaskIdClick
                        ? (e) => {
                            const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(
                              'a[href^="task://"]'
                            );
                            if (link) {
                              e.preventDefault();
                              e.stopPropagation();
                              const href = link.getAttribute('href');
                              const parsedTaskLink = href ? parseTaskLinkHref(href) : null;
                              if (parsedTaskLink?.taskId) onTaskIdClick(parsedTaskLink.taskId);
                            }
                          }
                        : undefined
                    }
                  >
                    <MarkdownViewer
                      content={displayText}
                      maxHeight="max-h-none"
                      className="[&_li]:text-[13px] [&_p]:text-[13px] [&_table]:text-[13px]"
                      bare
                      teamColorByName={teamColorByName}
                      onTeamClick={onTeamClick}
                    />
                  </span>
                </ExpandableContent>
              </div>
            ) : summaryText ? (
              <p className="text-xs italic" style={{ color: CARD_TEXT_LIGHT }}>
                {summaryText}
              </p>
            ) : null}
            {/* Auth error recovery action */}
            {isAuthError && onRestartTeam ? (
              <div className="mt-2 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 px-3 py-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
                <div className="flex-1 space-y-1.5">
                  <p className="text-[11px] leading-relaxed text-red-300/90">
                    {t('activity.authError.description')}
                  </p>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md bg-red-500/20 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/30 hover:text-red-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRestartTeam();
                    }}
                  >
                    <RefreshCw size={11} />
                    {t('activity.actions.restartTeam')}
                  </button>
                </div>
              </div>
            ) : null}
            {message.attachments?.length && message.messageId ? (
              <AttachmentDisplay
                teamName={teamName}
                messageId={message.messageId}
                attachments={message.attachments}
              />
            ) : null}
          </div>
        ) : null}
      </article>
    );
    /* eslint-enable jsx-a11y/no-noninteractive-tabindex */

    return (
      <ActivityMessageHoverCard
        copyText={displayText ?? ''}
        showToolbar={showHoverToolbar}
        canRevise={Boolean(canRevise && onRevise)}
        appearance={isWideOrdinary ? 'wide-chat' : 'compact'}
        alignToEnd={isWideUser}
        timestamp={isWideOrdinary ? timestamp : undefined}
        onRevise={onRevise ? () => onRevise(message) : undefined}
        onReply={onReply ? () => onReply(message) : undefined}
        onCreateTask={onCreateTask ? handleCreateTask : undefined}
      >
        {card}
      </ActivityMessageHoverCard>
    );
  },
  (prev, next) =>
    prev.teamName === next.teamName &&
    prev.localMemberNames === next.localMemberNames &&
    prev.memberRole === next.memberRole &&
    prev.memberColor === next.memberColor &&
    prev.recipientColor === next.recipientColor &&
    prev.isUnread === next.isUnread &&
    prev.isNewMessageHighlighted === next.isNewMessageHighlighted &&
    prev.memberColorMap === next.memberColorMap &&
    areStringArraysEqual(prev.teamNames, next.teamNames) &&
    areStringMapsEqual(prev.teamColorByName, next.teamColorByName) &&
    prev.onTeamClick === next.onTeamClick &&
    prev.onMemberNameClick === next.onMemberNameClick &&
    prev.onCreateTask === next.onCreateTask &&
    prev.onReply === next.onReply &&
    prev.canRevise === next.canRevise &&
    prev.onRevise === next.onRevise &&
    prev.onTaskIdClick === next.onTaskIdClick &&
    prev.onRestartTeam === next.onRestartTeam &&
    prev.zebraShade === next.zebraShade &&
    prev.collapseMode === next.collapseMode &&
    prev.isCollapsed === next.isCollapsed &&
    prev.canToggleCollapse === next.canToggleCollapse &&
    prev.collapseToggleKey === next.collapseToggleKey &&
    prev.onToggleCollapse === next.onToggleCollapse &&
    prev.compactHeader === next.compactHeader &&
    prev.onExpand === next.onExpand &&
    prev.expandItemKey === next.expandItemKey &&
    prev.onExpandContent === next.onExpandContent &&
    prev.timelineCardPosition === next.timelineCardPosition &&
    prev.directParticipant === next.directParticipant &&
    prev.appearance === next.appearance &&
    prev.continuesPreviousAuthor === next.continuesPreviousAuthor &&
    prev.continuesNextAuthor === next.continuesNextAuthor &&
    areMessagesEquivalentForActivityItem(prev.message, next.message)
);

ActivityItem.displayName = 'ActivityItem';
