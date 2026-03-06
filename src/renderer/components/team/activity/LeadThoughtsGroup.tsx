import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  CARD_BG,
  CARD_BG_ZEBRA,
  CARD_BORDER_STYLE,
  CARD_ICON_MUTED,
  CARD_TEXT_LIGHT,
} from '@renderer/constants/cssVariables';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useStore } from '@renderer/store';
import { formatToolSummary, parseToolSummary } from '@shared/utils/toolSummary';

import type { InboxMessage, ToolCallMeta } from '@shared/types';

export interface LeadThoughtGroup {
  type: 'lead-thoughts';
  thoughts: InboxMessage[];
}

/**
 * Check if a message is an intermediate lead "thought" (assistant text) rather than
 * an official message (SendMessage, direct reply, inbox, etc.).
 */
export function isLeadThought(msg: InboxMessage): boolean {
  if (msg.source === 'lead_session') return true;
  if (msg.source === 'lead_process') return true;
  return false;
}

export type TimelineItem =
  | { type: 'message'; message: InboxMessage; originalIndex: number }
  | { type: 'lead-thoughts'; group: LeadThoughtGroup; originalIndices: number[] };

/**
 * Group consecutive lead thoughts into compact blocks.
 * Even a single thought gets its own group (rendered as LeadThoughtsGroupRow).
 */
export function groupTimelineItems(messages: InboxMessage[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  let pendingThoughts: InboxMessage[] = [];
  let pendingIndices: number[] = [];

  const flushThoughts = (): void => {
    if (pendingThoughts.length === 0) return;
    result.push({
      type: 'lead-thoughts',
      group: { type: 'lead-thoughts', thoughts: pendingThoughts },
      originalIndices: pendingIndices,
    });
    pendingThoughts = [];
    pendingIndices = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isLeadThought(msg)) {
      pendingThoughts.push(msg);
      pendingIndices.push(i);
    } else {
      flushThoughts();
      result.push({ type: 'message', message: msg, originalIndex: i });
    }
  }
  flushThoughts();
  return result;
}

const VIEWPORT_THRESHOLD = 0.15;
const LIVE_WINDOW_MS = 5_000;
const AUTO_SCROLL_THRESHOLD = 30;

interface LeadThoughtsGroupRowProps {
  group: LeadThoughtGroup;
  memberColor?: string;
  isNew?: boolean;
  onVisible?: (message: InboxMessage) => void;
  /** When false, the live indicator is always off (for historical thought groups). */
  canBeLive?: boolean;
  /** When true, apply a subtle lighter background for zebra-striped lists. */
  zebraShade?: boolean;
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTimeWithSec(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isRecentTimestamp(timestamp: string): boolean {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= LIVE_WINDOW_MS;
}

const ToolSummaryTooltipContent = ({
  toolCalls,
  toolSummary,
}: Readonly<{
  toolCalls?: ToolCallMeta[];
  toolSummary?: string;
}>): JSX.Element => {
  if (toolCalls && toolCalls.length > 0) {
    return (
      <div className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto">
        <div className="mb-0.5 text-[10px] text-text-secondary">
          {toolCalls.length} {toolCalls.length === 1 ? 'tool call' : 'tool calls'}
        </div>
        {toolCalls.map((tc, i) => {
          const isAgent = tc.name === 'Agent' || tc.name === 'TaskCreate';
          return (
            <div key={i} className={isAgent ? 'mt-0.5' : 'flex items-baseline gap-2'}>
              <span className={`shrink-0 font-semibold ${isAgent ? 'text-violet-400' : ''}`}>
                {isAgent ? '🤖 ' : ''}
                {tc.name}
              </span>
              {tc.preview && (
                <span
                  className={`text-text-secondary ${isAgent ? 'mt-0.5 block text-[10px]' : 'truncate'}`}
                >
                  {tc.preview}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (toolSummary) {
    const parsed = parseToolSummary(toolSummary);
    if (parsed) {
      const sorted = Object.entries(parsed.byName).sort((a, b) => b[1] - a[1]);
      return (
        <div className="flex flex-col gap-0.5">
          <div className="mb-0.5 text-[10px] text-text-secondary">
            {parsed.total} {parsed.total === 1 ? 'tool call' : 'tool calls'}
          </div>
          {sorted.map(([name, count]) => (
            <div key={name} className="flex justify-between gap-3">
              <span>{name}</span>
              <span className="text-text-secondary">×{count}</span>
            </div>
          ))}
        </div>
      );
    }
  }

  return <span>{toolSummary ?? ''}</span>;
};

export const LeadThoughtsGroupRow = ({
  group,
  memberColor,
  isNew,
  onVisible,
  canBeLive,
  zebraShade,
}: LeadThoughtsGroupRowProps): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  const isTeamAlive = useStore((s) => s.selectedTeamData?.isAlive ?? false);
  const leadActivity = useStore((s) => {
    const teamName = s.selectedTeamName;
    return teamName ? s.leadActivityByTeam[teamName] : undefined;
  });
  const leadContextUpdatedAt = useStore((s) => {
    const teamName = s.selectedTeamName;
    return teamName ? s.leadContextByTeam[teamName]?.updatedAt : undefined;
  });

  const colors = getTeamColorSet(memberColor ?? '');
  const { thoughts } = group;
  // thoughts is newest-first; first=newest, last=oldest
  const newest = thoughts[0];
  const oldest = thoughts[thoughts.length - 1];
  const leadName = newest.from;

  // Chronological order for rendering (oldest at top, newest at bottom)
  const chronologicalThoughts = useMemo(() => [...thoughts].reverse(), [thoughts]);

  // Aggregate tool usage across all thoughts in this group
  const totalToolSummary = useMemo(() => {
    const merged: Record<string, number> = {};
    let total = 0;
    for (const t of thoughts) {
      const parsed = parseToolSummary(t.toolSummary);
      if (!parsed) continue;
      total += parsed.total;
      for (const [name, count] of Object.entries(parsed.byName)) {
        merged[name] = (merged[name] ?? 0) + count;
      }
    }
    if (total === 0) return null;
    return formatToolSummary({ total, byName: merged });
  }, [thoughts]);

  // Aggregate all toolCalls across thoughts for header tooltip
  const allToolCalls = useMemo(() => {
    const calls: ToolCallMeta[] = [];
    for (const t of thoughts) {
      if (t.toolCalls) calls.push(...t.toolCalls);
    }
    return calls.length > 0 ? calls : undefined;
  }, [thoughts]);

  // Live = process alive AND (lead is in active turn OR context recently updated OR fresh thought)
  const computeIsLive = useCallback(
    () =>
      canBeLive !== false &&
      isTeamAlive &&
      (leadActivity === 'active' ||
        (leadContextUpdatedAt ? isRecentTimestamp(leadContextUpdatedAt) : false) ||
        isRecentTimestamp(newest.timestamp)),
    [canBeLive, isTeamAlive, leadActivity, leadContextUpdatedAt, newest.timestamp]
  );
  const [isLive, setIsLive] = useState(computeIsLive);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional immediate sync to avoid 1s stale gap
    setIsLive(computeIsLive());
    const id = window.setInterval(() => setIsLive(computeIsLive()), 1000);
    return () => window.clearInterval(id);
  }, [computeIsLive]);

  // Track how many thoughts have been reported as visible so far.
  const reportedCountRef = useRef(0);

  useEffect(() => {
    if (!onVisible) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        const alreadyReported = reportedCountRef.current;
        if (alreadyReported >= thoughts.length) return;
        for (let i = alreadyReported; i < thoughts.length; i++) {
          onVisible(thoughts[i]);
        }
        reportedCountRef.current = thoughts.length;
      },
      { threshold: VIEWPORT_THRESHOLD, rootMargin: '0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible, thoughts]);

  // Auto-scroll via ResizeObserver — fires after CSS animations expand content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (isUserScrolledUpRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isUserScrolledUpRef.current = distanceFromBottom > AUTO_SCROLL_THRESHOLD;
  }, []);

  return (
    <div
      ref={ref}
      className={isNew ? 'message-enter-animate min-h-px' : 'min-h-px'}
      style={{ overflowAnchor: 'none' }}
    >
      <article
        className="group rounded-md [overflow:clip]"
        style={{
          backgroundColor: zebraShade ? CARD_BG_ZEBRA : CARD_BG,
          border: CARD_BORDER_STYLE,
          borderLeft: `3px solid ${colors.border}`,
        }}
      >
        {/* Header */}
        <div className="flex select-none items-center gap-2 px-3 py-1.5">
          {/* Live / offline indicator */}
          {isLive ? (
            <span className="pointer-events-none relative inline-flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
            </span>
          ) : (
            <span className="inline-flex size-2 shrink-0 rounded-full bg-zinc-500" />
          )}
          <MemberBadge name={leadName} color={memberColor} hideAvatar />
          <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
            {thoughts.length} thoughts
          </span>
          <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
            {formatTime(oldest.timestamp) === formatTime(newest.timestamp)
              ? formatTime(oldest.timestamp)
              : `${formatTime(oldest.timestamp)}–${formatTime(newest.timestamp)}`}
          </span>
          {totalToolSummary && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                  {totalToolSummary}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[420px] font-mono text-[11px]">
                <ToolSummaryTooltipContent
                  toolCalls={allToolCalls}
                  toolSummary={totalToolSummary}
                />
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Scrollable body — fixed height, always visible */}
        <div
          ref={scrollRef}
          className="border-t"
          style={{
            borderColor: 'var(--color-border-subtle)',
            maxHeight: '200px',
            overflowY: 'scroll',
            scrollbarWidth: 'thin',
            scrollbarColor: 'var(--scrollbar-thumb) transparent',
          }}
          onScroll={handleScroll}
        >
          {chronologicalThoughts.map((thought, idx) => (
            <div key={thought.messageId ?? idx} className="thought-expand-in">
              {idx > 0 && (
                <div className="mx-auto flex w-2/5 items-center justify-center gap-[5px] py-px">
                  <hr
                    className="flex-1 border-0"
                    style={{
                      height: '1px',
                      backgroundColor: 'var(--color-border-emphasis)',
                    }}
                  />
                  <span
                    className="shrink-0 font-mono text-[9px]"
                    style={{ color: CARD_ICON_MUTED }}
                  >
                    {formatTimeWithSec(thought.timestamp)}
                  </span>
                  <hr
                    className="flex-1 border-0"
                    style={{
                      height: '1px',
                      backgroundColor: 'var(--color-border-emphasis)',
                    }}
                  />
                </div>
              )}
              <div className="flex text-[11px]">
                <div className="min-w-0 flex-1 [&_>div>div]:p-0" style={{ color: CARD_TEXT_LIGHT }}>
                  <MarkdownViewer
                    content={thought.text.replace(/\n/g, '  \n')}
                    maxHeight="max-h-none"
                    bare
                  />
                </div>
              </div>
              {thought.toolSummary && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className="cursor-default pb-0.5 pl-3 pr-1 font-mono text-[9px]"
                      style={{ color: CARD_ICON_MUTED }}
                    >
                      🔧 {thought.toolSummary}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    align="start"
                    className="max-w-[420px] font-mono text-[11px]"
                  >
                    <ToolSummaryTooltipContent
                      toolCalls={thought.toolCalls}
                      toolSummary={thought.toolSummary}
                    />
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
      </article>
    </div>
  );
};
