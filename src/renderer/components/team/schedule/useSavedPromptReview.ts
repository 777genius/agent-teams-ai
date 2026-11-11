import { useEffect, useState } from 'react';

import { api } from '@renderer/api';

export interface SavedPromptReview {
  teamName: string;
  prompt: string;
  confirmed: boolean;
}

/** Preview saved one-time instructions; submit re-reads them authoritatively. */
export function useSavedPromptReview(input: {
  open: boolean;
  enabled: boolean;
  teamName: string;
  scheduleId?: string;
  reviewed: boolean;
}) {
  const { open, enabled, teamName, scheduleId, reviewed } = input;
  const [review, setReview] = useState<SavedPromptReview | null>(null);

  useEffect(() => setReview(null), [teamName, scheduleId, open]);
  useEffect(() => {
    if (!open || !enabled || !teamName) return;
    let cancelled = false;
    void api.teams.getSavedRequest(teamName).then((saved) => {
      if (cancelled) return;
      const prompt = saved?.prompt?.trim() ?? '';
      if (!prompt) {
        setReview(null);
        return;
      }
      setReview((current) =>
        current?.teamName === teamName && current.prompt === prompt
          ? current
          : { teamName, prompt, confirmed: reviewed }
      );
    }).catch(() => {
      // The submit path performs the authoritative read and reports errors.
    });
    return () => { cancelled = true; };
  }, [enabled, open, reviewed, teamName]);

  return [review, setReview] as const;
}
