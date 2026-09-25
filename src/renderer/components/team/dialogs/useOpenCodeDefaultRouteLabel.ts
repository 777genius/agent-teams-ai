import { useMemo } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';

import {
  formatOpenCodeDefaultRouteLabel,
  resolveOpenCodeProjectDefaultModel,
} from './openCodeDefaultModel';

/**
 * The route OpenCode "Default" launches in this project, formatted for a
 * trigger or card ("big-pickle (OpenCode Zen)"), or null while it is unknown.
 * Reads the same project-scoped status the dialogs materialize Default from.
 */
export function useOpenCodeDefaultRouteLabel(
  projectPath: string | null | undefined
): string | null {
  const { providerStatus } = useEffectiveCliProviderStatus('opencode', {
    projectPath: projectPath?.trim() || null,
  });
  return useMemo(() => {
    const projectDefault = resolveOpenCodeProjectDefaultModel(providerStatus);
    return projectDefault.state === 'available'
      ? formatOpenCodeDefaultRouteLabel(projectDefault.model, providerStatus)
      : null;
  }, [providerStatus]);
}
