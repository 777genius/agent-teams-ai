import { Fragment, memo, useCallback, useMemo } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { CopyButton } from '@renderer/components/common/CopyButton';
import { AttachmentDisplay } from '@renderer/components/team/attachments/AttachmentDisplay';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { TaskTooltip } from '@renderer/components/team/TaskTooltip';
import { ExpandableContent } from '@renderer/components/ui/ExpandableContent';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
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
  parseStructuredAgentMessage,
} from '@renderer/utils/agentMessageFormatting';
import {
  getBootstrapAcknowledgementDisplay,
  getBootstrapPromptDisplay,
  getSanitizedInboxMessageSummary,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  classifyIdleNotification,
  getIdleNoiseLabel,
} from '@renderer/utils/idleNotificationSemantics';
import { linkifyAllMentionsInMarkdown } from '@renderer/utils/mentionLinkify';
import {
  areInboxMessagesEquivalentForRender,
  areStringArraysEqual,
  areStringMapsEqual,
} from '@renderer/utils/messageRenderEquality';
import { linkifyTaskIdsInMarkdown, parseTaskLinkHref } from '@renderer/utils/taskReferenceUtils';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import {
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
  stripCrossTeamPrefix,
} from '@shared/constants/crossTeam';
import { extractMarkdownPlainText } from '@shared/utils/markdownTextSearch';
import { isRateLimitMessage } from '@shared/utils/rateLimitDetector';
import {
  buildStandaloneSlashCommandMeta,
  getKnownSlashCommand,
  parseStandaloneSlashCommand,
} from '@shared/utils/slashCommands';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  Command,
  ListPlus,
  Maximize2,
  MoveRight,
  RefreshCw,
  Reply,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ReplyQuoteBlock } from './ReplyQuoteBlock';

import type { TeamColorSet } from '@renderer/constants/teamColors';
import type { InboxMessage } from '@shared/types';

type StructuredMessage = Record<string, unknown>;

function parseQualifiedRecipient(
  value: string | undefined
): { teamName: string; memberName: string } | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  return {
    teamName: trimmed.slice(0, dot),
    memberName: trimmed.slice(dot + 1),
  };
}

function parseCrossTeamPseudoRecipient(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('cross-team:')) return null;
  const teamName = trimmed.slice('cross-team:'.length).trim();
  return teamName.length > 0 ? teamName : null;
}

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
  if (!match) {
    return { recipient: null, body: trimmed };
  }

  const recipient = match[1]?.trim() || null;
  const body = match[2]?.trim() || trimmed;
  return { recipient, body };
}

export function isQualifiedExternalRecipient(
  value: string | undefined,
  teamName: string,
  localMemberNames?: Set<string>
): boolean {
  const recipient = parseQualifiedRecipient(value);
  if (!recipient) return false;
  if (recipient.teamName === teamName) return false;
  return !localMemberNames?.has(value?.trim() ?? '');
}

export function getCrossTeamSentTarget(
  value: string | undefined,
  teamName: string,
  localMemberNames?: Set<string>
): string | null {
  const pseudoTarget = parseCrossTeamPseudoRecipient(value);
  if (pseudoTarget) return pseudoTarget;
  const recipient = parseQualifiedRecipient(value);
  if (!recipient) return null;
  if (recipient.teamName === teamName) return null;
  if (localMemberNames?.has(value?.trim() ?? '')) return null;
  return recipient.teamName;
}

export function getCrossTeamSentMemberName(value: string | undefined): string | null {
  return parseQualifiedRecipient(value)?.memberName ?? null;
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
  /** Map of member name → color name for @mention badge rendering. */
  memberColorMap?: Map<string, string>;
  /** Team color mapping for team:// links rendered inside markdown. */
  teamColorByName?: ReadonlyMap<string, string>;
  /** Opens a team tab from cross-team badges or team:// links. */
  onTeamClick?: (teamName: string) => void;
  onMemberNameClick?: (memberName: string) => void;
  onCreateTask?: (subject: string, description: string) => void;
  onReply?: (message: InboxMessage) => void;
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
}

function areMessagesEquivalentForActivityItem(prev: InboxMessage, next: InboxMessage): boolean {
  return areInboxMessagesEquivalentForRender(prev, next);
}

function getStringField(obj: StructuredMessage, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Check if a message renders as a compact noise row (idle, shutdown, etc.). */
export function isNoiseMessage(text: string): boolean {
  return (
    getIdleNoiseLabel(text) !== null ||
    ((): boolean => {
      const parsed = parseStructuredAgentMessage(text);
      return parsed !== null && getNoiseLabel(parsed) !== null;
    })()
  );
}

function getNoiseLabel(parsed: StructuredMessage): string | null {
  const type = getStringField(parsed, 'type');

  if (type === 'idle_notification') {
    return getIdleNoiseLabel(parsed);
  }

  if (type === 'shutdown_response') {
    return parsed.approve === true ? 'Shut down' : 'Rejected shutdown';
  }

  if (type === 'shutdown_request') {
    return 'Shutdown requested';
  }

  if (type === 'shutdown_approved' || type === 'teammate_terminated') {
    return type === 'shutdown_approved' ? 'Shutdown confirmed' : 'Terminated';
  }

  if (type === 'task_completed') {
    const rawTaskId = parsed.taskId;
    const taskId =
      typeof rawTaskId === 'string' || typeof rawTaskId === 'number' ? rawTaskId : null;
    return taskId !== null
      ? `Completed task ${formatTaskDisplayLabel({ id: String(taskId) })}`
      : 'Completed a task';
  }

  if (type === 'permission_request') {
    const toolName = getStringField(parsed, 'tool_name');
    return toolName ? `Permission: ${toolName}` : 'Permission request';
  }

  if (type === 'permission_response') {
    if (parsed.approved === true) return 'Permission granted';
    if (parsed.approved === false) return 'Permission denied';
    return 'Permission response';
  }

  return null;
}

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
      {name}
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
  summary,
  timestamp,
  onMemberNameClick,
}: {
  teamName: string;
  senderName: string;
  senderColor?: string;
  summary: string;
  timestamp: string;
  onMemberNameClick?: (memberName: string) => void;
}): React.JSX.Element => {
  const { recipient, body } = parseIdlePeerSummaryRoute(summary);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5" style={{ opacity: 0.78 }}>
      <span className="bg-sky-500/12 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
        update
      </span>
      <MemberBadge
        name={senderName}
        color={senderColor}
        teamName={teamName}
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
            {recipient}
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

const BootstrapSystemRow = ({
  teamName,
  senderName,
  recipientName,
  runtime,
  senderColor,
  recipientColor,
  timestamp,
  onMemberNameClick,
}: {
  teamName: string;
  senderName: string;
  recipientName: string;
  runtime?: string;
  senderColor?: string;
  recipientColor?: string;
  timestamp: string;
  onMemberNameClick?: (memberName: string) => void;
}): React.JSX.Element => (
  <div className="flex items-center gap-2 px-3 py-2" style={{ opacity: 0.82 }}>
    <span className="bg-sky-500/12 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
      start
    </span>
    <MemberBadge
      name={senderName}
      color={senderColor}
      teamName={teamName}
      hideAvatar
      onClick={onMemberNameClick}
    />
    <MoveRight size={10} style={{ color: CARD_ICON_MUTED }} className="shrink-0" />
    <MemberBadge
      name={recipientName}
      color={recipientColor}
      teamName={teamName}
      hideAvatar
      onClick={onMemberNameClick}
    />
    <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: CARD_ICON_MUTED }}>
      {runtime || 'Starting teammate'}
    </span>
    <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
      {timestamp}
    </span>
  </div>
);

const BootstrapAcknowledgementRow = ({
  teamName,
  senderName,
  recipientName,
  senderColor,
  recipientColor,
  timestamp,
  onMemberNameClick,
}: {
  teamName: string;
  senderName: string;
  recipientName: string;
  senderColor?: string;
  recipientColor?: string;
  timestamp: string;
  onMemberNameClick?: (memberName: string) => void;
}): React.JSX.Element => (
  <div className="flex items-center gap-2 px-3 py-2" style={{ opacity: 0.72 }}>
    <span className="bg-emerald-500/12 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
      bootstrap
    </span>
    <MemberBadge
      name={senderName}
      color={senderColor}
      teamName={teamName}
      hideAvatar
      onClick={onMemberNameClick}
    />
    <MoveRight size={10} style={{ color: CARD_ICON_MUTED }} className="shrink-0" />
    <MemberBadge
      name={recipientName}
      color={recipientColor}
      teamName={teamName}
      hideAvatar
      onClick={onMemberNameClick}
    />
    <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: CARD_ICON_MUTED }}>
      Bootstrap acknowledged
    </span>
    <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
      {timestamp}
    </span>
  </div>
);

// ---------------------------------------------------------------------------
// Detect historical system/automated messages that should be collapsed by default.
// These patterns are kept only for legacy compatibility with old inbox/session rows;
// new runtime behavior must not depend on exact legacy wording.
// ---------------------------------------------------------------------------

const SYSTEM_MESSAGE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /^New task assigned to you:/, label: 'Task' },
  { pattern: /^Task #[A-Za-z0-9-]+\s+approved/, label: 'Task approved' },
  { pattern: /^Task #[A-Za-z0-9-]+\s+needs fixes/, label: 'Review changes requested' },
];

export function getSystemMessageLabel(text: string): string | null {
  for (const { pattern, label } of SYSTEM_MESSAGE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

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

/** Detect authentication/authorization errors that may be resolved by restarting. */
const AUTH_ERROR_PATTERNS = [
  /OAuth token has expired/i,
  /API Error:\s*401/i,
  /authentication_error/i,
  /Failed to authenticate/i,
  /invalid.*api.key/i,
  /unauthorized/i,
];

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
    memberColorMap,
    teamColorByName,
    onTeamClick,
    onMemberNameClick,
    onCreateTask,
    onReply,
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
  }: Readonly<ActivityItemProps>): React.JSX.Element => {
    const colors = getTeamColorSet(memberColor ?? message.color ?? '');
    const { isLight } = useTheme();
    // Hide role when it matches the sender name (avoids "lead" badge + "Team Lead" text duplication)
    const formattedRole =
      memberRole && memberRole !== message.from ? formatAgentRole(memberRole) : null;

    const timestamp = useMemo(() => {
      if (Number.isNaN(Date.parse(message.timestamp))) return message.timestamp;
      const date = new Date(message.timestamp);
      const now = new Date();
      const isToday =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
      return isToday
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString();
    }, [message.timestamp]);

    const structured = parseStructuredAgentMessage(message.text);
    const bootstrapDisplay = useMemo(() => getBootstrapPromptDisplay(message), [message]);
    const bootstrapAcknowledgement = useMemo(
      () => getBootstrapAcknowledgementDisplay(message),
      [message]
    );
    // Only flag agent messages as rate-limited, not user's own quotes
    const rateLimited = message.from !== 'user' && isRateLimitMessage(message.text);
    // Highlight messages containing API errors
    const isApiError = message.text.includes('API Error');
    // Detect auth errors that may be resolved by restarting the team
    const isAuthError = isApiError && AUTH_ERROR_PATTERNS.some((p) => p.test(message.text));
    // Never collapse rate limit messages as noise — they must be visible
    const noiseLabel = structured && !rateLimited ? getNoiseLabel(structured) : null;
    const idleSemantic = useMemo(() => classifyIdleNotification(message), [message]);

    const systemLabel = !structured && !rateLimited ? getSystemMessageLabel(message.text) : null;
    const isManaged = collapseMode === 'managed';
    const isExpanded = isManaged ? !isCollapsed : true;

    const parsedCrossTeamPrefix = useMemo(() => parseCrossTeamPrefix(message.text), [message.text]);
    const qualifiedRecipient = useMemo(() => parseQualifiedRecipient(message.to), [message.to]);
    const crossTeamSentTarget = useMemo(
      () => getCrossTeamSentTarget(message.to, teamName, localMemberNames),
      [message.to, teamName, localMemberNames]
    );
    const crossTeamSentMemberName = useMemo(
      () => getCrossTeamSentMemberName(message.to),
      [message.to]
    );
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
      crossTeamOrigin?.memberName === 'user';
    const isUserSent = message.source === 'user_sent' || isCrossTeamSent;
    const isSystemMessage = message.from === 'system';

    // Strip agent-only blocks + normalize escape sequences (before linkification)
    const strippedText = useMemo(() => {
      if (structured) return null;
      let stripped = getSanitizedInboxMessageText(message).trim();
      if (!bootstrapDisplay) {
        stripped = stripAgentBlocks(stripped).trim();
      }
      if (!stripped) return null; // All content was agent-only blocks → show summary instead
      // Strip cross-team metadata tag (e.g. `<cross-team from="team.lead" depth="0" />\n`)
      // — kept in stored text for CLI agents / durable artifacts.
      if (isCrossTeamAny) {
        stripped = stripCrossTeamPrefix(stripped);
      }
      // Normalize literal \n from historical CLI-produced text to real newlines
      return stripped.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }, [structured, message, bootstrapDisplay, isCrossTeamAny]);
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
      let result = highlightSystemLabels(strippedText, !!systemLabel);
      result = linkifyTaskIdsInMarkdown(result, message.taskRefs);
      if ((memberColorMap && memberColorMap.size > 0) || teamNames.length > 0)
        result = linkifyAllMentionsInMarkdown(result, memberColorMap ?? new Map(), teamNames);
      return result;
    }, [strippedText, memberColorMap, teamNames, systemLabel]);

    const crossTeamPreview = useMemo(() => {
      if (!isCrossTeamAny || !strippedText) return '';
      const oneLine = strippedText.replace(/\n+/g, ' ').trim();
      if (!oneLine) return '';
      return oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine;
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
      const oneLine = plain.replace(/\n+/g, ' ');
      return oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine;
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
    const summaryText = useMemo(() => extractMarkdownPlainText(rawSummary), [rawSummary]);
    const commentTaskRef =
      message.messageKind === 'task_comment_notification' ? (message.taskRefs?.[0] ?? null) : null;
    const commentTaskDisplayId =
      commentTaskRef?.displayId ??
      (commentTaskRef?.taskId ? `#${commentTaskRef.taskId.slice(0, 6)}` : null);

    // Permission request status icon (check/x/clock)
    const pendingApprovals = useStore(useShallow((s) => s.pendingApprovals));
    const resolvedApprovals = useStore(useShallow((s) => s.resolvedApprovals));
    const permissionIcon = useMemo(() => {
      if (!structured) return null;
      const type = typeof structured.type === 'string' ? structured.type : null;
      if (type !== 'permission_request') return null;
      const requestId = typeof structured.request_id === 'string' ? structured.request_id : null;
      if (!requestId) return null;

      const resolved = resolvedApprovals.get(requestId);
      if (resolved === true) {
        return <Check size={12} className="text-emerald-400" />;
      }
      if (resolved === false) {
        return <X size={12} className="text-red-400" />;
      }
      const isPending = pendingApprovals.some((a) => a.requestId === requestId);
      if (isPending) {
        return <Clock size={12} className="animate-pulse text-amber-400" />;
      }
      // Not in pending and not resolved — already handled before we started tracking
      return <Check size={12} className="text-emerald-400/50" />;
    }, [structured, pendingApprovals, resolvedApprovals]);

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
          summary={idleSemantic.peerSummary}
          timestamp={timestamp}
          onMemberNameClick={onMemberNameClick}
        />
      );
    }

    if (bootstrapDisplay) {
      return (
        <BootstrapSystemRow
          teamName={teamName}
          senderName={senderName}
          recipientName={bootstrapDisplay.teammateName ?? message.to ?? 'teammate'}
          runtime={bootstrapDisplay.runtime}
          senderColor={senderColor}
          recipientColor={recipientColor}
          timestamp={timestamp}
          onMemberNameClick={onMemberNameClick}
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
          timestamp={timestamp}
          onMemberNameClick={onMemberNameClick}
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

    const senderBadge = isSlashCommandResult ? (
      <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
        result
      </span>
    ) : (
      <MemberBadge
        name={senderName}
        color={senderColor}
        teamName={teamName}
        hideAvatar={senderHideAvatar || compactHeader}
        onClick={onMemberNameClick}
        disableHoverCard={crossTeamOrigin != null}
      />
    );

    const messageTypeBadge = systemLabel ? (
      <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
        {systemLabel}
      </span>
    ) : commentTaskRef ? (
      <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
        Comment
      </span>
    ) : isSlashCommandResult && message.commandOutput ? (
      <span
        className={[
          'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
          isCommandOutputError ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300',
        ].join(' ')}
      >
        {message.commandOutput.stream}
      </span>
    ) : isSlashCommandMessage ? (
      <span className="text-[10px] uppercase tracking-wide text-amber-400">command</span>
    ) : messageType ? (
      <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
        {messageType}
      </span>
    ) : null;

    const leadSourceBadge =
      message.source === 'lead_session' && !isSlashCommandResult ? (
        <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
          session
        </span>
      ) : message.source === 'lead_process' && !isSlashCommandResult ? (
        <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
          live
        </span>
      ) : null;

    const statusBadge = rateLimited ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
        <AlertTriangle size={10} />
        Rate Limited
      </span>
    ) : isApiError ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
        <AlertTriangle size={10} />
        API Error
      </span>
    ) : null;

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
      ) : message.to && message.to !== message.from ? (
        <>
          <MoveRight size={10} style={{ color: CARD_ICON_MUTED }} className="shrink-0" />
          {crossTeamTarget ? (
            <CrossTeamTeamBadge teamName={crossTeamTarget} onClick={onTeamClick} />
          ) : null}
          {crossTeamSentMemberName || !crossTeamTarget ? (
            <MemberBadge
              name={crossTeamSentMemberName ?? qualifiedRecipient?.memberName ?? message.to}
              color={crossTeamTarget ? undefined : recipientColor}
              teamName={crossTeamTarget ? undefined : teamName}
              hideAvatar={
                compactHeader ||
                (crossTeamSentMemberName ?? qualifiedRecipient?.memberName ?? message.to) === 'user'
              }
              onClick={onMemberNameClick}
              disableHoverCard={crossTeamTarget != null}
            />
          ) : null}
        </>
      ) : null;

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

    return (
      <article
        className="group overflow-hidden rounded-md"
        style={{
          marginLeft: isSlashCommandResult ? 26 : isUserSent ? 15 : undefined,
          backgroundColor:
            rateLimited || isApiError
              ? 'var(--tool-result-error-bg)'
              : isSlashCommandResult
                ? 'rgba(245, 158, 11, 0.08)'
                : isSlashCommandMessage
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
              : isSlashCommandResult
                ? '1px solid rgba(245, 158, 11, 0.22)'
                : isSlashCommandMessage
                  ? '1px solid rgba(245, 158, 11, 0.22)'
                  : isCrossTeamAny
                    ? '1px solid var(--cross-team-border)'
                    : isSystemMessage
                      ? '1px solid var(--system-activity-border)'
                      : CARD_BORDER_STYLE,
          borderLeft:
            rateLimited || isApiError
              ? '3px solid var(--tool-result-error-text)'
              : isSlashCommandResult
                ? '3px solid rgba(245, 158, 11, 0.85)'
                : isSlashCommandMessage
                  ? '3px solid rgba(245, 158, 11, 0.85)'
                  : isCrossTeamAny
                    ? '3px solid var(--cross-team-accent)'
                    : isSystemMessage
                      ? '3px solid var(--system-activity-accent)'
                      : `3px solid ${getThemedBorder(colors, isLight)}`,
        }}
      >
        {/* Header — div with role=button (cannot use <button> due to nested buttons inside) */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- role=button, tabIndex, onKeyDown below; nested buttons prevent using native button */}
        <div
          role={isHeaderClickable ? 'button' : undefined}
          tabIndex={isHeaderClickable ? 0 : undefined}
          className={[
            useCompactCollapsedHeader
              ? 'min-w-0 px-3 py-2'
              : 'flex min-w-0 items-center gap-2 px-3 py-2',
            isHeaderClickable ? 'cursor-pointer select-none' : '',
          ].join(' ')}
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
          {useCompactCollapsedHeader ? (
            <div className="min-w-0">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  {isUnread ? (
                    <span
                      className="size-2 shrink-0 rounded-full bg-blue-500"
                      title="Unread"
                      aria-hidden
                    />
                  ) : null}
                  {crossTeamOrigin ? (
                    <CrossTeamTeamBadge teamName={crossTeamOrigin.teamName} onClick={onTeamClick} />
                  ) : null}
                  {senderBadge}
                  {messageTypeBadge}
                  {leadSourceBadge}
                  {statusBadge}
                  {recipientBadge}
                </div>
                <div className="relative flex shrink-0 items-center">
                  <span
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
                      aria-label="Expand message"
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
              <div
                className="mt-1 min-w-0 truncate text-[11px]"
                style={{ color: CARD_TEXT_LIGHT }}
                title={summaryText || rawSummary}
              >
                {summaryContent}
              </div>
            </div>
          ) : (
            <>
              {isUnread ? (
                <span
                  className="size-2 shrink-0 rounded-full bg-blue-500"
                  title="Unread"
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
              {senderBadge}
              {!compactHeader && formattedRole && !isSlashCommandResult ? (
                <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                  {formattedRole}
                </span>
              ) : null}
              {messageTypeBadge}
              {leadSourceBadge}
              {statusBadge}
              {recipientBadge}
              <span className="min-w-0 flex-1 truncate text-xs" style={{ color: CARD_TEXT_LIGHT }}>
                {summaryContent}
              </span>
              <div className="relative flex shrink-0 items-center">
                <span
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
                    aria-label="Expand message"
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
          <div className="min-w-0 overflow-hidden px-3 pb-3">
            {structured ? (
              <div className="space-y-2">
                {autoSummary && autoSummary !== messageType ? (
                  <p className="text-xs text-[var(--color-text-secondary)]">{autoSummary}</p>
                ) : null}
                <details className="rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                  <summary className="cursor-pointer px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
                    Raw JSON
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
                      'rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
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
                memberColor={memberColorMap?.get(parsedReply.agentName)}
                replyTaskRefs={message.taskRefs}
              />
            ) : displayText ? (
              <div
                className={`group/message-body relative${isApiError ? '[&_code]:!text-red-400 [&_p]:!text-red-400' : ''}`}
                style={isApiError ? { color: '#f87171' } : undefined}
              >
                <div className="absolute right-1 top-1 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message-body:opacity-100">
                  {onReply ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="rounded p-1 transition-colors hover:bg-[var(--color-surface-raised)]"
                          style={{ color: CARD_ICON_MUTED }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onReply(message);
                          }}
                        >
                          <Reply size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">Reply to message</TooltipContent>
                    </Tooltip>
                  ) : null}
                  {onCreateTask ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="rounded p-1 transition-colors hover:bg-[var(--color-surface-raised)]"
                          style={{ color: CARD_ICON_MUTED }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCreateTask();
                          }}
                        >
                          <ListPlus size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">Create task from message</TooltipContent>
                    </Tooltip>
                  ) : null}
                  <CopyButton text={displayText} inline />
                </div>
                <ExpandableContent onExpand={onExpandContent}>
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
                    Authentication failed. Restarting the team will refresh the session and may
                    resolve this issue. If the problem persists, check your API credentials or try
                    again later.
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
                    Restart team
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
  },
  (prev, next) =>
    prev.teamName === next.teamName &&
    prev.localMemberNames === next.localMemberNames &&
    prev.memberRole === next.memberRole &&
    prev.memberColor === next.memberColor &&
    prev.recipientColor === next.recipientColor &&
    prev.isUnread === next.isUnread &&
    prev.memberColorMap === next.memberColorMap &&
    areStringArraysEqual(prev.teamNames, next.teamNames) &&
    areStringMapsEqual(prev.teamColorByName, next.teamColorByName) &&
    prev.onTeamClick === next.onTeamClick &&
    prev.onMemberNameClick === next.onMemberNameClick &&
    prev.onCreateTask === next.onCreateTask &&
    prev.onReply === next.onReply &&
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
    areMessagesEquivalentForActivityItem(prev.message, next.message)
);

ActivityItem.displayName = 'ActivityItem';
