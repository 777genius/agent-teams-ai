/**
 * RepositoryDropdown - Dropdown for selecting repository groups.
 *
 * Features:
 * - Shows repository groups (not individual worktrees)
 * - Displays worktree count and total sessions
 * - Click outside to close
 * - Keyboard navigation (Escape to close)
 * - Filter out already selected items
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import { ChevronDown, FolderOpen, GitBranch } from 'lucide-react';

import type { RepositoryDropdownItem } from '@renderer/components/settings/hooks/useSettingsConfig';

interface RepositoryDropdownProps {
  /** Callback when a repository is selected */
  onSelect: (item: RepositoryDropdownItem) => void;
  /** IDs of items to exclude from the list */
  excludeIds?: string[];
  /** Placeholder text */
  placeholder?: string;
  /** Whether the dropdown is disabled */
  disabled?: boolean;
  /** Whether to drop up instead of down */
  dropUp?: boolean;
  /** Custom class for the container */
  className?: string;
}

export const RepositoryDropdown = ({
  onSelect,
  excludeIds = [],
  placeholder = 'Select repository...',
  disabled = false,
  dropUp = false,
  className = '',
}: Readonly<RepositoryDropdownProps>): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Get repository groups from store
  const repositoryGroups = useStore((state) => state.repositoryGroups);
  const fetchRepositoryGroups = useStore((state) => state.fetchRepositoryGroups);

  // Fetch data if not loaded
  useEffect(() => {
    if (repositoryGroups.length === 0) {
      void fetchRepositoryGroups();
    }
  }, [repositoryGroups.length, fetchRepositoryGroups]);

  // Convert repository groups to dropdown items
  const allItems = useMemo((): RepositoryDropdownItem[] => {
    return repositoryGroups.map((group) => ({
      id: group.id,
      name: group.name,
      path: group.worktrees[0]?.path ?? '',
      worktreeCount: group.worktrees.length,
      totalSessions: group.totalSessions,
    }));
  }, [repositoryGroups]);

  // Filter out excluded items
  const availableItems = useMemo(() => {
    return allItems.filter((item) => !excludeIds.includes(item.id));
  }, [allItems, excludeIds]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  const handleSelect = (item: RepositoryDropdownItem): void => {
    onSelect(item);
    setIsOpen(false);
  };

  const isEmpty = availableItems.length === 0;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => !disabled && !isEmpty && setIsOpen(!isOpen)}
        disabled={disabled || isEmpty}
        className={`flex w-full items-center justify-between gap-2 rounded border border-border bg-transparent px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised ${disabled || isEmpty ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} `}
      >
        <span className="flex items-center gap-2">
          <FolderOpen className="size-3" />
          {isEmpty ? t('repositories.noneAvailable') : placeholder}
        </span>
        <ChevronDown
          className={`size-4 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && !isEmpty && (
        <div
          className={`absolute inset-x-0 z-50 max-h-64 overflow-y-auto rounded border border-border bg-surface-overlay py-1 shadow-lg ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'} `}
        >
          {availableItems.map((item) => (
            <RepositoryDropdownItemComponent
              key={item.id}
              item={item}
              onSelect={() => handleSelect(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Individual item in the dropdown.
 */
const RepositoryDropdownItemComponentInner = ({
  item,
  onSelect,
}: Readonly<{
  item: RepositoryDropdownItem;
  onSelect: () => void;
}>): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-surface-raised"
    >
      <FolderOpen className="size-3 shrink-0 text-indigo-400" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs text-text">{item.name}</span>
          {item.worktreeCount > 1 && (
            <span className="flex shrink-0 items-center gap-0.5 rounded bg-surface-raised px-1 py-0.5 text-[10px] text-text-muted">
              <GitBranch className="size-2.5" />
              {item.worktreeCount}
            </span>
          )}
          <span className="shrink-0 text-[10px] text-text-muted">
            {t('sessions.count', { count: item.totalSessions })}
          </span>
        </div>
        <span className="block truncate text-[10px] text-text-muted">{item.path}</span>
      </div>
    </button>
  );
};

const RepositoryDropdownItemComponent = React.memo(RepositoryDropdownItemComponentInner);

/**
 * Selected repository item with remove button.
 */
const SelectedRepositoryItemInner = ({
  item,
  onRemove,
  disabled = false,
}: Readonly<{
  item: RepositoryDropdownItem;
  onRemove: () => void;
  disabled?: boolean;
}>): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle py-1.5">
      <FolderOpen className="size-3 shrink-0 text-indigo-400" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs text-text">{item.name}</span>
          {item.worktreeCount > 1 && (
            <span className="flex shrink-0 items-center gap-0.5 rounded bg-surface-raised px-1 py-0.5 text-[10px] text-text-muted">
              <GitBranch className="size-2.5" />
              {item.worktreeCount}
            </span>
          )}
        </div>
        <span className="truncate text-[10px] text-text-muted" title={item.path}>
          {item.path}
        </span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className={`shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400 ${disabled ? 'cursor-not-allowed opacity-50' : ''} `}
        aria-label={t('repositories.remove')}
      >
        <svg className="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
};

export const SelectedRepositoryItem = React.memo(SelectedRepositoryItemInner);
