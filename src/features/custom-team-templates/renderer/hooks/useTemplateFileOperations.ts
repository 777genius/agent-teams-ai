import { useMemo } from 'react';

import { api } from '@renderer/api';

import type {
  CustomTeamTemplatesBrowserFileApi,
  CustomTeamTemplatesDesktopFileApi,
} from '@features/custom-team-templates/contracts';

/**
 * Resolves which platform-specific file capability is available.
 *
 * Detection is explicit capability detection, not user-agent sniffing:
 * - Electron preload bridge exposes `desktopFile`
 * * Browser HTTP adapter exposes `browserFile`
 * - Neither means file import/export is unavailable in this environment.
 */
export function useTemplateFileOperations(): {
  platform: 'electron' | 'browser' | 'none';
  desktopFile: CustomTeamTemplatesDesktopFileApi | undefined;
  browserFile: CustomTeamTemplatesBrowserFileApi | undefined;
} {
  const apiRef = api.customTeamTemplates;

  return useMemo(() => {
    const desktopFile = apiRef.desktopFile;
    const browserFile = apiRef.browserFile;

    if (desktopFile) {
      return { platform: 'electron', desktopFile, browserFile: undefined };
    }
    if (browserFile) {
      return { platform: 'browser', desktopFile: undefined, browserFile };
    }
    return { platform: 'none', desktopFile: undefined, browserFile: undefined };
  }, [apiRef.desktopFile, apiRef.browserFile]);
}
