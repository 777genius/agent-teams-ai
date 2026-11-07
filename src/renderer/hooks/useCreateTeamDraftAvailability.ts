import { useEffect, useState } from 'react';

import { createTeamDraftStorage } from '@renderer/services/createTeamDraftStorage';
import { draftStorage } from '@renderer/services/draftStorage';

/** Only saved, meaningful creation input counts as an unfinished draft. */
export async function hasUnfinishedCreateTeamDraft(): Promise<boolean> {
  const [form, description, prompt, chips] = await Promise.all([
    createTeamDraftStorage.loadSnapshot(),
    draftStorage.loadDraft('createTeam:description'),
    draftStorage.loadDraft('createTeam:prompt'),
    draftStorage.loadDraft('createTeam:prompt:chips'),
  ]);
  return Boolean(
    form?.teamName.trim() ||
      form?.members.length ||
      form?.customCwd.trim() ||
      form?.teamColor.trim() ||
      form?.organizationPlacementEnabled ||
      description?.trim() ||
      prompt?.trim() ||
      (chips != null && chips.trim() !== '' && chips.trim() !== '[]')
  );
}

/** Read-only list indicator; the creation form owns editing and autosave. */
export function useCreateTeamDraftAvailability(creationOpen: boolean): boolean {
  const [hasDraft, setHasDraft] = useState(false);

  useEffect(() => {
    if (creationOpen) return;
    let active = true;
    void hasUnfinishedCreateTeamDraft().then((saved) => {
      if (active) setHasDraft(saved);
    });
    return () => {
      active = false;
    };
  }, [creationOpen]);

  return hasDraft;
}
