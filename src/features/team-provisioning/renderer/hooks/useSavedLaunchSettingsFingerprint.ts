import { useEffect, useState } from 'react';

import { api } from '@renderer/api';

/** Capture once for this editor, never adopt newer defaults during relaunch hydration. */
export function useSavedLaunchSettingsFingerprint(teamName: string): string | null {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFingerprint(null);
    void api.teams
      .getSavedRequest(teamName)
      .then((saved) => {
        if (!cancelled) setFingerprint(saved?.savedSettingsFingerprint ?? null);
      })
      .catch(() => {
        /* Missing baseline must fail closed on relaunch. */
      });
    return () => {
      cancelled = true;
    };
  }, [teamName]);
  return fingerprint;
}
