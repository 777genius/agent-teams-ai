import {
  buildEffectiveTeamMemberSpecs,
  getExplicitLaunchModelSelection,
  normalizeTeamMemberProviderId,
} from './TeamProvisioningMemberSpecs';
import { buildMissingCliError } from './TeamProvisioningRuntimeFailureLabels';

import type { TeamCreateRequest, TeamLaunchRequest, TeamProviderBackendId } from '@shared/types';

export interface OpenCodeRuntimeDefaultProvisioningEnv {
  warning?: string;
  env: Record<string, string | undefined>;
  providerArgs?: string[];
}

export interface OpenCodeRuntimeDefaultsPorts {
  resolveClaudePath(): Promise<string | null>;
  buildProvisioningEnv(
    providerId: 'opencode',
    providerBackendId: TeamProviderBackendId | undefined
  ): Promise<OpenCodeRuntimeDefaultProvisioningEnv>;
  resolveProviderDefaultModel(
    claudePath: string,
    cwd: string,
    providerId: 'opencode',
    env: Record<string, string | undefined>,
    providerArgs: string[],
    limitContext: boolean
  ): Promise<string | null | undefined>;
}

export async function materializeOpenCodeRuntimeAdapterDefaults<
  TRequest extends TeamCreateRequest | TeamLaunchRequest,
>(
  params: {
    request: TRequest;
    members: TeamCreateRequest['members'];
  },
  ports: OpenCodeRuntimeDefaultsPorts
): Promise<{
  request: TRequest;
  members: TeamCreateRequest['members'];
}> {
  const effectiveMembers = buildEffectiveTeamMemberSpecs(params.members, {
    providerId: params.request.providerId,
    model: params.request.model,
    effort: params.request.effort,
  });
  const explicitRootModel = getExplicitLaunchModelSelection(params.request.model);
  const memberModels = [
    ...new Set(
      effectiveMembers
        .map((member) => member.model?.trim())
        .filter((model): model is string => Boolean(model))
    ),
  ];
  if (!explicitRootModel && memberModels.length > 1) {
    throw new Error(
      'OpenCode runtime adapter launch supports one selected model per lane. Select one team model or align OpenCode teammate models.'
    );
  }
  const inheritedRootModel = explicitRootModel ? undefined : memberModels[0];
  const rootModel = explicitRootModel ?? inheritedRootModel;
  const needsMemberModel = effectiveMembers.some((member) => {
    const providerId = normalizeTeamMemberProviderId(member.providerId) ?? 'opencode';
    return providerId === 'opencode' && !member.model?.trim();
  });
  if (rootModel && !needsMemberModel) {
    return {
      request: {
        ...params.request,
        model: rootModel,
      } as TRequest,
      members: effectiveMembers,
    };
  }
  if (rootModel) {
    return {
      request: {
        ...params.request,
        model: rootModel,
      } as TRequest,
      members: effectiveMembers.map((member) => {
        const providerId = normalizeTeamMemberProviderId(member.providerId) ?? 'opencode';
        if (providerId !== 'opencode' || member.model?.trim()) {
          return member;
        }
        return {
          ...member,
          model: rootModel,
        };
      }),
    };
  }

  const claudePath = await ports.resolveClaudePath();
  if (!claudePath) {
    throw buildMissingCliError();
  }
  const provisioningEnv = await ports.buildProvisioningEnv(
    'opencode',
    params.request.providerBackendId
  );
  if (provisioningEnv.warning) {
    throw new Error(provisioningEnv.warning);
  }
  const resolvedDefaultModel = await ports.resolveProviderDefaultModel(
    claudePath,
    params.request.cwd,
    'opencode',
    provisioningEnv.env,
    provisioningEnv.providerArgs ?? [],
    params.request.limitContext === true
  );
  const normalizedDefaultModel = resolvedDefaultModel?.trim();
  if (!normalizedDefaultModel) {
    throw new Error(
      'Could not resolve the runtime default model for OpenCode teammates. Select an explicit model and retry.'
    );
  }

  return {
    request: {
      ...params.request,
      model: normalizedDefaultModel,
    } as TRequest,
    members: effectiveMembers.map((member) => {
      const providerId = normalizeTeamMemberProviderId(member.providerId) ?? 'opencode';
      if (providerId !== 'opencode' || member.model?.trim()) {
        return member;
      }
      return {
        ...member,
        model: normalizedDefaultModel,
      };
    }),
  };
}
