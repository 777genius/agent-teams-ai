import { useCallback } from 'react';

import { api } from '@renderer/api';

import type {
  ImportCustomTeamTemplateResult,
  PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

/**
 * Hook for custom template import operations.
 *
 * Keeps the renderer presentational layer free of direct API imports while
 * centralizing the transport call behind a typed callback.
 */
export function useTemplateImport() {
  const importTemplate = useCallback(
    (portable: PortableCustomTeamTemplateV1): Promise<ImportCustomTeamTemplateResult> => {
      return api.customTeamTemplates.importTemplate({ portable });
    },
    []
  );

  return { importTemplate };
}
