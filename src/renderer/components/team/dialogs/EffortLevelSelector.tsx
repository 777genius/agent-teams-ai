import React, { useEffect, useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Label } from '@renderer/components/ui/label';
import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { cn } from '@renderer/lib/utils';
import {
  getAvailableTeamEffortValue,
  getTeamEffortSelectorPresentation,
} from '@renderer/utils/teamEffortOptions';
import { Brain } from 'lucide-react';

import type { TeamProviderId } from '@shared/types';

export interface EffortLevelSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
  providerId?: TeamProviderId;
  model?: string;
  limitContext?: boolean;
}

export const EffortLevelSelector: React.FC<EffortLevelSelectorProps> = ({
  value,
  onValueChange,
  id,
  providerId,
  model,
  limitContext,
}) => {
  const { t } = useAppTranslation('team');
  const { providerStatus } = useEffectiveCliProviderStatus(providerId);
  const presentation = getTeamEffortSelectorPresentation({
    providerId,
    model,
    limitContext,
    providerStatus,
  });
  const effortOptions = presentation.options;
  const displayValue = getAvailableTeamEffortValue({
    providerId,
    model,
    limitContext,
    providerStatus,
    value,
  });
  const validValues = useMemo(
    () => new Set(effortOptions.map((option) => option.value)),
    [effortOptions]
  );
  const showsAnthropicMax =
    providerId === 'anthropic' && effortOptions.some((option) => option.value === 'max');

  useEffect(() => {
    if (!presentation.canValidateValue || !value || validValues.has(value)) {
      return;
    }
    onValueChange('');
  }, [onValueChange, presentation.canValidateValue, validValues, value]);

  return (
    <div className="mb-3">
      <Label htmlFor={id} className="label-optional mb-1.5 block">
        {t('effortLevel.label')}
      </Label>
      <div className="flex items-center gap-2">
        <Brain size={16} className="shrink-0 text-[var(--color-text-muted)]" />
        <div className="inline-flex flex-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {effortOptions.map((opt) => (
            <button
              key={opt.value || '__default__'}
              type="button"
              id={opt.value === displayValue ? id : undefined}
              disabled={presentation.disabled}
              className={cn(
                'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
                presentation.disabled
                  ? 'cursor-not-allowed text-[var(--color-text-muted)] opacity-70'
                  : displayValue === opt.value
                    ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() => onValueChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{presentation.helperText}</p>
      {presentation.unavailableText ? (
        <p className="mt-1 text-[11px] text-amber-300">{presentation.unavailableText}</p>
      ) : null}
      {showsAnthropicMax ? (
        <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
          {t('effortLevel.maxDescription')}
        </p>
      ) : null}
    </div>
  );
};
