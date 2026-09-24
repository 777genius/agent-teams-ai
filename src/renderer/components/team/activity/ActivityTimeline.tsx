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

import { ComposerOutboxBubble } from '../messages/ComposerOutboxBubble';

import { buildMessageContext, resolveMessageRenderProps } from './activityMessageContext';
import { type ChatAppearance, isNoiseMessage } from './activityMessagePresentation';
import { findNewestMessageIndex, resolveTimelineCollapseState } from './collapseState';
import {
  type ActivityTimelineItem,
  mergeComposerOutboxTimelineItems,
} from './composerOutboxTimeline';
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
import { useUnreadBelowViewport } from './useUnreadBelowViewport';
import {
  buildWideChatContinuationFlags,
  collectScrollMarginObserverTargets,
  getWideChatRowStyle,
} from './wideChatTimelinePresentation';

import type { ComposerOutboxItem } from '@renderer/services/composerOutbox';
import type { RestoreRecoveryResult } from '@renderer/types/composerDraft';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

/** Scroll and observation contract for the conversation timeline. */
export interface TimelineViewport {
  /** The element that actually scrolls. */
  scrollElementRef: RefObject<HTMLElement | null>;
  scrollElement?: HTMLElement | null;
  /** Usually the scroll element; defaults to scrollElementRef. */
  observerRoot?: RefObject<HTMLElement | null>;
  scrollMargin?: number;
  virtualizationEnabled?: boolean;
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
  onTaskIdClick?: (taskId: string) => void;
  onRestartTeam?: () => void;
  allCollapsed?: boolean;
  expandOverrides?: Set<string>;
  onToggleExpandOverride?: (key: string) => void;
  currentLeadSessionId?: string;
  isTeamAlive?: boolean;
  leadActivity?: string;
  leadContextUpdatedAt?: string;
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
  onExpandItem?: (key: string) => void;
  onExpandContent?: () => void;
  loading?: boolean;
  directParticipant?: string;
  unreadSnapshot?: ReadonlySet<string>;
  emptyLabel?: string;
  emptyHint?: string;
  /** Scroll container used for row visibility and virtualized positioning. */
  viewport?: TimelineViewport;
  presentation?: 'activity' | 'conversation';
  appearance?: ChatAppearance;
  conversationIdentity?: string;
  conversationHandleRef?: RefObject<ConversationViewportHandle | null>;
  onLatestAvailable?: (available: boolean) => void;
  onUnreadBelowChange?: (count: number) => void;
  historyControl?: (prepare: () => void) => React.ReactNode;
  composerOutboxItems?: readonly ComposerOutboxItem[];
  onComposerOutboxCopy?: (item: ComposerOutboxItem) => Promise<void>;
  onComposerOutboxRestore?: (item: ComposerOutboxItem) => Promise<RestoreRecoveryResult>;
  onComposerOutboxDiscard?: (
    item: ComposerOutboxItem
  ) => Promise<'discarded' | 'missing' | 'conflict' | 'active' | 'blocked'>;
}

const MESSAGES_PAGE_SIZE = 30;
const COMPACT_MESSAGES_WIDTH_PX = 400;
const EMPTY_TEAM_NAMES: string[] = [];
const EMPTY_TEAM_COLOR_MAP = new Map<string, string>();
const EMPTY_OUTBOX_ITEMS: readonly ComposerOutboxItem[] = [];
const EMPTY_READ_SET: ReadonlySet<string> = new Set();
const NOOP_OUTBOX_COPY = async (): Promise<void> => undefined;
const NOOP_OUTBOX_RESTORE = async (): Promise<RestoreRecoveryResult> => ({
  kind: 'active',
  status: 'durable',
});
const NOOP_OUTBOX_DISCARD = async (): Promise<'blocked'> => 'blocked';
const DEFAULT_COLLAPSE_MODE = 'default' as const;
const VIRTUALIZER_OVERSCAN = 8;
const VIRTUALIZATION_ROW_GAP_PX = 0;

const VIRTUALIZATION_ROW_THRESHOLD = 60;

/** Initial estimates are replaced by measured heights after mount. */
const ROW_SIZE_ESTIMATES: Record<TimelineRow['kind'], number> = {
  'session-separator': 135,
  'compaction-divider': 50,
  'lead-thought-group': 220,
  'message-row': 140,
  'composer-outbox-row': 120,
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
  onUnreadBelowChange,
  historyControl,
  composerOutboxItems = EMPTY_OUTBOX_ITEMS,
  onComposerOutboxCopy,
  onComposerOutboxRestore,
  onComposerOutboxDiscard,
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
  const timelineItems = useMemo(
    () => mergeComposerOutboxTimelineItems(groupTimelineItems(visibleMessages), composerOutboxItems),
    [composerOutboxItems, visibleMessages]
  );

  // Zebra striping is anchored from the bottom of the visible list so prepending
  // new live messages at the top does not recolor every existing card.
  const zebraShadeSet = useMemo(() => {
    const result = new Set<number>();
    let cardCount = 0;
    for (let i = timelineItems.length - 1; i >= 0; i--) {
      const item = timelineItems[i];
      if (item.type === 'composer-outbox') {
        if (cardCount % 2 === 1) result.add(i);
        cardCount++;
      } else if (item.type === 'lead-thoughts') {
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
    const getItemKey = (item: ActivityTimelineItem): string => {
      if (item.type === 'composer-outbox') {
        return `composer-outbox:${item.item.id}`;
      }
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
            item.type === 'composer-outbox'
              ? false
              : item.type === 'lead-thoughts'
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

  // O(1) previous-session lookup for each rendered row.
  const previousSessionAnchorByIndex = useMemo<readonly (string | undefined)[]>(() => {
    const anchors: (string | undefined)[] = [];
    let lastSeen: string | undefined;
    for (const item of timelineItems) {
      anchors.push(lastSeen);
      const anchor = item.type === 'composer-outbox' ? undefined : getItemSessionAnchorId(item);
      if (anchor) lastSeen = anchor;
    }
    return anchors;
  }, [timelineItems]);

  // Pin the newest thought group (if first) so it stays at the top and doesn't jump.
  const pinnedThoughtGroup = timelineItems[0]?.type === 'lead-thoughts' ? timelineItems[0] : null;
  const startIndex = pinnedThoughtGroup ? 1 : 0;

  // Each render row has one measurable element.
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
        const currSessionId =
          item.type === 'composer-outbox' ? undefined : getItemSessionAnchorId(item);
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
      if (item.type === 'composer-outbox') {
        rows.push({
          kind: 'composer-outbox-row',
          key: `composer-outbox:${item.item.id}`,
          itemIndex: i,
          item: item.item,
        });
        continue;
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

  // Short conversations use the direct render path.
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

  useUnreadBelowViewport({
    enabled: conversation && canObserve,
    identity: conversationIdentity,
    rows: renderRows,
    readSet: readState?.readSet ?? EMPTY_READ_SET,
    scroll: viewportScrollElement,
    contentRef: rootRef,
    virtual: shouldVirtualize,
    onChange: onUnreadBelowChange,
  });

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
  // Virtual row remounts must not replay entry animation.
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
            continuesNextAuthor={continuesPreviousAuthor[(options?.rowIndex ?? 0) + 1] ?? false}
          />
        );
      }
      case 'composer-outbox-row': {
        const { item, key } = row;
        return (
          <ComposerOutboxBubble
            key={key}
            item={item}
            appearance={appearance}
            continuesPreviousAuthor={continuesPreviousAuthor[options?.rowIndex ?? 0] ?? false}
            continuesNextAuthor={continuesPreviousAuthor[(options?.rowIndex ?? 0) + 1] ?? false}
            onCopy={onComposerOutboxCopy ?? NOOP_OUTBOX_COPY}
            onRestore={onComposerOutboxRestore ?? NOOP_OUTBOX_RESTORE}
            onDiscard={onComposerOutboxDiscard ?? NOOP_OUTBOX_DISCARD}
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

  if (messages.length === 0 && composerOutboxItems.length === 0) {
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
