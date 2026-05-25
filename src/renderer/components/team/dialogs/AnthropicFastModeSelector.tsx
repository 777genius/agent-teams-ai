import React, { useMemo } from 'react';

import {
  resolveAnthropicFastMode,
  resolveAnthropicRuntimeSelection,
} from '@features/anthropic-runtime-profile/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { Label } from '@renderer/components/ui/label';
import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { cn } from '@renderer/lib/utils';
import { Zap } from 'lucide-react';

import type { TeamFastMode } from '@shared/types';

export interface AnthropicFastModeSelectorProps {
  value: TeamFastMode;
  onValueChange: (value: TeamFastMode) => void;
  providerFastModeDefault: boolean;
  model?: string;
  limitContext: boolean;
  id?: string;
}

export const AnthropicFastModeSelector: React.FC<AnthropicFastModeSelectorProps> = ({
  value,
  onValueChange,
  providerFastModeDefault,
  model,
  limitContext,
  id,
}) => {
  const { t } = useAppTranslation('team');
  const { providerStatus } = useEffectiveCliProviderStatus('anthropic');

  const selection = useMemo(
    () =>
      resolveAnthropicRuntimeSelection({
        source: {
          modelCatalog: providerStatus?.modelCatalog,
          runtimeCapabilities: providerStatus?.runtimeCapabilities,
        },
        selectedModel: model,
        limitContext,
      }),
    [limitContext, model, providerStatus?.modelCatalog, providerStatus?.runtimeCapabilities]
  );

  const resolution = useMemo(
    () =>
      resolveAnthropicFastMode({
        selection,
        selectedFastMode: value,
        providerFastModeDefault,
      }),
    [providerFastModeDefault, selection, value]
  );

  if (!resolution.showFastModeControl) {
    return null;
  }

  const defaultLabel = providerFastModeDefault
    ? t('modelSelector.fastMode.defaultFast')
    : t('modelSelector.fastMode.defaultOff');
  const helperText =
    value === 'inherit'
      ? t('modelSelector.fastMode.defaultResolvesTo', {
          mode: resolution.resolvedFastMode
            ? t('modelSelector.fastMode.fast')
            : t('modelSelector.fastMode.off'),
        })
      : (resolution.disabledReason ?? t('modelSelector.fastMode.runtimeBackedHint'));

  return (
    <div className="mb-3">
      <Label htmlFor={id} className="label-optional mb-1.5 block">
        {t('modelSelector.fastMode.optionalLabel')}
      </Label>
      <div className="flex items-center gap-2">
        <Zap size={16} className="shrink-0 text-[var(--color-text-muted)]" />
        <div className="inline-flex flex-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {[
            { value: 'inherit' as const, label: defaultLabel, disabled: false },
            {
              value: 'on' as const,
              label: t('modelSelector.fastMode.fast'),
              disabled: !resolution.selectable,
            },
            { value: 'off' as const, label: t('modelSelector.fastMode.off'), disabled: false },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              id={option.value === value ? id : undefined}
              className={cn(
                'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
                value === option.value
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                option.disabled &&
                  'cursor-not-allowed opacity-50 hover:text-[var(--color-text-muted)]'
              )}
              disabled={option.disabled}
              onClick={() => onValueChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{helperText}</p>
    </div>
  );
};
