import React, { useState } from 'react';

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
  /** Whether the surrounding creation dialog is open; drives library loading. */
  open: boolean;
  /**
   * Receives the wholesale draft for every explicit choice, plus which kind
   * of source produced it. The dialog applies builtin/custom drafts exactly
   * like the previous built-in picker (description, prompt and members are
   * replaced, never merged), so switching templates cannot leak draft data
   * from the previously selected template. A `none` source resets only the
   * template-derived content fields and leaves launch/runtime settings alone.
   */
  onApply: (draft: CreateTeamTemplateDraft, source: 'none' | 'builtin' | 'custom') => void;
}

/**
 * Optional template selector for team creation.
 *
 * The default selection (`none`) preserves the ordinary no-template creation
 * experience. Built-in templates come from the closed static catalogue;
 * custom templates come from the persisted library via the existing
 * read-only list operation. Applying a template only prefills the creation
 * form — creation itself still goes through the dialog's unchanged submit
 * path, and no team-creation request is sent from this picker.
 */
export const CreateTeamTemplatePicker = ({
  open,
  onApply,
}: CreateTeamTemplatePickerProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { state, reload } = useCustomTemplateLibrary(open);

  const [selection, setSelection] = useState<string>(CREATE_TEAM_TEMPLATE_NONE_VALUE);
  const [lastCustomSnapshot, setLastCustomSnapshot] = useState<CustomTeamTemplateV1 | null>(null);

  // No reset-on-open here by design: the creation form itself persists drafts
  // across dialog opens, and the surrounding dialog content unmounts on close
  // (fresh picker for a fresh dialog). Keeping the selection lets a reopen
  // reload detect that the selected custom template was deleted elsewhere
  // and surface the stale warning instead of silently dropping it.

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
    // Re-clicking the active option is a no-op: re-applying the same draft
    // must never toggle dialog settings as a side effect.
    if (value === selection) return;
    const result = resolveCreateTeamTemplateDraft(value, {
      builtins: TEAM_TEMPLATES,
      customs,
    });
    switch (result.status) {
      case 'none':
        setSelection(value);
        onApply(result.draft, 'none');
        return;
      case 'builtin':
        setSelection(value);
        onApply(result.draft, 'builtin');
        return;
      case 'custom': {
        const record = customs.find((entry) => entry.templateId === result.templateId) ?? null;
        setSelection(value);
        setLastCustomSnapshot(record);
        onApply(result.draft, 'custom');
        return;
      }
      default:
        // `builtinNotFound`, `customNotFound` and `unknownSelection` cannot be
        // produced by the rendered options; ignore defensively so a stale or
        // forged value can never apply the wrong content.
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

      <button
        type="button"
        data-testid="create-template-option-none"
        aria-pressed={selection === CREATE_TEAM_TEMPLATE_NONE_VALUE}
        className={`w-full ${optionClass(selection === CREATE_TEAM_TEMPLATE_NONE_VALUE)}`}
        onClick={() => handleSelect(CREATE_TEAM_TEMPLATE_NONE_VALUE)}
      >
        <span className="text-sm font-semibold text-[var(--color-text)]">
          {t('customTemplates.createFromTemplate.noneLabel')}
        </span>
        <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
          {t('customTemplates.createFromTemplate.noneHint')}
        </span>
      </button>

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
              <button
                key={template.id}
                type="button"
                data-testid={`create-template-option-builtin-${template.id}`}
                aria-pressed={active}
                className={optionClass(active)}
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
              </button>
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
                <button
                  key={template.templateId}
                  type="button"
                  data-testid={`create-template-option-custom-${template.templateId}`}
                  aria-pressed={active}
                  className={optionClass(active)}
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
                </button>
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
