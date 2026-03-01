/**
 * Toolbar with Save, Undo, Redo buttons.
 */

import { redo, undo } from '@codemirror/commands';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { editorBridge } from '@renderer/utils/editorBridge';
import { shortcutLabel } from '@renderer/utils/platformKeys';
import { Redo2, Save, Undo2, WrapText } from 'lucide-react';

// =============================================================================
// Component
// =============================================================================

export const EditorToolbar = (): React.ReactElement | null => {
  const activeTabId = useStore((s) => s.editorActiveTabId);
  const modifiedFiles = useStore((s) => s.editorModifiedFiles);
  const saving = useStore((s) => s.editorSaving);
  const saveFile = useStore((s) => s.saveFile);
  const lineWrap = useStore((s) => s.editorLineWrap);
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

const ToolbarButton = ({
  icon,
  label,
  shortcut,
  onClick,
  disabled = false,
  active = false,
}: ToolbarButtonProps): React.ReactElement => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        onClick={onClick}
        disabled={disabled}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors hover:bg-surface-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent ${
          active ? 'bg-surface-raised text-text' : 'text-text-muted'
        }`}
        aria-label={`${label} (${shortcut})`}
        aria-pressed={active}
      >
        {icon}
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom">
      {label} ({shortcut})
    </TooltipContent>
  </Tooltip>
);
