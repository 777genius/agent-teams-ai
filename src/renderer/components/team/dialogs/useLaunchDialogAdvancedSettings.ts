import { useCallback, useState } from 'react';

import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';

import type { TeamCreateRequest } from '@shared/types';

/** Existing advanced controls retain their legacy local preferences until owner hydration. */
export function useLaunchDialogAdvancedSettings(teamName: string, markEdited: () => void) {
  const [worktreeEnabled, setEnabled] = useState(
    () =>
      localStorage.getItem(`team:lastWorktreeEnabled:${teamName}`) === 'true' &&
      Boolean(localStorage.getItem(`team:lastWorktreeName:${teamName}`))
  );
  const [worktreeName, setName] = useState(
    () => localStorage.getItem(`team:lastWorktreeName:${teamName}`) ?? ''
  );
  const [customArgs, setArgs] = useState(
    () => localStorage.getItem(`team:lastCustomArgs:${teamName}`) ?? ''
  );
  const hydrate = useCallback((saved: TeamCreateRequest) => {
    setEnabled(Boolean(saved.worktree));
    setName(saved.worktree ?? '');
    setArgs(saved.extraCliArgs ?? '');
  }, []);
  return {
    worktreeEnabled,
    worktreeName,
    customArgs,
    hydrate,
    setWorktreeEnabled(value: boolean) {
      markEdited();
      setEnabled(value);
      localStorage.setItem(`team:lastWorktreeEnabled:${teamName}`, String(value));
      if (!value) {
        setName('');
        localStorage.setItem(`team:lastWorktreeName:${teamName}`, '');
      }
    },
    setWorktreeName(value: string) {
      markEdited();
      setName(value);
      localStorage.setItem(`team:lastWorktreeName:${teamName}`, value);
    },
    setCustomArgs(value: string) {
      markEdited();
      setArgs(value);
      localStorage.setItem(`team:lastCustomArgs:${teamName}`, value);
    },
  };
}

/** An owner's captured prompt wins over a late asynchronous local draft load. */
export function useLaunchDialogPrompt(key: string, markEdited: () => void) {
  const draft = useDraftPersistence({ key });
  const [owned, setOwned] = useState<{ key: string; value: string }>();
  const hydrate = useCallback(
    (value: string) => {
      setOwned({ key, value });
    },
    [key]
  );
  return {
    ...draft,
    value: owned?.key === key ? owned.value : draft.value,
    isSaved: owned?.key === key ? false : draft.isSaved,
    hydrate,
    setValue(value: string) {
      markEdited();
      // Protect user input as well as owner hydration from a pending draft load.
      setOwned({ key, value });
      draft.setValue(value);
    },
    setValueRaw(value: string) {
      setOwned(undefined);
      draft.setValue(value);
    },
    clearDraft() {
      setOwned(undefined);
      draft.clearDraft();
    },
  };
}
