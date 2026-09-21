import './wideChat.css';

import React, {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isUserUnreadMessage } from '@features/team-direct-chats/renderer';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Loader2 } from 'lucide-react';

import { buildMessageContext, resolveMessageRenderProps } from './activityMessageContext';
import { type ChatAppearance, isNoiseMessage } from './activityMessagePresentation';
import { findNewestMessageIndex, resolveTimelineCollapseState } from './collapseState';
import { projectTimelineRows } from './conversationWindow';
import {
  getThoughtGroupKey,
  groupTimelineItems,
  isCompactionMessage,
  isLeadThought,
  LeadThoughtsGroupRow,
} from './LeadThoughtsGroup';
import { MemoizedMessageRowWithObserver } from './MessageRowWithObserver';
import {
  CompactionDivider,
  getCardPositionForRow,
  getItemSessionAnchorId,
  TimelineHistoryControls,
  type TimelineRow,
} from './timelineRows';
import {
  type ConversationViewportHandle,
  useConversationViewport,
} from './useConversationViewport';
import { useConversationWindow } from './useConversationWindow';
import { useNewItemKeys } from './useNewItemKeys';
import {
  buildWideChatContinuationFlags,
  collectScrollMarginObserverTargets,
  getWideChatRowStyle,
} from './wideChatTimelinePresentation';

import type { TimelineItem } from './LeadThoughtsGroup';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

/**
 * Flattened timeline rows. `groupTimelineItems` groups first; this layer
 * maps 1:1 into JSX for `@tanstack/react-virtual`. `itemIndex` points back
 * into `timelineItems` for collapse, zebra, and session-anchor state.
 */
/**
 * Viewport contract — describes the scroll container that hosts the timeline
 * and how ActivityTimeline should report visibility against it. When omitted,
 * ActivityTimeline falls back to the document viewport (current behavior).
 *
 * This contract is grouped intentionally so consumers pass a single coherent
 * object rather than threading several refs and flags. Virtualizer wiring
 * lands in a follow-up; for now only `observerRoot` has an observable effect.
 */
export interface TimelineViewport {
  /** The element that actually scrolls. */
  scrollElementRef: RefObject<HTMLElement | null>;
  /** Reactive counterpart to the ref, used to bind effects after portal mounts. */
  scrollElement?: HTMLElement | null;
  /**
   * Root element for IntersectionObserver-based visibility tracking.
   * Typically the same node as `scrollElementRef`, but left separate so
   * future code can observe a more specific inner container when needed.
   */
  observerRoot?: RefObject<HTMLElement | null>;
  /**
   * Distance from the scroll container's scroll origin to the timeline root,
   * measured from the DOM. Zero in this release; used by the virtualizer in a
   * follow-up change.
   */
  scrollMargin?: number;
  /** Enable virtualization (wired in a follow-up; ignored for now). */
  virtualizationEnabled?: boolean;
  /** Optional row-count gate for compact hosts that need virtualization earlier. */
  virtualizationRowThreshold?: number;
}

interface ActivityTimelineProps {
  messages: InboxMessage[];
  teamName: string;
  members?: ResolvedTeamMember[];
  /**
   * When provided, unread is derived from this set and getMessageKey.
   * When omitted, unread is derived from message.read.
   */
  readState?: { readSet: Set<string>; getMessageKey: (message: InboxMessage) => string };
  onCreateTaskFromMessage?: (subject: string, description: string) => void;
  onReplyToMessage?: (message: InboxMessage) => void;
  revisionMessageId?: string | null;
  onReviseMessage?: (message: InboxMessage) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onMessageVisible?: (message: InboxMessage) => void;
  observationEnabled?: boolean;
  /** Called when a task ID link (e.g. #10) is clicked in message text. */
  onTaskIdClick?: (taskId: string) => void;
  /** Called when the user clicks "Restart team" on an auth error message. */
  onRestartTeam?: () => void;
  /** When true, collapse all message bodies — show only headers with expand chevrons. */
  allCollapsed?: boolean;
  /** Set of stable message keys that the user has manually expanded in collapsed mode. */
  expandOverrides?: Set<string>;
  /** Called when user toggles expand/collapse override on a specific message. */
  onToggleExpandOverride?: (key: string) => void;
  /** Current lead session ID for the active team, if known. */
  currentLeadSessionId?: string;
  /** Whether the current team is alive. */
  isTeamAlive?: boolean;
  /** Current lead activity status for the active team. */
  leadActivity?: string;
  /** Latest lead context timestamp for the active team. */
  leadContextUpdatedAt?: string;
  /** Team names used for mention/team-link rendering. */
  teamNames?: string[];
  /** Team color mapping used by markdown viewers. */
  teamColorByName?: ReadonlyMap<string, string>;
  /** Opens a team tab from cross-team badges or team:// links. */
  onTeamClick?: (teamName: string) => void;
  /** Callback to expand a message/thought item into a fullscreen dialog. */
  onExpandItem?: (key: string) => void;
  /** Called when ExpandableContent is expanded via "Show more" in any ActivityItem. */
  onExpandContent?: () => void;
  /** True while the initial message page is loading and no cached rows are available yet. */
  loading?: boolean;
  directParticipant?: string;
  unreadSnapshot?: ReadonlySet<string>;
  emptyLabel?: string;
  emptyHint?: string;
  /**
   * Optional viewport contract. When provided, IntersectionObserver uses the
   * passed `observerRoot` instead of the document viewport, which is required
   * for correctness inside scrollable layouts (sidebar, bottom-sheet) where
   * the row may be clipped by its scroll parent while still intersecting the
   * page viewport.
   */
  viewport?: TimelineViewport;
  presentation?: 'activity' | 'conversation';
  appearance?: ChatAppearance;
  conversationIdentity?: string;
  conversationHandleRef?: RefObject<ConversationViewportHandle | null>;
  onLatestAvailable?: (available: boolean) => void;
  historyControl?: (prepare: () => void) => React.ReactNode;
}

const MESSAGES_PAGE_SIZE = 30;
const COMPACT_MESSAGES_WIDTH_PX = 400;
const EMPTY_TEAM_NAMES: string[] = [];
const EMPTY_TEAM_COLOR_MAP = new Map<string, string>();
const DEFAULT_COLLAPSE_MODE = 'default' as const;
const VIRTUALIZER_OVERSCAN = 8;
const VIRTUALIZATION_ROW_GAP_PX = 0;

/**
 * Row count above which virtualization is worth its complexity cost. Below
 * this, the direct render path is both simpler and faster (no wrapper div,
 * no position: absolute, no measurement churn). Chosen so conversations under
 * roughly one session of activity stay on the direct path and the virtualized
 * path only activates when scrolling behavior actually starts to matter.
 */
const VIRTUALIZATION_ROW_THRESHOLD = 60;

/**
 * Per-kind height estimates for `estimateSize`. These are rough initial guesses
 * only; the virtualizer re-measures rows as they mount via `measureElement`
 * (wired in a follow-up PR), so small inaccuracies here are self-correcting.
 * Sizes come from visually averaged steady-state heights in production layouts.
 */
const ROW_SIZE_ESTIMATES: Record<TimelineRow['kind'], number> = {
  'session-separator': 135,
  'compaction-divider': 50,
  'lead-thought-group': 220,
  'message-row': 140,
};

const TimelineLoadingState = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div
      className="rounded-md border border-[var(--color-border)] p-3 pl-5 text-xs text-[var(--color-text-muted)]"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Loader2 size={13} className="animate-spin" />
        <span>{t('activity.timeline.loadingMessages')}</span>
      </div>
      <div className="mt-3 space-y-2" aria-hidden="true">
        <div className="h-3 w-3/4 animate-pulse rounded bg-[var(--color-surface-raised)]" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--color-surface-raised)]" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--color-surface-raised)]" />
      </div>
    </div>
  );
};

const TimelineEmptyState = ({
  label,
  hint,
}: {
  label?: string;
  hint?: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div className="rounded-md border border-[var(--color-border)] p-3 pl-5 text-xs text-[var(--color-text-muted)]">
      <p>{label ?? t('activity.timeline.noMessages')}</p>
      {hint === '' ? null : (
        <p className="mt-1 text-[11px]">{hint ?? t('activity.timeline.emptyHint')}</p>
      )}
    </div>
  );
};

interface ItemCollapseProps {
  collapseMode: 'default' | 'managed';
  isCollapsed: boolean;
  canToggleCollapse: boolean;
  collapseToggleKey?: string;
}

export const ActivityTimeline = React.memo(function ActivityTimeline({
  messages,
  teamName,
  members,
  readState,
  onCreateTaskFromMessage,
  onReplyToMessage,
  revisionMessageId,
  onReviseMessage,
  onMemberClick,
  onMessageVisible,
  observationEnabled = true,
  onTaskIdClick,
  onRestartTeam,
  allCollapsed,
  expandOverrides,
  onToggleExpandOverride,
  currentLeadSessionId,
  isTeamAlive,
  leadActivity,
  leadContextUpdatedAt,
  teamNames = EMPTY_TEAM_NAMES,
  teamColorByName = EMPTY_TEAM_COLOR_MAP,
  onTeamClick,
  onExpandItem,
  onExpandContent,
  loading = false,
  directParticipant,
  unreadSnapshot,
  emptyLabel,
  emptyHint,
  viewport,
  presentation = 'activity',
  appearance = 'compact',
  conversationIdentity = teamName,
  conversationHandleRef,
  onLatestAvailable,
  historyControl,
}: ActivityTimelineProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const observerRoot = viewport?.observerRoot ?? viewport?.scrollElementRef;
  const conversation = presentation === 'conversation';
  const conversationWindow = useConversationWindow(messages, conversationIdentity, conversation);
  const [visibleCount, setVisibleCount] = useState(MESSAGES_PAGE_SIZE);
  const rootRef = useRef<HTMLDivElement>(null);
  const [compactHeader, setCompactHeader] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const updateCompactMode = (width: number): void => {
      setCompactHeader((prev) => {
        const next = width < COMPACT_MESSAGES_WIDTH_PX;
        return prev === next ? prev : next;
      });
    };

    updateCompactMode(el.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateCompactMode(entry.contentRect.width);
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const ctx = useMemo(() => buildMessageContext(members), [members]);
  const { colorMap, localMemberNames, memberInfo } = ctx;

  const handleMemberNameClick = useCallback(
    (name: string) => {
      const member = members?.find(
        (candidate) => candidate.name === name || candidate.agentType === name
      );
      if (member) onMemberClick?.(member);
    },
    [members, onMemberClick]
  );

  // Pagination counts only significant (non-thought) messages so that lead thoughts
  // don't consume the page limit — they collapse into a single visual group anyway.
  const { visibleMessages, hiddenCount } = useMemo(() => {
    if (conversation) return conversationWindow;
    const total = messages.length;
    if (total === 0) return { visibleMessages: messages, hiddenCount: 0 };

    let significantSeen = 0;
    let cutoff = total;
    for (let i = 0; i < total; i++) {
      if (!isLeadThought(messages[i])) {
        significantSeen++;
        if (significantSeen > visibleCount) {
          cutoff = i;
          break;
        }
      }
    }

    const significantTotal =
      significantSeen +
      (cutoff < total ? messages.slice(cutoff).filter((m) => !isLeadThought(m)).length : 0);
    const hidden = Math.max(0, significantTotal - visibleCount);
    return {
      visibleMessages: cutoff < total ? messages.slice(0, cutoff) : messages,
      hiddenCount: hidden,
    };
  }, [messages, visibleCount, conversation, conversationWindow]);

  // Group consecutive lead thoughts into collapsible blocks.
  const timelineItems = useMemo(() => groupTimelineItems(visibleMessages), [visibleMessages]);

  // Zebra striping is anchored from the bottom of the visible list so prepending
  // new live messages at the top does not recolor every existing card.
  const zebraShadeSet = useMemo(() => {
    const result = new Set<number>();
    let cardCount = 0;
    for (let i = timelineItems.length - 1; i >= 0; i--) {
      const item = timelineItems[i];
      if (item.type === 'lead-thoughts') {
        // Thought groups count as one card for striping
        if (cardCount % 2 === 1) result.add(i);
        cardCount++;
      } else {
        if (isNoiseMessage(item.message.text)) continue;
        if (isCompactionMessage(item.message)) continue;
        if (cardCount % 2 === 1) result.add(i);
        cardCount++;
      }
    }
    return result;
  }, [timelineItems]);

  const timelineItemKeys = useMemo(() => {
    const getItemKey = (item: TimelineItem): string => {
      if (item.type === 'lead-thoughts') {
        return getThoughtGroupKey(item.group);
      }
      return toMessageKey(item.message);
    };

    return timelineItems.map(getItemKey);
  }, [timelineItems]);

  const activityNewItemKeys = useNewItemKeys({
    itemKeys: timelineItemKeys,
    paginationKey: visibleCount,
    resetKey: teamName,
  });

  const newItemKeys = conversation
    ? new Set(
        timelineItems.flatMap((item, index) => {
          const fresh =
            item.type === 'lead-thoughts'
              ? item.group.thoughts.every((message) =>
                  conversationWindow.freshKeys.has(toMessageKey(message))
                )
              : conversationWindow.freshKeys.has(toMessageKey(item.message));
          return fresh ? [timelineItemKeys[index]] : [];
        })
      )
    : activityNewItemKeys;

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const key of timelineItemKeys) {
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    if (duplicates.size > 0) {
      console.warn('[ActivityTimeline] Duplicate timeline item keys detected', {
        teamName,
        duplicates: [...duplicates],
      });
    }
  }, [teamName, timelineItemKeys]);

  const handleShowMore = (): void => {
    if (conversation) {
      conversationHandleRef?.current?.prepareHistory();
      conversationWindow.showMore();
    } else setVisibleCount((prev) => prev + MESSAGES_PAGE_SIZE);
  };

  const handleShowAll = (): void => {
    if (conversation) {
      conversationHandleRef?.current?.prepareHistory();
      conversationWindow.showAll();
    } else setVisibleCount(Infinity);
  };

  // Precompute, per timeline index, the most recent session anchor that appears
  // strictly earlier in the list. Replaces an O(n) backward scan during render
  // with an O(1) lookup; total work drops from O(n^2) to O(n) per timelineItems
  // change.
  const previousSessionAnchorByIndex = useMemo<readonly (string | undefined)[]>(() => {
    const anchors: (string | undefined)[] = [];
    let lastSeen: string | undefined;
    for (const item of timelineItems) {
      anchors.push(lastSeen);
      const anchor = getItemSessionAnchorId(item);
      if (anchor) lastSeen = anchor;
    }
    return anchors;
  }, [timelineItems]);

  // Pin the newest thought group (if first) so it stays at the top and doesn't jump.
  const pinnedThoughtGroup = timelineItems[0]?.type === 'lead-thoughts' ? timelineItems[0] : null;
  const startIndex = pinnedThoughtGroup ? 1 : 0;

  // Flatten timelineItems into atomic render rows. Each row maps to exactly
  // one visual element — no Fragment bundles session separators with their
  // owning item, because a windowing layer (landing in a follow-up PR) needs
  // each row to be measurable and addressable independently.
  const renderRows = useMemo<readonly TimelineRow[]>(() => {
    const rows: TimelineRow[] = [];
    if (pinnedThoughtGroup) {
      rows.push({
        kind: 'lead-thought-group',
        key: getThoughtGroupKey(pinnedThoughtGroup.group),
        itemIndex: 0,
        group: pinnedThoughtGroup.group,
        isPinned: true,
      });
    }
    for (let i = startIndex; i < timelineItems.length; i += 1) {
      const item = timelineItems[i];
      if (i > 0) {
        const currSessionId = getItemSessionAnchorId(item);
        const prevSessionId = previousSessionAnchorByIndex[i];
        if (prevSessionId && currSessionId && prevSessionId !== currSessionId) {
          // Include itemIndex in the key so a repeated transition (e.g. lead
          // sessions A→B→A→B) does not collide on key `A->B` twice — React
          // treats duplicate keys as the same element and reuses state
          // across unrelated separators.
          rows.push({
            kind: 'session-separator',
            key: `session-separator-${i}-${prevSessionId}->${currSessionId}`,
          });
        }
      }
      if (item.type === 'lead-thoughts') {
        rows.push({
          kind: 'lead-thought-group',
          key: getThoughtGroupKey(item.group),
          itemIndex: i,
          group: item.group,
          isPinned: false,
        });
        continue;
      }
      const message = item.message;
      if (isCompactionMessage(message)) {
        rows.push({
          kind: 'compaction-divider',
          key: `compaction-${toMessageKey(message)}`,
          message,
        });
        continue;
      }
      rows.push({
        kind: 'message-row',
        key: toMessageKey(message),
        itemIndex: i,
        message,
      });
    }
    return projectTimelineRows(rows, presentation);
  }, [pinnedThoughtGroup, previousSessionAnchorByIndex, startIndex, timelineItems, presentation]);

  // Virtualizer gate — activates only when the parent opts in via
  // `viewport.virtualizationEnabled`, the scroll element ref is present, and
  // the row count is large enough for virtualization to pay for itself. Below
  // the threshold the direct render path is both simpler and faster, so we
  // keep it for short lists.
  const viewportScrollElement =
    viewport?.scrollElement ?? viewport?.scrollElementRef.current ?? null;
  const shouldVirtualize =
    viewport?.virtualizationEnabled === true &&
    viewportScrollElement !== null &&
    renderRows.length >= (viewport.virtualizationRowThreshold ?? VIRTUALIZATION_ROW_THRESHOLD);

  // DOM-measured distance from the scroll container's scroll origin to the
  // timeline root. We avoid re-measuring on every scroll: the offset only
  // changes when layout above the timeline changes, so observe the timeline,
  // its ancestor chain, and all previous siblings that can push it down.
  const [measuredScrollMargin, setMeasuredScrollMargin] = useState(0);

  useLayoutEffect(() => {
    if (!shouldVirtualize) return;
    const scrollEl = viewportScrollElement;
    const rootEl = rootRef.current;
    if (!scrollEl || !rootEl) return;

    let pending = false;
    let rafId: number | null = null;
    const measure = (): void => {
      if (pending) return;
      pending = true;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        pending = false;
        const scrollRect = scrollEl.getBoundingClientRect();
        const rootRect = (
          rootEl.querySelector<HTMLElement>('[data-timeline-rows]') ?? rootEl
        ).getBoundingClientRect();
        // Distance from top of scroll content to top of timeline root. Adding
        // `scrollTop` compensates for the fact that both rects are relative
        // to the viewport at measurement time, not the scrollable content.
        const next = Math.max(0, rootRect.top - scrollRect.top + scrollEl.scrollTop);
        setMeasuredScrollMargin((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
      });
    };

    measure();
    const resizeObserver = new ResizeObserver(measure);
    const observedTargets = collectScrollMarginObserverTargets(
      rootEl.querySelector<HTMLElement>('[data-timeline-rows]') ?? rootEl,
      scrollEl
    );
    observedTargets.forEach((target) => resizeObserver.observe(target));
    window.addEventListener('resize', measure);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [shouldVirtualize, viewportScrollElement]);

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? renderRows.length : 0,
    getScrollElement: () => viewportScrollElement,
    estimateSize: (index) => ROW_SIZE_ESTIMATES[renderRows[index]?.kind ?? 'message-row'],
    getItemKey: (index) => renderRows[index]?.key ?? `row-${index}`,
    overscan: VIRTUALIZER_OVERSCAN,
    gap: VIRTUALIZATION_ROW_GAP_PX,
    scrollMargin: measuredScrollMargin,
  });

  const conversationViewport = useConversationViewport({
    enabled: conversation,
    identity: conversationIdentity,
    active: observationEnabled,
    rows: renderRows,
    scrollRef: viewport?.scrollElementRef,
    scrollElement: viewportScrollElement,
    contentRef: rootRef,
    virtualizer: rowVirtualizer,
    virtual: shouldVirtualize,
    handleRef: conversationHandleRef,
    onLatestAvailable,
  });
  const canObserve = observationEnabled && conversationViewport.observationEnabled;

  const newestMessageIndex = useMemo(() => {
    return findNewestMessageIndex(timelineItems);
  }, [timelineItems]);

  const getItemCollapseProps = useCallback(
    (stableKey: string, itemIndex: number): ItemCollapseProps => {
      const collapseState = resolveTimelineCollapseState({
        allCollapsed,
        itemIndex,
        newestMessageIndex,
        isPinnedThoughtGroup: itemIndex === 0 && pinnedThoughtGroup != null,
        isExpandedOverride: expandOverrides?.has(stableKey) ?? false,
        onToggleOverride: onToggleExpandOverride
          ? () => onToggleExpandOverride(stableKey)
          : undefined,
      });

      if (collapseState.mode !== DEFAULT_COLLAPSE_MODE) {
        return {
          collapseMode: collapseState.mode,
          isCollapsed: collapseState.isCollapsed,
          canToggleCollapse: collapseState.canToggle,
          collapseToggleKey: collapseState.canToggle ? stableKey : undefined,
        };
      }

      return {
        collapseMode: DEFAULT_COLLAPSE_MODE,
        isCollapsed: false,
        canToggleCollapse: false,
      };
    },
    [allCollapsed, newestMessageIndex, pinnedThoughtGroup, expandOverrides, onToggleExpandOverride]
  );

  const continuesPreviousAuthor = useMemo<readonly boolean[]>(() => {
    return buildWideChatContinuationFlags({
      appearance,
      rows: renderRows,
      teamName,
      localMemberNames,
      isCollapsed: (key, itemIndex) => getItemCollapseProps(key, itemIndex).isCollapsed,
    });
  }, [appearance, getItemCollapseProps, localMemberNames, renderRows, teamName]);

  // Render a single atomic row. Logic per kind mirrors the previous inline
  // render path; separators and dividers are their own rows rather than
  // being bundled into Fragments, which is the contract the virtualizer will
  // consume in a follow-up PR.
  //
  // `suppressEntryAnimation` is set when the caller is the virtualized path:
  // the virtualizer mounts and unmounts rows as they enter and leave the
  // viewport, so relying on mount as a signal of "this item is new" would
  // replay the entry animation every time the user scrolls back to an old
  // row. In the direct render path the flag stays false and animation still
  // runs on real data-set additions.
  const renderTimelineRow = (
    row: TimelineRow,
    options?: { suppressEntryAnimation?: boolean; rowIndex?: number }
  ): React.JSX.Element | null => {
    const suppressEntry = options?.suppressEntryAnimation === true;
    const cardPosition = getCardPositionForRow(renderRows, options?.rowIndex);
    switch (row.kind) {
      case 'session-separator':
        return (
          <div
            key={row.key}
            className="flex items-center gap-3"
            style={{ paddingTop: 45, paddingBottom: 45 }}
          >
            <div className="h-px flex-1 bg-blue-600/30 dark:bg-blue-400/30" />
            <span className="whitespace-nowrap text-[11px] font-medium text-blue-600 dark:text-blue-400">
              {t('activity.timeline.newSession')}
            </span>
            <div className="h-px flex-1 bg-blue-600/30 dark:bg-blue-400/30" />
          </div>
        );
      case 'compaction-divider':
        return <CompactionDivider key={row.key} message={row.message} />;
      case 'lead-thought-group': {
        const { group, itemIndex, isPinned, key } = row;
        const firstThought = group.thoughts[0];
        const info =
          memberInfo.get('team-lead') ??
          memberInfo.get('lead') ??
          memberInfo.get(firstThought.from);
        const collapseProps = getItemCollapseProps(key, itemIndex);
        const pinnedCanBeLive = isPinned
          ? currentLeadSessionId
            ? firstThought.leadSessionId === currentLeadSessionId
            : true
          : false;
        return (
          <LeadThoughtsGroupRow
            key={key}
            group={group}
            memberColor={info?.color}
            canBeLive={pinnedCanBeLive}
            isTeamAlive={pinnedCanBeLive ? isTeamAlive : undefined}
            leadActivity={pinnedCanBeLive ? leadActivity : undefined}
            leadContextUpdatedAt={pinnedCanBeLive ? leadContextUpdatedAt : undefined}
            isNew={!suppressEntry && newItemKeys.has(key)}
            animateLatestThought={
              !conversation || conversationWindow.freshKeys.has(toMessageKey(firstThought))
            }
            onVisible={onMessageVisible}
            observationEnabled={canObserve}
            observerRoot={observerRoot}
            zebraShade={zebraShadeSet.has(itemIndex)}
            collapseMode={collapseProps.collapseMode}
            isCollapsed={collapseProps.isCollapsed}
            canToggleCollapse={collapseProps.canToggleCollapse}
            collapseToggleKey={collapseProps.collapseToggleKey}
            onToggleCollapse={onToggleExpandOverride}
            onTaskIdClick={onTaskIdClick}
            memberColorMap={colorMap}
            onReply={onReplyToMessage}
            compactHeader={compactHeader}
            teamNames={teamNames}
            teamColorByName={teamColorByName}
            onTeamClick={onTeamClick}
            onExpand={compactHeader ? onExpandItem : undefined}
            expandItemKey={compactHeader ? key : undefined}
            timelineCardPosition={cardPosition}
          />
        );
      }
      case 'message-row': {
        const { message, itemIndex, key } = row;
        const renderProps = resolveMessageRenderProps(message, ctx);
        const collapseProps = getItemCollapseProps(key, itemIndex);
        const isUnread = readState
          ? Boolean(unreadSnapshot?.has(readState.getMessageKey(message))) ||
            isUserUnreadMessage(message, readState.readSet, readState.getMessageKey)
          : !message.read;
        return (
          <MemoizedMessageRowWithObserver
            key={key}
            message={message}
            teamName={teamName}
            memberRole={renderProps.memberRole}
            memberColor={renderProps.memberColor}
            recipientColor={renderProps.recipientColor}
            isUnread={isUnread}
            isNew={!suppressEntry && newItemKeys.has(key)}
            isNewlyAdded={newItemKeys.has(key)}
            zebraShade={zebraShadeSet.has(itemIndex)}
            memberColorMap={colorMap}
            localMemberNames={localMemberNames}
            onMemberNameClick={onMemberClick ? handleMemberNameClick : undefined}
            onCreateTask={onCreateTaskFromMessage}
            onReply={onReplyToMessage}
            revisionMessageId={revisionMessageId}
            onRevise={onReviseMessage}
            onVisible={onMessageVisible}
            observationEnabled={canObserve}
            onTaskIdClick={onTaskIdClick}
            onRestartTeam={onRestartTeam}
            collapseMode={collapseProps.collapseMode}
            isCollapsed={collapseProps.isCollapsed}
            canToggleCollapse={collapseProps.canToggleCollapse}
            collapseToggleKey={collapseProps.collapseToggleKey}
            onToggleCollapse={onToggleExpandOverride}
            compactHeader={compactHeader}
            teamNames={teamNames}
            teamColorByName={teamColorByName}
            onTeamClick={onTeamClick}
            onExpand={compactHeader ? onExpandItem : undefined}
            expandItemKey={compactHeader ? key : undefined}
            observerRoot={observerRoot}
            onExpandContent={onExpandContent}
            timelineCardPosition={cardPosition}
            directParticipant={directParticipant}
            appearance={appearance}
            continuesPreviousAuthor={continuesPreviousAuthor[options?.rowIndex ?? 0] ?? false}
          />
        );
      }
    }
  };

  const history = (
    <div data-conversation-history={conversation || undefined}>
      <TimelineHistoryControls
        hiddenCount={hiddenCount}
        onShowMore={handleShowMore}
        onShowAll={handleShowAll}
      />
      {hiddenCount === 0 &&
        conversation &&
        historyControl?.(() => {
          conversationHandleRef?.current?.prepareHistory();
          conversationWindow.showAll();
        })}
    </div>
  );

  if (messages.length === 0) {
    return (
      <div
        ref={rootRef}
        className="flex flex-col"
        data-chat-appearance={appearance === 'wide-chat' ? appearance : undefined}
      >
        {conversation && history}
        {loading ? (
          <TimelineLoadingState />
        ) : (
          <TimelineEmptyState label={emptyLabel} hint={emptyHint} />
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="flex flex-col"
      data-chat-appearance={appearance === 'wide-chat' ? appearance : undefined}
    >
      {conversation && history}
      {shouldVirtualize ? (
        <div
          data-timeline-rows="true"
          style={{
            visibility: conversationViewport.initialPending ? 'hidden' : undefined,
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = renderRows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                // `measureElement` swaps each row's estimated height for its
                // real rendered height as it mounts, so the virtualizer can
                // correct totalSize and downstream row positions. The wrapper
                // The wrapper owns wide-chat gutter and group spacing, so the
                // virtualizer measures the complete visual row. The observer
                // remains on the inner reveal and keeps its read semantics.
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                data-timeline-row-key={row.key}
                style={{
                  ...getWideChatRowStyle(appearance, continuesPreviousAuthor, virtualRow.index),
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  // `translateY` is offset by scrollMargin so the virtualizer
                  // positions rows relative to the timeline's own origin,
                  // not the scroll container's top — otherwise rows would
                  // overlap the composer / status block at the top.
                  transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
                }}
              >
                {renderTimelineRow(row, {
                  suppressEntryAnimation: true,
                  rowIndex: virtualRow.index,
                })}
              </div>
            );
          })}
        </div>
      ) : (
        renderRows.map((row, index) => (
          <div
            key={row.key}
            data-timeline-row-key={row.key}
            style={{
              ...getWideChatRowStyle(appearance, continuesPreviousAuthor, index),
              visibility: conversationViewport.initialPending ? 'hidden' : undefined,
            }}
          >
            {renderTimelineRow(row, { rowIndex: index })}
          </div>
        ))
      )}
      {!conversation && history}
    </div>
  );
});
