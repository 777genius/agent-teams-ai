import { useAppTranslation } from '@features/localization/renderer';
import { DropdownMenuItem } from '@renderer/components/ui/dropdown-menu';
import { ChevronsDownUp, ChevronsUpDown, Search, X } from 'lucide-react';

import type { JSX } from 'react';

interface MessagesThreadUtilityMenuItemsProps {
  collapsed: boolean;
  searchVisible: boolean;
  onToggleCollapsed: () => void;
  onToggleSearch: () => void;
  showCollapse?: boolean;
}

export const MessagesThreadUtilityMenuItems = ({
  collapsed,
  searchVisible,
  onToggleCollapsed,
  onToggleSearch,
  showCollapse = true,
}: MessagesThreadUtilityMenuItemsProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <>
      {showCollapse ? (
        <DropdownMenuItem onSelect={onToggleCollapsed}>
          {collapsed ? (
            <ChevronsUpDown size={14} className="shrink-0" />
          ) : (
            <ChevronsDownUp size={14} className="shrink-0" />
          )}
          <span>
            {collapsed ? t('messages.actions.expandAll') : t('messages.actions.collapseAll')}
          </span>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={onToggleSearch}>
        {searchVisible ? (
          <X size={14} className="shrink-0" />
        ) : (
          <Search size={14} className="shrink-0" />
        )}
        <span>
          {searchVisible ? t('messages.actions.hideSearch') : t('messages.actions.searchMessages')}
        </span>
      </DropdownMenuItem>
    </>
  );
};
