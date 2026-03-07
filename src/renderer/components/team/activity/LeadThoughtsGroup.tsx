import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { CopyButton } from '@renderer/components/common/CopyButton';
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
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { formatToolSummary, parseToolSummary } from '@shared/utils/toolSummary';
import { ChevronDown, ChevronRight, ChevronUp, Reply } from 'lucide-react';

import { linkifyMentionsInMarkdown, linkifyTaskIdsInMarkdown } from './ActivityItem';
import {
  AnimatedHeightReveal,
  ENTRY_REVEAL_ANIMATION_MS,
  ENTRY_REVEAL_EASING,
} from './AnimatedHeightReveal';
import { isManagedCollapseState } from './collapseState';

import type { ActivityCollapseState } from './collapseState';
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
  const hasSameLeadSession = (a: InboxMessage, b: InboxMessage): boolean =>
    (a.leadSessionId ?? null) === (b.leadSessionId ?? null);

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
      const previousThought = pendingThoughts[pendingThoughts.length - 1];
      if (previousThought && !hasSameLeadSession(previousThought, msg)) {
        flushThoughts();
      }
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
const COLLAPSED_THOUGHTS_HEIGHT = 200;
const AUTO_SCROLL_THRESHOLD = 30;
const THOUGHT_HEIGHT_ANIMATION_MS = ENTRY_REVEAL_ANIMATION_MS;

interface LeadThoughtsGroupRowProps {
  group: LeadThoughtGroup;
  memberColor?: string;
  isNew?: boolean;
  onVisible?: (message: InboxMessage) => void;
  /** When false, the live indicator is always off (for historical thought groups). */
  canBeLive?: boolean;
  /** When true, apply a subtle lighter background for zebra-striped lists. */
  zebraShade?: boolean;
  /** Explicit collapse state for timeline-controlled collapsed mode. */
  collapseState?: ActivityCollapseState;
  /** Called when a task ID link (e.g. #10) is clicked in thought text. */
  onTaskIdClick?: (taskId: string) => void;
  /** Map of member name → color name for @mention badge rendering. */
  memberColorMap?: Map<string, string>;
  /** Called when user clicks the reply button on a thought. */
  onReply?: (message: InboxMessage) => void;
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

interface LeadThoughtItemProps {
  thought: InboxMessage;
  showDivider: boolean;
  shouldAnimate: boolean;
  onTaskIdClick?: (taskId: string) => void;
  memberColorMap?: Map<string, string>;
  onReply?: (message: InboxMessage) => void;
}

const LeadThoughtItem = ({
  thought,
  showDivider,
  shouldAnimate,
  onTaskIdClick,
  memberColorMap,
  onReply,
}: LeadThoughtItemProps): JSX.Element => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousHeightRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const cleanupTimerRef = useRef<number | null>(null);

  const displayContent = useMemo(() => {
    let text = thought.text.replace(/\n/g, '  \n');
    text = linkifyTaskIdsInMarkdown(text);
    if (memberColorMap && memberColorMap.size > 0) {
      text = linkifyMentionsInMarkdown(text, memberColorMap);
    }
    return text;
  }, [thought.text, memberColorMap]);

  const clearPendingAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
  }, []);

  const resetWrapperStyles = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.style.height = 'auto';
    wrapper.style.opacity = '1';
    wrapper.style.overflow = 'visible';
    wrapper.style.transition = '';
    wrapper.style.willChange = '';
  }, []);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const applyTransition = (targetHeight: number): void => {
      wrapper.style.transition = [
        `height ${THOUGHT_HEIGHT_ANIMATION_MS}ms ${ENTRY_REVEAL_EASING}`,
        `opacity ${THOUGHT_HEIGHT_ANIMATION_MS}ms ease`,
      ].join(', ');
      wrapper.style.height = `${Math.max(targetHeight, 0)}px`;
      wrapper.style.opacity = '1';
    };

    const scheduleTransition = (targetHeight: number): void => {
      animationFrameRef.current = requestAnimationFrame(() => {
        applyTransition(targetHeight);
      });
    };

    const animateHeight = (
      targetHeight: number,
      startHeight: number,
      startOpacity: number
    ): void => {
      clearPendingAnimation();
      wrapper.style.transition = 'none';
      wrapper.style.overflow = 'hidden';
      wrapper.style.height = `${Math.max(startHeight, 0)}px`;
      wrapper.style.opacity = `${startOpacity}`;
      wrapper.style.willChange = 'height, opacity';
      // Force layout reflow so the browser registers the starting values
      const _reflow = wrapper.offsetHeight;
      if (_reflow < -1) return; // unreachable — prevents unused-variable lint

      animationFrameRef.current = requestAnimationFrame(() => {
        scheduleTransition(targetHeight);
      });

      cleanupTimerRef.current = window.setTimeout(() => {
        resetWrapperStyles();
        cleanupTimerRef.current = null;
      }, THOUGHT_HEIGHT_ANIMATION_MS + 40);
    };

    const syncHeight = (nextHeight: number, animateFromZero: boolean): void => {
      const previousHeight = previousHeightRef.current;
      previousHeightRef.current = nextHeight;

      if (!shouldAnimate) {
        resetWrapperStyles();
        return;
      }

      if (previousHeight === null) {
        if (nextHeight > 0 && animateFromZero) {
          animateHeight(nextHeight, 0, 0);
        } else {
          resetWrapperStyles();
        }
        return;
      }

      if (Math.abs(nextHeight - previousHeight) < 1) return;

      const renderedHeight = wrapper.getBoundingClientRect().height;
      animateHeight(nextHeight, renderedHeight > 0 ? renderedHeight : previousHeight, 1);
    };

    syncHeight(content.getBoundingClientRect().height, true);

    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height ?? content.getBoundingClientRect().height;
      syncHeight(nextHeight, false);
    });
    observer.observe(content);

    return () => {
      observer.disconnect();
      clearPendingAnimation();
      resetWrapperStyles();
    };
  }, [clearPendingAnimation, resetWrapperStyles, shouldAnimate]);

  useEffect(
    () => () => {
      clearPendingAnimation();
    },
    [clearPendingAnimation]
  );

  return (
    <div ref={wrapperRef}>
      <div ref={contentRef}>
        {showDivider && (
          <div className="mx-auto flex w-2/5 items-center justify-center gap-[5px] py-px">
            <hr
              className="flex-1 border-0"
              style={{
                height: '1px',
                backgroundColor: 'var(--color-border-emphasis)',
              }}
            />
            <span className="shrink-0 font-mono text-[9px]" style={{ color: CARD_ICON_MUTED }}>
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
        <div className="group/thought relative flex text-[11px]">
          <div className="min-w-0 flex-1 [&_>div>div]:p-0" style={{ color: CARD_TEXT_LIGHT }}>
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
              <MarkdownViewer content={displayContent} maxHeight="max-h-none" bare />
            </span>
          </div>
          <div className="absolute right-1 top-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/thought:opacity-100">
            {onReply ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReply(thought);
                    }}
                  >
                    <Reply size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Reply</TooltipContent>
              </Tooltip>
            ) : null}
            <CopyButton text={thought.text} inline />
          </div>
        </div>
        {thought.toolSummary && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="mb-[7px] cursor-default pb-0.5 pl-3 pr-1 font-mono text-[9px]"
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
    </div>
  );
};

export const LeadThoughtsGroupRow = ({
  group,
  memberColor,
  isNew,
  onVisible,
  canBeLive,
  zebraShade,
  collapseState,
  onTaskIdClick,
  memberColorMap,
  onReply,
}: LeadThoughtsGroupRowProps): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  const distanceFromBottomRef = useRef(0);
  const scrollSyncFrameRef = useRef<number | null>(null);
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
  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);
  const isManaged = isManagedCollapseState(collapseState);
  const isBodyVisible = isManaged ? !collapseState.isCollapsed : true;
  const canToggleBodyVisibility = isManaged && collapseState.canToggle;
  const handleBodyToggle = canToggleBodyVisibility
    ? (): void => {
        collapseState.onToggle?.();
      }
    : undefined;

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

  const clearPendingScrollSync = useCallback(() => {
    if (scrollSyncFrameRef.current !== null) {
      cancelAnimationFrame(scrollSyncFrameRef.current);
      scrollSyncFrameRef.current = null;
    }
  }, []);

  const queueScrollSync = useCallback(
    (mode: 'bottom' | 'preserve') => {
      clearPendingScrollSync();
      scrollSyncFrameRef.current = requestAnimationFrame(() => {
        scrollSyncFrameRef.current = requestAnimationFrame(() => {
          const scrollEl = scrollRef.current;
          if (!scrollEl || expanded || !isBodyVisible) {
            scrollSyncFrameRef.current = null;
            return;
          }

          const nextScrollTop =
            mode === 'bottom'
              ? scrollEl.scrollHeight - scrollEl.clientHeight
              : scrollEl.scrollHeight - scrollEl.clientHeight - distanceFromBottomRef.current;

          scrollEl.scrollTop = Math.max(0, nextScrollTop);
          if (mode === 'bottom') {
            distanceFromBottomRef.current = 0;
            isUserScrolledUpRef.current = false;
          }
          scrollSyncFrameRef.current = null;
        });
      });
    },
    [clearPendingScrollSync, expanded, isBodyVisible]
  );

  const syncScrollableBody = useCallback(
    (forceScrollToBottom = false) => {
      const scrollEl = scrollRef.current;
      const contentEl = contentRef.current;
      if (!scrollEl || !contentEl) return;

      const nextNeedsTruncation = contentEl.scrollHeight > COLLAPSED_THOUGHTS_HEIGHT + 1;
      setNeedsTruncation((prev) => (prev === nextNeedsTruncation ? prev : nextNeedsTruncation));

      if (expanded || !isBodyVisible) return;
      if (!nextNeedsTruncation) {
        clearPendingScrollSync();
        distanceFromBottomRef.current = 0;
        isUserScrolledUpRef.current = false;
        return;
      }

      if (forceScrollToBottom || !isUserScrolledUpRef.current) {
        queueScrollSync('bottom');
        return;
      }

      queueScrollSync('preserve');
    },
    [clearPendingScrollSync, expanded, isBodyVisible, queueScrollSync]
  );

  useLayoutEffect(() => {
    if (!isBodyVisible) return;
    const contentEl = contentRef.current;
    if (!contentEl) return;

    syncScrollableBody(true);

    const observer = new ResizeObserver(() => {
      syncScrollableBody();
    });
    observer.observe(contentEl);

    return () => observer.disconnect();
  }, [isBodyVisible, syncScrollableBody]);

  useEffect(
    () => () => {
      clearPendingScrollSync();
    },
    [clearPendingScrollSync]
  );

  useEffect(() => {
    if (isBodyVisible) return;
    clearPendingScrollSync();
  }, [clearPendingScrollSync, isBodyVisible]);

  const handleScroll = useCallback(() => {
    if (expanded) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    distanceFromBottomRef.current = distanceFromBottom;
    isUserScrolledUpRef.current = distanceFromBottom > AUTO_SCROLL_THRESHOLD;
  }, [expanded]);

  const handleCollapse = useCallback(() => {
    isUserScrolledUpRef.current = false;
    distanceFromBottomRef.current = 0;
    setExpanded(false);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scrollEl = scrollRef.current;
        if (scrollEl) {
          scrollEl.scrollTop = scrollEl.scrollHeight;
        }
        ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });
  }, []);

  return (
    <AnimatedHeightReveal animate={isNew} containerRef={ref} style={{ overflowAnchor: 'none' }}>
      <article
        className="group rounded-md [overflow:clip]"
        style={{
          backgroundColor: zebraShade ? CARD_BG_ZEBRA : CARD_BG,
          border: CARD_BORDER_STYLE,
          borderLeft: `3px solid ${colors.border}`,
        }}
      >
        {/* Header */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- role=button + tabIndex + onKeyDown below; nested tooltips prevent native button */}
        <div
          role={canToggleBodyVisibility ? 'button' : undefined}
          tabIndex={canToggleBodyVisibility ? 0 : undefined}
          className={[
            'flex select-none items-center gap-2 px-3 py-1.5',
            canToggleBodyVisibility ? 'cursor-pointer' : '',
          ].join(' ')}
          onClick={handleBodyToggle}
          onKeyDown={
            canToggleBodyVisibility
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleBodyToggle?.();
                  }
                }
              : undefined
          }
        >
          {/* Chevron for collapse mode */}
          {canToggleBodyVisibility ? (
            <ChevronRight
              className="size-3 shrink-0 transition-transform duration-150"
              style={{
                color: CARD_ICON_MUTED,
                transform: isBodyVisible ? 'rotate(90deg)' : undefined,
              }}
            />
          ) : null}
          {/* Lead avatar with optional live indicator */}
          <div className="relative shrink-0">
            <img
              src={agentAvatarUrl(leadName, 24)}
              alt=""
              className="size-5 rounded-full bg-[var(--color-surface-raised)]"
              loading="lazy"
            />
            {isLive ? (
              <span className="absolute -bottom-0.5 -right-0.5 flex size-2.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex size-full rounded-full border-2 border-[var(--color-surface)] bg-emerald-400" />
              </span>
            ) : null}
          </div>
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

        {/* Scrollable body — live thoughts follow bottom unless user scrolls up */}
        {isBodyVisible ? (
          <div
            ref={scrollRef}
            className="border-t"
            style={{
              borderColor: 'var(--color-border-subtle)',
              maxHeight: expanded || !needsTruncation ? 'none' : `${COLLAPSED_THOUGHTS_HEIGHT}px`,
              overflowY: expanded ? 'visible' : needsTruncation ? 'auto' : 'hidden',
              scrollbarWidth: expanded || !needsTruncation ? undefined : 'thin',
              scrollbarColor:
                expanded || !needsTruncation ? undefined : 'var(--scrollbar-thumb) transparent',
              overflowAnchor: 'none',
            }}
            onScroll={handleScroll}
          >
            <div ref={contentRef}>
              {chronologicalThoughts.map((thought, idx) => (
                <LeadThoughtItem
                  key={thought.messageId ?? idx}
                  thought={thought}
                  showDivider={idx > 0}
                  shouldAnimate={isLive && idx === chronologicalThoughts.length - 1}
                  onTaskIdClick={onTaskIdClick}
                  memberColorMap={memberColorMap}
                  onReply={onReply}
                />
              ))}
            </div>
          </div>
        ) : null}
      </article>
      {isBodyVisible && !expanded && needsTruncation ? (
        <div
          className="pointer-events-none flex justify-center pt-1"
          style={{ transform: 'translateY(-20px)' }}
        >
          <button
            type="button"
            className="pointer-events-auto flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)] shadow-sm transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
          >
            <ChevronDown size={12} />
            Show more
          </button>
        </div>
      ) : null}
      {isBodyVisible && expanded && needsTruncation ? (
        <div
          className="pointer-events-none sticky bottom-0 z-10 flex justify-center pb-1 pt-2"
          style={{ transform: 'translateY(-20px)' }}
        >
          <button
            type="button"
            className="pointer-events-auto flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] shadow-sm transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-secondary)]"
            onClick={(e) => {
              e.stopPropagation();
              handleCollapse();
            }}
          >
            <ChevronUp size={12} />
            Show less
          </button>
        </div>
      ) : null}
    </AnimatedHeightReveal>
  );
};
