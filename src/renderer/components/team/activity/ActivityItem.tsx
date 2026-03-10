import { useMemo } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
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
import {
  getMessageTypeLabel,
  getStructuredMessageSummary,
  parseMessageReply,
  parseStructuredAgentMessage,
} from '@renderer/utils/agentMessageFormatting';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { linkifyMentionsInMarkdown } from '@renderer/utils/mentionLinkify';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import {
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
  stripCrossTeamPrefix,
} from '@shared/constants/crossTeam';
import { extractMarkdownPlainText } from '@shared/utils/markdownTextSearch';
import { isRateLimitMessage } from '@shared/utils/rateLimitDetector';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { AlertTriangle, ChevronRight, ListPlus, RefreshCw, Reply } from 'lucide-react';

import { isManagedCollapseState } from './collapseState';
import { ReplyQuoteBlock } from './ReplyQuoteBlock';

import type { ActivityCollapseState } from './collapseState';
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

function CrossTeamTeamBadge({ teamName }: { teamName: string }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
      style={{ backgroundColor: 'rgba(168, 85, 247, 0.15)', color: '#c084fc' }}
    >
      {teamName}
    </span>
  );
}

interface ActivityItemProps {
  message: InboxMessage;
  teamName: string;
  localMemberNames?: Set<string>;
  memberRole?: string;
  memberColor?: string;
  recipientColor?: string;
  /** When true, show a blue unread dot. */
  isUnread?: boolean;
  /** Map of member name → color name for @mention badge rendering. */
  memberColorMap?: Map<string, string>;
  onMemberNameClick?: (memberName: string) => void;
  onCreateTask?: (subject: string, description: string) => void;
  onReply?: (message: InboxMessage) => void;
  /** Called when a task ID link (e.g. #10) is clicked in message text. */
  onTaskIdClick?: (taskId: string) => void;
  /** Called when the user clicks "Restart team" on an auth error message. */
  onRestartTeam?: () => void;
  /** When true, apply a subtle lighter background for zebra-striped lists. */
  zebraShade?: boolean;
  /** Explicit collapse state for timeline-controlled collapsed mode. */
  collapseState?: ActivityCollapseState;
}

function getStringField(obj: StructuredMessage, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Check if a message renders as a compact noise row (idle, shutdown, etc.). */
export function isNoiseMessage(text: string): boolean {
  const parsed = parseStructuredAgentMessage(text);
  return parsed !== null && getNoiseLabel(parsed) !== null;
}

function getNoiseLabel(parsed: StructuredMessage): string | null {
  const type = getStringField(parsed, 'type');

  if (type === 'idle_notification') {
    const reason = getStringField(parsed, 'idleReason');
    return reason ? `Idle (${reason})` : 'Idle';
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

  return null;
}

// ---------------------------------------------------------------------------
// Compact noise row (idle, shutdown, terminated) — minimal dot + name + label
// ---------------------------------------------------------------------------

const NoiseRow = ({
  name,
  label,
  colors,
}: {
  name: string;
  label: string;
  colors: TeamColorSet;
}): React.JSX.Element => (
  <div className="flex items-center gap-2 px-3 py-1" style={{ opacity: 0.45 }}>
    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colors.border }} />
    <span className="text-[11px]" style={{ color: CARD_ICON_MUTED }}>
      {name}
    </span>
    <span className="text-[11px]" style={{ color: CARD_ICON_MUTED }}>
      {label}
    </span>
  </div>
);

// ---------------------------------------------------------------------------
// Detect historical system/automated messages that should be collapsed by default.
// These patterns are kept only for legacy compatibility with old inbox/session rows;
// new runtime behavior must not depend on exact legacy wording.
// ---------------------------------------------------------------------------

const SYSTEM_MESSAGE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /^New task assigned to you:/, label: 'Task assignment' },
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

/** Convert `#<task-display-id>` in plain text to markdown links with task:// protocol. */
export function linkifyTaskIdsInMarkdown(text: string): string {
  return text.replace(/#([A-Za-z0-9-]+)\b/g, '[#$1](task://$1)');
}

/** Render `#<task-display-id>` in plain text as clickable inline elements with TaskTooltip. */
function linkifyTaskIds(text: string, onClick: (taskId: string) => void): React.ReactNode[] {
  return text.split(/(#[A-Za-z0-9-]+\b)/g).map((part, i) => {
    const match = /^#([A-Za-z0-9-]+)$/.exec(part);
    if (!match) return <span key={i}>{part}</span>;
    const taskId = match[1];
    return (
      <TaskTooltip key={i} taskId={taskId}>
        <button
          type="button"
          className="cursor-pointer font-medium text-blue-600 hover:underline dark:text-blue-400"
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

export const ActivityItem = ({
  message,
  teamName,
  localMemberNames,
  memberRole,
  memberColor,
  recipientColor,
  isUnread,
  memberColorMap,
  onMemberNameClick,
  onCreateTask,
  onReply,
  onTaskIdClick,
  onRestartTeam,
  zebraShade,
  collapseState,
}: ActivityItemProps): React.JSX.Element => {
  const colors = getTeamColorSet(memberColor ?? message.color ?? '');
  const { isLight } = useTheme();
  const formattedRole = formatAgentRole(memberRole);

  const timestamp = Number.isNaN(Date.parse(message.timestamp))
    ? message.timestamp
    : new Date(message.timestamp).toLocaleString();

  const structured = parseStructuredAgentMessage(message.text);
  // Only flag agent messages as rate-limited, not user's own quotes
  const rateLimited = message.from !== 'user' && isRateLimitMessage(message.text);
  // Highlight messages containing API errors
  const isApiError = message.text.includes('API Error');
  // Detect auth errors that may be resolved by restarting the team
  const isAuthError = isApiError && AUTH_ERROR_PATTERNS.some((p) => p.test(message.text));
  // Never collapse rate limit messages as noise — they must be visible
  const noiseLabel = structured && !rateLimited ? getNoiseLabel(structured) : null;

  const systemLabel = !structured && !rateLimited ? getSystemMessageLabel(message.text) : null;
  const isManaged = isManagedCollapseState(collapseState);
  const isExpanded = isManaged ? !collapseState.isCollapsed : true;

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
  const isCrossTeamSent = message.source === CROSS_TEAM_SENT_SOURCE || crossTeamSentTarget !== null;
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
    message.from === 'user' || message.from === 'system' || crossTeamOrigin?.memberName === 'user';

  // Strip agent-only blocks + normalize escape sequences (before linkification)
  const strippedText = useMemo(() => {
    if (structured) return null;
    let stripped = stripAgentBlocks(message.text).trim();
    if (!stripped) return null; // All content was agent-only blocks → show summary instead
    // Strip cross-team prefix (e.g. "[Cross-team from team.lead | depth:0]\n") — kept in stored text for CLI agents
    if (isCrossTeamAny) {
      stripped = stripCrossTeamPrefix(stripped);
    }
    // Normalize literal \n from historical CLI-produced text to real newlines
    return stripped.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }, [structured, message.text, isCrossTeamAny]);

  // Parse reply BEFORE linkification — linkifyMentionsInMarkdown transforms @name
  // into markdown links which breaks the reply regex matcher
  const parsedReply = useMemo(
    () => (strippedText ? parseMessageReply(strippedText) : null),
    [strippedText]
  );

  // Linkify task IDs (always, for TaskTooltip) + @mentions for display
  const displayText = useMemo(() => {
    if (!strippedText) return null;
    let result = highlightSystemLabels(strippedText, !!systemLabel);
    result = linkifyTaskIdsInMarkdown(result);
    if (memberColorMap && memberColorMap.size > 0)
      result = linkifyMentionsInMarkdown(result, memberColorMap);
    return result;
  }, [strippedText, memberColorMap, systemLabel]);

  const rawSummary =
    message.summary || (structured ? getStructuredMessageSummary(structured) : '') || '';
  const summaryText = useMemo(() => extractMarkdownPlainText(rawSummary), [rawSummary]);

  // Noise messages: minimal inline row
  if (noiseLabel) {
    return <NoiseRow name={message.from} label={noiseLabel} colors={colors} />;
  }

  const messageType =
    structured && typeof structured.type === 'string' ? getMessageTypeLabel(structured.type) : null;
  const autoSummary = structured ? getStructuredMessageSummary(structured) : null;

  const handleCreateTask = (): void => {
    const subject = message.summary || autoSummary || `Task from ${message.from}`;
    const plainText = structured
      ? JSON.stringify(structured, null, 2)
      : stripAgentBlocks(message.text);
    const description = `From: ${message.from}\nAt: ${timestamp}\n\n${plainText}`.slice(0, 2000);
    onCreateTask?.(subject, description);
  };

  const isHeaderClickable = isManaged ? collapseState.canToggle : false;
  const showChevron = isHeaderClickable;
  const isUserSent = message.source === 'user_sent' || isCrossTeamSent;
  const isSystemMessage = message.from === 'system';
  const onManagedToggle = isManaged ? collapseState.onToggle : undefined;
  const handleHeaderToggle = isHeaderClickable
    ? (): void => {
        onManagedToggle?.();
      }
    : undefined;

  return (
    <article
      className="group rounded-md [overflow:clip]"
      style={{
        marginLeft: isUserSent ? 15 : undefined,
        backgroundColor:
          rateLimited || isApiError
            ? 'var(--tool-result-error-bg)'
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
            : isCrossTeamAny
              ? '1px solid var(--cross-team-border)'
              : isSystemMessage
                ? '1px solid var(--system-activity-border)'
                : CARD_BORDER_STYLE,
        borderLeft:
          rateLimited || isApiError
            ? '3px solid var(--tool-result-error-text)'
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
          'flex items-center gap-2 px-3 py-2',
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
        {isUnread ? (
          <span className="size-2 shrink-0 rounded-full bg-blue-500" title="Unread" aria-hidden />
        ) : null}
        {/* Chevron for collapsible messages */}
        {showChevron ? (
          <ChevronRight
            className="size-3 shrink-0 transition-transform duration-150"
            style={{
              color: CARD_ICON_MUTED,
              transform: isExpanded ? 'rotate(90deg)' : undefined,
            }}
          />
        ) : null}

        {/* Sender avatar + name badge */}
        {crossTeamOrigin ? <CrossTeamTeamBadge teamName={crossTeamOrigin.teamName} /> : null}
        <MemberBadge
          name={senderName}
          color={senderColor}
          hideAvatar={senderHideAvatar}
          onClick={onMemberNameClick}
          disableHoverCard={crossTeamOrigin != null}
        />

        {/* Role */}
        {formattedRole ? (
          <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
            {formattedRole}
          </span>
        ) : null}

        {/* Message type label or system label */}
        {systemLabel ? (
          <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
            {systemLabel}
          </span>
        ) : messageType ? (
          <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
            {messageType}
          </span>
        ) : null}

        {/* Lead session marker */}
        {message.source === 'lead_session' ? (
          <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
            session
          </span>
        ) : message.source === 'lead_process' ? (
          <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
            live
          </span>
        ) : null}

        {/* Rate limit warning badge */}
        {rateLimited ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
            <AlertTriangle size={10} />
            Rate Limited
          </span>
        ) : null}

        {/* API Error warning badge */}
        {isApiError && !rateLimited ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
            <AlertTriangle size={10} />
            API Error
          </span>
        ) : null}

        {/* Recipient — arrow + avatar + badge */}
        {message.to && message.to !== message.from ? (
          <>
            <span style={{ color: CARD_ICON_MUTED }} className="text-[10px]">
              &rarr;
            </span>
            {crossTeamTarget ? <CrossTeamTeamBadge teamName={crossTeamTarget} /> : null}
            {crossTeamSentMemberName || !crossTeamTarget ? (
              <MemberBadge
                name={crossTeamSentMemberName ?? qualifiedRecipient?.memberName ?? message.to}
                color={crossTeamTarget ? undefined : recipientColor}
                hideAvatar={
                  (crossTeamSentMemberName ?? qualifiedRecipient?.memberName ?? message.to) ===
                  'user'
                }
                onClick={onMemberNameClick}
                disableHoverCard={crossTeamTarget != null}
              />
            ) : null}
          </>
        ) : null}

        {/* Summary */}
        <span className="flex-1 truncate text-xs" style={{ color: CARD_TEXT_LIGHT }}>
          {onTaskIdClick ? linkifyTaskIds(summaryText, onTaskIdClick) : summaryText}
        </span>

        {/* Timestamp + reply + create task */}
        <div className="flex shrink-0 items-center gap-1.5">
          {onReply && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--color-surface-raised)] group-hover:opacity-100"
                  style={{ color: CARD_ICON_MUTED }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onReply(message);
                  }}
                >
                  <Reply size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Reply to message</TooltipContent>
            </Tooltip>
          )}
          {onCreateTask && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--color-surface-raised)] group-hover:opacity-100"
                  style={{ color: CARD_ICON_MUTED }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCreateTask();
                  }}
                >
                  <ListPlus size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Create task from message</TooltipContent>
            </Tooltip>
          )}
          <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
            {timestamp}
          </span>
        </div>
      </div>

      {/* Content — collapsed for system messages, expanded for others */}
      {isExpanded ? (
        <div className="px-3 pb-3">
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
          ) : parsedReply ? (
            <ReplyQuoteBlock
              reply={parsedReply}
              memberColor={memberColorMap?.get(parsedReply.agentName)}
            />
          ) : displayText ? (
            <ExpandableContent>
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
                          const taskId = link.getAttribute('href')?.replace('task://', '');
                          if (taskId) onTaskIdClick(taskId);
                        }
                      }
                    : undefined
                }
              >
                <MarkdownViewer content={displayText} maxHeight="max-h-none" copyable bare />
              </span>
            </ExpandableContent>
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
};
