import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { MoreHorizontal } from 'lucide-react';

import { MessagesLayoutMenuItems } from './MessagesLayoutMenuItems';

interface Props {
  label: string;
  sortChatsByActivity: boolean;
  onSortChatsByActivityChange: (sort: boolean) => void;
  onMoveToInline: () => void;
  onMoveToBottomSheet: () => void;
  onMoveToSidebar: () => void;
  onMoveToFloatingComposer: () => void;
}

export const MessagesFloatingComposerModeControls = (props: Props): React.JSX.Element => {
  return (
    <div className="inline-flex items-center pr-1">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] data-[state=open]:bg-[var(--color-surface-raised)] data-[state=open]:text-[var(--color-text-secondary)]"
                aria-label={props.label}
              >
                <MoreHorizontal size={14} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{props.label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" side="top" className="w-48">
          <MessagesLayoutMenuItems
            variant="floating-composer"
            sortChatsByActivity={props.sortChatsByActivity}
            onSortChatsByActivityChange={props.onSortChatsByActivityChange}
            onMoveToInline={props.onMoveToInline}
            onMoveToBottomSheet={props.onMoveToBottomSheet}
            onMoveToSidebar={props.onMoveToSidebar}
            onMoveToFloatingComposer={props.onMoveToFloatingComposer}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
