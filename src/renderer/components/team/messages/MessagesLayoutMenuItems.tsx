import { useAppTranslation } from '@features/localization/renderer';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@renderer/components/ui/dropdown-menu';
import {
  Dock,
  PanelBottom,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeft,
  PanelLeftClose,
} from 'lucide-react';

import type { JSX } from 'react';

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
