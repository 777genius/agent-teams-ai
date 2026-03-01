/**
 * Tab bar for the project editor.
 * Shows open files as tabs with dirty indicator (dot) and close button.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { X } from 'lucide-react';

import { getFileIcon } from './fileIcons';

import type { EditorFileTab } from '@shared/types/editor';

// =============================================================================
// Types
// =============================================================================

interface EditorTabBarProps {
  /** Called instead of direct closeTab — allows parent to intercept dirty tabs */
  onRequestCloseTab: (tabId: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export const EditorTabBar = ({
  onRequestCloseTab,
}: EditorTabBarProps): React.ReactElement | null => {
  const tabs = useStore((s) => s.editorOpenTabs);
  const activeTabId = useStore((s) => s.editorActiveTabId);
  const modifiedFiles = useStore((s) => s.editorModifiedFiles);
  const setActiveEditorTab = useStore((s) => s.setActiveEditorTab);

  if (tabs.length === 0) return null;

  return (
    <div
      className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-surface-sidebar"
      role="tablist"
    >
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          isModified={!!modifiedFiles[tab.filePath]}
          onActivate={() => setActiveEditorTab(tab.id)}
          onClose={() => onRequestCloseTab(tab.id)}
        />
      ))}
    </div>
  );
};

// =============================================================================
// Tab item
// =============================================================================

interface TabProps {
  tab: EditorFileTab;
  isActive: boolean;
  isModified: boolean;
  onActivate: () => void;
  onClose: () => void;
}

const Tab = ({ tab, isActive, isModified, onActivate, onClose }: TabProps): React.ReactElement => {
  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  const handleAuxClick = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose();
    }
  };

  const iconInfo = getFileIcon(tab.fileName);
  const FileIcon = iconInfo.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onActivate}
          onAuxClick={handleAuxClick}
          role="tab"
          aria-selected={isActive}
          className={`group flex h-full shrink-0 items-center gap-1.5 border-r border-border px-3 text-xs transition-colors ${
            isActive
              ? 'bg-surface text-text'
              : 'bg-surface-sidebar text-text-muted hover:bg-surface-raised hover:text-text-secondary'
          }`}
        >
          {isModified && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-amber-400"
              aria-label="Unsaved changes"
            />
          )}
          <FileIcon className="size-3.5 shrink-0" style={{ color: iconInfo.color }} />
          <span className="max-w-40 truncate">
            {tab.fileName}
            {tab.disambiguatedLabel && (
              <span className="ml-1 text-text-muted">{tab.disambiguatedLabel}</span>
            )}
          </span>
          <span
            onClick={handleClose}
            className="ml-1 rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-raised group-hover:opacity-100"
            role="button"
            aria-label={`Close ${tab.fileName}`}
            tabIndex={-1}
          >
            <X className="size-3" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tab.filePath}</TooltipContent>
    </Tooltip>
  );
};
