import { useEffect, useState } from 'react';

import { createTeamDraftStorage } from '@renderer/services/createTeamDraftStorage';

/** Read-only list indicator; the creation form owns editing and autosave. */
export function useCreateTeamDraftAvailability(creationOpen: boolean): boolean {
  const [hasDraft, setHasDraft] = useState(false);

  useEffect(() => {
    if (creationOpen) return;
    let active = true;
    void createTeamDraftStorage.loadSnapshot().then((draft) => {
      if (active) setHasDraft(Boolean(draft?.teamName.trim() || draft?.members.length));
    });
    return () => {
      active = false;
    };
  }, [creationOpen]);

  return hasDraft;
}
