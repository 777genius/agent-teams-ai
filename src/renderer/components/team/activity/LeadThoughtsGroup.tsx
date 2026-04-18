import {
  type JSX,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { CompactMarkdownPreview } from '@renderer/components/chat/viewers/MarkdownViewer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import {
  CARD_BG,
  CARD_BG_ZEBRA,
  CARD_BORDER_STYLE,
  CARD_ICON_MUTED,
  CARD_TEXT_LIGHT,
} from '@renderer/constants/cssVariables';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import {
  areStringArraysEqual,
  areStringMapsEqual,
  areThoughtMessagesEquivalentForRender,
} from '@renderer/utils/messageRenderEquality';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { isApiErrorMessage } from '@shared/utils/apiErrorDetector';
import { isThoughtProtocolNoise } from '@shared/utils/inboxNoise';
import { extractMarkdownPlainText } from '@shared/utils/markdownTextSearch';
import { formatToolSummary, parseToolSummary } from '@shared/utils/toolSummary';
import { ChevronDown, ChevronRight, ChevronUp, Maximize2 } from 'lucide-react';

import { buildThoughtDisplayContent } from './activityMarkdown';
import {
  AnimatedHeightReveal,
  ENTRY_REVEAL_ANIMATION_MS,
  ENTRY_REVEAL_EASING,
} from './AnimatedHeightReveal';
import { ThoughtBodyContent } from './ThoughtBodyContent';

import type { InboxMessage, ToolCallMeta } from '@shared/types';

export interface LeadThoughtGroup {
  type: 'lead-thoughts';
  thoughts: InboxMessage[];
}

/**
 * Check if a message is a context compaction boundary (system event from lead process).
 */
export function isCompactionMessage(msg: InboxMessage): boolean {
  return msg.from === 'system' && !!msg.messageId?.startsWith('compact-');
}

/**
 * Check if a message is an intermediate lead "thought" (assistant text) rather than
 * an official message (SendMessage, direct reply, inbox, etc.).
 */
export function isLeadThought(msg: InboxMessage): boolean {
  if (typeof msg.to === 'string' && msg.to.trim().length > 0) return false;
  // Compaction boundary events are system messages, not lead thoughts
  if (isCompactionMessage(msg)) return false;
  if (msg.messageKind === 'slash_command_result') return false;
  // Protocol noise (JSON coordination signals, raw teammate-message XML) should be hidden
  if (isThoughtProtocolNoise(msg.text)) return false;
  if (msg.source === 'lead_session') return true;
  if (msg.source === 'lead_process') return true;
  return false;
}

/**
 * Check if a message from lead session/process is protocol noise that should be
 * completely excluded from the timeline (not shown as thoughts OR standalone messages).
 *
 * When `isLeadThought` returns false due to `isThoughtProtocolNoise`, the message
 * falls through to become a standalone ActivityItem — but ActivityItem can't parse
 * noise JSON wrapped in `<teammate-message>` tags. This helper catches those cases
 * so `groupTimelineItems` can skip them entirely.
 */
function isLeadSessionNoise(msg: InboxMessage): boolean {
  if (msg.source !== 'lead_session' && msg.source !== 'lead_process') return false;
  if (typeof msg.to === 'string' && msg.to.trim().length > 0) return false;
  return isThoughtProtocolNoise(msg.text);
}

export type TimelineItem =
  | { type: 'message'; message: InboxMessage }
  | { type: 'lead-thoughts'; group: LeadThoughtGroup };

/**
 * Use the oldest thought as the group's stable identity so live thoughts can prepend
 * without remounting the whole group on every update.
 */
export function getThoughtGroupKey(group: LeadThoughtGroup): string {
  const oldestThought = group.thoughts[group.thoughts.length - 1];
  return `thoughts-${toMessageKey(oldestThought)}`;
}

/**
 * Group consecutive lead thoughts into compact blocks.
 * Even a single thought gets its own group (rendered as LeadThoughtsGroupRow).
 */
export function groupTimelineItems(messages: InboxMessage[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  let pendingThoughts: InboxMessage[] = [];
  const hasSameLeadSession = (a: InboxMessage, b: InboxMessage): boolean =>
    (a.leadSessionId ?? null) === (b.leadSessionId ?? null);

  const flushThoughts = (): void => {
    if (pendingThoughts.length === 0) return;
    result.push({
      type: 'lead-thoughts',
      group: { type: 'lead-thoughts', thoughts: pendingThoughts },
    });
    pendingThoughts = [];
  };

  for (const msg of messages) {
    if (isLeadThought(msg)) {
      const previousThought = pendingThoughts[pendingThoughts.length - 1];
      if (previousThought && !hasSameLeadSession(previousThought, msg)) {
        flushThoughts();
      }
      pendingThoughts.push(msg);
    } else {
      // Skip lead session/process messages that are protocol noise — they should
      // not appear in the timeline at all (neither as thoughts nor as standalone messages).
      // isLeadThought already rejects these from thoughts, but without this guard
      // they fall through as standalone ActivityItem cards that can't parse the noise JSON.
      // Check BEFORE flushThoughts() so noise between two thoughts doesn't split the group.
      if (isLeadSessionNoise(msg)) continue;
      flushThoughts();
      result.push({ type: 'message', message: msg });
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
  /** Whether the owning team is currently alive. */
  isTeamAlive?: boolean;
  /** Current lead activity status for the owning team. */
  leadActivity?: string;
  /** Latest lead context timestamp for the owning team. */
  leadContextUpdatedAt?: string;
  /** When true, apply a subtle lighter background for zebra-striped lists. */
  zebraShade?: boolean;
  /** Collapsed-mode primitives stabilized by ActivityTimeline. */
  collapseMode: 'default' | 'managed';
  isCollapsed: boolean;
  canToggleCollapse: boolean;
  collapseToggleKey?: string;
  onToggleCollapse?: (key: string) => void;
  /** Called when a task ID link (e.g. #10) is clicked in thought text. */
  onTaskIdClick?: (taskId: string) => void;
  /** Map of member name → color name for @mention badge rendering. */
  memberColorMap?: Map<string, string>;
  /** Team names used for mention/team-link rendering. */
  teamNames?: string[];
  /** Team color mapping used by markdown viewers. */
  teamColorByName?: ReadonlyMap<string, string>;
  /** Opens a team tab from cross-team badges or team:// links. */
  onTeamClick?: (teamName: string) => void;
  /** Called when user clicks the reply button on a thought. */
  onReply?: (message: InboxMessage) => void;
  /** Compact header mode for narrow message lists. */
  compactHeader?: boolean;
  /** Callback to expand this item into a fullscreen dialog. */
  onExpand?: (key: string) => void;
  /** Stable key for expand identification. */
  expandItemKey?: string;
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatTimeWithSec(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isRecentTimestamp(timestamp: string): boolean {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= LIVE_WINDOW_MS;
}

export const ToolSummaryTooltipContent = ({
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
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
  onReply?: (message: InboxMessage) => void;
}

function hasSelectionWithin(container: HTMLElement | null): boolean {
  if (!container) return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return (
    (!!anchorNode && container.contains(anchorNode)) ||
    (!!focusNode && container.contains(focusNode))
  );
}

function areThoughtGroupsEquivalent(prev: LeadThoughtGroup, next: LeadThoughtGroup): boolean {
  if (prev === next) return true;
  if (getThoughtGroupKey(prev) !== getThoughtGroupKey(next)) return false;
  if (prev.thoughts.length !== next.thoughts.length) return false;
  for (let i = 0; i < prev.thoughts.length; i++) {
    if (!areThoughtMessagesEquivalentForRender(prev.thoughts[i], next.thoughts[i])) {
      return false;
    }
  }
  return true;
}

const LeadThoughtItem = memo(
  function LeadThoughtItem({
    thought,
    showDivider,
    shouldAnimate,
    onTaskIdClick,
    memberColorMap,
    teamNames = [],
    teamColorByName,
    onTeamClick,
    onReply,
  }: LeadThoughtItemProps): JSX.Element {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const previousHeightRef = useRef<number | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const cleanupTimerRef = useRef<number | null>(null);
    const initialAnimationCompletedRef = useRef(!shouldAnimate);
    const [shouldAnimateOnMount] = useState(() => shouldAnimate);

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
        initialAnimationCompletedRef.current = false;
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
          initialAnimationCompletedRef.current = true;
          cleanupTimerRef.current = null;
        }, THOUGHT_HEIGHT_ANIMATION_MS + 40);
      };

      const syncHeight = (nextHeight: number, animateFromZero: boolean): void => {
        const previousHeight = previousHeightRef.current;
        previousHeightRef.current = nextHeight;

        if (!shouldAnimateOnMount) {
          initialAnimationCompletedRef.current = true;
          resetWrapperStyles();
          return;
        }

        if (previousHeight === null) {
          if (nextHeight > 0 && animateFromZero) {
            animateHeight(nextHeight, 0, 0);
          } else {
            initialAnimationCompletedRef.current = true;
            resetWrapperStyles();
          }
          return;
        }

        if (Math.abs(nextHeight - previousHeight) < 1) return;

        // Only the first reveal should animate. Late content growth (for example when
        // tool summary metadata appears after the text) should resize naturally.
        if (initialAnimationCompletedRef.current) {
          resetWrapperStyles();
          return;
        }

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
        initialAnimationCompletedRef.current = true;
        resetWrapperStyles();
      };
    }, [clearPendingAnimation, resetWrapperStyles, shouldAnimateOnMount]);

    useEffect(
      () => () => {
        clearPendingAnimation();
      },
      [clearPendingAnimation]
    );

    return (
      <div ref={wrapperRef}>
        <div ref={contentRef}>
          <ThoughtBodyContent
            thought={thought}
            showDivider={showDivider}
            onTaskIdClick={onTaskIdClick}
            onReply={onReply}
            memberColorMap={memberColorMap}
            teamNames={teamNames}
            teamColorByName={teamColorByName}
            onTeamClick={onTeamClick}
          />
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.showDivider === next.showDivider &&
    prev.shouldAnimate === next.shouldAnimate &&
    prev.onTaskIdClick === next.onTaskIdClick &&
    prev.memberColorMap === next.memberColorMap &&
    areStringArraysEqual(prev.teamNames, next.teamNames) &&
    areStringMapsEqual(prev.teamColorByName, next.teamColorByName) &&
    prev.onTeamClick === next.onTeamClick &&
    prev.onReply === next.onReply &&
    areThoughtMessagesEquivalentForRender(prev.thought, next.thought)
);

const LiveThoughtStatusBadge = ({
  canBeLive,
  isTeamAlive,
  leadActivity,
  leadContextUpdatedAt,
  newestTimestamp,
}: {
  canBeLive?: boolean;
  isTeamAlive?: boolean;
  leadActivity?: string;
  leadContextUpdatedAt?: string;
  newestTimestamp: string;
}): JSX.Element | null => {
  const computeIsLive = useCallback(
    () =>
      canBeLive !== false &&
      !!isTeamAlive &&
      (leadActivity === 'active' ||
        (leadContextUpdatedAt ? isRecentTimestamp(leadContextUpdatedAt) : false) ||
        isRecentTimestamp(newestTimestamp)),
    [canBeLive, isTeamAlive, leadActivity, leadContextUpdatedAt, newestTimestamp]
  );

  const [isLive, setIsLive] = useState(computeIsLive);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional immediate sync to avoid 1s stale gap
    setIsLive(computeIsLive());
    const id = window.setInterval(() => setIsLive(computeIsLive()), 1000);
    return () => window.clearInterval(id);
  }, [computeIsLive]);

  if (!isLive) return null;

  return (
    <span className="absolute -bottom-0.5 -right-0.5 flex size-2.5">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
      <span className="relative inline-flex size-full rounded-full border-2 border-[var(--color-surface)] bg-emerald-400" />
    </span>
  );
};

const LeadThoughtsGroupRowComponent = ({
  group,
  memberColor,
  isNew,
  onVisible,
  canBeLive,
  isTeamAlive,
  leadActivity,
  leadContextUpdatedAt,
  zebraShade,
  collapseMode,
  isCollapsed,
  canToggleCollapse,
  collapseToggleKey,
  onToggleCollapse,
  onTaskIdClick,
  memberColorMap,
  teamNames = [],
  teamColorByName,
  onTeamClick,
  onReply,
  compactHeader = false,
  onExpand,
  expandItemKey,
}: LeadThoughtsGroupRowProps): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  const distanceFromBottomRef = useRef(0);
  const scrollSyncFrameRef = useRef<number | null>(null);

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

  // Reuse the same markdown preprocessing as the expanded thought body.
  const compactPreviewMarkdown = useMemo(() => {
    // Try newest first (most relevant), then scan for any text
    for (const t of thoughts) {
      if (t.text && t.text.trim()) {
        const stripped = stripAgentBlocks(t.text).trim();
        if (stripped) {
          return buildThoughtDisplayContent(t, memberColorMap, teamNames, {
            preserveLineBreaks: false,
            stripAgentOnlyBlocks: true,
          })
            .replace(/\n+/g, ' ')
            .trim();
        }
      }
    }
    return totalToolSummary;
  }, [memberColorMap, teamNames, thoughts, totalToolSummary]);
  const compactPreviewTooltipText = useMemo(() => {
    const normalized = extractMarkdownPlainText(compactPreviewMarkdown ?? '')
      .replace(/\n+/g, ' ')
      .trim();
    return normalized || compactPreviewMarkdown;
  }, [compactPreviewMarkdown]);

  // Detect if any thought in this group is an API error
  const hasApiError = useMemo(() => thoughts.some((t) => isApiErrorMessage(t.text)), [thoughts]);

  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);
  const isManaged = collapseMode === 'managed';
  const isBodyVisible = isManaged ? !isCollapsed : true;
  const canToggleBodyVisibility = isManaged && canToggleCollapse;
  const handleBodyToggle = useCallback(() => {
    if (canToggleBodyVisibility && collapseToggleKey) {
      onToggleCollapse?.(collapseToggleKey);
    }
  }, [canToggleBodyVisibility, collapseToggleKey, onToggleCollapse]);
  const shouldAnimateLatestThought = canBeLive !== false && isRecentTimestamp(newest.timestamp);

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
          if (hasSelectionWithin(scrollEl)) {
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
        if (scrollEl && !hasSelectionWithin(scrollEl)) {
          scrollEl.scrollTop = scrollEl.scrollHeight;
        }
        ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });
  }, []);

  const timestampLabel =
    formatTime(oldest.timestamp) === formatTime(newest.timestamp)
      ? formatTime(oldest.timestamp)
      : `${formatTime(oldest.timestamp)}–${formatTime(newest.timestamp)}`;
  const useCompactCollapsedHeader = compactHeader && !isBodyVisible;

  return (
    <AnimatedHeightReveal animate={isNew} containerRef={ref} style={{ overflowAnchor: 'none' }}>
      <article
        className="group rounded-md [overflow:clip]"
        style={{
          backgroundColor: zebraShade ? CARD_BG_ZEBRA : CARD_BG,
          border: hasApiError ? '1px solid rgba(248, 113, 113, 0.3)' : CARD_BORDER_STYLE,
          borderLeft: `3px solid ${hasApiError ? '#f87171' : colors.border}`,
        }}
      >
        {/* Header */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- role=button + tabIndex + onKeyDown below; nested tooltips prevent native button */}
        <div
          role={canToggleBodyVisibility ? 'button' : undefined}
          tabIndex={canToggleBodyVisibility ? 0 : undefined}
          className={[
            useCompactCollapsedHeader
              ? 'select-none px-3 py-2'
              : 'flex select-none items-center gap-2 px-3 py-1.5',
            canToggleBodyVisibility ? 'cursor-pointer' : '',
          ].join(' ')}
          style={hasApiError ? { backgroundColor: 'rgba(248, 113, 113, 0.08)' } : undefined}
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
          {useCompactCollapsedHeader ? (
            <div className="min-w-0">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <MemberBadge name={leadName} color={memberColor} hideAvatar />
                  <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                    {thoughts.length} thoughts
                  </span>
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
                    {timestampLabel}
                  </span>
                  {onExpand && expandItemKey && (
                    <button
                      type="button"
                      aria-label="Expand thoughts"
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
              {compactPreviewMarkdown ? (
                <TooltipProvider delayDuration={1000}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div>
                        <CompactMarkdownPreview
                          content={compactPreviewMarkdown}
                          className="mt-1 line-clamp-2 w-full min-w-0 max-w-full break-words text-[11px] leading-4"
                          teamColorByName={teamColorByName}
                          onTeamClick={onTeamClick}
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      align="start"
                      className="max-w-sm whitespace-normal break-words"
                    >
                      {compactPreviewTooltipText}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
          ) : !isBodyVisible ? (
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                {canToggleBodyVisibility && !compactHeader ? (
                  <ChevronRight
                    className="size-3 shrink-0 transition-transform duration-150"
                    style={{
                      color: CARD_ICON_MUTED,
                      transform: isBodyVisible ? 'rotate(90deg)' : undefined,
                    }}
                  />
                ) : null}
                {!compactHeader ? (
                  <div className="relative shrink-0">
                    <img
                      src={agentAvatarUrl(leadName, 24)}
                      alt=""
                      className="size-5 rounded-full bg-[var(--color-surface-raised)]"
                      loading="lazy"
                    />
                    <LiveThoughtStatusBadge
                      canBeLive={canBeLive}
                      isTeamAlive={isTeamAlive}
                      leadActivity={leadActivity}
                      leadContextUpdatedAt={leadContextUpdatedAt}
                      newestTimestamp={newest.timestamp}
                    />
                  </div>
                ) : null}
                <MemberBadge name={leadName} color={memberColor} hideAvatar />
                <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                  {thoughts.length} thoughts
                </span>
                <div className="relative ml-auto flex shrink-0 items-center">
                  <span
                    className={
                      onExpand && expandItemKey
                        ? 'text-[10px] transition-opacity group-hover:opacity-0'
                        : 'text-[10px]'
                    }
                    style={{ color: CARD_ICON_MUTED }}
                  >
                    {timestampLabel}
                  </span>
                  {onExpand && expandItemKey && (
                    <button
                      type="button"
                      aria-label="Expand thoughts"
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
              {compactPreviewMarkdown ? (
                <TooltipProvider delayDuration={1000}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div>
                        <CompactMarkdownPreview
                          content={compactPreviewMarkdown}
                          className="mt-1 line-clamp-2 w-full min-w-0 max-w-full break-words text-[11px] leading-4"
                          teamColorByName={teamColorByName}
                          onTeamClick={onTeamClick}
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      align="start"
                      className="max-w-sm whitespace-normal break-words"
                    >
                      {compactPreviewTooltipText}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
          ) : (
            <>
              {canToggleBodyVisibility && !compactHeader ? (
                <ChevronRight
                  className="size-3 shrink-0 transition-transform duration-150"
                  style={{
                    color: CARD_ICON_MUTED,
                    transform: isBodyVisible ? 'rotate(90deg)' : undefined,
                  }}
                />
              ) : null}
              {!compactHeader ? (
                <div className="relative shrink-0">
                  <img
                    src={agentAvatarUrl(leadName, 24)}
                    alt=""
                    className="size-5 rounded-full bg-[var(--color-surface-raised)]"
                    loading="lazy"
                  />
                  <LiveThoughtStatusBadge
                    canBeLive={canBeLive}
                    isTeamAlive={isTeamAlive}
                    leadActivity={leadActivity}
                    leadContextUpdatedAt={leadContextUpdatedAt}
                    newestTimestamp={newest.timestamp}
                  />
                </div>
              ) : null}
              <MemberBadge name={leadName} color={memberColor} hideAvatar />
              <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                {thoughts.length} thoughts
              </span>
              {totalToolSummary ? (
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
              ) : null}
              <div className="relative ml-auto flex shrink-0 items-center">
                <span
                  className={
                    onExpand && expandItemKey
                      ? 'text-[10px] transition-opacity group-hover:opacity-0'
                      : 'text-[10px]'
                  }
                  style={{ color: CARD_ICON_MUTED }}
                >
                  {timestampLabel}
                </span>
                {onExpand && expandItemKey && (
                  <button
                    type="button"
                    aria-label="Expand thoughts"
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
                  key={toMessageKey(thought)}
                  thought={thought}
                  showDivider={idx > 0}
                  shouldAnimate={
                    shouldAnimateLatestThought && idx === chronologicalThoughts.length - 1
                  }
                  onTaskIdClick={onTaskIdClick}
                  memberColorMap={memberColorMap}
                  teamNames={teamNames}
                  teamColorByName={teamColorByName}
                  onTeamClick={onTeamClick}
                  onReply={onReply}
                />
              ))}
            </div>
          </div>
        ) : null}
      </article>
      {isBodyVisible && !expanded && needsTruncation ? (
        <div
          className="pointer-events-none relative z-10 flex justify-center"
          style={{ marginTop: -15 }}
        >
          <button
            type="button"
            className="pointer-events-auto flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)] shadow-sm transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
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
        <div className="pointer-events-none sticky bottom-0 z-10 flex justify-center pb-1 pt-2">
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

export const LeadThoughtsGroupRow = memo(
  LeadThoughtsGroupRowComponent,
  (prev, next) =>
    prev.memberColor === next.memberColor &&
    prev.isNew === next.isNew &&
    prev.onVisible === next.onVisible &&
    prev.canBeLive === next.canBeLive &&
    prev.isTeamAlive === next.isTeamAlive &&
    prev.leadActivity === next.leadActivity &&
    prev.leadContextUpdatedAt === next.leadContextUpdatedAt &&
    prev.zebraShade === next.zebraShade &&
    prev.collapseMode === next.collapseMode &&
    prev.isCollapsed === next.isCollapsed &&
    prev.canToggleCollapse === next.canToggleCollapse &&
    prev.collapseToggleKey === next.collapseToggleKey &&
    prev.onToggleCollapse === next.onToggleCollapse &&
    prev.onTaskIdClick === next.onTaskIdClick &&
    prev.memberColorMap === next.memberColorMap &&
    areStringArraysEqual(prev.teamNames, next.teamNames) &&
    areStringMapsEqual(prev.teamColorByName, next.teamColorByName) &&
    prev.onTeamClick === next.onTeamClick &&
    prev.onReply === next.onReply &&
    prev.compactHeader === next.compactHeader &&
    prev.onExpand === next.onExpand &&
    prev.expandItemKey === next.expandItemKey &&
    areThoughtGroupsEquivalent(prev.group, next.group)
);
