import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { buttonVariants } from '@renderer/components/ui/button';
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
  disabled = false,
}: {
  onApply: (draft: ReturnType<typeof applyTeamTemplate>) => void;
  /** Ask before replacing non-default content in the owning form. */
  confirmBeforeApply?: boolean;
  /** Prevent replacement while persisted form fields are hydrating. */
  disabled?: boolean;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
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
            onApply(applyTeamTemplate(template));
            return;
          }
          setPendingTemplate(template);
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
      <AlertDialog
        open={pendingTemplate !== null && !disabled}
        onOpenChange={(next) => !next && setPendingTemplate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('templates.confirmTitle', { defaultValue: 'Apply team template?' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('templates.confirmMessage', {
                defaultValue:
                  'This will replace your teammates, instructions and team settings with the template’s values.',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'default' })}
              onClick={() => {
                if (pendingTemplate && !disabled) onApply(applyTeamTemplate(pendingTemplate));
                setPendingTemplate(null);
              }}
            >
              {t('templates.confirmAction', { defaultValue: 'Apply template' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
