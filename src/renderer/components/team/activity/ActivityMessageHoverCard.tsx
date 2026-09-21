import { memo, type ReactNode } from 'react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card';

import { ActivityMessageHoverToolbar } from './ActivityMessageHoverToolbar';

interface ActivityMessageHoverCardProps {
  children: ReactNode;
  copyText: string;
  showToolbar: boolean;
  canRevise: boolean;
  onRevise?: () => void;
  onReply?: () => void;
  onCreateTask?: () => void;
}

export const ActivityMessageHoverCard = memo(function ActivityMessageHoverCard({
  children,
  copyText,
  showToolbar,
  canRevise,
  onRevise,
  onReply,
  onCreateTask,
}: ActivityMessageHoverCardProps): React.JSX.Element {
  return (
    <HoverCard openDelay={120} closeDelay={220}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {showToolbar ? (
        <HoverCardContent
          side="right"
          align="start"
          sideOffset={0}
          avoidCollisions={false}
          hideWhenDetached={false}
          className="activity-message-toolbar w-auto min-w-0 bg-[var(--color-surface-raised)] p-1 shadow-none data-[side=left]:rounded-r-none data-[side=right]:rounded-l-none data-[side=left]:border-r-0 data-[side=right]:border-l-0"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <ActivityMessageHoverToolbar
            copyText={copyText}
            canRevise={canRevise}
            onRevise={onRevise}
            onReply={onReply}
            onCreateTask={onCreateTask}
          />
        </HoverCardContent>
      ) : null}
    </HoverCard>
  );
});
