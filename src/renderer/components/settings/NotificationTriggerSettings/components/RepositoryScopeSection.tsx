/**
 * RepositoryScopeSection - Section for limiting trigger to specific repositories.
 * Uses the shared RepositoryDropdown component.
 */

import { useAppTranslation } from '@features/localization/renderer';
import {
  RepositoryDropdown,
  SelectedRepositoryItem,
} from '@renderer/components/common/RepositoryDropdown';

import type { RepositoryDropdownItem } from '@renderer/components/settings/hooks/useSettingsConfig';

interface RepositoryScopeSectionProps {
  repositoryIds: string[];
  selectedItems: RepositoryDropdownItem[];
  onAdd: (item: RepositoryDropdownItem) => void;
  onRemove: (index: number) => void;
  disabled: boolean;
}

export const RepositoryScopeSection = ({
  repositoryIds,
  selectedItems,
  onAdd,
  onRemove,
  disabled,
}: Readonly<RepositoryScopeSectionProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');

  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-xs uppercase tracking-widest text-text-muted hover:text-text-secondary">
        {t('notificationTriggers.repositoryScope.summary')}
      </summary>
      <div className="mt-3 border-l border-border pl-4">
        <span className="mb-2 block text-xs text-text-muted">
          {t('notificationTriggers.repositoryScope.title')}
        </span>
        {selectedItems.length === 0 ? (
          <p className="mb-2 text-xs italic text-text-muted">
            {t('notificationTriggers.repositoryScope.empty')}
          </p>
        ) : (
          selectedItems.map((item, idx) => (
            <SelectedRepositoryItem
              key={item.id}
              item={item}
              onRemove={() => onRemove(idx)}
              disabled={disabled}
            />
          ))
        )}

        {/* Repository selector dropdown */}
        <RepositoryDropdown
          onSelect={onAdd}
          excludeIds={repositoryIds}
          placeholder={t('notificationTriggers.repositoryScope.placeholder')}
          disabled={disabled}
          className="mt-2"
        />

        <p className="mt-2 text-xs text-text-muted">
          {t('notificationTriggers.repositoryScope.hint')}
        </p>
      </div>
    </details>
  );
};
