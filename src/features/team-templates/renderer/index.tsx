import { useEffect, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';

import { applyTeamTemplate, TEAM_TEMPLATES } from '../core';

import type { TeamCreateConfigRequest } from '@shared/types';
import type { TeamProviderId } from '@shared/types';

export const TeamTemplatePicker = ({
  onApply,
  confirmBeforeApply = false,
}: {
  onApply: (draft: ReturnType<typeof applyTeamTemplate>) => void;
  /** Creation has an editable roster; replacing it requires an explicit decision. */
  confirmBeforeApply?: boolean;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return (
    <Select
      value=""
      onValueChange={(id) => {
        const template = TEAM_TEMPLATES.find((entry) => entry.id === id);
        if (!template) return;
        if (!confirmBeforeApply) {
          onApply(applyTeamTemplate(template));
          return;
        }
        void (async () => {
          const accepted = await confirm({
            title: t('templates.confirmTitle', { defaultValue: 'Apply team template?' }),
            message: t('templates.confirmMessage', {
              defaultValue: 'This replaces your current team description, prompt and teammates. Continue?',
            }),
            confirmLabel: t('templates.confirmAction', { defaultValue: 'Apply template' }),
          });
          // The user may have closed/replaced this editor while the modal was open.
          if (accepted && mounted.current) onApply(applyTeamTemplate(template));
        })();
      }}
    >
      <SelectTrigger aria-label={t('templates.label')}>
        <SelectValue placeholder={t('templates.placeholder')} />
      </SelectTrigger>
      <SelectContent>
        {TEAM_TEMPLATES.map((template) => (
          <SelectItem key={template.id} value={template.id}>
            {t(`templates.names.${template.id}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export const UnselectedTeamProvider = ({
  onSelect,
  anthropicOnly = false,
}: {
  onSelect: (provider: TeamProviderId) => void;
  anthropicOnly?: boolean;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const multimodelEnabled = useStore(
    (state) => state.appConfig?.general?.multimodelEnabled ?? true
  );
  return (
    <div className="space-y-1">
      <Select value="" onValueChange={(value) => onSelect(value as TeamProviderId)}>
        <SelectTrigger aria-label={t('templates.providerLabel')}>
          <SelectValue placeholder={t('templates.providerPlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="anthropic">Claude</SelectItem>
          {!anthropicOnly && multimodelEnabled ? (
            <>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="opencode">OpenCode</SelectItem>
            </>
          ) : null}
        </SelectContent>
      </Select>
      <p className="text-xs text-text-secondary">{t('templates.modelAfterProvider')}</p>
    </div>
  );
};

export type TemplateDraft = Pick<
  TeamCreateConfigRequest,
  'runtimeSelectionVersion' | 'description' | 'prompt' | 'members' | 'syncModelsWithLead'
>;
