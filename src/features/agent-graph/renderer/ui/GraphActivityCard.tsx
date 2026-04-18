import { ActivityItem } from '@renderer/components/team/activity/ActivityItem';
import {
  type MessageContext,
  resolveMessageRenderProps,
} from '@renderer/components/team/activity/activityMessageContext';

import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';
import type { InboxMessage } from '@shared/types';

interface GraphActivityCardProps {
  message: InboxMessage;
  teamName: string;
  messageContext: MessageContext;
  teamNames: string[];
  teamColorByName: ReadonlyMap<string, string>;
  isUnread?: boolean;
  zebraShade?: boolean;
  className?: string;
  onClick?: () => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenMemberProfile?: (
    memberName: string,
    options?: {
      initialTab?: MemberDetailTab;
      initialActivityFilter?: MemberActivityFilter;
    }
  ) => void;
}

export const GraphActivityCard = ({
  message,
  teamName,
  messageContext,
  teamNames,
  teamColorByName,
  isUnread = false,
  zebraShade = false,
  className,
  onClick,
  onOpenTaskDetail,
  onOpenMemberProfile,
}: GraphActivityCardProps): React.JSX.Element => {
  const renderProps = resolveMessageRenderProps(message, messageContext);
  const interactive = Boolean(onClick);

  return (
    <div
      className={[
        'h-[72px] min-h-[72px] min-w-0 max-w-full overflow-hidden',
        interactive ? 'cursor-pointer' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      onDragStart={(event) => {
        event.preventDefault();
      }}
    >
      <ActivityItem
        message={message}
        teamName={teamName}
        compactHeader
        collapseMode="managed"
        isCollapsed
        canToggleCollapse={false}
        isUnread={isUnread}
        memberRole={renderProps.memberRole}
        memberColor={renderProps.memberColor}
        recipientColor={renderProps.recipientColor}
        memberColorMap={messageContext.colorMap}
        localMemberNames={messageContext.localMemberNames}
        onMemberNameClick={(memberName) => onOpenMemberProfile?.(memberName)}
        onTaskIdClick={onOpenTaskDetail}
        zebraShade={zebraShade}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
      />
    </div>
  );
};
