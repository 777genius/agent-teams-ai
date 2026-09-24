import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Sheet, type SheetRef } from 'react-modal-sheet';

import { useAppTranslation } from '@features/localization/renderer';
import {
  ChatList,
  ChatUnreadBadges,
  ConversationHeader,
  createDirectScope,
  TEAM_FEED_SCOPE,
  useTeamConversationSurface,
} from '@features/team-direct-chats/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useComposerWorkingSummaries } from '@renderer/hooks/useComposerWorkingSummaries';
import { useTeamMessagesExpanded } from '@renderer/hooks/useTeamMessagesExpanded';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { useStore } from '@renderer/store';
import { selectTeamMessages } from '@renderer/store/slices/teamSlice';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { shouldExcludeInboxTextFromReplyCandidates } from '@shared/utils/idleNotificationSemantics';
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  isMemberWorkSyncNudgeMessage,
  isReviewPickupEscalationMessage,
  isTaskStallRemediationMessage,
} from '@shared/utils/teamAutomationMessages';
import {
  CheckCheck,
  Dock,
  MessageSquare,
  MoreHorizontal,
  PanelBottom,
  PanelLeft,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { type TimelineViewport } from '../activity/ActivityTimeline';
import {
  getThoughtGroupKey,
  groupTimelineItems,
  isLeadThought,
} from '../activity/LeadThoughtsGroup';
import {
  CollapsibleTeamSection,
  type CollapsibleTeamSectionVariant,
} from '../CollapsibleTeamSection';
import {
  getTeamMessagesSidebarUiState,
  setTeamMessagesSidebarUiState,
} from '../sidebar/teamSidebarUiState';

import { MessageComposer } from './MessageComposer';
import {
  FullScreenControl,
  LatestMessageControl,
  WideThreadHeader,
} from './MessagesExpandedChrome';
import { MessagesInlineBackButton } from './MessagesInlineBackButton';
import { MessagesLayoutMenuItems } from './MessagesLayoutMenuItems';
import {
  conversationChrome,
  conversationScopeKey,
  filterScopedMessages,
  scopedUnreadCounts,
  scopedUnreadKeys,
} from './messagesPanelConversations';
import {
  findLatestRevisableUserSentMessage,
  hasVisibleReplyForSendMessageDiagnostics,
  reconcilePendingRepliesByMember,
  trimString,
} from './messagesPanelLogic';
import { resolveReplyRecipient } from './messagesPanelReplyRecipient';
import { selectMessagesPanelTeamMentionMeta } from './messagesPanelTeamMentionMeta';
import { MessagesSearchBar, MessagesSearchControls } from './MessagesSearchBar';
import { MessagesSidebarSurface } from './MessagesSidebarSurface';
import { type ExpandedChatHost, MessagesThreadPlacement } from './MessagesThreadPlacement';
import { MessagesThreadUtilityMenuItems } from './MessagesThreadUtilityMenuItems';
import { MessagesThreadView } from './MessagesThreadView';
import { MessagesTimelineSection } from './MessagesTimelineSection';
import { StatusBlock } from './StatusBlock';
import { ThreadAwareMessageComposer } from './ThreadAwareMessageComposer';
import { calculateBottomSheetGeometry, useBottomSheetLayout } from './useBottomSheetLayout';
import { useComposerOutboxItems } from './useComposerOutboxItems';
import { useMessageRevisionIntent } from './useMessageRevisionIntent';
import {
  useDirectThreadAutoOlder,
  useResetScrollOnConversationChange,
  useTeamChatListItems,
  useThreadUnreadSnapshot,
} from './useMessagesPanelChats';
import { useMessagesPanelSend } from './useMessagesPanelSend';

import type { TimelineItem } from '../activity/LeadThoughtsGroup';
import type { ConversationViewportHandle } from '../activity/useConversationViewport';
import type { ComposerDraftDestination } from './composerDraftDestination';
import type { MessageRevisionTargetController } from './messageRevisionTarget';
import type { MessagesFilterState } from './MessagesFilterPopover';
import type { ComposerDraftAddress } from '@renderer/types/composerDraft';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type {
  DiscardQueuedUserMessagesResult,
  InboxMessage,
  ResolvedTeamMember,
  TeamTaskWithKanban,
} from '@shared/types';

interface TimeWindow {
  start: number;
  end: number;
}

const BOTTOM_SHEET_HEADER_HEIGHT = 40;
const BOTTOM_SHEET_COLLAPSED_SNAP_INDEX = 1;
const BOTTOM_SHEET_COMPOSER_SNAP_INDEX = 2;
const OPENCODE_RUNTIME_DELIVERY_STATUS_REFRESH_DELAYS_MS = [15_000, 45_000, 90_000] as const;
const MESSAGES_SCROLL_TOP_PERSIST_DELAY_MS = 100;
const EMPTY_REPLY_CANDIDATE_MESSAGES: InboxMessage[] = [];

interface MessagesPanelProps {
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
  onCreateTaskFromMessage?: (subject: string, description: string) => void;
  /** Callback to open reply dialog for a message. */
  onReplyToMessage?: (message: InboxMessage, recipientHint?: string) => void;
  /** Callback when "Restart team" is clicked. */
  onRestartTeam?: () => void;
  /** Callback when a task ID link is clicked. */
  onTaskIdClick?: (taskId: string) => void;
  /** Reports the rendered floating composer height so the parent can reserve scroll space. */
  onFloatingComposerHeightChange?: (height: number) => void;
  /** Parent-owned scroll viewport for the unchanged inline activity presentation. */
  inlineScrollContainerRef?: RefObject<HTMLDivElement | null>;
  /** Visual treatment for the inline section header. */
  sectionVariant?: CollapsibleTeamSectionVariant;
  /** Main-region host available only to the native team sidebar. */
  expandedChatHost?: ExpandedChatHost;
}

const MessagesComposerSection = memo(MessageComposer);
const MessagesStatusSection = memo(StatusBlock);

export const MessagesPanel = memo(function MessagesPanel({
  isActive = true,
  teamName,
  position,
  onPositionChange,
  mountPoint,
  members,
  tasks,
  isTeamAlive,
  leadActivity,
  leadContextUpdatedAt,
  timeWindow,
  currentLeadSessionId,
  pendingRepliesByMember,
  onPendingReplyChange,
  onMemberClick,
  onTaskClick,
  onCreateTaskFromMessage,
  onReplyToMessage,
  onRestartTeam,
  onTaskIdClick,
  onFloatingComposerHeightChange,
  inlineScrollContainerRef,
  sectionVariant,
  expandedChatHost,
}: MessagesPanelProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const {
    sendTeamMessage,
    sendCrossTeamMessage,
    sendingMessage,
    sendMessageError,
    sendMessageWarning,
    sendMessageDebugDetails,
    lastSendMessageResult,
    clearSendMessageRuntimeDiagnostics,
    refreshSendMessageRuntimeDeliveryStatus,
    teamMentionMeta,
    openTeamTab,
    messages,
    messagesEntryPresent,
    messagesHasMore,
    messagesLoadingHead,
    messagesLoadingOlder,
    loadOlderTeamMessages,
    refreshTeamMessagesHead,
    activeContextId,
  } = useStore(
    useShallow((s) => {
      const messagesState = teamName ? s.teamMessagesByName[teamName] : undefined;
      return {
        sendTeamMessage: s.sendTeamMessage,
        sendCrossTeamMessage: s.sendCrossTeamMessage,
        sendingMessage: s.sendingMessage,
        sendMessageError: s.sendMessageError,
        sendMessageWarning: s.sendMessageWarning,
        sendMessageDebugDetails: s.sendMessageDebugDetails,
        lastSendMessageResult: s.lastSendMessageResult,
        clearSendMessageRuntimeDiagnostics: s.clearSendMessageRuntimeDiagnostics,
        refreshSendMessageRuntimeDeliveryStatus: s.refreshSendMessageRuntimeDeliveryStatus,
        teamMentionMeta: selectMessagesPanelTeamMentionMeta(s.teams),
        openTeamTab: s.openTeamTab,
        messages: selectTeamMessages(s, teamName),
        messagesEntryPresent: messagesState !== undefined,
        messagesHasMore: messagesState?.hasMore ?? false,
        messagesLoadingHead: messagesState?.loadingHead ?? false,
        messagesLoadingOlder: messagesState?.loadingOlder ?? false,
        loadOlderTeamMessages: s.loadOlderTeamMessages,
        refreshTeamMessagesHead: s.refreshTeamMessagesHead,
        activeContextId: s.activeContextId,
      };
    })
  );
  const bootstrapHeadRefreshAttemptedForTeamRef = useRef<string | null>(null);

  const loadOlderMessages = useCallback(async () => {
    if (!messagesHasMore || messagesLoadingHead || messagesLoadingOlder) {
      return;
    }
    await loadOlderTeamMessages(teamName);
  }, [loadOlderTeamMessages, messagesHasMore, messagesLoadingHead, messagesLoadingOlder, teamName]);

  const handleLoadOlderMessagesClick = useCallback(() => {
    void loadOlderMessages();
  }, [loadOlderMessages]);

  const handleQueuedDiscarded = useCallback(
    (memberName: string, result: DiscardQueuedUserMessagesResult) => {
      // Only drop the pending entry when the member's queue is empty and this
      // discard is what emptied it. A discard that removed nothing means the
      // runtime took the message first, so the entry has to stay and become
      // "delivered" on the next head refresh. A discard that removed rows while
      // others were still queued has to keep it too: nothing recreates the
      // entry - reconcilePendingRepliesByMember only ever removes, and the head
      // refresh below reloads messages, not this map - so dropping it would
      // hide the rows that survived until the user sends the member something
      // new.
      if (result.discarded > 0 && result.remainingQueued === 0) {
        onPendingReplyChange((prev) => {
          if (!(memberName in prev)) return prev;
          const next = { ...prev };
          delete next[memberName];
          return next;
        });
      }
      void refreshTeamMessagesHead(teamName);
    },
    [onPendingReplyChange, refreshTeamMessagesHead, teamName]
  );

  const loadingOlderMessages = messagesLoadingOlder;
  const hasMore = messagesHasMore;
  const effectiveMessages = messages;
  const loadingInitialMessages =
    effectiveMessages.length === 0 && (!messagesEntryPresent || messagesLoadingHead);

  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const floatingComposerMeasureRef = useRef<HTMLDivElement | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const [threadScrollElement, setThreadScrollElement] = useState<HTMLDivElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const bottomSheetRef = useRef<SheetRef>(null);
  const bottomSheetScrollRef = useRef<HTMLDivElement | null>(null);
  const [bottomSheetScrollElement, setBottomSheetScrollElement] = useState<HTMLDivElement | null>(
    null
  );
  const setThreadScrollNode = useCallback((node: HTMLDivElement | null) => {
    threadScrollRef.current = node;
    setThreadScrollElement(node);
  }, []);
  const setBottomSheetScrollNode = useCallback((node: HTMLDivElement | null) => {
    bottomSheetScrollRef.current = node;
    setBottomSheetScrollElement(node);
  }, []);
  // ActivityTimeline observes and virtualizes against the active scroll owner.
  const activeScrollContainerRef =
    position === 'inline'
      ? (inlineScrollContainerRef ?? null)
      : position === 'sidebar'
        ? threadScrollRef
        : bottomSheetScrollRef;
  const activeScrollElement =
    position === 'inline'
      ? (inlineScrollContainerRef?.current ?? null)
      : position === 'sidebar'
        ? threadScrollElement
        : bottomSheetScrollElement;

  const activityTimelineViewport = useMemo<TimelineViewport | undefined>(() => {
    if (!activeScrollContainerRef) return undefined;
    return {
      scrollElementRef: activeScrollContainerRef,
      scrollElement: activeScrollElement,
      observerRoot: activeScrollContainerRef,
      scrollMargin: 0,
      virtualizationEnabled: true,
      virtualizationRowThreshold: position === 'sidebar' ? 48 : undefined,
    };
  }, [activeScrollContainerRef, activeScrollElement, position]);
  const handleExpandContent = useCallback(() => {
    // no-op: user is reading expanded content, not composing
  }, []);

  const initialSidebarStateRef = useRef(getTeamMessagesSidebarUiState(teamName));
  const [messagesSearchQuery, setMessagesSearchQuery] = useState(
    initialSidebarStateRef.current.messagesSearchQuery
  );
  const [messagesFilter, setMessagesFilter] = useState<MessagesFilterState>(
    initialSidebarStateRef.current.messagesFilter
  );
  const [messagesFilterOpen, setMessagesFilterOpen] = useState(
    initialSidebarStateRef.current.messagesFilterOpen
  );
  const [messagesCollapsed, setMessagesCollapsed] = useState(
    initialSidebarStateRef.current.messagesCollapsed
  );
  const [messagesSearchBarVisible, setMessagesSearchBarVisible] = useState(
    initialSidebarStateRef.current.messagesSearchBarVisible
  );
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(
    initialSidebarStateRef.current.expandedItemKey
  );
  const [messagesScrollTop, setMessagesScrollTop] = useState(
    initialSidebarStateRef.current.messagesScrollTop
  );
  const [listScrollTop, setListScrollTop] = useState(initialSidebarStateRef.current.listScrollTop);
  const messagesScrollTopRef = useRef(initialSidebarStateRef.current.messagesScrollTop);
  const messagesScrollPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesScrollPersistTeamRef = useRef(teamName);
  const conversationHandleRef = useRef<ConversationViewportHandle | null>(null);
  const [latestAvailable, setLatestAvailable] = useState(false);
  const isConversation = position === 'sidebar' || position === 'bottom-sheet';
  const [bottomSheetSnapIndex, setBottomSheetSnapIndex] = useState(
    initialSidebarStateRef.current.bottomSheetSnapIndex
  );
  const [sidebarThreadTarget, setSidebarThreadTarget] = useState<HTMLDivElement | null>(null);
  const [sortChatsByActivity, setSortChatsByActivity] = useState(
    () => initialSidebarStateRef.current.sortChatsByActivity === true
  );
  const [composerDestination, setComposerDestination] =
    useState<ComposerDraftDestination | null>(null);
  const revisionNavigationGenerationRef = useRef(0);
  const revisionPreparationRef = useRef<MessageRevisionTargetController | null>(null);
  const handleRevisionPreparationChange = useCallback(
    (controller: MessageRevisionTargetController | null) => {
      revisionPreparationRef.current = controller;
    },
    []
  );
  const conversation = useTeamConversationSurface({
    teamName,
    members,
    position,
    onScopeChange: () => setMessagesSearchQuery(''),
  });
  const { renderSurface, navigationSurface, scope, openChat, backToList, threadOpenedAt } =
    conversation;
  const {
    footerHeight: bottomSheetStickyTopHeight,
    footerRef: bottomSheetStickyTopRef,
    headerHeight: bottomSheetHeaderHeight,
    headerRef: bottomSheetHeaderRef,
    mountHeight: bottomSheetMountHeight,
    searchRef: bottomSheetSearchRef,
  } = useBottomSheetLayout({
    active: position === 'bottom-sheet',
    fallbackHeaderHeight: BOTTOM_SHEET_HEADER_HEIGHT,
    mountPoint,
    refreshKey: `${messagesSearchBarVisible}:${renderSurface}:${bottomSheetSnapIndex}`,
  });
  const scopeKey = conversationScopeKey(scope);
  const expanded = position === 'sidebar' && expandedChatHost?.expanded === true;
  const showChatList = navigationSurface === 'list' || expanded;
  const conversationIdentity = JSON.stringify([
    teamName,
    scopeKey,
    threadOpenedAt,
    messagesSearchQuery.trim().toLowerCase(),
    [...messagesFilter.from].sort(),
    [...messagesFilter.to].sort(),
    messagesFilter.showNoise,
    timeWindow,
  ]);
  const handleOpenChat = useCallback(
    (nextScope: typeof scope): void => {
      if (
        navigationSurface === 'thread' &&
        conversationScopeKey(nextScope) === conversationScopeKey(scope)
      ) {
        return;
      }
      revisionNavigationGenerationRef.current += 1;
      openChat(nextScope);
    },
    [navigationSurface, openChat, scope]
  );

  const handleExpandedChange = useCallback(
    (nextExpanded: boolean): void => {
      if (!expandedChatHost || nextExpanded === expandedChatHost.expanded) return;
      if (nextExpanded && !expandedChatHost.available) return;
      if (navigationSurface === 'thread') {
        conversationHandleRef.current?.prepareLayoutChange();
      }
      if (nextExpanded && navigationSurface === 'list') {
        revisionNavigationGenerationRef.current += 1;
        openChat(TEAM_FEED_SCOPE);
      }
      expandedChatHost.onExpandedChange(nextExpanded);
    },
    [expandedChatHost, navigationSurface, openChat]
  );

  useLayoutEffect(() => {
    if (expanded && navigationSurface === 'list') {
      expandedChatHost?.onExpandedChange(false);
    }
  }, [expanded, expandedChatHost, navigationSurface]);

  useEffect(() => {
    initialSidebarStateRef.current = getTeamMessagesSidebarUiState(teamName);
    setMessagesSearchQuery(initialSidebarStateRef.current.messagesSearchQuery);
    setMessagesFilter(initialSidebarStateRef.current.messagesFilter);
    setMessagesFilterOpen(initialSidebarStateRef.current.messagesFilterOpen);
    setMessagesCollapsed(initialSidebarStateRef.current.messagesCollapsed);
    setMessagesSearchBarVisible(initialSidebarStateRef.current.messagesSearchBarVisible);
    setExpandedItemKey(initialSidebarStateRef.current.expandedItemKey);
    messagesScrollTopRef.current = initialSidebarStateRef.current.messagesScrollTop;
    messagesScrollPersistTeamRef.current = teamName;
    setMessagesScrollTop(initialSidebarStateRef.current.messagesScrollTop);
    setListScrollTop(initialSidebarStateRef.current.listScrollTop);
    setBottomSheetSnapIndex(initialSidebarStateRef.current.bottomSheetSnapIndex);
    setSortChatsByActivity(initialSidebarStateRef.current.sortChatsByActivity === true);
  }, [teamName]);

  useEffect(() => {
    const persistTeamName = teamName;
    return () => {
      if (!messagesScrollPersistTimerRef.current) {
        return;
      }
      clearTimeout(messagesScrollPersistTimerRef.current);
      messagesScrollPersistTimerRef.current = null;
      const pendingScrollTop = messagesScrollTopRef.current;
      const persisted = getTeamMessagesSidebarUiState(persistTeamName);
      if (Math.abs(persisted.messagesScrollTop - pendingScrollTop) >= 1) {
        setTeamMessagesSidebarUiState(persistTeamName, {
          ...persisted,
          messagesScrollTop: pendingScrollTop,
        });
      }
    };
  }, [teamName]);

  const persistMessagesScrollTop = useCallback((nextScrollTop: number): void => {
    messagesScrollTopRef.current = nextScrollTop;
    const scheduledTeamName = messagesScrollPersistTeamRef.current;
    if (messagesScrollPersistTimerRef.current) {
      clearTimeout(messagesScrollPersistTimerRef.current);
    }
    messagesScrollPersistTimerRef.current = setTimeout(() => {
      messagesScrollPersistTimerRef.current = null;
      if (messagesScrollPersistTeamRef.current !== scheduledTeamName) {
        return;
      }
      setMessagesScrollTop((current) =>
        Math.abs(current - messagesScrollTopRef.current) < 1
          ? current
          : messagesScrollTopRef.current
      );
    }, MESSAGES_SCROLL_TOP_PERSIST_DELAY_MS);
  }, []);

  useEffect(() => {
    if (isConversation && messagesScrollPersistTimerRef.current) {
      clearTimeout(messagesScrollPersistTimerRef.current);
      messagesScrollPersistTimerRef.current = null;
    }
  }, [isConversation]);

  const handleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    setListScrollTop(event.currentTarget.scrollTop);
  }, []);

  useEffect(() => {
    setTeamMessagesSidebarUiState(teamName, {
      messagesSearchQuery,
      messagesFilter,
      messagesFilterOpen,
      messagesCollapsed,
      messagesSearchBarVisible,
      expandedItemKey,
      messagesScrollTop,
      listScrollTop,
      bottomSheetSnapIndex,
      conversationSurface: navigationSurface,
      conversationScope: scope,
      sortChatsByActivity,
    });
  }, [
    teamName,
    messagesSearchQuery,
    messagesFilter,
    messagesFilterOpen,
    messagesCollapsed,
    messagesSearchBarVisible,
    expandedItemKey,
    messagesScrollTop,
    listScrollTop,
    bottomSheetSnapIndex,
    navigationSurface,
    scope,
    sortChatsByActivity,
  ]);

  useEffect(() => {
    const hasActiveParticipantFilter = messagesFilter.from.size > 0 || messagesFilter.to.size > 0;
    if (
      messagesSearchBarVisible ||
      (messagesSearchQuery.trim().length === 0 && !hasActiveParticipantFilter)
    ) {
      return;
    }
    setMessagesSearchBarVisible(true);
  }, [messagesFilter.from, messagesFilter.to, messagesSearchBarVisible, messagesSearchQuery]);

  useEffect(() => {
    if (!teamName) {
      return;
    }
    if (effectiveMessages.length > 0) {
      bootstrapHeadRefreshAttemptedForTeamRef.current = null;
      return;
    }
    if (messagesLoadingHead || messagesLoadingOlder) {
      return;
    }
    if (bootstrapHeadRefreshAttemptedForTeamRef.current === teamName) {
      return;
    }
    bootstrapHeadRefreshAttemptedForTeamRef.current = teamName;
    void refreshTeamMessagesHead(teamName).catch(() => undefined);
  }, [
    effectiveMessages.length,
    messagesLoadingHead,
    messagesLoadingOlder,
    refreshTeamMessagesHead,
    teamName,
  ]);

  useLayoutEffect(() => {
    if (position !== 'sidebar' || !showChatList) return;
    const el = listScrollRef.current;
    if (!el) return;
    el.scrollTop = Math.min(listScrollTop, Math.max(0, el.scrollHeight - el.clientHeight));
  }, [listScrollTop, position, showChatList]);
  useResetScrollOnConversationChange({
    enabled: !isConversation,
    teamName,
    scopeKey,
    navigationSurface,
    persistScrollTop: persistMessagesScrollTop,
    scrollElementRef: activeScrollContainerRef ?? threadScrollRef,
  });

  const leadNames = useMemo(
    () => members.filter((member) => isLeadMember(member)).map((member) => member.name),
    [members]
  );
  const memberNames = useMemo(() => new Set(members.map((member) => member.name)), [members]);
  const handleReplyToTimelineMessage = useCallback(
    (message: InboxMessage) => {
      onReplyToMessage?.(
        message,
        resolveReplyRecipient({ message, scope, teamName, members })
      );
    },
    [members, onReplyToMessage, scope, teamName]
  );
  const canonicalMessages = useMemo(() => {
    return filterTeamMessages(effectiveMessages, {
      leadNames,
      timeWindow,
      filter: { from: new Set(), to: new Set(), showNoise: false },
      searchQuery: '',
    });
  }, [effectiveMessages, leadNames, timeWindow]);

  const filteredMessages = useMemo(() => {
    return filterTeamMessages(effectiveMessages, {
      leadNames,
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
  }, [effectiveMessages, leadNames, messagesFilter, messagesSearchQuery, timeWindow]);

  const threadMessages = useMemo(
    () => filterScopedMessages(filteredMessages, scope, leadNames),
    [filteredMessages, leadNames, scope]
  );
  const threadCanonicalMessages = useMemo(
    () => filterScopedMessages(canonicalMessages, scope, leadNames),
    [canonicalMessages, leadNames, scope]
  );
  const visibleConversationAddress = useMemo<ComposerDraftAddress>(
    () => ({
      contextId: activeContextId,
      teamName,
      target:
        scope.kind === 'direct'
          ? { kind: 'direct', participant: scope.participant }
          : { kind: 'team-feed' },
    }),
    [activeContextId, scope, teamName]
  );
  const hasConversationSurface = useCallback(
    (address: ComposerDraftAddress) =>
      address.target.kind === 'team-feed' ||
      (address.target.kind === 'direct' && memberNames.has(address.target.participant)),
    [memberNames]
  );
  const composerOutbox = useComposerOutboxItems({
    contextId: activeContextId,
    teamName,
    viewAddress: visibleConversationAddress,
    destination: composerDestination,
    canonicalMessages: threadCanonicalMessages,
    canOpenAddress: hasConversationSurface,
  });

  const activityTimelineMessages = useMemo(() => {
    const unscoped = filterTeamMessages(effectiveMessages, {
      includeAutomationEvents: true,
      leadNames,
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
    return renderSurface === 'thread' ? filterScopedMessages(unscoped, scope, leadNames) : unscoped;
  }, [
    effectiveMessages,
    leadNames,
    messagesFilter,
    messagesSearchQuery,
    renderSurface,
    scope,
    timeWindow,
  ]);
  const firstTimelineMessage = activityTimelineMessages[0];
  const hasVisibleCurrentLeadThought =
    firstTimelineMessage != null &&
    isLeadThought(firstTimelineMessage) &&
    (currentLeadSessionId ? firstTimelineMessage.leadSessionId === currentLeadSessionId : true);
  const timelineLeadActivity = hasVisibleCurrentLeadThought ? leadActivity : undefined;
  const timelineLeadContextUpdatedAt = hasVisibleCurrentLeadThought
    ? leadContextUpdatedAt
    : undefined;

  const hasTrackedPendingReplies = useMemo(
    () => Object.keys(pendingRepliesByMember).length > 0,
    [pendingRepliesByMember]
  );
  const replyCandidateMessages = useMemo(
    () =>
      hasTrackedPendingReplies
        ? effectiveMessages.filter(
            (m) =>
              m.messageKind !== 'task_comment_notification' &&
              !isTaskStallRemediationMessage(m) &&
              !isMemberWorkSyncNudgeMessage(m) &&
              !isReviewPickupEscalationMessage(m) &&
              !shouldExcludeInboxTextFromReplyCandidates(typeof m.text === 'string' ? m.text : '')
          )
        : EMPTY_REPLY_CANDIDATE_MESSAGES,
    [effectiveMessages, hasTrackedPendingReplies]
  );
  const sendMessageRuntimeReplyVisible = useMemo(
    () => hasVisibleReplyForSendMessageDiagnostics(sendMessageDebugDetails, effectiveMessages),
    [effectiveMessages, sendMessageDebugDetails]
  );
  const effectiveSendMessageWarning = sendMessageRuntimeReplyVisible ? null : sendMessageWarning;
  const effectiveSendMessageDebugDetails = sendMessageRuntimeReplyVisible
    ? null
    : sendMessageDebugDetails;
  const latestRevisableMessage = useMemo(
    () => findLatestRevisableUserSentMessage(effectiveMessages, memberNames),
    [effectiveMessages, memberNames]
  );
  const revisionMessageId = trimString(latestRevisableMessage?.messageId) || null;
  const {
    revisionRequest,
    revisionPreparation,
    handleReviseMessage,
    cancelRevision: handleRevisionCancel,
    completeRevision: handleRevisionComplete,
    invalidatePendingRevisionIntent,
  } = useMessageRevisionIntent({
    teamName,
    conversationKey: scopeKey,
    directRecipient: scope.kind === 'direct' ? scope.participant : undefined,
    revisionMessageId,
    memberNames,
    sendRevisionNotice: sendTeamMessage,
    navigationGenerationRef: revisionNavigationGenerationRef,
    prepareRevisionTarget: (recipient, signal) =>
      revisionPreparationRef.current?.prepare(recipient, signal) ?? Promise.resolve(null),
    isRevisionTargetCurrent: (target) =>
      revisionPreparationRef.current?.isCurrent(target) === true,
    focusComposer: () => composerTextareaRef.current?.focus(),
  });

  const handleBackToList = useCallback(() => {
    revisionNavigationGenerationRef.current += 1;
    handleRevisionCancel();
    backToList();
  }, [backToList, handleRevisionCancel]);

  // Resolve the expanded item from filtered messages
  const expandedItem = useMemo<TimelineItem | null>(() => {
    if (!expandedItemKey) {
      return null;
    }
    if (!expandedItemKey.startsWith('thoughts-')) {
      const msg = activityTimelineMessages.find((m) => toMessageKey(m) === expandedItemKey);
      return msg ? { type: 'message', message: msg } : null;
    }
    const allItems = groupTimelineItems(activityTimelineMessages);
    return (
      allItems.find(
        (item) =>
          item.type === 'lead-thoughts' && getThoughtGroupKey(item.group) === expandedItemKey
      ) ?? null
    );
  }, [expandedItemKey, activityTimelineMessages]);

  // Auto-clear stale expanded key
  useEffect(() => {
    if (expandedItemKey && expandedItem === null) {
      setExpandedItemKey(null);
    }
  }, [expandedItemKey, expandedItem]);

  const handleExpandItem = useCallback((key: string) => {
    setExpandedItemKey(key);
  }, []);

  const handleExpandDialogChange = useCallback((open: boolean) => {
    if (!open) setExpandedItemKey(null);
  }, []);

  const { readSet, markAllRead } = useTeamMessagesRead(teamName, canonicalMessages, !hasMore);
  const { expandedSet, toggle: toggleExpandOverride } = useTeamMessagesExpanded(teamName);
  const pendingVisibleReadKeysRef = useRef<Set<string>>(new Set());
  const visibleReadFlushFrameRef = useRef<number | null>(null);

  const listUnread = useMemo(
    () =>
      scopedUnreadCounts(
        canonicalMessages,
        { kind: 'team-feed' },
        readSet,
        toMessageKey,
        leadNames
      ),
    [canonicalMessages, leadNames, readSet]
  );
  const threadUnread = useMemo(
    () => scopedUnreadCounts(canonicalMessages, scope, readSet, toMessageKey, leadNames),
    [canonicalMessages, leadNames, readSet, scope]
  );
  const messagesUnreadCount = showChatList ? listUnread.unreadCount : threadUnread.unreadCount;
  const messagesAttentionCount = showChatList
    ? listUnread.attentionCount
    : threadUnread.attentionCount;

  const flushVisibleReadKeys = useCallback(() => {
    visibleReadFlushFrameRef.current = null;
    const keys = [...pendingVisibleReadKeysRef.current];
    pendingVisibleReadKeysRef.current.clear();
    markAllRead(keys);
  }, [markAllRead]);

  const handleMessageVisible = useCallback(
    (message: InboxMessage) => {
      pendingVisibleReadKeysRef.current.add(toMessageKey(message));
      if (visibleReadFlushFrameRef.current !== null) return;
      visibleReadFlushFrameRef.current = window.requestAnimationFrame(flushVisibleReadKeys);
    },
    [flushVisibleReadKeys]
  );

  useEffect(() => {
    const pendingVisibleReadKeys = pendingVisibleReadKeysRef.current;
    return () => {
      if (visibleReadFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(visibleReadFlushFrameRef.current);
        visibleReadFlushFrameRef.current = null;
      }
      pendingVisibleReadKeys.clear();
    };
  }, [teamName]);

  const readState = useMemo(() => ({ readSet, getMessageKey: toMessageKey }), [readSet]);

  const { teamNames, teamColorByName } = teamMentionMeta;

  const workingDrafts = useComposerWorkingSummaries(activeContextId, teamName);
  const localDraftsByScope = useMemo(() => {
    const drafts = new Map<
      string,
      {
        preview: string;
        updatedAt: number;
        attachmentCount: number;
        chipCount: number;
        editorKind: 'plain' | 'revision';
      }
    >();
    for (const summary of workingDrafts.summaries) {
      const target = summary.address.target;
      if (target.kind === 'cross-team') continue;
      const draft = {
        preview: summary.preview,
        updatedAt: summary.updatedAt,
        attachmentCount: summary.attachmentCount,
        chipCount: summary.chipCount,
        editorKind: summary.editorKind,
      };
      drafts.set(
        conversationScopeKey(
          target.kind === 'team-feed' ? TEAM_FEED_SCOPE : createDirectScope(target.participant)
        ),
        draft
      );
    }
    return drafts;
  }, [workingDrafts.summaries]);

  const chatListItems = useTeamChatListItems({
    members,
    messages: canonicalMessages,
    readSet,
    teamFeedLabel: t('messages.chats.teamFeed'),
    emptyPreview: t('messages.chats.emptyPreview'),
    leadNames,
    sortByActivity: sortChatsByActivity,
    draftsByScope: localDraftsByScope,
    enabled: showChatList,
  });
  useDirectThreadAutoOlder({
    renderSurface,
    scope,
    threadOpenedAt,
    scopedCount: threadMessages.length,
    hasMore,
    loadingOlder: loadingOlderMessages,
    loadOlder: loadOlderMessages,
  });
  const { snapshot: unreadSnapshot, dismissUnreadKeys } = useThreadUnreadSnapshot({
    renderSurface,
    scope,
    threadOpenedAt,
    messages: threadCanonicalMessages,
    readSet,
  });
  const { lockedRecipient, conversationTitle } = conversationChrome(renderSurface, scope, members, {
    list: t('messages.title'),
    teamFeed: t('messages.chats.teamFeed'),
  });

  const handleMarkAllRead = useCallback(() => {
    const keys = scopedUnreadKeys(threadCanonicalMessages, readSet, toMessageKey);
    markAllRead(keys);
    dismissUnreadKeys(keys);
  }, [dismissUnreadKeys, markAllRead, readSet, threadCanonicalMessages]);

  // Auto-clear pending replies when a member actually responds
  useEffect(() => {
    if (!hasTrackedPendingReplies) return;
    const next = reconcilePendingRepliesByMember(pendingRepliesByMember, replyCandidateMessages);
    if (next !== pendingRepliesByMember) onPendingReplyChange(() => next);
  }, [
    hasTrackedPendingReplies,
    onPendingReplyChange,
    pendingRepliesByMember,
    replyCandidateMessages,
  ]);

  useEffect(() => {
    if (!sendMessageRuntimeReplyVisible || !sendMessageDebugDetails?.messageId) return;
    clearSendMessageRuntimeDiagnostics(sendMessageDebugDetails.messageId);
  }, [
    clearSendMessageRuntimeDiagnostics,
    sendMessageDebugDetails?.messageId,
    sendMessageRuntimeReplyVisible,
  ]);

  useEffect(() => {
    const debugDetails = sendMessageDebugDetails;
    const messageId = debugDetails?.messageId;
    const shouldPoll =
      debugDetails?.userVisibleState === 'checking' ||
      (!debugDetails?.userVisibleState && debugDetails?.responsePending === true);
    if (!messageId || sendMessageRuntimeReplyVisible || !shouldPoll) {
      return;
    }
    const statusMessageId = debugDetails.statusMessageId || messageId;
    const timers = OPENCODE_RUNTIME_DELIVERY_STATUS_REFRESH_DELAYS_MS.map((delayMs) =>
      window.setTimeout(() => {
        void refreshSendMessageRuntimeDeliveryStatus(teamName, {
          messageId,
          statusMessageId,
        });
      }, delayMs)
    );
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    refreshSendMessageRuntimeDeliveryStatus,
    sendMessageDebugDetails,
    sendMessageRuntimeReplyVisible,
    teamName,
  ]);

  const { handleSend, handleCrossTeamSend } = useMessagesPanelSend({
    teamName,
    sendTeamMessage,
    sendCrossTeamMessage,
    onPendingReplyChange,
  });

  const moveToInline = useCallback(() => {
    expandedChatHost?.onExpandedChange(false);
    onPositionChange('inline');
  }, [expandedChatHost, onPositionChange]);

  const moveToSidebar = useCallback(() => {
    onPositionChange('sidebar');
  }, [onPositionChange]);

  const moveToBottomSheet = useCallback(() => {
    expandedChatHost?.onExpandedChange(false);
    setBottomSheetSnapIndex(BOTTOM_SHEET_COMPOSER_SNAP_INDEX);
    onPositionChange('bottom-sheet');
  }, [expandedChatHost, onPositionChange]);

  const moveToFloatingComposer = useCallback(() => {
    expandedChatHost?.onExpandedChange(false);
    onPositionChange('floating-composer');
  }, [expandedChatHost, onPositionChange]);

  useLayoutEffect(() => {
    if (position !== 'floating-composer' || !onFloatingComposerHeightChange) return undefined;

    const node = floatingComposerMeasureRef.current;
    if (!node) {
      onFloatingComposerHeightChange(0);
      return undefined;
    }

    const updateHeight = (): void => {
      onFloatingComposerHeightChange(Math.ceil(node.getBoundingClientRect().height));
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);

    return () => {
      observer.disconnect();
      onFloatingComposerHeightChange(0);
    };
  }, [onFloatingComposerHeightChange, position]);

  const snapBottomSheetTo = useCallback((snapIndex: number) => {
    setBottomSheetSnapIndex(snapIndex);
    bottomSheetRef.current?.snapTo(snapIndex);
  }, []);

  const toggleBottomSheetExpansion = useCallback(() => {
    if (bottomSheetSnapIndex === BOTTOM_SHEET_COLLAPSED_SNAP_INDEX) {
      snapBottomSheetTo(BOTTOM_SHEET_COMPOSER_SNAP_INDEX);
      return;
    }
    snapBottomSheetTo(BOTTOM_SHEET_COLLAPSED_SNAP_INDEX);
  }, [bottomSheetSnapIndex, snapBottomSheetTo]);

  const {
    contentHeight: bottomSheetContentHeight,
    normalizedSnapIndex: normalizedBottomSheetSnapIndex,
    snapPoints: bottomSheetSnapPoints,
  } = useMemo(
    () =>
      calculateBottomSheetGeometry({
        footerHeight: bottomSheetStickyTopHeight,
        headerHeight: bottomSheetHeaderHeight,
        mountHeight: bottomSheetMountHeight,
        snapIndex: bottomSheetSnapIndex,
      }),
    [
      bottomSheetHeaderHeight,
      bottomSheetMountHeight,
      bottomSheetSnapIndex,
      bottomSheetStickyTopHeight,
    ]
  );

  const sharedComposerProps = {
    teamName,
    members,
    isTeamAlive,
    sending: sendingMessage,
    sendError: sendMessageError,
    sendWarning: effectiveSendMessageWarning,
    sendDebugDetails: effectiveSendMessageDebugDetails,
    lastResult: lastSendMessageResult,
    revisionRequest,
    revisionPreparation,
    revisableMessageId: revisionMessageId,
    textareaRef: composerTextareaRef,
    suggestionPlacement: isConversation ? ('above' as const) : undefined,
    lockedRecipient,
    autoFocusKey: threadOpenedAt,
    workingDraftSummaries: workingDrafts.summaries,
    onSend: handleSend,
    onCrossTeamSend: handleCrossTeamSend,
    onSubmitIntent: () => conversationHandleRef.current?.preservePositionOnSubmit(),
    onDraftMutation: invalidatePendingRevisionIntent,
    onRecoveryDestinationChange: setComposerDestination,
    onRevisionPreparationChange: handleRevisionPreparationChange,
    onRevisionCancel: handleRevisionCancel,
    onRevisionComplete: handleRevisionComplete,
  };

  const renderDefaultComposerSection = (): React.JSX.Element => (
    <ThreadAwareMessageComposer {...sharedComposerProps} />
  );

  const renderFloatingComposerModeControls = (): React.JSX.Element => (
    <div className="inline-flex items-center pr-1">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] data-[state=open]:bg-[var(--color-surface-raised)] data-[state=open]:text-[var(--color-text-secondary)]"
                aria-label={t('messages.panelMode')}
              >
                <MoreHorizontal size={14} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{t('messages.panelMode')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" side="top" className="w-48">
          <MessagesLayoutMenuItems
            variant="floating-composer"
            sortChatsByActivity={sortChatsByActivity}
            onSortChatsByActivityChange={setSortChatsByActivity}
            onMoveToInline={moveToInline}
            onMoveToBottomSheet={moveToBottomSheet}
            onMoveToSidebar={moveToSidebar}
            onMoveToFloatingComposer={moveToFloatingComposer}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const renderCompactComposerSection = (): React.JSX.Element => (
    <ThreadAwareMessageComposer layout="compact" {...sharedComposerProps} />
  );

  const renderFloatingComposerSection = (): React.JSX.Element => (
    <MessagesComposerSection
      {...sharedComposerProps}
      layout="compact"
      widthMode="floating-adaptive"
      cornerActionPrefix={
        <div className="flex items-center gap-1">
          {renderFloatingComposerModeControls()}
        </div>
      }
    />
  );

  const renderInlineStatusSection = (): React.JSX.Element => (
    <MessagesStatusSection
      members={members}
      tasks={tasks}
      messages={effectiveMessages}
      isTeamAlive={isTeamAlive}
      pendingRepliesByMember={pendingRepliesByMember}
      teamName={teamName}
      onQueuedDiscarded={handleQueuedDiscarded}
      layout="flow"
      position="inline"
      onMemberClick={onMemberClick}
      onTaskClick={onTaskClick}
    />
  );

  const renderSidebarStatusSection = (): React.JSX.Element => (
    <MessagesStatusSection
      members={members}
      tasks={tasks}
      messages={effectiveMessages}
      isTeamAlive={isTeamAlive}
      pendingRepliesByMember={pendingRepliesByMember}
      teamName={teamName}
      onQueuedDiscarded={handleQueuedDiscarded}
      layout="flow"
      position="sidebar"
      onMemberClick={onMemberClick}
      onTaskClick={onTaskClick}
    />
  );

  const renderComposerStatusSection = (): React.JSX.Element => (
    <MessagesStatusSection
      members={members}
      tasks={tasks}
      messages={effectiveMessages}
      isTeamAlive={isTeamAlive}
      pendingRepliesByMember={pendingRepliesByMember}
      teamName={teamName}
      onQueuedDiscarded={handleQueuedDiscarded}
      placement="composer"
      position="sidebar"
      onMemberClick={onMemberClick}
      onTaskClick={onTaskClick}
    />
  );

  const useWideChat = position === 'bottom-sheet' || (position === 'sidebar' && expanded);
  const renderTimelineSection = (): React.JSX.Element => (
    <>
      {composerOutbox.readError ? (
        <p role="status" className="px-3 py-1 text-[10px] text-amber-400">
          {t('messages.outbox.storageWarning')}
        </p>
      ) : null}
      <MessagesTimelineSection
        messages={activityTimelineMessages}
        loading={loadingInitialMessages}
        teamName={teamName}
        members={members}
        readState={readState}
        allCollapsed={useWideChat ? false : messagesCollapsed}
        expandOverrides={expandedSet}
        onToggleExpandOverride={toggleExpandOverride}
        currentLeadSessionId={currentLeadSessionId}
        isTeamAlive={isTeamAlive}
        leadActivity={timelineLeadActivity}
        leadContextUpdatedAt={timelineLeadContextUpdatedAt}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
        onTeamClick={openTeamTab}
        onMemberClick={onMemberClick}
        onCreateTaskFromMessage={onCreateTaskFromMessage}
        onReplyToMessage={handleReplyToTimelineMessage}
        revisionMessageId={revisionMessageId}
        onReviseMessage={handleReviseMessage}
        onMessageVisible={handleMessageVisible}
        presentation={isConversation ? 'conversation' : 'activity'}
        appearance={useWideChat ? 'wide-chat' : 'compact'}
        observationEnabled={!isConversation || isActive}
        conversationIdentity={conversationIdentity}
        conversationHandleRef={conversationHandleRef}
        onLatestAvailable={setLatestAvailable}
        directParticipant={scope.kind === 'direct' ? scope.participant : undefined}
        unreadSnapshot={unreadSnapshot}
        emptyLabel={t('messages.chats.emptyThread')}
        onRestartTeam={onRestartTeam}
        onTaskIdClick={onTaskIdClick}
        onExpandItem={handleExpandItem}
        onExpandContent={handleExpandContent}
        viewport={activityTimelineViewport}
        composerOutboxItems={composerOutbox.items}
        onComposerOutboxCopy={composerOutbox.copy}
        onComposerOutboxRestore={composerOutbox.restore}
        onComposerOutboxDiscard={composerOutbox.discard}
        hasMore={hasMore}
        loadingOlderMessages={loadingOlderMessages}
        onLoadOlderMessages={handleLoadOlderMessagesClick}
        expandedItem={expandedItem}
        expandedItemKey={expandedItemKey}
        onExpandDialogChange={handleExpandDialogChange}
      />
    </>
  );
  const searchControlProps = {
    teamName,
    members,
    messages: effectiveMessages,
    searchQuery: messagesSearchQuery,
    onSearchQueryChange: setMessagesSearchQuery,
    filter: messagesFilter,
    filterOpen: messagesFilterOpen,
    onFilterOpenChange: setMessagesFilterOpen,
    onFilterApply: setMessagesFilter,
    searchPlaceholder: t('messages.search.placeholder'),
  };

  const renderSearchAndFilterControls = (): React.JSX.Element => (
    <MessagesSearchControls {...searchControlProps} />
  );

  const renderSearchAndFilterBar = (): React.JSX.Element => (
    <MessagesSearchBar
      {...searchControlProps}
      collapsed={messagesCollapsed}
      onToggleCollapsed={() => setMessagesCollapsed((value) => !value)}
      expandLabel={t('messages.actions.expandAll')}
      collapseLabel={t('messages.actions.collapseAll')}
    />
  );

  const fullScreenControl = (
    <FullScreenControl
      label={t('messages.fullScreen.label')}
      unavailableLabel={t('messages.fullScreen.teamOnly')}
      available={expandedChatHost?.available === true}
      expanded={expanded}
      restoreFocusAfterChange={navigationSurface !== 'list'}
      onExpandedChange={handleExpandedChange}
    />
  );

  const wideThreadHeader = (
    <WideThreadHeader
      title={lockedRecipient ?? conversationTitle}
      participant={scope.kind === 'direct' ? scope.participant : undefined}
      unreadCount={threadUnread.unreadCount}
      attentionCount={threadUnread.attentionCount}
      markAllReadLabel={t('messages.actions.markAllRead')}
      actionsLabel={t('messages.actions.messageActions')}
      collapsed={messagesCollapsed}
      searchVisible={messagesSearchBarVisible}
      onMarkAllRead={handleMarkAllRead}
      onToggleCollapsed={() => setMessagesCollapsed((value) => !value)}
      onToggleSearch={() => setMessagesSearchBarVisible((value) => !value)}
    />
  );

  const renderSharedThreadView = (variant: 'sidebar' | 'wide'): React.JSX.Element => (
    <MessagesThreadView
      variant={variant}
      header={variant === 'wide' && position !== 'bottom-sheet' ? wideThreadHeader : undefined}
      search={messagesSearchBarVisible ? renderSearchAndFilterControls() : undefined}
      composer={
        variant === 'wide' ? renderCompactComposerSection() : renderDefaultComposerSection()
      }
      status={
        expanded
          ? null
          : variant === 'wide'
            ? renderInlineStatusSection()
            : renderSidebarStatusSection()
      }
      composerStatus={expanded ? renderComposerStatusSection() : undefined}
      timeline={renderTimelineSection()}
      scrollRef={position === 'bottom-sheet' ? setBottomSheetScrollNode : setThreadScrollNode}
      composerRef={position === 'bottom-sheet' ? bottomSheetStickyTopRef : undefined}
      searchRef={bottomSheetSearchRef}
      latestControl={
        latestAvailable ? (
          <LatestMessageControl
            label={t('messages.actions.toLatest')}
            onReveal={() => conversationHandleRef.current?.revealLatest()}
          />
        ) : undefined
      }
    />
  );

  const renderMessagesContent = (): React.JSX.Element => (
    <div className="pb-14">
      {renderSurface === 'list' ? (
        <ChatList items={chatListItems} teamName={teamName} onOpen={handleOpenChat} />
      ) : (
        <>
          {renderDefaultComposerSection()}
          {renderInlineStatusSection()}
          {renderTimelineSection()}
        </>
      )}
    </div>
  );

  // ---- Sidebar mode ----
  if (position === 'sidebar') {
    return (
      <MessagesSidebarSurface
        conversationHeader={
          <ConversationHeader
            title={showChatList ? t('messages.title') : (lockedRecipient ?? conversationTitle)}
            unreadCount={messagesUnreadCount}
            attentionCount={messagesAttentionCount}
            onBack={!expanded && renderSurface === 'thread' ? handleBackToList : undefined}
          />
        }
        showMarkAllRead={!showChatList && messagesUnreadCount > 0}
        markAllReadLabel={t('messages.actions.markAllRead')}
        onMarkAllRead={handleMarkAllRead}
        fullScreenControl={fullScreenControl}
        showThreadUtilities={!showChatList}
        collapsed={messagesCollapsed}
        searchVisible={messagesSearchBarVisible}
        onToggleCollapsed={() => setMessagesCollapsed((value) => !value)}
        onToggleSearch={() => setMessagesSearchBarVisible((value) => !value)}
        showCollapse={!expanded}
        panelActionsLabel={t('messages.actions.panelActions')}
        messageActionsLabel={t('messages.actions.messageActions')}
        layoutMenu={
          <MessagesLayoutMenuItems
            variant="sidebar"
            showChatSort={showChatList}
            sortChatsByActivity={sortChatsByActivity}
            onSortChatsByActivityChange={setSortChatsByActivity}
            onMoveToInline={moveToInline}
            onMoveToBottomSheet={moveToBottomSheet}
            onMoveToSidebar={moveToSidebar}
            onMoveToFloatingComposer={moveToFloatingComposer}
          />
        }
        showChatList={showChatList}
        listScrollRef={listScrollRef}
        onListScroll={handleListScroll}
        chatList={
          <ChatList
            items={chatListItems}
            teamName={teamName}
            selectedScope={expanded ? scope : undefined}
            onOpen={handleOpenChat}
          />
        }
        threadSlotRef={setSidebarThreadTarget}
        thread={
          renderSurface === 'thread' ? (
            <MessagesThreadPlacement
              sidebarTarget={sidebarThreadTarget}
              expandedHost={expandedChatHost}
            >
              {renderSharedThreadView(expanded ? 'wide' : 'sidebar')}
            </MessagesThreadPlacement>
          ) : null
        }
      />
    );
  }

  if (position === 'floating-composer') {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 px-4 pb-5 sm:px-6 sm:pb-6">
        <div className="mx-auto flex w-full max-w-[500px] justify-center">
          <div ref={floatingComposerMeasureRef} className="pointer-events-auto">
            {renderFloatingComposerSection()}
          </div>
        </div>
      </div>
    );
  }

  if (position === 'bottom-sheet') {
    if (!mountPoint) {
      return <div className="hidden" aria-hidden="true" />;
    }

    const isBottomSheetCollapsed =
      normalizedBottomSheetSnapIndex === BOTTOM_SHEET_COLLAPSED_SNAP_INDEX;

    return (
      <Sheet
        ref={bottomSheetRef}
        isOpen
        onClose={moveToInline}
        mountPoint={mountPoint}
        avoidKeyboard={false}
        detent="full"
        snapPoints={bottomSheetSnapPoints}
        initialSnap={normalizedBottomSheetSnapIndex}
        onSnap={setBottomSheetSnapIndex}
        disableDismiss
        disableScrollLocking
        style={{ zIndex: 30 }}
        className="!pointer-events-none !absolute !inset-0"
        unstyled
      >
        <Sheet.Container
          unstyled
          className="flex max-h-full w-full flex-col overflow-hidden rounded-t-[20px] border border-[var(--color-border)] bg-[var(--color-surface-sidebar)] shadow-[0_-18px_48px_rgba(0,0,0,0.35)]"
        >
          <Sheet.Header
            ref={bottomSheetHeaderRef}
            unstyled
            className="shrink-0 cursor-grab select-none border-b border-[var(--color-border)] bg-[var(--color-surface-sidebar)] active:cursor-grabbing"
          >
            <div className="relative h-10 px-3">
              <div className="pointer-events-none absolute inset-x-0 top-1 flex justify-center">
                <Sheet.DragIndicator
                  className="!h-1 !w-9 cursor-grab !rounded-full active:cursor-grabbing"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--color-text-muted) 45%, transparent)',
                  }}
                />
              </div>
              <div className="flex h-full items-center gap-1.5">
                <ConversationHeader
                  title={lockedRecipient ?? conversationTitle}
                  unreadCount={messagesUnreadCount}
                  attentionCount={messagesAttentionCount}
                  onBack={renderSurface === 'thread' ? handleBackToList : undefined}
                />
                <div
                  className="ml-auto flex items-center gap-1"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] data-[state=open]:bg-[var(--color-surface-raised)] data-[state=open]:text-[var(--color-text-secondary)]"
                            aria-label={t('messages.actions.bottomSheetActions')}
                          >
                            <MoreHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {t('messages.actions.messageActions')}
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" side="top" className="w-48">
                      {renderSurface === 'thread' && messagesUnreadCount > 0 && (
                        <DropdownMenuItem
                          className="text-blue-400 focus:text-blue-300"
                          onSelect={handleMarkAllRead}
                        >
                          <CheckCheck size={14} className="shrink-0" />
                          <span>{t('messages.actions.markAllRead')}</span>
                        </DropdownMenuItem>
                      )}
                      {renderSurface === 'thread' ? (
                        <MessagesThreadUtilityMenuItems
                          collapsed={messagesCollapsed}
                          searchVisible={messagesSearchBarVisible}
                          onToggleCollapsed={() => setMessagesCollapsed((value) => !value)}
                          onToggleSearch={() => setMessagesSearchBarVisible((value) => !value)}
                          showCollapse={false}
                        />
                      ) : null}
                      <MessagesLayoutMenuItems
                        variant="bottom-sheet"
                        showChatSort={renderSurface === 'list'}
                        sortChatsByActivity={sortChatsByActivity}
                        onSortChatsByActivityChange={setSortChatsByActivity}
                        onMoveToInline={moveToInline}
                        onMoveToBottomSheet={moveToBottomSheet}
                        onMoveToSidebar={moveToSidebar}
                        onMoveToFloatingComposer={moveToFloatingComposer}
                        isBottomSheetCollapsed={isBottomSheetCollapsed}
                        onToggleBottomSheetExpansion={toggleBottomSheetExpansion}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </Sheet.Header>
          {!isBottomSheetCollapsed && (
            <Sheet.Content
              className="flex min-h-0 !shrink-0 !grow-0 overflow-hidden bg-[var(--color-surface-sidebar)]"
              scrollClassName="flex h-full min-h-0 flex-col overflow-hidden"
              style={{ height: bottomSheetContentHeight }}
              disableDrag
              disableScroll
            >
              {renderSurface === 'list' ? (
                <div className="h-full overflow-y-auto pt-2">
                  <ChatList items={chatListItems} teamName={teamName} onOpen={handleOpenChat} />
                </div>
              ) : (
                renderSharedThreadView('wide')
              )}
            </Sheet.Content>
          )}
        </Sheet.Container>
      </Sheet>
    );
  }

  // ---- Inline mode (wrapped in CollapsibleTeamSection) ----
  return (
    <CollapsibleTeamSection
      sectionId="messages"
      variant={sectionVariant}
      title={conversationTitle}
      icon={
        renderSurface === 'thread' ? (
          <MessagesInlineBackButton label={t('messages.chats.back')} onBack={handleBackToList} />
        ) : (
          <MessageSquare size={14} />
        )
      }
      badge={renderSurface === 'list' ? undefined : threadMessages.length}
      secondaryBadge={
        renderSurface === 'thread' && messagesUnreadCount > 0 ? messagesUnreadCount : undefined
      }
      afterBadge={
        renderSurface === 'list' ? (
          <ChatUnreadBadges
            unreadCount={messagesUnreadCount}
            attentionCount={messagesAttentionCount}
          />
        ) : messagesUnreadCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="pointer-events-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-blue-400 transition-colors hover:bg-blue-500/10"
                onClick={(e) => {
                  e.stopPropagation();
                  handleMarkAllRead();
                }}
              >
                <CheckCheck size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('messages.actions.markAllRead')}</TooltipContent>
          </Tooltip>
        ) : undefined
      }
      headerExtra={
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                onClick={(e) => {
                  e.stopPropagation();
                  moveToBottomSheet();
                }}
                aria-label={t('messages.actions.moveMessagesToBottomSheet')}
              >
                <PanelBottom size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('messages.actions.moveToBottomSheet')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                onClick={(e) => {
                  e.stopPropagation();
                  moveToFloatingComposer();
                }}
                aria-label={t('messages.actions.floatMessagesComposer')}
              >
                <Dock size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('messages.actions.floatComposer')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                onClick={(e) => {
                  e.stopPropagation();
                  moveToSidebar();
                }}
                aria-label={t('messages.actions.moveMessagesToSidebar')}
              >
                <PanelLeft size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('messages.actions.moveToSidebar')}</TooltipContent>
          </Tooltip>
        </div>
      }
      defaultOpen
      action={
        renderSurface === 'thread' ? (
          <div className="flex items-center gap-2 px-2">{renderSearchAndFilterBar()}</div>
        ) : undefined
      }
    >
      {renderMessagesContent()}
    </CollapsibleTeamSection>
  );
});
