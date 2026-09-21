import { type ComponentProps, memo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import { ActivityTimeline } from '../activity/ActivityTimeline';
import { MessageExpandDialog } from '../activity/MessageExpandDialog';

import type { TimelineItem } from '../activity/LeadThoughtsGroup';

type MessagesTimelineSectionProps = ComponentProps<typeof ActivityTimeline> & {
  hasMore: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => void;
  expandedItem: TimelineItem | null;
  expandedItemKey: string | null;
  onExpandDialogChange: (open: boolean) => void;
};

export const MessagesTimelineSection = memo(function MessagesTimelineSection({
  hasMore,
  loadingOlderMessages,
  onLoadOlderMessages,
  expandedItem,
  expandedItemKey,
  onExpandDialogChange,
  ...timelineProps
}: MessagesTimelineSectionProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const history = (prepare?: () => void): React.ReactNode =>
    hasMore ? (
      <div className="flex justify-center py-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-text-muted"
          aria-busy={loadingOlderMessages}
          disabled={loadingOlderMessages}
          onClick={() => {
            prepare?.();
            onLoadOlderMessages();
          }}
        >
          {t('messages.actions.loadOlder')}
        </Button>
      </div>
    ) : null;
  return (
    <>
      <ActivityTimeline {...timelineProps} historyControl={history} />
      {timelineProps.presentation !== 'conversation' && history()}
      <MessageExpandDialog
        expandedItem={expandedItem}
        open={expandedItemKey !== null}
        onOpenChange={onExpandDialogChange}
        teamName={timelineProps.teamName}
        members={timelineProps.members}
        onCreateTaskFromMessage={timelineProps.onCreateTaskFromMessage}
        onReplyToMessage={timelineProps.onReplyToMessage}
        revisionMessageId={timelineProps.revisionMessageId}
        onReviseMessage={timelineProps.onReviseMessage}
        onMemberClick={timelineProps.onMemberClick}
        onTaskIdClick={timelineProps.onTaskIdClick}
        onRestartTeam={timelineProps.onRestartTeam}
        teamNames={timelineProps.teamNames}
        teamColorByName={timelineProps.teamColorByName}
        onTeamClick={timelineProps.onTeamClick}
      />
    </>
  );
});
