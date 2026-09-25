import { useMemo } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';

import {
  formatOpenCodeDefaultRouteLabel,
  formatOpenCodeDefaultRouteModelLabel,
  resolveOpenCodeProjectDefaultModel,
} from './openCodeDefaultModel';

export interface OpenCodeDefaultRouteLabel {
  /** "big-pickle (OpenCode Zen)" */
  label: string;
  /** "big-pickle", for places too narrow for the source */
  modelLabel: string;
}

/**
 * The route OpenCode "Default" launches in this project, or null while it is
 * unknown. Reads the same project-scoped status the dialogs materialize
 * Default from.
 */
export function useOpenCodeDefaultRouteLabel(
  projectPath: string | null | undefined
): OpenCodeDefaultRouteLabel | null {
  const { providerStatus } = useEffectiveCliProviderStatus('opencode', {
    projectPath: projectPath?.trim() || null,
  });
  return useMemo(() => {
    const projectDefault = resolveOpenCodeProjectDefaultModel(providerStatus);
    if (projectDefault.state !== 'available') return null;
    return {
      label: formatOpenCodeDefaultRouteLabel(projectDefault.model, providerStatus),
      modelLabel: formatOpenCodeDefaultRouteModelLabel(projectDefault.model, providerStatus),
    };
  }, [providerStatus]);
}
