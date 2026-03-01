/**
 * Floating action menu shown near text selection in the editor.
 *
 * Positioned absolutely relative to the editor content container.
 * Uses onMouseDown preventDefault to avoid deselecting text in CM6.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { ListTodo, MessageSquare } from 'lucide-react';

import type { EditorSelectionInfo } from '@shared/types/editor';

// =============================================================================
// Types
// =============================================================================

interface EditorSelectionMenuProps {
  info: EditorSelectionInfo;
  /** Bounding rect of the editor content container (for viewport → container conversion) */
  containerRect: DOMRect;
  onSendMessage: () => void;
  onCreateTask: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const MENU_GAP = 8; // px gap between selection end and menu
const MENU_WIDTH = 68; // approximate menu width for clamping
const MENU_HEIGHT = 32; // approximate menu height for clamping

// =============================================================================
// Component
// =============================================================================

export const EditorSelectionMenu = ({
  info,
  containerRect,
  onSendMessage,
  onCreateTask,
}: EditorSelectionMenuProps): React.ReactElement | null => {
  if (!info.text.trim()) return null;

  // Convert viewport coords → container-relative
  const rawTop = info.screenRect.top - containerRect.top;
  const rawLeft = info.screenRect.right - containerRect.left + MENU_GAP;

  // Check if selection is within visible container bounds
  const selTopInContainer = info.screenRect.top - containerRect.top;
  const selBottomInContainer = info.screenRect.bottom - containerRect.top;
  if (selBottomInContainer < 0 || selTopInContainer > containerRect.height) {
    return null; // selection is scrolled out of view
  }

  // Clamp to container bounds
  const top = Math.max(0, Math.min(rawTop, containerRect.height - MENU_HEIGHT));
  const left =
    rawLeft + MENU_WIDTH > containerRect.width
      ? info.screenRect.right - containerRect.left - MENU_WIDTH - MENU_GAP // flip to left side
      : rawLeft;

  return (
    <div
      className="pointer-events-auto absolute z-20 flex items-center gap-0.5 rounded-md border border-border-emphasis bg-surface-overlay p-0.5 shadow-lg animate-in fade-in-0 zoom-in-95"
      style={{ top, left: Math.max(0, left) }}
    >
      <MenuButton
        icon={<MessageSquare className="size-3.5" />}
        label="Write Teammate"
        onClick={onSendMessage}
      />
      <MenuButton
        icon={<ListTodo className="size-3.5" />}
        label="Create Task"
        onClick={onCreateTask}
      />
    </div>
  );
};

// =============================================================================
// Menu button
// =============================================================================

interface MenuButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

const MenuButton = ({ icon, label, onClick }: MenuButtonProps): React.ReactElement => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        onClick={onClick}
        onMouseDown={(e) => e.preventDefault()} // prevent CM6 selection loss
        className="rounded p-1.5 text-text-secondary transition-colors hover:bg-surface-raised hover:text-text"
      >
        {icon}
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" sideOffset={6}>
      {label}
    </TooltipContent>
  </Tooltip>
);
