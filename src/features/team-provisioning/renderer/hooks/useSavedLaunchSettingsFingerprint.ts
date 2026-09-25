import { useEffect, useState } from 'react';

export type SavedLaunchSettingsReader = (
  teamName: string
) => Promise<{ savedSettingsFingerprint?: string } | null>;

/** Capture once for this editor, never adopt newer defaults during relaunch hydration. */
export function useSavedLaunchSettingsFingerprint(
  teamName: string,
  getSavedRequest: SavedLaunchSettingsReader
): string | null {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFingerprint(null);
    void getSavedRequest(teamName)
      .then((saved) => {
        if (!cancelled) setFingerprint(saved?.savedSettingsFingerprint ?? null);
      })
      .catch(() => {
        /* Missing baseline must fail closed on relaunch. */
      });
    return () => {
      cancelled = true;
    };
  }, [getSavedRequest, teamName]);
  return fingerprint;
}
