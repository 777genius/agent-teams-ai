import { useCallback, useMemo } from 'react';

import { Combobox } from '@renderer/components/ui/combobox';
import { AGENT_LANGUAGE_OPTIONS } from '@shared/utils/agentLanguage';
import { Check } from 'lucide-react';

import { useAppTranslation } from '../hooks/useAppTranslation';

interface AgentLanguageComboboxProps {
  readonly id?: string;
  /** An agent language code from `AGENT_LANGUAGE_OPTIONS`, `system` included. */
  readonly value: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onValueChange: (value: string) => void;
}

/** The language agents communicate in; the same control for desktop settings and hosted drafts. */
export const AgentLanguageCombobox = ({
  id,
  value,
  disabled = false,
  className = 'min-w-[180px]',
  onValueChange,
}: AgentLanguageComboboxProps): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const options = useMemo(
    () =>
      AGENT_LANGUAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: `${option.flag}  ${option.label}`,
        meta: { flag: option.flag },
      })),
    []
  );
  const renderOption = useCallback(
    (option: { value: string; label: string }, isSelected: boolean) => (
      <>
        <Check className={`mr-2 size-3.5 shrink-0 ${isSelected ? 'opacity-100' : 'opacity-0'}`} />
        <span className="text-[var(--color-text)]">{option.label}</span>
      </>
    ),
    []
  );

  return (
    <Combobox
      id={id}
      options={options}
      value={value}
      onValueChange={onValueChange}
      placeholder={t('general.agentLanguage.selectPlaceholder')}
      searchPlaceholder={t('general.agentLanguage.searchPlaceholder')}
      emptyMessage={t('general.agentLanguage.emptyMessage')}
      disabled={disabled}
      className={className}
      renderOption={renderOption}
    />
  );
};
