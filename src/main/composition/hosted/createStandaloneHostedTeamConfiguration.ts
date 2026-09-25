import type { HostedAccessFeature } from '@features/hosted-access/main';
import type { TeamIdentityReadGateway } from '@features/internal-storage/main';
// eslint-disable-next-line no-restricted-imports -- Hosted storage composition is main-process-only.
import type { createHostedPromotionStorageBackend } from '@features/internal-storage/main/hosted';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

import type { HostedAuthStorageBackend } from '../../http';

import type { HostedDraftPublicationComposition } from './hostedDraftPublicationComposition';
import {
  createHostedTeamConfigurationComposition,
  createHostedTeamConfigurationRouteAdmissionBinding,
  type HostedTeamConfigurationComposition,
} from './hostedTeamConfigurationComposition';
import type { TeamLifecycleCommandComposition } from './teamLifecycleCommandComposition';

export function createStandaloneHostedTeamConfiguration(params: {
  readonly hostedDiagnosticsRuntimeInstance: RuntimeInstanceContext | null;
  readonly hostedAccessFeature: HostedAccessFeature;
  readonly teamIdentityGrantFenceSource: TeamIdentityReadGateway | null;
  readonly hostedDraftPublication: HostedDraftPublicationComposition | null;
  readonly hostedAuthStorageBackend: HostedAuthStorageBackend;
  readonly hostedPromotionStorage: ReturnType<typeof createHostedPromotionStorageBackend> | null;
  readonly promotionRoot: string | null;
  readonly hostedLifecycleCommands: TeamLifecycleCommandComposition | null;
  readonly isReady: () => boolean;
}): HostedTeamConfigurationComposition | null {
  const {
    hostedDiagnosticsRuntimeInstance,
    hostedAccessFeature,
    teamIdentityGrantFenceSource,
    hostedDraftPublication,
    hostedAuthStorageBackend,
    hostedPromotionStorage,
    promotionRoot,
    hostedLifecycleCommands,
    isReady,
  } = params;
  return hostedDiagnosticsRuntimeInstance === null
    ? null
    : createHostedTeamConfigurationComposition({
        authentication: hostedAccessFeature.http,
        publication: teamIdentityGrantFenceSource === null ? null : hostedDraftPublication,
        restoreGeneration: hostedAccessFeature.restoreGeneration,
        storage: hostedAuthStorageBackend.teamConfigurations,
        ...(hostedPromotionStorage === null
          ? {}
          : {
              promotions: hostedPromotionStorage.promotions,
              promotionWorkspaceRoot: promotionRoot!,
              ...(hostedLifecycleCommands === null
                ? {}
                : {
                    admitPromotionPlan: (
                      input: Parameters<
                        NonNullable<
                          Parameters<
                            typeof createHostedTeamConfigurationComposition
                          >[0]['admitPromotionPlan']
                        >
                      >[0],
                      context: Parameters<
                        NonNullable<
                          Parameters<
                            typeof createHostedTeamConfigurationComposition
                          >[0]['admitPromotionPlan']
                        >
                      >[1],
                      httpRequest: object,
                      promotionFence: Parameters<
                        NonNullable<
                          Parameters<
                            typeof createHostedTeamConfigurationComposition
                          >[0]['admitPromotionPlan']
                        >
                      >[3]
                    ) =>
                      hostedLifecycleCommands!.admitPromotionPlan(
                        input,
                        context,
                        httpRequest,
                        promotionFence
                      ),
                  }),
            }),
        runtimeInstance: hostedDiagnosticsRuntimeInstance,
        expectedDeploymentId: hostedAccessFeature.deploymentId,
        routeAdmissionBinding: createHostedTeamConfigurationRouteAdmissionBinding(isReady),
      });
}
