import React, { useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { TEAM_TEMPLATES } from '@features/team-templates';
import { Button } from '@renderer/components/ui/button';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';

import { useCustomTemplateLibrary } from '../hooks/useCustomTemplateLibrary';
import {
  builtinTemplateSelectionValue,
  CREATE_TEAM_TEMPLATE_NONE_VALUE,
  customTemplateSelectionValue,
  parseTemplateSelectionValue,
  resolveCreateTeamTemplateDraft,
} from '../templateDraft';

import type { CreateTeamTemplateDraft } from '../templateDraft';
import type { CustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';

export interface CreateTeamTemplatePickerProps {
  open: boolean;
  initialSelection?: string;
  /** True once the persisted template selection has been restored (or confirmed absent). */
  initialSelectionReady?: boolean;
  onApply: (
    draft: CreateTeamTemplateDraft,
    source: 'none' | 'builtin' | 'custom',
    selectionValue?: string
  ) => void;
}

/** An absent or empty saved selection always resolves to the explicit "No template" option. */
function resolveInitialSelection(initialSelection: string | undefined): string {
  return initialSelection && initialSelection.length > 0
    ? initialSelection
    : CREATE_TEAM_TEMPLATE_NONE_VALUE;
}

export const CreateTeamTemplatePicker = ({
  open,
  initialSelection,
  initialSelectionReady,
  onApply,
}: CreateTeamTemplatePickerProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { state, reload } = useCustomTemplateLibrary(open);

  const [selection, setSelection] = useState<string>(() =>
    resolveInitialSelection(initialSelection)
  );
  // A deliberate user choice always outranks a draft selection that arrives
  // later: draft persistence restores asynchronously, long after mount.
  const userSelectionMadeRef = useRef(false);
  const [lastCustomSnapshot, setLastCustomSnapshot] = useState<CustomTeamTemplateV1 | null>(null);

  // Hydration readiness: while the persisted selection has not been restored,
  // option changes are blocked so they cannot race with the pending restore.
  const selectionReady = initialSelectionReady ?? true;

  // Draft persistence restores the saved selection after mount. Adopt it only
  // while the picker still shows its default, so the visible selection matches
  // the restored prompt/members without re-applying the template (restoration
  // must never overwrite user-edited prompt/member data).
  useEffect(() => {
    if (userSelectionMadeRef.current) return;
    setSelection((current) => {
      const next = resolveInitialSelection(initialSelection);
      return current === next ? current : next;
    });
  }, [initialSelection]);

  const customs = state.status === 'ready' || state.status === 'partial' ? state.templates : [];
  const libraryLoading = state.status === 'idle' || state.status === 'loading';
  const libraryFailed = state.status === 'storageUnavailable' || state.status === 'requestFailed';
  const libraryEmpty = state.status === 'empty';

  const parsedSelection = parseTemplateSelectionValue(selection);
  const selectedBuiltin =
    parsedSelection.kind === 'builtin'
      ? (TEAM_TEMPLATES.find((entry) => entry.id === parsedSelection.builtinTemplateId) ?? null)
      : null;
  const selectedCustom =
    parsedSelection.kind === 'custom'
      ? (customs.find((entry) => entry.templateId === parsedSelection.templateId) ?? null)
      : null;
  const librarySettled =
    state.status === 'ready' || state.status === 'partial' || state.status === 'empty';
  const staleCustomId =
    parsedSelection.kind === 'custom' && librarySettled && !selectedCustom
      ? parsedSelection.templateId
      : null;
  const previewCustom = selectedCustom ?? (staleCustomId ? lastCustomSnapshot : null);

  const handleSelect = (value: string): void => {
    if (!selectionReady) return;
    userSelectionMadeRef.current = true;
    if (value === selection) return;
    const result = resolveCreateTeamTemplateDraft(value, {
      builtins: TEAM_TEMPLATES,
      customs,
    });
    switch (result.status) {
      case 'none':
        setSelection(value);
        onApply(result.draft, 'none', value);
        return;
      case 'builtin':
        setSelection(value);
        onApply(result.draft, 'builtin', value);
        return;
      case 'custom': {
        const record = customs.find((entry) => entry.templateId === result.templateId) ?? null;
        setSelection(value);
        setLastCustomSnapshot(record);
        onApply(result.draft, 'custom', value);
        return;
      }
      default:
        return;
    }
  };

  const optionClass = (active: boolean): string =>
    `rounded-md border p-3 text-left transition-colors ${
      active
        ? 'border-[var(--color-primary)] bg-[var(--color-surface-raised)] ring-1 ring-[var(--color-primary)]'
        : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-raised)]'
    }`;

  return (
    <div data-testid="create-team-template-picker" className="space-y-3">
      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">
          {t('customTemplates.createFromTemplate.title')}
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
          {t('customTemplates.createFromTemplate.description')}
        </p>
      </div>

      {!selectionReady ? (
        <p
          role="status"
          data-testid="create-template-selection-loading"
          className="text-xs text-[var(--color-text-muted)]"
        >
          {t('customTemplates.library.loading')}
        </p>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        data-testid="create-template-option-none"
        disabled={!selectionReady}
        aria-pressed={selection === CREATE_TEAM_TEMPLATE_NONE_VALUE}
        aria-busy={!selectionReady}
        className={`h-auto w-full flex-col items-stretch justify-start whitespace-normal ${optionClass(selection === CREATE_TEAM_TEMPLATE_NONE_VALUE)}`}
        onClick={() => handleSelect(CREATE_TEAM_TEMPLATE_NONE_VALUE)}
      >
        <span className="text-sm font-semibold text-[var(--color-text)]">
          {t('customTemplates.createFromTemplate.noneLabel')}
        </span>
        <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
          {t('customTemplates.createFromTemplate.noneHint')}
        </span>
      </Button>

      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-[var(--color-text-muted)]">
          {t('customTemplates.createFromTemplate.builtinGroup')}
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TEAM_TEMPLATES.map((template) => {
            const value = builtinTemplateSelectionValue(
              template.id as Parameters<typeof builtinTemplateSelectionValue>[0]
            );
            const active = selection === value;
            return (
              <Button
                key={template.id}
                type="button"
                variant="ghost"
                data-testid={`create-template-option-builtin-${template.id}`}
                disabled={!selectionReady}
                aria-pressed={active}
                aria-busy={!selectionReady}
                className={`h-auto w-full flex-col items-stretch justify-start whitespace-normal ${optionClass(active)}`}
                onClick={() => handleSelect(value)}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--color-text)]">
                    {t(`templates.names.${template.id}`)}
                  </span>
                  <ShieldCheck className="size-4 shrink-0 text-sky-400" />
                </span>
                <span className="mt-1 line-clamp-2 block text-xs text-[var(--color-text-muted)]">
                  {t(`templates.descriptions.${template.id}`)}
                </span>
                <span className="mt-2 block text-[11px] text-[var(--color-text-secondary)]">
                  {t('customTemplates.createFromTemplate.membersCount', {
                    count: template.members.length,
                  })}
                </span>
              </Button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-[var(--color-text-muted)]">
          {t('customTemplates.createFromTemplate.customGroup')}
        </p>
        {libraryLoading ? (
          <p role="status" className="text-xs text-[var(--color-text-muted)]">
            {t('customTemplates.library.loading')}
          </p>
        ) : null}
        {libraryFailed ? (
          <div
            role="alert"
            data-testid="create-template-library-error"
            className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>
              {state.status === 'storageUnavailable'
                ? t('customTemplates.library.storageUnavailable')
                : t('customTemplates.library.loadFailed')}
            </p>
          </div>
        ) : null}
        {libraryFailed ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            data-testid="create-template-retry"
            onClick={() => void reload()}
          >
            <RefreshCw className="size-3.5" />
            {t('customTemplates.actions.retry')}
          </Button>
        ) : null}
        {libraryEmpty ? (
          <p
            data-testid="create-template-custom-empty"
            className="rounded-md border border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]"
          >
            {t('customTemplates.library.empty')} — {t('customTemplates.library.emptyDescription')}
          </p>
        ) : null}
        {state.status === 'ready' || state.status === 'partial' ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {customs.map((template) => {
              const value = customTemplateSelectionValue(template.templateId);
              const active = selection === value;
              return (
                <Button
                  key={template.templateId}
                  type="button"
                  variant="ghost"
                  data-testid={`create-template-option-custom-${template.templateId}`}
                  disabled={!selectionReady}
                  aria-pressed={active}
                  aria-busy={!selectionReady}
                  className={`h-auto w-full flex-col items-stretch justify-start whitespace-normal ${optionClass(active)}`}
                  onClick={() => handleSelect(value)}
                >
                  <span className="text-sm font-semibold text-[var(--color-text)]">
                    {template.name}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-xs text-[var(--color-text-muted)]">
                    {template.description?.trim()
                      ? template.description
                      : t('customTemplates.library.noDescription')}
                  </span>
                  <span className="mt-2 block text-[11px] text-[var(--color-text-secondary)]">
                    {t('customTemplates.createFromTemplate.membersCount', {
                      count: template.members.length,
                    })}
                  </span>
                </Button>
              );
            })}
          </div>
        ) : null}
        {state.status === 'partial' ? (
          <div
            role="status"
            data-testid="create-template-unreadable"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>
              {t('customTemplates.library.unreadableRecords', {
                count: state.unreadableRecords.length,
              })}
            </p>
          </div>
        ) : null}
      </div>

      {staleCustomId ? (
        <div
          role="alert"
          data-testid="create-template-stale"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>{t('customTemplates.createFromTemplate.staleWarning')}</p>
        </div>
      ) : null}

      <div
        data-testid="create-template-preview"
        className="space-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-xs"
      >
        {selectedBuiltin ? (
          <>
            <div className="flex items-center justify-between text-[var(--color-text-muted)]">
              <span className="font-medium text-[var(--color-text)]">
                {t(`templates.names.${selectedBuiltin.id}`)}
              </span>
              <span className="text-[11px] text-sky-400">
                {t('customTemplates.createFromTemplate.readOnlySource')}
              </span>
            </div>
            <p className="text-[var(--color-text-secondary)]">{selectedBuiltin.teamPrompt}</p>
            <div className="pt-1">
              <span className="font-semibold text-[var(--color-text)]">
                {t('customTemplates.preview.membersLabel')}:{' '}
              </span>
              <span className="text-[var(--color-text-muted)]">
                {selectedBuiltin.members.map((member) => member.name).join(', ')}
              </span>
            </div>
          </>
        ) : previewCustom ? (
          <>
            <div className="flex items-center justify-between text-[var(--color-text-muted)]">
              <span className="font-medium text-[var(--color-text)]">{previewCustom.name}</span>
              <span className="text-[11px] text-emerald-400">
                {t('customTemplates.createFromTemplate.sourceCustom')}
              </span>
            </div>
            <p className="text-[var(--color-text-secondary)]">
              {previewCustom.teamPrompt.trim()
                ? previewCustom.teamPrompt
                : t('customTemplates.preview.promptEmpty')}
            </p>
            <div className="pt-1">
              <span className="font-semibold text-[var(--color-text)]">
                {t('customTemplates.preview.membersLabel')}:{' '}
              </span>
              <span className="text-[var(--color-text-muted)]">
                {previewCustom.members.length > 0
                  ? previewCustom.members.map((member) => member.name).join(', ')
                  : t('customTemplates.preview.membersEmpty')}
              </span>
            </div>
          </>
        ) : (
          <p className="text-[var(--color-text-muted)]">
            {t('customTemplates.createFromTemplate.noneHint')}
          </p>
        )}
      </div>
    </div>
  );
};
