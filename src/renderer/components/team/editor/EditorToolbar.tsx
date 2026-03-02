/**
 * Toolbar with Save, Undo, Redo buttons.
 */

import React from 'react';

import { redo, undo } from '@codemirror/commands';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { editorBridge } from '@renderer/utils/editorBridge';
import { shortcutLabel } from '@renderer/utils/platformKeys';
import { Columns2, Eye, Redo2, Save, Undo2, WrapText } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

// =============================================================================
// Types
// =============================================================================

export type MdPreviewMode = 'off' | 'split' | 'preview';

// =============================================================================
// Component
// =============================================================================

interface EditorToolbarProps {
  isMarkdown?: boolean;
  mdPreviewMode?: MdPreviewMode;
  onToggleSplit?: () => void;
  onToggleFullPreview?: () => void;
}

export const EditorToolbar = ({
  isMarkdown = false,
  mdPreviewMode = 'off',
  onToggleSplit,
  onToggleFullPreview,
}: EditorToolbarProps): React.ReactElement | null => {
  const { activeTabId, modifiedFiles, saving, lineWrap } = useStore(
    useShallow((s) => ({
      activeTabId: s.editorActiveTabId,
      modifiedFiles: s.editorModifiedFiles,
      saving: s.editorSaving,
      lineWrap: s.editorLineWrap,
    }))
  );
  const saveFile = useStore((s) => s.saveFile);
  const toggleLineWrap = useStore((s) => s.toggleLineWrap);

  if (!activeTabId) return null;

  const isDirty = !!modifiedFiles[activeTabId];
  const isSaving = !!saving[activeTabId];

  const handleSave = () => {
    void saveFile(activeTabId);
  };

  const handleUndo = () => {
    const view = editorBridge.getView();
    if (view) undo(view);
  };

  const handleRedo = () => {
    const view = editorBridge.getView();
    if (view) redo(view);
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface px-2">
      <ToolbarButton
        icon={<Save className="size-3.5" />}
        label="Save"
        shortcut={shortcutLabel('⌘ S', 'Ctrl+S')}
        onClick={handleSave}
        disabled={!isDirty || isSaving}
      />
      <ToolbarButton
        icon={<Undo2 className="size-3.5" />}
        label="Undo"
        shortcut={shortcutLabel('⌘ Z', 'Ctrl+Z')}
        onClick={handleUndo}
      />
      <ToolbarButton
        icon={<Redo2 className="size-3.5" />}
        label="Redo"
        shortcut={shortcutLabel('⌘ ⇧ Z', 'Ctrl+Y')}
        onClick={handleRedo}
      />
      <div className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton
        icon={<WrapText className="size-3.5" />}
        label={lineWrap ? 'Disable word wrap' : 'Enable word wrap'}
        shortcut={shortcutLabel('⌘ ⇧ W', 'Ctrl+Shift+W')}
        onClick={toggleLineWrap}
        active={lineWrap}
      />
      {isMarkdown && (
        <>
          <div className="mx-1 h-4 w-px bg-border" />
          <ToolbarButton
            icon={<Columns2 className="size-3.5" />}
            label={mdPreviewMode === 'split' ? 'Close split preview' : 'Split preview'}
            shortcut={shortcutLabel('⌘ ⇧ M', 'Ctrl+Shift+M')}
            onClick={onToggleSplit ?? (() => {})}
            active={mdPreviewMode === 'split'}
          />
          <ToolbarButton
            icon={<Eye className="size-3.5" />}
            label={mdPreviewMode === 'preview' ? 'Close preview' : 'Full preview'}
            shortcut={shortcutLabel('⌘ ⇧ V', 'Ctrl+Shift+V')}
            onClick={onToggleFullPreview ?? (() => {})}
            active={mdPreviewMode === 'preview'}
          />
        </>
      )}
    </div>
  );
};

// =============================================================================
// Toolbar button
// =============================================================================

interface ToolbarButtonProps {
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

const ToolbarButton = React.memo(function ToolbarButton({
  icon,
  label,
  shortcut,
  onClick,
  disabled = false,
  active = false,
}: ToolbarButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          onClick={onClick}
          disabled={disabled}
          className={`h-auto gap-1 px-1.5 py-0.5 text-xs ${
            active ? 'bg-surface-raised text-text' : 'text-text-muted'
          }`}
          aria-label={`${label} (${shortcut})`}
          aria-pressed={active}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} ({shortcut})
      </TooltipContent>
    </Tooltip>
  );
});
