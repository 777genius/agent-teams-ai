/**
 * Keyboard shortcuts help modal for the project editor.
 *
 * Cross-platform: detects Mac vs Windows/Linux and shows
 * the appropriate modifier symbols.
 */

import { useEffect, useMemo } from 'react';

import { IS_MAC } from '@renderer/utils/platformKeys';
import { X } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

interface EditorShortcutsHelpProps {
  onClose: () => void;
}

interface ShortcutDef {
  mac: string;
  other: string;
  description: string;
}

// =============================================================================
// Shortcuts data
// =============================================================================

const SHORTCUT_GROUPS: { title: string; shortcuts: ShortcutDef[] }[] = [
  {
    title: 'File Operations',
    shortcuts: [
      { mac: '⌘ P', other: 'Ctrl+P', description: 'Quick Open' },
      { mac: '⌘ S', other: 'Ctrl+S', description: 'Save' },
      { mac: '⌘ ⇧ S', other: 'Ctrl+Shift+S', description: 'Save All' },
      { mac: '⌘ W', other: 'Ctrl+W', description: 'Close Tab' },
    ],
  },
  {
    title: 'Search',
    shortcuts: [
      { mac: '⌘ F', other: 'Ctrl+F', description: 'Find in File' },
      { mac: '⌘ ⇧ F', other: 'Ctrl+Shift+F', description: 'Search in Files' },
      { mac: '⌘ G', other: 'Ctrl+G', description: 'Go to Line' },
    ],
  },
  {
    title: 'Navigation',
    shortcuts: [
      { mac: '⌘ ⇧ ]', other: 'Ctrl+Shift+]', description: 'Next Tab' },
      { mac: '⌘ ⇧ [', other: 'Ctrl+Shift+[', description: 'Previous Tab' },
      { mac: '⌃ Tab', other: 'Ctrl+Tab', description: 'Cycle Tabs' },
      { mac: '⌘ B', other: 'Ctrl+B', description: 'Toggle Sidebar' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { mac: '⌘ Z', other: 'Ctrl+Z', description: 'Undo' },
      { mac: '⌘ ⇧ Z', other: 'Ctrl+Y', description: 'Redo' },
      { mac: '⌘ D', other: 'Ctrl+D', description: 'Select Next Match' },
      { mac: '⌘ /', other: 'Ctrl+/', description: 'Toggle Comment' },
    ],
  },
  {
    title: 'General',
    shortcuts: [{ mac: 'Esc', other: 'Esc', description: 'Close Editor' }],
  },
];

// =============================================================================
// Component
// =============================================================================

export const EditorShortcutsHelp = ({ onClose }: EditorShortcutsHelpProps): React.ReactElement => {
  // Escape closes help (capture phase)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  // Resolve platform-specific keys once
  const resolvedGroups = useMemo(
    () =>
      SHORTCUT_GROUPS.map((group) => ({
        ...group,
        shortcuts: group.shortcuts.map((s) => ({
          keys: IS_MAC ? s.mac : s.other,
          description: s.description,
        })),
      })),
    []
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" role="presentation">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-dialog-title"
        className="relative z-10 w-[480px] rounded-lg border border-border-emphasis bg-surface p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="shortcuts-dialog-title" className="text-sm font-semibold text-text">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          {resolvedGroups.map((group) => (
            <div key={group.title}>
              <h3 className="mb-1.5 text-xs font-medium text-text-secondary">{group.title}</h3>
              <div className="space-y-1">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.keys} className="flex items-center justify-between text-xs">
                    <span className="text-text-muted">{shortcut.description}</span>
                    <kbd className="rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
                      {shortcut.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
