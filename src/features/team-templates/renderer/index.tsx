import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';

import { applyTeamTemplate, TEAM_TEMPLATES } from '../core';

import { TemplateApplyConfirmDialog } from './TemplateApplyConfirmDialog';
import { TEAM_TEMPLATE_ICONS } from './templateIcons';

import type { TeamTemplateV1 } from '../contracts';
import type { TeamCreateConfigRequest, TeamProviderId } from '@shared/types';

export { TemplateApplyConfirmDialog } from './TemplateApplyConfirmDialog';
export { TEAM_TEMPLATE_ICONS } from './templateIcons';

export const TeamTemplatePicker = ({
  onApply,
  confirmBeforeApply = false,
  disabled = false,
}: {
  onApply: (
    draft: ReturnType<typeof applyTeamTemplate>,
    templateId: TeamTemplateV1['id']
  ) => void;
  /** Ask before replacing non-default content in the owning form. */
  confirmBeforeApply?: boolean;
  /** Prevent replacement while persisted form fields are hydrating. */
  disabled?: boolean;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [pendingTemplate, setPendingTemplate] = useState<(typeof TEAM_TEMPLATES)[number] | null>(
    null
  );
  useEffect(() => {
    if (disabled) setPendingTemplate(null);
  }, [disabled]);
  return (
    <>
      <Select
        disabled={disabled}
        value=""
        onValueChange={(id) => {
          const template = TEAM_TEMPLATES.find((entry) => entry.id === id);
          if (!template) return;
          if (!confirmBeforeApply) {
            onApply(applyTeamTemplate(template), template.id);
            return;
          }
          setPendingTemplate(template);
        }}
      >
        <SelectTrigger aria-label={t('templates.label')}>
          <SelectValue placeholder={t('templates.placeholder')} />
        </SelectTrigger>
        <SelectContent>
          {TEAM_TEMPLATES.map((template) => {
            const Icon = TEAM_TEMPLATE_ICONS[template.id];
            return (
              <SelectItem key={template.id} value={template.id}>
                <span className="flex items-center gap-2">
                  <Icon
                    className="size-4 shrink-0 text-[var(--color-text-muted)]"
                    aria-hidden="true"
                  />
                  {t(`templates.names.${template.id}`)}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <TemplateApplyConfirmDialog
        open={pendingTemplate !== null && !disabled}
        onCancel={() => setPendingTemplate(null)}
        onConfirm={() => {
          if (pendingTemplate && !disabled) {
            onApply(applyTeamTemplate(pendingTemplate), pendingTemplate.id);
          }
          setPendingTemplate(null);
        }}
      />
    </>
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
