import { useLayoutEffect, useRef } from 'react';

import { ConversationHeader } from '@features/team-direct-chats/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { Switch } from '@renderer/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { CheckCheck, MoreHorizontal } from 'lucide-react';

import { MessagesThreadUtilityMenuItems } from './MessagesThreadUtilityMenuItems';

interface FullScreenControlProps {
  label: string;
  unavailableLabel: string;
  available: boolean;
  expanded: boolean;
  restoreFocusAfterChange?: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export const FullScreenControl = ({
  label,
  unavailableLabel,
  available,
  expanded,
  restoreFocusAfterChange = true,
  onExpandedChange,
}: FullScreenControlProps): React.JSX.Element => {
  const switchRef = useRef<HTMLButtonElement>(null);
  const restoreSwitchFocusRef = useRef(false);

  useLayoutEffect(() => {
    if (!restoreSwitchFocusRef.current) return;
    restoreSwitchFocusRef.current = false;
    let focusFrame: number | null = null;
    const settleFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => switchRef.current?.focus({ preventScroll: true }));
    });
    return () => {
      cancelAnimationFrame(settleFrame);
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    };
  }, [expanded]);

  const control = (
    <label className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
      <span className="whitespace-nowrap">{label}</span>
      <Switch
        ref={switchRef}
        checked={expanded}
        disabled={!available && !expanded}
        aria-label={label}
        onCheckedChange={(nextExpanded) => {
          restoreSwitchFocusRef.current =
            restoreFocusAfterChange && document.activeElement === switchRef.current;
          onExpandedChange(nextExpanded);
        }}
      />
    </label>
  );
  if (available || expanded) return control;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">{control}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{unavailableLabel}</TooltipContent>
    </Tooltip>
  );
};

interface WideThreadHeaderProps {
  title: string;
  participant?: string;
  unreadCount: number;
  attentionCount: number;
  markAllReadLabel: string;
  actionsLabel: string;
  collapsed: boolean;
  searchVisible: boolean;
  onMarkAllRead: () => void;
  onToggleCollapsed: () => void;
  onToggleSearch: () => void;
}

export const WideThreadHeader = ({
  title,
  participant,
  unreadCount,
  attentionCount,
  markAllReadLabel,
  actionsLabel,
  collapsed,
  searchVisible,
  onMarkAllRead,
  onToggleCollapsed,
  onToggleSearch,
}: WideThreadHeaderProps): React.JSX.Element => {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ConversationHeader
        title={title}
        participant={participant}
        unreadCount={unreadCount}
        attentionCount={attentionCount}
      />
      {unreadCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center rounded-md px-1.5 py-1 text-blue-400 transition-colors hover:bg-blue-500/10"
              aria-label={markAllReadLabel}
              onClick={onMarkAllRead}
            >
              <CheckCheck size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{markAllReadLabel}</TooltipContent>
        </Tooltip>
      ) : null}
      <div className="ml-auto shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="size-7 p-0 text-[var(--color-text-muted)]"
              aria-label={actionsLabel}
            >
              <MoreHorizontal size={15} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <MessagesThreadUtilityMenuItems
              collapsed={collapsed}
              searchVisible={searchVisible}
              onToggleCollapsed={onToggleCollapsed}
              onToggleSearch={onToggleSearch}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
