import {
  type ComponentProps,
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
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useTeamMessagesExpanded } from '@renderer/hooks/useTeamMessagesExpanded';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { useStore } from '@renderer/store';
import { selectTeamMessages } from '@renderer/store/slices/teamSlice';
import { shouldClearPendingReplyForOpenCodeRuntimeDelivery } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
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
  ChevronsDownUp,
  ChevronsUpDown,
  Dock,
  MessageSquare,
  MoreHorizontal,
  PanelBottom,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeft,
  PanelLeftClose,
  Search,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ActivityTimeline, type TimelineViewport } from '../activity/ActivityTimeline';
import {
  getThoughtGroupKey,
  groupTimelineItems,
  isLeadThought,
} from '../activity/LeadThoughtsGroup';
import { MessageExpandDialog } from '../activity/MessageExpandDialog';
import { CollapsibleTeamSection } from '../CollapsibleTeamSection';
import {
  getTeamMessagesSidebarUiState,
  setTeamMessagesSidebarUiState,
} from '../sidebar/teamSidebarUiState';

import { MessageComposer, type MessageRevisionRequest } from './MessageComposer';
import { MessagesFilterPopover } from './MessagesFilterPopover';
import {
  buildRevisionNoticeText,
  findLatestRevisableUserSentMessage,
  getRevisableMessageText,
  hasVisibleReplyForSendMessageDiagnostics,
  isRevisableUserSentMessage,
  reconcilePendingRepliesByMember,
  REVISION_NOTICE_PREFIX,
  trimString,
} from './messagesPanelLogic';
import { StatusBlock } from './StatusBlock';

import type { TimelineItem } from '../activity/LeadThoughtsGroup';
import type { ActionMode } from './ActionModeSelector';
import type { MessagesFilterState } from './MessagesFilterPopover';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type {
  InboxMessage,
  ResolvedTeamMember,
  TaskRef,
  TeamSummary,
  TeamTaskWithKanban,
} from '@shared/types';

interface TimeWindow {
  start: number;
  end: number;
}

const BOTTOM_SHEET_HEADER_HEIGHT = 40;
const BOTTOM_SHEET_COLLAPSED_SNAP_INDEX = 1;
const BOTTOM_SHEET_COMPOSER_SNAP_INDEX = 2;
const BOTTOM_SHEET_FULL_SNAP_INDEX = 4;
const OPENCODE_RUNTIME_DELIVERY_STATUS_REFRESH_DELAYS_MS = [15_000, 45_000, 90_000] as const;
const MESSAGES_SCROLL_TOP_PERSIST_DELAY_MS = 100;
const EMPTY_TEAM_NAMES: string[] = [];
const EMPTY_TEAM_COLOR_MAP = new Map<string, string>();
const EMPTY_REPLY_CANDIDATE_MESSAGES: InboxMessage[] = [];

interface TeamMentionMeta {
  teamNames: string[];
  teamColorByName: ReadonlyMap<string, string>;
}

interface TeamMentionEntry {
  teamName: string;
  displayName: string;
  color: string;
  deletedAt: string;
}

let cachedTeamMentionSignature = '';
let cachedTeamMentionSource: readonly TeamSummary[] | null = null;
let cachedTeamMentionMeta: TeamMentionMeta = {
  teamNames: EMPTY_TEAM_NAMES,
  teamColorByName: EMPTY_TEAM_COLOR_MAP,
};

function encodeTeamMentionParts(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function compareTeamMentionEntries(a: TeamMentionEntry, b: TeamMentionEntry): number {
  return (
    a.teamName.localeCompare(b.teamName, undefined, { sensitivity: 'base' }) ||
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
  );
}

function getTeamMentionSignature(teams: readonly TeamSummary[]): string {
  return encodeTeamMentionParts(
    teams.flatMap((team) => [
      team.teamName ?? '',
      team.displayName ?? '',
      team.color ?? '',
      team.deletedAt ?? '',
    ])
  );
}

function selectMessagesPanelTeamMentionMeta(teams: readonly TeamSummary[]): TeamMentionMeta {
  if (teams === cachedTeamMentionSource) {
    return cachedTeamMentionMeta;
  }

  const signature = getTeamMentionSignature(teams);
  if (signature === cachedTeamMentionSignature) {
    cachedTeamMentionSource = teams;
    return cachedTeamMentionMeta;
  }

  const entries = teams
    .map((team) => ({
      teamName: team.teamName ?? '',
      displayName: team.displayName ?? '',
      color: team.color ?? '',
      deletedAt: team.deletedAt ?? '',
    }))
    .sort(compareTeamMentionEntries);

  if (entries.length === 0) {
    cachedTeamMentionSource = teams;
    cachedTeamMentionSignature = signature;
    cachedTeamMentionMeta = {
      teamNames: EMPTY_TEAM_NAMES,
      teamColorByName: EMPTY_TEAM_COLOR_MAP,
    };
    return cachedTeamMentionMeta;
  }

  const teamNames: string[] = [];
  const teamColorByName = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.deletedAt && entry.teamName) {
      teamNames.push(entry.teamName);
    }
    if (entry.teamName) {
      teamColorByName.set(entry.teamName, entry.color);
    }
    if (entry.displayName) {
      teamColorByName.set(entry.displayName, entry.color);
    }
  }

  cachedTeamMentionSource = teams;
  cachedTeamMentionSignature = signature;
  cachedTeamMentionMeta = { teamNames, teamColorByName };
  return cachedTeamMentionMeta;
}

interface MessagesPanelProps {
  teamName: string;
  position: TeamMessagesPanelMode;
  onPositionChange: (position: TeamMessagesPanelMode) => void;
  mountPoint?: Element | null;
  /** Active (non-removed) members. */
  members: ResolvedTeamMember[];
  /** All team tasks. */
  tasks: TeamTaskWithKanban[];
  /** Whether the team is alive. */
  isTeamAlive?: boolean;
  /** Live lead activity status for the current team. */
  leadActivity?: string;
  /** Latest lead context timestamp for the current team. */
  leadContextUpdatedAt?: string;
  /** Time window for filtering. */
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
  onReplyToMessage?: (message: InboxMessage) => void;
  /** Callback when "Restart team" is clicked. */
  onRestartTeam?: () => void;
  /** Callback when a task ID link is clicked. */
  onTaskIdClick?: (taskId: string) => void;
  /** Reports the rendered floating composer height so the parent can reserve scroll space. */
  onFloatingComposerHeightChange?: (height: number) => void;
  /**
   * Scroll container owned by the parent view when `position === 'inline'`.
   * MessagesPanel does not own this element — the viewport lives in
   * TeamDetailView's content scroll area. Plumbed for future viewport
   * consumers (virtualization); unused in this release.
   */
  inlineScrollContainerRef?: RefObject<HTMLDivElement | null>;
}

const MessagesComposerSection = memo(MessageComposer);
const MessagesStatusSection = memo(StatusBlock);

type MessagesTimelineSectionProps = ComponentProps<typeof ActivityTimeline> & {
  hasMore: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => void;
  expandedItem: TimelineItem | null;
  expandedItemKey: string | null;
  onExpandDialogChange: (open: boolean) => void;
};

const MessagesTimelineSection = memo(function MessagesTimelineSection({
  hasMore,
  loadingOlderMessages,
  onLoadOlderMessages,
  expandedItem,
  expandedItemKey,
  onExpandDialogChange,
  messages,
  loading,
  teamName,
  members,
  readState,
  allCollapsed,
  expandOverrides,
  onToggleExpandOverride,
  currentLeadSessionId,
  isTeamAlive,
  leadActivity,
  leadContextUpdatedAt,
  teamNames,
  teamColorByName,
  onTeamClick,
  onMemberClick,
  onCreateTaskFromMessage,
  onReplyToMessage,
  revisionMessageId,
  onReviseMessage,
  onMessageVisible,
  onRestartTeam,
  onTaskIdClick,
  onExpandItem,
  onExpandContent,
  viewport,
}: MessagesTimelineSectionProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  return (
    <>
      <ActivityTimeline
        messages={messages}
        loading={loading}
        teamName={teamName}
        members={members}
        readState={readState}
        allCollapsed={allCollapsed}
        expandOverrides={expandOverrides}
        onToggleExpandOverride={onToggleExpandOverride}
        currentLeadSessionId={currentLeadSessionId}
        isTeamAlive={isTeamAlive}
        leadActivity={leadActivity}
        leadContextUpdatedAt={leadContextUpdatedAt}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
        onTeamClick={onTeamClick}
        onMemberClick={onMemberClick}
        onCreateTaskFromMessage={onCreateTaskFromMessage}
        onReplyToMessage={onReplyToMessage}
        revisionMessageId={revisionMessageId}
        onReviseMessage={onReviseMessage}
        onMessageVisible={onMessageVisible}
        onRestartTeam={onRestartTeam}
        onTaskIdClick={onTaskIdClick}
        onExpandItem={onExpandItem}
        onExpandContent={onExpandContent}
        viewport={viewport}
      />
      {hasMore && (
        <div className="flex justify-center py-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-text-muted"
            aria-busy={loadingOlderMessages}
            disabled={loadingOlderMessages}
            onClick={onLoadOlderMessages}
          >
            {t('messages.actions.loadOlder')}
          </Button>
        </div>
      )}
      <MessageExpandDialog
        expandedItem={expandedItem}
        open={expandedItemKey !== null}
        onOpenChange={onExpandDialogChange}
        teamName={teamName}
        members={members}
        onCreateTaskFromMessage={onCreateTaskFromMessage}
        onReplyToMessage={onReplyToMessage}
        revisionMessageId={revisionMessageId}
        onReviseMessage={onReviseMessage}
        onMemberClick={onMemberClick}
        onTaskIdClick={onTaskIdClick}
        onRestartTeam={onRestartTeam}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
        onTeamClick={onTeamClick}
      />
    </>
  );
});

export const MessagesPanel = memo(function MessagesPanel({
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

  const loadingOlderMessages = messagesLoadingOlder;
  const hasMore = messagesHasMore;
  const effectiveMessages = messages;
  const loadingInitialMessages =
    effectiveMessages.length === 0 && (!messagesEntryPresent || messagesLoadingHead);

  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const floatingComposerMeasureRef = useRef<HTMLDivElement | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const bottomSheetRef = useRef<SheetRef>(null);
  const bottomSheetStickyTopRef = useRef<HTMLDivElement | null>(null);
  // Scroll container inside `Sheet.Content` for the bottom-sheet layout.
  // react-modal-sheet merges this ref with its own internal scroll ref.
  // Held here so future viewport consumers (virtualization) can observe the
  // true scrolling element in bottom-sheet mode.
  const bottomSheetScrollRef = useRef<HTMLDivElement | null>(null);

  // Resolve the active scroll owner for the current layout. This is the
  // ref that ActivityTimeline's IntersectionObserver will use as its root,
  // so visibility is measured against the real scroll container rather
  // than the document viewport. Virtualizer consumers will hook into the
  // same ref in a follow-up change.
  const activeScrollContainerRef =
    position === 'inline'
      ? (inlineScrollContainerRef ?? null)
      : position === 'sidebar'
        ? sidebarScrollRef
        : bottomSheetScrollRef;

  const activityTimelineViewport = useMemo<TimelineViewport | undefined>(() => {
    if (!activeScrollContainerRef) return undefined;
    return {
      scrollElementRef: activeScrollContainerRef,
      observerRoot: activeScrollContainerRef,
      scrollMargin: 0,
      // Opt into virtualization; ActivityTimeline keeps the direct render
      // path for short lists and only switches to the windowed path once
      // the row count crosses its internal threshold.
      virtualizationEnabled: true,
      virtualizationRowThreshold: position === 'sidebar' ? 48 : undefined,
    };
  }, [activeScrollContainerRef, position]);
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
  const messagesScrollTopRef = useRef(initialSidebarStateRef.current.messagesScrollTop);
  const messagesScrollPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks which team the pending scroll persistence belongs to, so a debounced update
  // scheduled before a team switch is never applied to or persisted under the new team.
  const messagesScrollPersistTeamRef = useRef(teamName);
  const [bottomSheetSnapIndex, setBottomSheetSnapIndex] = useState(
    initialSidebarStateRef.current.bottomSheetSnapIndex
  );
  const [bottomSheetStickyTopHeight, setBottomSheetStickyTopHeight] = useState(196);
  const [bottomSheetMountHeight, setBottomSheetMountHeight] = useState(0);

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
    setBottomSheetSnapIndex(initialSidebarStateRef.current.bottomSheetSnapIndex);
  }, [teamName]);

  useEffect(() => {
    const persistTeamName = teamName;
    return () => {
      if (!messagesScrollPersistTimerRef.current) {
        return;
      }
      // A debounced scroll update was still pending when the panel unmounts (e.g. switching
      // panel mode away from sidebar, closing the tab) or when the team changes. Flush the
      // latest scroll position directly into persisted UI state so a scroll within the 100ms
      // debounce window is not lost.
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
      // Drop a queued update that outlived a team switch: it carries the previous team's
      // offset and must not overwrite the scroll state the new team just restored.
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

  const handleSidebarScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>): void => {
      persistMessagesScrollTop(event.currentTarget.scrollTop);
    },
    [persistMessagesScrollTop]
  );

  useEffect(() => {
    setTeamMessagesSidebarUiState(teamName, {
      messagesSearchQuery,
      messagesFilter,
      messagesFilterOpen,
      messagesCollapsed,
      messagesSearchBarVisible,
      expandedItemKey,
      messagesScrollTop,
      bottomSheetSnapIndex,
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
    bottomSheetSnapIndex,
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
    if (position !== 'sidebar') return;
    const el = sidebarScrollRef.current;
    if (!el) return;
    el.scrollTop = messagesScrollTop;
  }, [position, messagesScrollTop]);

  useLayoutEffect(() => {
    if (position !== 'bottom-sheet' || typeof ResizeObserver === 'undefined') return;

    const mountPointElement = mountPoint instanceof HTMLElement ? mountPoint : null;
    const observedEntries: [Element | null, (height: number) => void][] = [
      [bottomSheetStickyTopRef.current, setBottomSheetStickyTopHeight],
      [mountPointElement, setBottomSheetMountHeight],
    ];
    const observers: ResizeObserver[] = [];

    for (const [element, setHeight] of observedEntries) {
      if (!element) continue;

      const updateHeight = (): void => {
        const nextHeight = Math.ceil(element.getBoundingClientRect().height);
        if (nextHeight > 0) {
          setHeight(nextHeight);
        }
      };

      updateHeight();

      const observer = new ResizeObserver(() => {
        updateHeight();
      });
      observer.observe(element);
      observers.push(observer);
    }

    return () => {
      observers.forEach((observer) => observer.disconnect());
    };
  }, [position, mountPoint]);

  const leadNames = useMemo(
    () => members.filter((member) => isLeadMember(member)).map((member) => member.name),
    [members]
  );
  const memberNames = useMemo(() => new Set(members.map((member) => member.name)), [members]);
  const [revisionRequest, setRevisionRequest] = useState<MessageRevisionRequest | null>(null);

  const filteredMessages = useMemo(() => {
    return filterTeamMessages(effectiveMessages, {
      leadNames,
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
  }, [effectiveMessages, leadNames, messagesFilter, messagesSearchQuery, timeWindow]);

  const activityTimelineMessages = useMemo(() => {
    return filterTeamMessages(effectiveMessages, {
      includeAutomationEvents: true,
      leadNames,
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
  }, [effectiveMessages, leadNames, messagesFilter, messagesSearchQuery, timeWindow]);
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

  useEffect(() => {
    setRevisionRequest(null);
  }, [teamName]);

  const handleRevisionCancel = useCallback(() => {
    setRevisionRequest(null);
  }, []);

  const handleRevisionComplete = useCallback((requestId: string) => {
    setRevisionRequest((current) => (current?.requestId === requestId ? null : current));
  }, []);

  const handleReviseMessage = useCallback(
    async (message: InboxMessage) => {
      if (!isRevisableUserSentMessage(message, memberNames)) return;
      const originalMessageId = trimString(message.messageId);
      if (originalMessageId !== revisionMessageId) return;
      const recipient = trimString(message.to);
      const originalText = getRevisableMessageText(message);
      try {
        await sendTeamMessage(teamName, {
          member: recipient,
          text: buildRevisionNoticeText(originalMessageId, originalText),
          summary: `${REVISION_NOTICE_PREFIX} ${originalMessageId}`,
        });
      } catch {
        return;
      }
      setRevisionRequest({
        requestId: `${originalMessageId}:${Date.now()}`,
        originalMessageId,
        originalText,
        recipient,
        actionMode: message.actionMode,
      });
      composerTextareaRef.current?.focus();
    },
    [memberNames, revisionMessageId, sendTeamMessage, teamName]
  );

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

  const { readSet, markAllRead } = useTeamMessagesRead(teamName);
  const { expandedSet, toggle: toggleExpandOverride } = useTeamMessagesExpanded(teamName);
  const pendingVisibleReadKeysRef = useRef<Set<string>>(new Set());
  const visibleReadFlushFrameRef = useRef<number | null>(null);

  const messagesUnreadCount = useMemo(
    () => filteredMessages.filter((m) => !m.read && !readSet.has(toMessageKey(m))).length,
    [filteredMessages, readSet]
  );

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

  const handleMarkAllRead = useCallback(() => {
    const keys = filteredMessages
      .filter((m) => !m.read && !readSet.has(toMessageKey(m)))
      .map((m) => toMessageKey(m));
    markAllRead(keys);
  }, [filteredMessages, readSet, markAllRead]);

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

  const handleSend = useCallback(
    (
      member: string,
      text: string,
      summary?: string,
      attachments?: Parameters<typeof sendTeamMessage>[1] extends { attachments?: infer A }
        ? A
        : never,
      actionMode?: ActionMode,
      taskRefs?: TaskRef[]
    ) => {
      const sentAtMs = Date.now();
      onPendingReplyChange((prev) => ({ ...prev, [member]: sentAtMs }));
      void sendTeamMessage(teamName, {
        member,
        text,
        summary,
        attachments,
        actionMode,
        taskRefs,
      })
        .then((result) => {
          if (shouldClearPendingReplyForOpenCodeRuntimeDelivery(result?.runtimeDelivery)) {
            onPendingReplyChange((prev) => {
              if (prev[member] !== sentAtMs) return prev;
              const next = { ...prev };
              delete next[member];
              return next;
            });
          }
        })
        .catch(() => {
          onPendingReplyChange((prev) => {
            if (prev[member] !== sentAtMs) return prev;
            const next = { ...prev };
            delete next[member];
            return next;
          });
        });
    },
    [teamName, sendTeamMessage, onPendingReplyChange]
  );

  const handleCrossTeamSend = useCallback(
    (
      toTeam: string,
      text: string,
      summary?: string,
      actionMode?: ActionMode,
      taskRefs?: TaskRef[]
    ) => {
      void sendCrossTeamMessage({
        fromTeam: teamName,
        fromMember: 'user',
        toTeam,
        text,
        taskRefs,
        actionMode,
        summary,
      });
    },
    [teamName, sendCrossTeamMessage]
  );

  const moveToInline = useCallback(() => {
    onPositionChange('inline');
  }, [onPositionChange]);

  const moveToSidebar = useCallback(() => {
    onPositionChange('sidebar');
  }, [onPositionChange]);

  const moveToBottomSheet = useCallback(() => {
    setBottomSheetSnapIndex(BOTTOM_SHEET_COMPOSER_SNAP_INDEX);
    onPositionChange('bottom-sheet');
  }, [onPositionChange]);

  const moveToFloatingComposer = useCallback(() => {
    onPositionChange('floating-composer');
  }, [onPositionChange]);

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

  const bottomSheetSnapPoints = useMemo(() => {
    const maxOpenHeight =
      bottomSheetMountHeight > 0
        ? Math.max(bottomSheetMountHeight - 1, 96)
        : Number.POSITIVE_INFINITY;
    const collapsedHeight = Math.min(BOTTOM_SHEET_HEADER_HEIGHT, maxOpenHeight);
    const composerHeight = Math.min(
      Math.max(collapsedHeight + bottomSheetStickyTopHeight, collapsedHeight + 120),
      maxOpenHeight
    );
    const centeredHeight = Math.min(
      Math.max(
        bottomSheetMountHeight > 0 ? Math.round(bottomSheetMountHeight * 0.58) : 520,
        composerHeight + 140
      ),
      maxOpenHeight
    );

    return [0, collapsedHeight, composerHeight, centeredHeight, 1];
  }, [bottomSheetMountHeight, bottomSheetStickyTopHeight]);

  const normalizedBottomSheetSnapIndex = useMemo(() => {
    return Math.min(
      Math.max(bottomSheetSnapIndex, BOTTOM_SHEET_COLLAPSED_SNAP_INDEX),
      BOTTOM_SHEET_FULL_SNAP_INDEX
    );
  }, [bottomSheetSnapIndex]);

  const renderDefaultComposerSection = (): React.JSX.Element => (
    <MessagesComposerSection
      teamName={teamName}
      members={members}
      isTeamAlive={isTeamAlive}
      sending={sendingMessage}
      sendError={sendMessageError}
      sendWarning={effectiveSendMessageWarning}
      sendDebugDetails={effectiveSendMessageDebugDetails}
      lastResult={lastSendMessageResult}
      revisionRequest={revisionRequest}
      textareaRef={composerTextareaRef}
      onSend={handleSend}
      onCrossTeamSend={handleCrossTeamSend}
      onRevisionCancel={handleRevisionCancel}
      onRevisionComplete={handleRevisionComplete}
    />
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
          <DropdownMenuItem onSelect={moveToInline}>
            <PanelBottom size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToInline')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={moveToBottomSheet}>
            <PanelBottomOpen size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToBottomSheet')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={moveToSidebar}>
            <PanelLeft size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToSidebar')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const renderCompactComposerSection = (): React.JSX.Element => (
    <MessagesComposerSection
      teamName={teamName}
      layout="compact"
      members={members}
      isTeamAlive={isTeamAlive}
      sending={sendingMessage}
      sendError={sendMessageError}
      sendWarning={effectiveSendMessageWarning}
      sendDebugDetails={effectiveSendMessageDebugDetails}
      lastResult={lastSendMessageResult}
      revisionRequest={revisionRequest}
      textareaRef={composerTextareaRef}
      onSend={handleSend}
      onCrossTeamSend={handleCrossTeamSend}
      onRevisionCancel={handleRevisionCancel}
      onRevisionComplete={handleRevisionComplete}
    />
  );

  const renderFloatingComposerSection = (): React.JSX.Element => (
    <MessagesComposerSection
      teamName={teamName}
      layout="compact"
      widthMode="floating-adaptive"
      members={members}
      isTeamAlive={isTeamAlive}
      sending={sendingMessage}
      sendError={sendMessageError}
      sendWarning={effectiveSendMessageWarning}
      sendDebugDetails={effectiveSendMessageDebugDetails}
      lastResult={lastSendMessageResult}
      cornerActionPrefix={renderFloatingComposerModeControls()}
      revisionRequest={revisionRequest}
      textareaRef={composerTextareaRef}
      onSend={handleSend}
      onCrossTeamSend={handleCrossTeamSend}
      onRevisionCancel={handleRevisionCancel}
      onRevisionComplete={handleRevisionComplete}
    />
  );

  const renderInlineStatusSection = (): React.JSX.Element => (
    <MessagesStatusSection
      members={members}
      tasks={tasks}
      messages={effectiveMessages}
      pendingRepliesByMember={pendingRepliesByMember}
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
      pendingRepliesByMember={pendingRepliesByMember}
      layout="flow"
      position="sidebar"
      onMemberClick={onMemberClick}
      onTaskClick={onTaskClick}
    />
  );

  const renderTimelineSection = (): React.JSX.Element => (
    <MessagesTimelineSection
      messages={activityTimelineMessages}
      loading={loadingInitialMessages}
      teamName={teamName}
      members={members}
      readState={readState}
      allCollapsed={messagesCollapsed}
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
      onReplyToMessage={onReplyToMessage}
      revisionMessageId={revisionMessageId}
      onReviseMessage={handleReviseMessage}
      onMessageVisible={handleMessageVisible}
      onRestartTeam={onRestartTeam}
      onTaskIdClick={onTaskIdClick}
      onExpandItem={handleExpandItem}
      onExpandContent={handleExpandContent}
      viewport={activityTimelineViewport}
      hasMore={hasMore}
      loadingOlderMessages={loadingOlderMessages}
      onLoadOlderMessages={handleLoadOlderMessagesClick}
      expandedItem={expandedItem}
      expandedItemKey={expandedItemKey}
      onExpandDialogChange={handleExpandDialogChange}
    />
  );

  // ---- Shared content (used in both modes) ----
  const renderSearchAndFilterControls = (): React.JSX.Element => (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1">
        <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <input
          type="text"
          placeholder={t('messages.search.placeholder')}
          value={messagesSearchQuery}
          onChange={(e) => setMessagesSearchQuery(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
        />
        {messagesSearchQuery && (
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={() => setMessagesSearchQuery('')}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <MessagesFilterPopover
        teamName={teamName}
        members={members}
        filter={messagesFilter}
        messages={effectiveMessages}
        open={messagesFilterOpen}
        onOpenChange={setMessagesFilterOpen}
        onApply={setMessagesFilter}
      />
    </div>
  );

  const renderSearchAndFilterBar = (): React.JSX.Element => (
    <div className="flex items-center gap-2">
      {renderSearchAndFilterControls()}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-events-auto size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onClick={(e) => {
              e.stopPropagation();
              setMessagesCollapsed((v) => !v);
            }}
          >
            {messagesCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {messagesCollapsed ? 'Expand all messages' : 'Collapse all messages'}
        </TooltipContent>
      </Tooltip>
    </div>
  );

  const renderMessagesContent = (): React.JSX.Element => (
    <div className="pb-14">
      {renderDefaultComposerSection()}
      {renderInlineStatusSection()}
      {renderTimelineSection()}
    </div>
  );

  // ---- Sidebar mode ----
  if (position === 'sidebar') {
    return (
      <div className="flex size-full flex-col overflow-hidden bg-[var(--color-surface-sidebar)]">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-3 py-2">
          <MessageSquare size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <span className="text-sm font-medium text-[var(--color-text)]">
            {t('messages.title')}
          </span>
          {filteredMessages.length > 0 && (
            <Badge
              variant="secondary"
              className="px-1.5 py-0.5 text-[10px] font-normal leading-none"
            >
              {filteredMessages.length}
            </Badge>
          )}
          {messagesUnreadCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-normal leading-none text-blue-600 dark:text-blue-400"
                >
                  {t('messages.unread.new', { count: messagesUnreadCount })}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('messages.unread.unread', { count: messagesUnreadCount })}
              </TooltipContent>
            </Tooltip>
          )}
          {messagesUnreadCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-blue-400 transition-colors hover:bg-blue-500/10"
                  onClick={handleMarkAllRead}
                >
                  <CheckCheck size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('messages.actions.markAllRead')}</TooltipContent>
            </Tooltip>
          )}
          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] data-[state=open]:bg-[var(--color-surface-raised)] data-[state=open]:text-[var(--color-text-secondary)]"
                      aria-label={t('messages.actions.panelActions')}
                    >
                      <MoreHorizontal size={15} />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t('messages.actions.messageActions')}
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" side="bottom" className="w-48">
                <DropdownMenuItem onSelect={() => setMessagesCollapsed((v) => !v)}>
                  {messagesCollapsed ? (
                    <ChevronsUpDown size={14} className="shrink-0" />
                  ) : (
                    <ChevronsDownUp size={14} className="shrink-0" />
                  )}
                  <span>
                    {messagesCollapsed
                      ? t('messages.actions.expandAll')
                      : t('messages.actions.collapseAll')}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setMessagesSearchBarVisible((v) => !v)}>
                  {messagesSearchBarVisible ? (
                    <X size={14} className="shrink-0" />
                  ) : (
                    <Search size={14} className="shrink-0" />
                  )}
                  <span>
                    {messagesSearchBarVisible
                      ? t('messages.actions.hideSearch')
                      : t('messages.actions.searchMessages')}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={moveToInline}>
                  <PanelLeftClose size={14} className="shrink-0" />
                  <span>{t('messages.actions.moveToInline')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={moveToBottomSheet}>
                  <PanelBottomOpen size={14} className="shrink-0" />
                  <span>{t('messages.actions.moveToBottomSheet')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={moveToFloatingComposer}>
                  <Dock size={14} className="shrink-0" />
                  <span>{t('messages.actions.floatComposer')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {/* Search & filter bar (toggleable) */}
        {messagesSearchBarVisible && (
          <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5">
            {renderSearchAndFilterControls()}
          </div>
        )}
        {/* Scrollable content */}
        <div
          ref={sidebarScrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-14 pr-3 pt-2"
          onScroll={handleSidebarScroll}
        >
          <div className="pl-3">
            {renderDefaultComposerSection()}
            {renderSidebarStatusSection()}
          </div>
          {renderTimelineSection()}
        </div>
      </div>
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
                <MessageSquare size={13} className="shrink-0 text-[var(--color-text-muted)]" />
                <span className="text-[13px] font-medium text-[var(--color-text)]">
                  {t('messages.title')}
                </span>
                {filteredMessages.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="px-1 py-0 text-[9px] font-normal leading-none"
                  >
                    {filteredMessages.length}
                  </Badge>
                )}
                {messagesUnreadCount > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="secondary"
                        className="bg-blue-500/20 px-1 py-0 text-[9px] font-normal leading-none text-blue-600 dark:text-blue-400"
                      >
                        {t('messages.unread.new', { count: messagesUnreadCount })}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {t('messages.unread.unread', { count: messagesUnreadCount })}
                    </TooltipContent>
                  </Tooltip>
                )}
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
                      {messagesUnreadCount > 0 && (
                        <DropdownMenuItem
                          className="text-blue-400 focus:text-blue-300"
                          onSelect={handleMarkAllRead}
                        >
                          <CheckCheck size={14} className="shrink-0" />
                          <span>{t('messages.actions.markAllRead')}</span>
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => setMessagesCollapsed((value) => !value)}>
                        {messagesCollapsed ? (
                          <ChevronsUpDown size={14} className="shrink-0" />
                        ) : (
                          <ChevronsDownUp size={14} className="shrink-0" />
                        )}
                        <span>
                          {messagesCollapsed
                            ? t('messages.actions.expandAll')
                            : t('messages.actions.collapseAll')}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setMessagesSearchBarVisible((value) => !value)}
                      >
                        {messagesSearchBarVisible ? (
                          <X size={14} className="shrink-0" />
                        ) : (
                          <Search size={14} className="shrink-0" />
                        )}
                        <span>
                          {messagesSearchBarVisible
                            ? t('messages.actions.hideSearch')
                            : t('messages.actions.searchMessages')}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={toggleBottomSheetExpansion}>
                        {isBottomSheetCollapsed ? (
                          <PanelBottomOpen size={14} className="shrink-0" />
                        ) : (
                          <PanelBottomClose size={14} className="shrink-0" />
                        )}
                        <span>
                          {isBottomSheetCollapsed
                            ? t('messages.actions.expandSheet')
                            : t('messages.actions.collapseSheet')}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={moveToInline}>
                        <PanelBottom size={14} className="shrink-0" />
                        <span>{t('messages.actions.moveToInline')}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={moveToSidebar}>
                        <PanelLeft size={14} className="shrink-0" />
                        <span>{t('messages.actions.moveToSidebar')}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={moveToFloatingComposer}>
                        <Dock size={14} className="shrink-0" />
                        <span>{t('messages.actions.floatComposer')}</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </Sheet.Header>
          {!isBottomSheetCollapsed && (
            <Sheet.Content
              className="min-h-0 bg-[var(--color-surface-sidebar)]"
              scrollClassName="flex min-h-full flex-col"
              scrollRef={bottomSheetScrollRef}
              disableDrag={(state) => state.scrollPosition !== 'top'}
            >
              <div
                ref={bottomSheetStickyTopRef}
                className="sticky top-0 z-[1] shrink-0 border-b border-[var(--color-border)] backdrop-blur"
                style={{
                  backgroundColor: 'var(--color-surface-sidebar)',
                }}
              >
                {messagesSearchBarVisible && (
                  <div className="border-b border-[var(--color-border)] px-3 py-2">
                    {renderSearchAndFilterControls()}
                  </div>
                )}
                <div className="p-3">{renderCompactComposerSection()}</div>
              </div>
              <div className="shrink-0 px-3 pt-2">{renderInlineStatusSection()}</div>
              <div className="flex-1 px-3 pb-4 pt-2">{renderTimelineSection()}</div>
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
      title={t('messages.title')}
      icon={<MessageSquare size={14} />}
      badge={filteredMessages.length}
      secondaryBadge={
        filteredMessages.length > 0 && messagesUnreadCount > 0 ? messagesUnreadCount : undefined
      }
      afterBadge={
        messagesUnreadCount > 0 ? (
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
      action={<div className="flex items-center gap-2 px-2">{renderSearchAndFilterBar()}</div>}
    >
      {renderMessagesContent()}
    </CollapsibleTeamSection>
  );
});
