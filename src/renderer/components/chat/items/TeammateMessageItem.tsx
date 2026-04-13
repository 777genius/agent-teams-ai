import React, { useMemo } from 'react';

import {
  CARD_BG,
  CARD_BORDER_STYLE,
  CARD_HEADER_BG,
  CARD_ICON_MUTED,
  CARD_TEXT_LIGHT,
} from '@renderer/constants/cssVariables';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { detectOperationalNoise } from '@renderer/utils/agentMessageFormatting';
import { formatTokensCompact } from '@renderer/utils/formatters';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { linkifyAllMentionsInMarkdown } from '@renderer/utils/mentionLinkify';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { extractMarkdownPlainText } from '@shared/utils/markdownTextSearch';
import { format } from 'date-fns';
import { ChevronRight, CornerDownLeft, MessageSquare, RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { MarkdownViewer } from '../viewers/MarkdownViewer';

import type { TeammateMessage } from '@renderer/types/groups';

// =============================================================================
// Types
// =============================================================================

interface TeammateMessageItemProps {
  teammateMessage: TeammateMessage;
  onClick: () => void;
  isExpanded: boolean;
  /** Callback to spotlight the reply link: pass toolId on hover, null on leave */
  onReplyHover?: (toolId: string | null) => void;
  /** Additional classes for highlighting (e.g., error deep linking) */
  highlightClasses?: string;
  /** Inline styles for highlighting (used by custom hex colors) */
  highlightStyle?: React.CSSProperties;
}

// =============================================================================
// Resend Detection
// =============================================================================

const RESEND_PATTERNS = [
  /\bresend/i,
  /\bre-send/i,
  /\bsent\b.{0,20}\bearlier/i,
  /\balready\s+sent/i,
  /\bsent\s+in\s+my\s+previous/i,
];

function isResendMessage(message: TeammateMessage): boolean {
  // Check summary first (cheaper)
  if (RESEND_PATTERNS.some((p) => p.test(message.summary))) return true;
  // Check first 300 chars of content
  const contentSnippet = message.content.slice(0, 300);
  return RESEND_PATTERNS.some((p) => p.test(contentSnippet));
}

// =============================================================================
// Component
// =============================================================================

/**
 * TeammateMessageItem - Card component for teammate messages.
 *
 * Visual distinction from SubagentItem:
 * - Left color accent border (3px)
 * - "Message" type label after name badge
 * - No metrics pill, no duration, no model info
 *
 * Operational noise (idle/shutdown/terminated) renders as minimal inline text.
 */
export const TeammateMessageItem: React.FC<TeammateMessageItemProps> = ({
  teammateMessage,
  onClick,
  isExpanded,
  onReplyHover,
  highlightClasses = '',
  highlightStyle,
}) => {
  const colors = getTeamColorSet(teammateMessage.color);
  const { isLight } = useTheme();

  // Get team members for @mention highlighting
  const members = useStore(useShallow((s) => s.selectedTeamData?.members));
  const memberColorMap = useMemo(
    () => (members ? buildMemberColorMap(members) : new Map<string, string>()),
    [members]
  );

  // Get team names for @team linkification
  const teams = useStore(useShallow((s) => s.teams));
  const teamNames = useMemo(
    () => teams.filter((t) => !t.deletedAt).map((t) => t.teamName),
    [teams]
  );

  // Detect operational noise
  const noiseLabel = useMemo(
    () => detectOperationalNoise(teammateMessage.content, teammateMessage.teammateId),
    [teammateMessage.content, teammateMessage.teammateId]
  );

  // Detect resent/duplicate messages
  const isResend = useMemo(() => isResendMessage(teammateMessage), [teammateMessage]);

  const plainSummary = useMemo(
    () => extractMarkdownPlainText(teammateMessage.summary),
    [teammateMessage.summary]
  );
  const plainReplyToSummary = useMemo(
    () =>
      teammateMessage.replyToSummary
        ? extractMarkdownPlainText(teammateMessage.replyToSummary)
        : undefined,
    [teammateMessage.replyToSummary]
  );

  const displayContent = useMemo(() => {
    const stripped = stripAgentBlocks(teammateMessage.content);
    return linkifyAllMentionsInMarkdown(stripped, memberColorMap, teamNames);
  }, [teammateMessage.content, memberColorMap, teamNames]);

  // Noise: minimal inline row (no card, no expand)
  if (noiseLabel) {
    return (
      <div className="flex items-center gap-2 px-3 py-1" style={{ opacity: 0.45 }}>
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colors.border }} />
        <span className="text-[11px]" style={{ color: CARD_ICON_MUTED }}>
          {teammateMessage.teammateId}
        </span>
        <span className="text-[11px]" style={{ color: CARD_ICON_MUTED }}>
          {noiseLabel}
        </span>
      </div>
    );
  }

  const truncatedSummary =
    plainSummary.length > 80 ? plainSummary.slice(0, 80) + '...' : plainSummary;

  return (
    <div
      className={`overflow-hidden rounded-md transition-[background-color,box-shadow] duration-300 ${highlightClasses}`}
      style={{
        backgroundColor: CARD_BG,
        border: CARD_BORDER_STYLE,
        borderLeft: `3px solid ${colors.border}`,
        opacity: isResend ? 0.6 : undefined,
        ...highlightStyle,
      }}
    >
      {/* Header */}
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
        className="flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors"
        style={{
          backgroundColor: isExpanded ? CARD_HEADER_BG : 'transparent',
          borderBottom: isExpanded ? CARD_BORDER_STYLE : 'none',
        }}
      >
        <ChevronRight
          className={`size-3.5 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          style={{ color: CARD_ICON_MUTED }}
        />

        {/* Message icon — distinguishes from SubagentItem's Bot/dot icon */}
        <MessageSquare className="size-3.5 shrink-0" style={{ color: colors.border }} />

        {/* Teammate name badge */}
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
          style={{
            backgroundColor: getThemedBadge(colors, isLight),
            color: colors.text,
            border: `1px solid ${colors.border}40`,
          }}
        >
          {teammateMessage.teammateId}
        </span>

        {/* "Message" type label — parallels SubagentItem's model info */}
        <span className="text-[10px] uppercase tracking-wide" style={{ color: CARD_ICON_MUTED }}>
          Message
        </span>

        {/* Reply indicator — shows which SendMessage triggered this response */}
        {plainReplyToSummary && (
          <span
            role="presentation"
            className="flex cursor-default items-center gap-1 text-[10px]"
            style={{ color: CARD_ICON_MUTED }}
            onMouseEnter={() => onReplyHover?.(teammateMessage.replyToToolId ?? null)}
            onMouseLeave={() => onReplyHover?.(null)}
          >
            <CornerDownLeft className="size-2.5" />
            <span className="truncate" style={{ maxWidth: '180px' }}>
              {plainReplyToSummary}
            </span>
          </span>
        )}

        {/* Resend badge — marks duplicate/resent messages */}
        {isResend && (
          <span
            className="flex items-center gap-0.5 text-[10px]"
            style={{ color: CARD_ICON_MUTED }}
          >
            <RefreshCw className="size-2.5" />
            Resent
          </span>
        )}

        {/* Summary */}
        <span className="flex-1 truncate text-xs" style={{ color: CARD_TEXT_LIGHT }}>
          {truncatedSummary || 'Teammate message'}
        </span>

        {/* Context impact — tokens injected into main session */}
        {teammateMessage.tokenCount != null && teammateMessage.tokenCount > 0 && (
          <span
            className="shrink-0 font-mono text-[11px] tabular-nums"
            style={{ color: CARD_ICON_MUTED }}
          >
            ~{formatTokensCompact(teammateMessage.tokenCount)} tokens
          </span>
        )}

        {/* Timestamp — rightmost info element */}
        <span
          className="shrink-0 font-mono text-[11px] tabular-nums"
          style={{ color: CARD_ICON_MUTED }}
        >
          {format(teammateMessage.timestamp, 'HH:mm:ss')}
        </span>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="p-3">
          <MarkdownViewer content={displayContent} copyable />
        </div>
      )}
    </div>
  );
};
