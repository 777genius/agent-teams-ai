import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { IS_MAC } from '@renderer/utils/platformKeys';
import { X } from 'lucide-react';

interface KeyboardShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const mod = IS_MAC ? '\u2318' : 'Ctrl';
const alt = IS_MAC ? '\u2325' : 'Alt';
const shift = IS_MAC ? '\u21E7' : 'Shift';

const shortcuts = [
  { keys: [`${alt}+J`], actionKey: 'nextChange' },
  { keys: [`${alt}+K`], actionKey: 'previousChange' },
  { keys: [`${alt}+\u2193`], actionKey: 'nextFile' },
  { keys: [`${alt}+\u2191`], actionKey: 'previousFile' },
  { keys: [`${mod}+Y`], actionKey: 'acceptChange' },
  { keys: [`${mod}+N`], actionKey: 'rejectChange' },
  { keys: [`${mod}+S`], actionKey: 'saveFile' },
  { keys: [`${mod}+Z`], actionKey: 'undo' },
  { keys: [`${mod}+${shift}+Z`], actionKey: 'redo' },
  { keys: ['?'], actionKey: 'toggleShortcuts' },
  { keys: ['Esc'], actionKey: 'closeDialog' },
] as const;

export const KeyboardShortcutsHelp = ({
  open,
  onOpenChange,
}: KeyboardShortcutsHelpProps): React.ReactElement | null => {
  const { t } = useAppTranslation('team');

  if (!open) return null;

  return (
    <div className="absolute right-4 top-14 z-50 w-64 rounded-lg border border-border bg-surface-overlay p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-text">{t('review.shortcuts.title')}</span>
        <button
          onClick={() => onOpenChange(false)}
          className="rounded p-0.5 text-text-muted hover:bg-surface-raised hover:text-text"
        >
          <X className="size-3" />
        </button>
      </div>
      <div className="space-y-1">
        {shortcuts.map(({ keys, actionKey }) => (
          <div key={actionKey} className="flex items-center justify-between text-xs">
            <span className="text-text-secondary">
              {t(`review.shortcuts.actions.${actionKey}` as const)}
            </span>
            <div className="flex gap-1">
              {keys.map((key) => (
                <kbd
                  key={key}
                  className="rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
                >
                  {key}
                </kbd>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
