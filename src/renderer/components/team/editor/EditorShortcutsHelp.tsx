/**
 * Keyboard shortcuts help modal for the project editor.
 *
 * Cross-platform: detects Mac vs Windows/Linux and shows
 * the appropriate modifier symbols.
 */

import { useAppTranslation } from '@features/localization/renderer';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog';
import { IS_MAC } from '@renderer/utils/platformKeys';

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
// Component
// =============================================================================

export const EditorShortcutsHelp = ({ onClose }: EditorShortcutsHelpProps): React.ReactElement => {
  const { t } = useAppTranslation('team');
  const resolvedGroups: { title: string; shortcuts: { keys: string; description: string }[] }[] = [
    {
      title: t('editor.shortcuts.groups.fileOperations'),
      shortcuts: [
        { mac: '⌘ P', other: 'Ctrl+P', description: t('editor.shortcuts.actions.quickOpen') },
        { mac: '⌘ S', other: 'Ctrl+S', description: t('editor.shortcuts.actions.save') },
        { mac: '⌘ ⇧ S', other: 'Ctrl+Shift+S', description: t('editor.shortcuts.actions.saveAll') },
        { mac: '⌘ W', other: 'Ctrl+W', description: t('editor.shortcuts.actions.closeTab') },
      ].map((shortcut: ShortcutDef) => ({
        keys: IS_MAC ? shortcut.mac : shortcut.other,
        description: shortcut.description,
      })),
    },
    {
      title: t('editor.shortcuts.groups.search'),
      shortcuts: [
        { mac: '⌘ F', other: 'Ctrl+F', description: t('editor.shortcuts.actions.findInFile') },
        {
          mac: '⌘ ⇧ F',
          other: 'Ctrl+Shift+F',
          description: t('editor.shortcuts.actions.searchInFiles'),
        },
        { mac: '⌘ G', other: 'Ctrl+G', description: t('editor.shortcuts.actions.goToLine') },
      ].map((shortcut: ShortcutDef) => ({
        keys: IS_MAC ? shortcut.mac : shortcut.other,
        description: shortcut.description,
      })),
    },
    {
      title: t('editor.shortcuts.groups.navigation'),
      shortcuts: [
        { mac: '⌘ ⇧ ]', other: 'Ctrl+Shift+]', description: t('editor.shortcuts.actions.nextTab') },
        {
          mac: '⌘ ⇧ [',
          other: 'Ctrl+Shift+[',
          description: t('editor.shortcuts.actions.previousTab'),
        },
        { mac: '⌃ Tab', other: 'Ctrl+Tab', description: t('editor.shortcuts.actions.cycleTabs') },
        { mac: '⌘ B', other: 'Ctrl+B', description: t('editor.shortcuts.actions.toggleSidebar') },
      ].map((shortcut: ShortcutDef) => ({
        keys: IS_MAC ? shortcut.mac : shortcut.other,
        description: shortcut.description,
      })),
    },
    {
      title: t('editor.shortcuts.groups.editing'),
      shortcuts: [
        { mac: '⌘ Z', other: 'Ctrl+Z', description: t('editor.shortcuts.actions.undo') },
        { mac: '⌘ ⇧ Z', other: 'Ctrl+Y', description: t('editor.shortcuts.actions.redo') },
        {
          mac: '⌘ D',
          other: 'Ctrl+D',
          description: t('editor.shortcuts.actions.selectNextMatch'),
        },
        { mac: '⌘ /', other: 'Ctrl+/', description: t('editor.shortcuts.actions.toggleComment') },
      ].map((shortcut: ShortcutDef) => ({
        keys: IS_MAC ? shortcut.mac : shortcut.other,
        description: shortcut.description,
      })),
    },
    {
      title: t('editor.shortcuts.groups.markdown'),
      shortcuts: [
        {
          mac: '⌘ ⇧ M',
          other: 'Ctrl+Shift+M',
          description: t('editor.shortcuts.actions.splitPreview'),
        },
        {
          mac: '⌘ ⇧ V',
          other: 'Ctrl+Shift+V',
          description: t('editor.shortcuts.actions.fullPreview'),
        },
      ].map((shortcut: ShortcutDef) => ({
        keys: IS_MAC ? shortcut.mac : shortcut.other,
        description: shortcut.description,
      })),
    },
    {
      title: t('editor.shortcuts.groups.general'),
      shortcuts: [
        {
          keys: 'Esc',
          description: t('editor.shortcuts.actions.closeEditor'),
        },
      ],
    },
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[480px] max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-sm">{t('editor.shortcuts.title')}</DialogTitle>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  );
};
