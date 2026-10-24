import { useEffect, useState } from 'react';

import { api } from '@renderer/api';

interface SavedLaunchSettings {
  fingerprint: string | null;
  syncModelsWithLead: boolean | null;
}

/** Capture once for this editor, never adopt newer defaults during relaunch hydration. */
export function useSavedLaunchSettings(teamName: string): SavedLaunchSettings {
  const [settings, setSettings] = useState<SavedLaunchSettings>({
    fingerprint: null,
    syncModelsWithLead: null,
  });
  useEffect(() => {
    let cancelled = false;
    setSettings({ fingerprint: null, syncModelsWithLead: null });
    void api.teams
      .getSavedRequest(teamName)
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
  }, [teamName]);
  return settings;
}
