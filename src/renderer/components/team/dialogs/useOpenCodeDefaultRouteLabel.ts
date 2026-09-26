import { useMemo, useState } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';

import {
  useLaunchInheritsLeadModel,
  useOpenCodeDefaultMaterialization,
} from './openCodeDefaultMaterialization';
import {
  formatOpenCodeDefaultRouteLabel,
  formatOpenCodeDefaultRouteModelLabel,
  type OpenCodeProjectDefaultModel,
  resolveOpenCodeProjectDefaultModel,
} from './openCodeDefaultModel';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

/**
 * The project's OpenCode Default route. The status of a background refresh
 * looks like the provisional first snapshot (the global catalog before the
 * project probe), so a refresh keeps this project's last settled answer
 * instead of flipping to unknown; only a project with no answer yet waits.
 */
export function useOpenCodeProjectDefaultModel(
  status: CliProviderStatus | null | undefined,
  projectPath: string | null | undefined
): OpenCodeProjectDefaultModel {
  const current = useMemo(() => resolveOpenCodeProjectDefaultModel(status), [status]);
  const projectKey = projectPath?.trim() ?? '';
  const [settled, setSettled] = useState<{
    projectKey: string;
    value: OpenCodeProjectDefaultModel;
  } | null>(null);
  if (
    current.state !== 'unknown' &&
    (settled?.projectKey !== projectKey || !isSameProjectDefault(settled.value, current))
  ) {
    setSettled({ projectKey, value: current });
  }
  return current.state === 'unknown' &&
    status?.modelCatalogRefreshState === 'loading' &&
    settled?.projectKey === projectKey
    ? settled.value
    : current;
}

function isSameProjectDefault(
  left: OpenCodeProjectDefaultModel,
  right: OpenCodeProjectDefaultModel
): boolean {
  return (
    left.state === right.state &&
    (left.state !== 'available' || right.state !== 'available' || left.model === right.model)
  );
}

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
  const projectDefault = useOpenCodeProjectDefaultModel(providerStatus, projectPath);
  return useMemo(() => {
    if (!enabled) return null;
    if (projectDefault.state !== 'available') return null;
    return {
      label: formatOpenCodeDefaultRouteLabel(projectDefault.model, providerStatus),
      modelLabel: formatOpenCodeDefaultRouteModelLabel(projectDefault.model, providerStatus),
    };
  }, [enabled, projectDefault, providerStatus]);
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

/**
 * The provider and model a roster row launches with, and the Default route
 * label when that is OpenCode Default. A row inherits the lead's model under
 * sync, and in Create/Launch also when main gives an unset teammate the lead's
 * model at launch.
 */
export function useMemberDraftRowModel(input: {
  member: { providerId?: TeamProviderId; model?: string };
  inheritedProviderId: TeamProviderId;
  inheritedModel: string;
  forced: boolean;
  projectPath: string | null | undefined;
}): {
  inheritsLeadModel: boolean;
  effectiveProviderId: TeamProviderId;
  effectiveModel: string | undefined;
  openCodeDefaultRoute: OpenCodeDefaultRouteLabel | null;
} {
  const { member, inheritedProviderId, inheritedModel } = input;
  const launchInherits = useLaunchInheritsLeadModel();
  const inheritsLeadModel =
    input.forced ||
    (launchInherits &&
      (!member.providerId || member.providerId === inheritedProviderId) &&
      !member.model?.trim() &&
      Boolean(inheritedModel.trim()));
  const effectiveProviderId = inheritsLeadModel
    ? inheritedProviderId
    : (member.providerId ?? inheritedProviderId);
  const effectiveModel = inheritsLeadModel ? inheritedModel : (member.model ?? inheritedModel);
  const openCodeDefaultRoute = useMaterializedOpenCodeDefaultRoute(
    input.projectPath,
    effectiveProviderId,
    effectiveModel,
    inheritsLeadModel
  );
  return { inheritsLeadModel, effectiveProviderId, effectiveModel, openCodeDefaultRoute };
}
