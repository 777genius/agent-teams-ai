import { useEffect, useState } from 'react';

export type SavedLaunchSettingsReader = (
  teamName: string
) => Promise<{ savedSettingsFingerprint?: string; syncModelsWithLead?: boolean } | null>;

interface SavedLaunchSettings {
  fingerprint: string | null;
  syncModelsWithLead: boolean | null;
}

/** Capture once for this editor, never adopt newer defaults during relaunch hydration. */
export function useSavedLaunchSettingsFingerprint(
  teamName: string,
  getSavedRequest: SavedLaunchSettingsReader
): SavedLaunchSettings {
  const [settings, setSettings] = useState<SavedLaunchSettings>({
    fingerprint: null,
    syncModelsWithLead: null,
  });
  useEffect(() => {
    let cancelled = false;
    setSettings({ fingerprint: null, syncModelsWithLead: null });
    void getSavedRequest(teamName)
      .then((saved) => {
        if (!cancelled) {
          setSettings({
            fingerprint: saved?.savedSettingsFingerprint ?? null,
            syncModelsWithLead: saved?.syncModelsWithLead !== false,
          });
        }
      })
      .catch(() => {
        /* Missing baseline must fail closed on relaunch. */
      });
    return () => {
      cancelled = true;
    };
  }, [getSavedRequest, teamName]);
  return settings;
}
