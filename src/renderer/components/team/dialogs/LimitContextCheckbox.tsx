import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { HoverTooltip } from '@renderer/components/ui/hover-tooltip';
import { Label } from '@renderer/components/ui/label';
import { Info } from 'lucide-react';

interface LimitContextCheckboxProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  scopeLabel?: string;
}

export const LimitContextCheckbox: React.FC<LimitContextCheckboxProps> = ({
  id,
  checked,
  onCheckedChange,
  disabled = false,
  scopeLabel,
}) => {
  const { t } = useAppTranslation('team');
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Checkbox
        id={id}
        checked={disabled ? true : checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <Label
        htmlFor={id}
        className={`flex flex-wrap items-center gap-1.5 text-xs font-normal leading-snug ${
          disabled ? 'cursor-not-allowed text-text-muted opacity-50' : 'text-text-secondary'
        }`}
      >
        {t('contextLimit.limitTo200k')}
        {scopeLabel ? (
          <span className="text-[10px] text-[var(--color-text-muted)]">({scopeLabel})</span>
        ) : null}
        {disabled && <span className="text-[10px] italic">{t('contextLimit.always200k')}</span>}
      </Label>
      <HoverTooltip
        content={t('contextLimit.tooltipContent')}
        title={t('contextLimit.tooltipTitle')}
        contentClassName="max-w-[260px]"
      >
        <Info
          className={`size-3.5 shrink-0 ${disabled ? 'text-text-muted opacity-50' : 'text-text-muted hover:text-text-secondary'} cursor-help`}
          aria-hidden="true"
        />
      </HoverTooltip>
    </div>
  );
};
