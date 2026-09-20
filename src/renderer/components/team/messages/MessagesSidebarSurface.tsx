import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { CheckCheck, MoreHorizontal } from 'lucide-react';

import { MessagesThreadUtilityMenuItems } from './MessagesThreadUtilityMenuItems';

interface MessagesSidebarSurfaceProps {
  conversationHeader: React.ReactNode;
  showMarkAllRead: boolean;
  markAllReadLabel: string;
  onMarkAllRead: () => void;
  fullScreenControl: React.ReactNode;
  showThreadUtilities: boolean;
  collapsed: boolean;
  searchVisible: boolean;
  onToggleCollapsed: () => void;
  onToggleSearch: () => void;
  panelActionsLabel: string;
  messageActionsLabel: string;
  layoutMenu: React.ReactNode;
  showChatList: boolean;
  chatList: React.ReactNode;
  thread: React.ReactNode;
  listScrollRef: React.Ref<HTMLDivElement>;
  threadSlotRef: React.Ref<HTMLDivElement>;
  onListScroll: React.UIEventHandler<HTMLDivElement>;
}

export const MessagesSidebarSurface = ({
  conversationHeader,
  showMarkAllRead,
  markAllReadLabel,
  onMarkAllRead,
  fullScreenControl,
  showThreadUtilities,
  collapsed,
  searchVisible,
  onToggleCollapsed,
  onToggleSearch,
  panelActionsLabel,
  messageActionsLabel,
  layoutMenu,
  showChatList,
  chatList,
  thread,
  listScrollRef,
  threadSlotRef,
  onListScroll,
}: Readonly<MessagesSidebarSurfaceProps>): React.JSX.Element => {
  return (
    <div className="flex size-full flex-col overflow-hidden bg-[var(--color-surface-sidebar)]">
      <div className="flex shrink-0 items-center gap-2 overflow-visible border-b border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-3 py-2">
        {conversationHeader}
        {showMarkAllRead ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex items-center rounded-md px-1.5 py-1 text-blue-400 transition-colors hover:bg-blue-500/10"
                aria-label={markAllReadLabel}
                onClick={onMarkAllRead}
              >
                <CheckCheck size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{markAllReadLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {fullScreenControl}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] data-[state=open]:bg-[var(--color-surface-raised)] data-[state=open]:text-[var(--color-text-secondary)]"
                    aria-label={panelActionsLabel}
                  >
                    <MoreHorizontal size={15} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{messageActionsLabel}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" side="bottom" className="w-48">
              {showThreadUtilities ? (
                <MessagesThreadUtilityMenuItems
                  collapsed={collapsed}
                  searchVisible={searchVisible}
                  onToggleCollapsed={onToggleCollapsed}
                  onToggleSearch={onToggleSearch}
                />
              ) : null}
              {layoutMenu}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div
        ref={listScrollRef}
        className={showChatList ? 'min-h-0 flex-1 overflow-y-auto pt-2' : 'hidden'}
        onScroll={onListScroll}
      >
        {chatList}
      </div>
      <div
        ref={threadSlotRef}
        className={!showChatList ? 'min-h-0 min-w-0 flex-1' : 'hidden'}
        data-messages-thread-slot="sidebar"
      />
      {thread}
    </div>
  );
};
