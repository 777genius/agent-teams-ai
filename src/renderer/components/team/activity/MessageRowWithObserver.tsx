import React, { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  areInboxMessagesEquivalentForRender,
  areStringArraysEqual,
  areStringMapsEqual,
} from '@renderer/utils/messageRenderEquality';
import { toMessageKey } from '@renderer/utils/teamMessageKey';

import { ActivityItem } from './ActivityItem';
import { AnimatedHeightReveal } from './AnimatedHeightReveal';
import { useMessageReadVisibility } from './useMessageReadVisibility';

import type { ChatAppearance } from './activityMessagePresentation';
import type { TimelineCardPosition } from './timelineCardStack';
import type { InboxMessage } from '@shared/types';

const NEW_MESSAGE_HIGHLIGHT_MS = 3_000;

function getNewMessageHighlightRemainingMs(timestamp: string): number {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return NEW_MESSAGE_HIGHLIGHT_MS;

  const ageMs = Math.max(0, Date.now() - timestampMs);
  return Math.max(0, NEW_MESSAGE_HIGHLIGHT_MS - ageMs);
}

interface MessageRowWithObserverProps {
  message: InboxMessage;
  teamName: string;
  memberRole?: string;
  memberColor?: string;
  recipientColor?: string;
  isUnread?: boolean;
  isNew?: boolean;
  isNewlyAdded?: boolean;
  zebraShade?: boolean;
  memberColorMap?: Map<string, string>;
  localMemberNames?: Set<string>;
  onMemberNameClick?: (name: string) => void;
  onCreateTask?: (subject: string, description: string) => void;
  onReply?: (message: InboxMessage) => void;
  revisionMessageId?: string | null;
  onRevise?: (message: InboxMessage) => void;
  onVisible?: (message: InboxMessage) => void;
  observationEnabled?: boolean;
  onTaskIdClick?: (taskId: string) => void;
  onRestartTeam?: () => void;
  collapseMode: 'default' | 'managed';
  isCollapsed: boolean;
  canToggleCollapse: boolean;
  collapseToggleKey?: string;
  onToggleCollapse?: (key: string) => void;
  compactHeader?: boolean;
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
  onExpand?: (key: string) => void;
  expandItemKey?: string;
  onExpandContent?: () => void;
  observerRoot?: RefObject<HTMLElement | null>;
  timelineCardPosition?: TimelineCardPosition;
  directParticipant?: string;
  appearance?: ChatAppearance;
  continuesPreviousAuthor?: boolean;
  continuesNextAuthor?: boolean;
}

const MessageRowWithObserver = ({
  message,
  teamName,
  memberRole,
  memberColor,
  recipientColor,
  isUnread,
  isNew,
  isNewlyAdded,
  zebraShade,
  memberColorMap,
  localMemberNames,
  onMemberNameClick,
  onCreateTask,
  onReply,
  revisionMessageId,
  onRevise,
  onVisible,
  observationEnabled = true,
  onTaskIdClick,
  onRestartTeam,
  collapseMode,
  isCollapsed,
  canToggleCollapse,
  collapseToggleKey,
  onToggleCollapse,
  compactHeader,
  teamNames,
  teamColorByName,
  onTeamClick,
  onExpand,
  expandItemKey,
  onExpandContent,
  observerRoot,
  timelineCardPosition,
  directParticipant,
  appearance,
  continuesPreviousAuthor,
  continuesNextAuthor,
}: Readonly<MessageRowWithObserverProps>): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  const messageRef = useRef(message);
  const onVisibleRef = useRef(onVisible);
  const [isNewMessageHighlighted, setIsNewMessageHighlighted] = useState(() => {
    if (!isNewlyAdded) return false;
    return getNewMessageHighlightRemainingMs(message.timestamp) > 0;
  });

  useEffect(() => {
    if (!isNewMessageHighlighted) return;

    const remainingMs = getNewMessageHighlightRemainingMs(message.timestamp);
    if (remainingMs <= 0) {
      queueMicrotask(() => setIsNewMessageHighlighted(false));
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsNewMessageHighlighted(false);
    }, remainingMs);
    return () => window.clearTimeout(timeoutId);
  }, [isNewMessageHighlighted, message.timestamp]);

  useLayoutEffect(() => {
    messageRef.current = message;
    onVisibleRef.current = onVisible;
  }, [message, onVisible]);
  const handleVisible = useCallback(() => {
    onVisibleRef.current?.(messageRef.current);
  }, []);

  useMessageReadVisibility({
    targetRef: ref,
    observerRoot,
    observationEnabled,
    visibilityKey: toMessageKey(message),
    onVisible: onVisible ? handleVisible : undefined,
  });

  return (
    <AnimatedHeightReveal animate={isNew} containerRef={ref}>
      <ActivityItem
        message={message}
        teamName={teamName}
        memberRole={memberRole}
        memberColor={memberColor}
        recipientColor={recipientColor}
        isUnread={isUnread}
        isNewMessageHighlighted={isNewMessageHighlighted}
        zebraShade={zebraShade}
        memberColorMap={memberColorMap}
        localMemberNames={localMemberNames}
        onMemberNameClick={onMemberNameClick}
        onCreateTask={onCreateTask}
        onReply={onReply}
        canRevise={message.messageId === revisionMessageId}
        onRevise={onRevise}
        onTaskIdClick={onTaskIdClick}
        onRestartTeam={onRestartTeam}
        collapseMode={collapseMode}
        isCollapsed={isCollapsed}
        canToggleCollapse={canToggleCollapse}
        collapseToggleKey={collapseToggleKey}
        onToggleCollapse={onToggleCollapse}
        compactHeader={compactHeader}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
        onTeamClick={onTeamClick}
        onExpand={onExpand}
        expandItemKey={expandItemKey}
        onExpandContent={onExpandContent}
        timelineCardPosition={timelineCardPosition}
        directParticipant={directParticipant}
        appearance={appearance}
        continuesPreviousAuthor={continuesPreviousAuthor}
        continuesNextAuthor={continuesNextAuthor}
      />
    </AnimatedHeightReveal>
  );
};

export const MemoizedMessageRowWithObserver = React.memo(
  MessageRowWithObserver,
  (prev, next) =>
    prev.teamName === next.teamName &&
    prev.memberRole === next.memberRole &&
    prev.memberColor === next.memberColor &&
    prev.recipientColor === next.recipientColor &&
    prev.isUnread === next.isUnread &&
    prev.isNew === next.isNew &&
    prev.isNewlyAdded === next.isNewlyAdded &&
    prev.zebraShade === next.zebraShade &&
    prev.memberColorMap === next.memberColorMap &&
    prev.localMemberNames === next.localMemberNames &&
    prev.onMemberNameClick === next.onMemberNameClick &&
    prev.onCreateTask === next.onCreateTask &&
    prev.onReply === next.onReply &&
    prev.revisionMessageId === next.revisionMessageId &&
    prev.onRevise === next.onRevise &&
    prev.onVisible === next.onVisible &&
    prev.observationEnabled === next.observationEnabled &&
    prev.onTaskIdClick === next.onTaskIdClick &&
    prev.onRestartTeam === next.onRestartTeam &&
    prev.collapseMode === next.collapseMode &&
    prev.isCollapsed === next.isCollapsed &&
    prev.canToggleCollapse === next.canToggleCollapse &&
    prev.collapseToggleKey === next.collapseToggleKey &&
    prev.onToggleCollapse === next.onToggleCollapse &&
    prev.compactHeader === next.compactHeader &&
    areStringArraysEqual(prev.teamNames, next.teamNames) &&
    areStringMapsEqual(prev.teamColorByName, next.teamColorByName) &&
    prev.onTeamClick === next.onTeamClick &&
    prev.onExpand === next.onExpand &&
    prev.expandItemKey === next.expandItemKey &&
    prev.onExpandContent === next.onExpandContent &&
    prev.observerRoot === next.observerRoot &&
    prev.timelineCardPosition === next.timelineCardPosition &&
    prev.directParticipant === next.directParticipant &&
    prev.appearance === next.appearance &&
    prev.continuesPreviousAuthor === next.continuesPreviousAuthor &&
    prev.continuesNextAuthor === next.continuesNextAuthor &&
    areInboxMessagesEquivalentForRender(prev.message, next.message)
);
