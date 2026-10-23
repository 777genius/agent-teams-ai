import { useEffect, useRef, useState } from 'react';

import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';

import {
  type CreateTeamTemplateSource,
  readStoredTemplateSelection,
  type StoredTemplateSelection,
} from './createTeamTemplateSelectionRestore';

export interface UseCreateTeamTemplateSelectionOptions {
  /** True when the dialog was populated from existing team data; template state must be cleared then. */
  initialData: boolean;
}

export interface UseCreateTeamTemplateSelectionResult {
  /**
   * Persistence draft for the picker selection, owned by this hook.
   *
   * `value` is the serialized JSON `{"source": "...", "value": "..."}` written
   * by the dialog's `onApply` handler; `clearDraft` removes it (used when the
   * dialog is populated from existing team data).
   */
  templateSelectionDraft: {
    value: string;
    setValue: (value: string) => void;
    isSaved: boolean;
    clearDraft: () => void;
    isLoaded: boolean;
  };
  /** True once the persisted template selection has been restored (or confirmed absent). */
  templateSelectionHydrated: boolean;
  /** Template source that prefilled the current form; keeps the prompt field
   * visible for template-driven config-only creation (`launchTeam=false`). */
  appliedTemplateSource: CreateTeamTemplateSource;
  /** Records the applied template source without re-applying template
   * content, so apply/restore never overwrites user edits. */
  setAppliedTemplateSource: (source: CreateTeamTemplateSource) => void;
  /** Parsed selection (`source` + `value`) from the persisted draft, or the
   * empty/invalid defaults. */
  storedTemplateSelection: StoredTemplateSelection;
  /** Clears the applied source and deletes the persisted draft; mirrors the
   * former inline reset of `setAppliedTemplateSource('none')` +
   * `templateSelectionDraft.clearDraft()` in `resetFormState`. */
  clearTemplateSelection: () => void;
}

/**
 * Focused hook for the template-selection state of `CreateTeamDialog`.
 *
 * It owns the persisted picker selection draft, the applied source used to
 * keep the prompt field visible for template-driven config-only creation, and
 * the async restoration of that source. The picker's `onApply` handler stays
 * in the dialog so the template content is applied by the component that
 * owns the form state.
 */
export function useCreateTeamTemplateSelection({
  initialData,
}: UseCreateTeamTemplateSelectionOptions): UseCreateTeamTemplateSelectionResult {
  const templateSelectionDraft = useDraftPersistence({
    key: 'createTeam:templateSelection',
  });

  // Template source that prefilled the current form; keeps the prompt field
  // visible for template-driven config-only creation (launchTeam=false).
  const [appliedTemplateSource, setAppliedTemplateSource] =
    useState<CreateTeamTemplateSource>('none');
  const storedTemplateSelection = readStoredTemplateSelection(templateSelectionDraft.value);

  // Copy Team's initial template reset must happen only once per dialog session,
  // not on every persisted draft change (which would repeatedly clear drafts and
  // race with later restoration).
  const initialResetDoneRef = useRef(false);

  useEffect(() => {
    if (initialData) {
      if (!initialResetDoneRef.current) {
        initialResetDoneRef.current = true;
        setAppliedTemplateSource('none');
        templateSelectionDraft.clearDraft();
      }
      return;
    }
    const { source } = readStoredTemplateSelection(templateSelectionDraft.value);
    if (source) setAppliedTemplateSource(source);
  }, [templateSelectionDraft.value, initialData, templateSelectionDraft]);

  const clearTemplateSelection = (): void => {
    setAppliedTemplateSource('none');
    templateSelectionDraft.clearDraft();
  };

  return {
    templateSelectionDraft,
    appliedTemplateSource,
    setAppliedTemplateSource,
    storedTemplateSelection,
    clearTemplateSelection,
    templateSelectionHydrated: templateSelectionDraft.isLoaded,
  };
}
