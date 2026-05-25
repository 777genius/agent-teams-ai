/**
 * ModeSelector - Segmented control for selecting trigger mode - Linear style.
 */

import { useAppTranslation } from '@features/localization/renderer';

import { getModeLabelKey, MODE_OPTIONS } from '../utils/constants';

import type { TriggerMode } from '@renderer/types/data';

interface ModeSelectorProps {
  value: TriggerMode;
  onChange: (mode: TriggerMode) => void;
  disabled?: boolean;
}

export const ModeSelector = ({
  value,
  onChange,
  disabled = false,
}: Readonly<ModeSelectorProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');

  return (
    <div className="inline-flex gap-0.5 rounded-md bg-surface-raised p-0.5">
      {MODE_OPTIONS.map((mode) => {
        const Icon = mode.icon;
        const isActive = value === mode.value;

        return (
          <button
            key={mode.value}
            type="button"
            onClick={() => onChange(mode.value)}
            disabled={disabled}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
              isActive
                ? 'bg-indigo-500/20 text-indigo-400'
                : 'text-text-muted hover:bg-surface-raised hover:text-text-secondary'
            } ${disabled ? 'cursor-not-allowed opacity-50' : ''} `}
          >
            <Icon className="size-3.5" />
            {t(getModeLabelKey(mode.value))}
          </button>
        );
      })}
    </div>
  );
};
