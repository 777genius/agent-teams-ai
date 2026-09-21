import {
  cloneElement,
  type FocusEvent,
  type HTMLAttributes,
  memo,
  type ReactElement,
  useCallback,
  useRef,
  useState,
} from 'react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card';

import { ActivityMessageHoverToolbar } from './ActivityMessageHoverToolbar';

interface ActivityMessageHoverCardProps {
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  copyText: string;
  showToolbar: boolean;
  canRevise: boolean;
  appearance?: 'compact' | 'wide-chat';
  timestamp?: string;
  onRevise?: () => void;
  onReply?: () => void;
  onCreateTask?: () => void;
}

export const ActivityMessageHoverCard = memo(function ActivityMessageHoverCard({
  children,
  copyText,
  showToolbar,
  canRevise,
  appearance = 'compact',
  timestamp,
  onRevise,
  onReply,
  onCreateTask,
}: ActivityMessageHoverCardProps): React.JSX.Element {
  const isWide = appearance === 'wide-chat';
  const [wideOpen, setWideOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeAfterFocusLeaves = useCallback((): void => {
    window.setTimeout(() => {
      const active = document.activeElement;
      if (
        active instanceof Node &&
        (triggerRef.current?.contains(active) || contentRef.current?.contains(active))
      ) {
        return;
      }
      setWideOpen(false);
    }, 0);
  }, []);
  const trigger = isWide
    ? cloneElement(children, {
        onFocusCapture: (event: FocusEvent<HTMLElement>) => {
          triggerRef.current = event.currentTarget;
          setWideOpen(true);
        },
        onBlurCapture: closeAfterFocusLeaves,
      })
    : children;
  return (
    <HoverCard
      openDelay={120}
      closeDelay={220}
      open={isWide ? wideOpen : undefined}
      onOpenChange={isWide ? setWideOpen : undefined}
    >
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      {showToolbar ? (
        <HoverCardContent
          ref={contentRef}
          side={isWide ? 'bottom' : 'right'}
          align="start"
          alignOffset={isWide ? 8 : 0}
          sideOffset={isWide ? -2 : 0}
          avoidCollisions={isWide}
          collisionPadding={isWide ? 8 : undefined}
          hideWhenDetached={false}
          data-chat-toolbar-appearance={isWide ? 'wide-chat' : undefined}
          data-wide-chat-message-footer={isWide ? 'true' : undefined}
          className={
            isWide
              ? 'activity-message-toolbar flex w-auto min-w-0 items-center gap-1 rounded-lg bg-[var(--color-surface-raised)] px-1 py-0.5 shadow-md'
              : 'activity-message-toolbar w-auto min-w-0 bg-[var(--color-surface-raised)] p-1 shadow-none data-[side=left]:rounded-r-none data-[side=right]:rounded-l-none data-[side=left]:border-r-0 data-[side=right]:border-l-0'
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onFocusCapture={() => setWideOpen(true)}
          onBlurCapture={closeAfterFocusLeaves}
        >
          <ActivityMessageHoverToolbar
            copyText={copyText}
            canRevise={canRevise}
            onRevise={onRevise}
            onReply={onReply}
            onCreateTask={onCreateTask}
            orientation={isWide ? 'horizontal' : 'vertical'}
          />
          {isWide && timestamp ? (
            <span
              data-wide-chat-hover-time="true"
              className="ml-0.5 border-l border-[var(--color-border)] px-1.5 text-[10px] font-medium leading-5 text-[var(--color-text-secondary)]"
            >
              {timestamp}
            </span>
          ) : null}
        </HoverCardContent>
      ) : null}
    </HoverCard>
  );
});
