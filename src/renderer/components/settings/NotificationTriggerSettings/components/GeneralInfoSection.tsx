/**
 * GeneralInfoSection - Name input and tool select for AddTriggerForm.
 */

import { useAppTranslation } from '@features/localization/renderer';

import { TOOL_NAME_OPTIONS } from '../utils/constants';

import { SectionHeader } from './SectionHeader';

interface GeneralInfoSectionProps {
  name: string;
  toolName: string;
  saving: boolean;
  onNameChange: (name: string) => void;
  onToolNameChange: (toolName: string) => void;
}

export const GeneralInfoSection = ({
  name,
  toolName,
  saving,
  onNameChange,
  onToolNameChange,
}: Readonly<GeneralInfoSectionProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');

  return (
    <div className="space-y-3">
      <SectionHeader title={t('notificationTriggers.sections.generalInfo')} />

      {/* Trigger Name */}
      <div className="border-b border-border-subtle py-2">
        <div className="mb-2 flex items-center justify-between">
          <label htmlFor="new-trigger-name" className="text-sm text-text-secondary">
            {t('notificationTriggers.fields.triggerNameRequired')}
          </label>
        </div>
        <input
          id="new-trigger-name"
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('notificationTriggers.fields.triggerNamePlaceholder')}
          disabled={saving}
          required
          className={`w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-transparent focus:outline-none focus:ring-1 focus:ring-indigo-500 ${saving ? 'cursor-not-allowed opacity-50' : ''} `}
        />
      </div>

      {/* Scope/Tool Name */}
      <div className="flex items-center justify-between border-b border-border-subtle py-2">
        <label htmlFor="new-trigger-tool-name" className="label-optional text-sm">
          {t('notificationTriggers.fields.scopeToolNameOptional')}
        </label>
        <select
          id="new-trigger-tool-name"
          value={toolName}
          onChange={(e) => onToolNameChange(e.target.value)}
          disabled={saving}
          className={`rounded border border-border bg-transparent px-2 py-1 text-sm text-text focus:border-transparent focus:outline-none focus:ring-1 focus:ring-indigo-500 ${saving ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} `}
        >
          {TOOL_NAME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value} className="bg-[#141416]">
              {option.value ? option.label : t('notificationTriggers.options.toolNames.anyTool')}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
