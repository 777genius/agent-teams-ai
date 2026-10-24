import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@renderer/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  Dock,
  PanelBottom,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeft,
  PanelLeftClose,
} from 'lucide-react';

import type { JSX, ReactNode } from 'react';

interface MessagesLayoutMenuItemsProps {
  variant: 'sidebar' | 'bottom-sheet' | 'floating-composer';
  showChatSort?: boolean;
  sortChatsByActivity: boolean;
  onSortChatsByActivityChange: (checked: boolean) => void;
  onMoveToInline: () => void;
  onMoveToBottomSheet: () => void;
  onMoveToSidebar: () => void;
  onMoveToFloatingComposer: () => void;
  isBottomSheetCollapsed?: boolean;
  onToggleBottomSheetExpansion?: () => void;
}

export const MessagesLayoutMenuItems = ({
  variant,
  showChatSort = false,
  sortChatsByActivity,
  onSortChatsByActivityChange,
  onMoveToInline,
  onMoveToBottomSheet,
  onMoveToSidebar,
  onMoveToFloatingComposer,
  isBottomSheetCollapsed,
  onToggleBottomSheetExpansion,
}: MessagesLayoutMenuItemsProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <>
      {showChatSort ? (
        <>
          <DropdownMenuCheckboxItem
            checked={sortChatsByActivity}
            onCheckedChange={(value) => onSortChatsByActivityChange(value === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {t('messages.chats.sortByActivity')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
        </>
      ) : null}
      {variant === 'bottom-sheet' && onToggleBottomSheetExpansion ? (
        <DropdownMenuItem onSelect={onToggleBottomSheetExpansion}>
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
      ) : null}
      {variant === 'sidebar' && (
        <>
          <DropdownMenuItem onSelect={onMoveToInline}>
            <PanelLeftClose size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToInline')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onMoveToBottomSheet}>
            <PanelBottomOpen size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToBottomSheet')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onMoveToFloatingComposer}>
            <Dock size={14} className="shrink-0" />
            <span>{t('messages.actions.floatComposer')}</span>
          </DropdownMenuItem>
        </>
      )}
      {variant === 'bottom-sheet' && (
        <>
          <DropdownMenuItem onSelect={onMoveToInline}>
            <PanelBottom size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToInline')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onMoveToSidebar}>
            <PanelLeft size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToSidebar')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onMoveToFloatingComposer}>
            <Dock size={14} className="shrink-0" />
            <span>{t('messages.actions.floatComposer')}</span>
          </DropdownMenuItem>
        </>
      )}
      {variant === 'floating-composer' && (
        <>
          <DropdownMenuItem onSelect={onMoveToInline}>
            <PanelBottom size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToInline')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onMoveToBottomSheet}>
            <PanelBottomOpen size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToBottomSheet')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onMoveToSidebar}>
            <PanelLeft size={14} className="shrink-0" />
            <span>{t('messages.actions.moveToSidebar')}</span>
          </DropdownMenuItem>
        </>
      )}
    </>
  );
};

/** Inline layout controls use the same actions as the other Messages layouts. */
export const MessagesInlineLayoutActions = ({
  onMoveToBottomSheet,
  onMoveToFloatingComposer,
  onMoveToSidebar,
  children,
}: Pick<
  MessagesLayoutMenuItemsProps,
  'onMoveToBottomSheet' | 'onMoveToFloatingComposer' | 'onMoveToSidebar'
> & { children?: ReactNode }): JSX.Element => {
  const { t } = useAppTranslation('team');
  const actions = [
    {
      id: 'bottom-sheet',
      icon: PanelBottom,
      onMove: onMoveToBottomSheet,
      label: t('messages.actions.moveMessagesToBottomSheet'),
      tip: t('messages.actions.moveToBottomSheet'),
    },
    {
      id: 'floating-composer',
      icon: Dock,
      onMove: onMoveToFloatingComposer,
      label: t('messages.actions.floatMessagesComposer'),
      tip: t('messages.actions.floatComposer'),
    },
    {
      id: 'sidebar',
      icon: PanelLeft,
      onMove: onMoveToSidebar,
      label: t('messages.actions.moveMessagesToSidebar'),
      tip: t('messages.actions.moveToSidebar'),
    },
  ];
  return (
    <div className="flex items-center gap-1">
      {children}
      {actions.map(({ id, icon: Icon, onMove, label, tip }) => (
        <Tooltip key={id}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              onClick={(event) => {
                event.stopPropagation();
                onMove();
              }}
              aria-label={label}
            >
              <Icon size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{tip}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
};
