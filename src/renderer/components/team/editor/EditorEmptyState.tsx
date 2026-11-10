/**
 * Empty state shown when no file is open in the editor.
 * Shows keyboard shortcuts cheatsheet.
 */

import { useAppTranslation } from '@features/localization/renderer';
import { shortcutLabel } from '@renderer/utils/platformKeys';
import { FileCode } from 'lucide-react';

export const EditorEmptyState = (): React.ReactElement => {
  const { t } = useAppTranslation('team');
  const shortcuts = [
    { keys: shortcutLabel('⌘ P', 'Ctrl+P'), label: t('editor.shortcuts.actions.quickOpen') },
    {
      keys: shortcutLabel('⌘ ⇧ F', 'Ctrl+Shift+F'),
      label: t('editor.shortcuts.actions.searchInFiles'),
    },
    { keys: shortcutLabel('⌘ S', 'Ctrl+S'), label: t('editor.shortcuts.actions.save') },
    { keys: shortcutLabel('⌘ B', 'Ctrl+B'), label: t('editor.shortcuts.actions.toggleSidebar') },
    { keys: shortcutLabel('⌘ G', 'Ctrl+G'), label: t('editor.shortcuts.actions.goToLine') },
    { keys: 'Esc', label: t('editor.shortcuts.actions.closeEditor') },
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-text-muted">
      <FileCode className="size-12 opacity-30" />
      <p className="text-sm">{t('editor.empty.selectFile')}</p>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5">
        {shortcuts.map((s) => (
          <div key={s.keys} className="flex items-center justify-between gap-4 text-xs">
            <span className="text-text-muted">{s.label}</span>
            <kbd className="rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
              {s.keys}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
};
