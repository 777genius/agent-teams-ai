import { useId } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Combobox } from '@renderer/components/ui/combobox';
import { Label } from '@renderer/components/ui/label';
import { Check } from 'lucide-react';

import type { ScopeOption } from '../view-model/reviewFlowViewModel';

interface ReviewFlowScopePickerProps {
  options: ScopeOption[];
  value: string;
  onChange: (value: string) => void;
}

/** Searchable choice between "all teams" and one team; teams with their own settings are marked. */
export const ReviewFlowScopePicker = ({
  options,
  value,
  onChange,
}: Readonly<ReviewFlowScopePickerProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const id = useId();
  const badgeByValue = new Map(options.map((option) => [option.value, option.badge]));

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t('reviewFlow.scope.label')}</Label>
      <Combobox
        id={id}
        options={options}
        value={value}
        onValueChange={onChange}
        searchPlaceholder={t('reviewFlow.scope.searchPlaceholder')}
        emptyMessage={t('reviewFlow.scope.empty')}
        renderOption={(option, isSelected) => (
          <>
            {isSelected ? <Check className="mr-2 size-3.5 shrink-0" /> : null}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-[var(--color-text)]">{option.label}</p>
              {option.description ? (
                <p className="truncate text-[var(--color-text-muted)]">{option.description}</p>
              ) : null}
            </div>
            {badgeByValue.get(option.value) ? (
              <Badge
                variant={badgeByValue.get(option.value) === 'repair' ? 'destructive' : 'secondary'}
                className="ml-2 shrink-0 px-1.5 py-0 text-[10px]"
              >
                {badgeByValue.get(option.value) === 'repair'
                  ? t('reviewFlow.badges.repair')
                  : t('reviewFlow.badges.custom')}
              </Badge>
            ) : null}
          </>
        )}
      />
    </div>
  );
};
