import { useMemo } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';

import { useOpenCodeDefaultMaterialization } from './openCodeDefaultMaterialization';
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
  projectPath: string | null | undefined,
  enabled = true
): OpenCodeDefaultRouteLabel | null {
  const { providerStatus } = useEffectiveCliProviderStatus(enabled ? 'opencode' : undefined, {
    projectPath: projectPath?.trim() || null,
  });
  return useMemo(() => {
    if (!enabled) return null;
    const projectDefault = resolveOpenCodeProjectDefaultModel(providerStatus);
    if (projectDefault.state !== 'available') return null;
    return {
      label: formatOpenCodeDefaultRouteLabel(projectDefault.model, providerStatus),
      modelLabel: formatOpenCodeDefaultRouteModelLabel(projectDefault.model, providerStatus),
    };
  }, [enabled, providerStatus]);
}

/** The Default route label for a row that sits on OpenCode Default inside Create/Launch. */
export function useMaterializedOpenCodeDefaultRoute(
  projectPath: string | null | undefined,
  providerId: string | undefined,
  model: string | null | undefined,
  inheritsLeadModel = false
): OpenCodeDefaultRouteLabel | null {
  const materializes = useOpenCodeDefaultMaterialization();
  return useOpenCodeDefaultRouteLabel(
    projectPath,
    materializes && providerId === 'opencode' && !model?.trim() && !inheritsLeadModel
  );
}
