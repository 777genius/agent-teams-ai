import { toOpenCodeGatewayProviderId } from '@features/gateway-provider/main';
import { createMemberGatewayRuntimeSeams } from '@main/services/team/provisioning/TeamProvisioningMemberGatewayRuntime';
import { createLogger } from '@shared/utils/logger';

import { GatewayRunMetadataStore } from './GatewayRunMetadataStore';

import type { GatewayProviderFeatureFacade } from '@features/gateway-provider/main';
import type { OpenCodeLocalProviderConnector } from '@features/runtime-provider-management/main';
import type { TokenUsageRunDto } from '@features/token-usage/contracts';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';

/** Cross-feature integration belongs to the app shell, not either feature's policy. */
export function createGatewayLaunchRuntime(deps: {
  feature: Pick<
    GatewayProviderFeatureFacade,
    | 'resolveMemberConnection'
    | 'markRuntimeArtifactActive'
    | 'markRuntimeArtifactRetired'
    | 'listGatewayUsageSources'
  >;
  connector: Pick<
    OpenCodeLocalProviderConnector,
    'configureGatewayProvider' | 'retireGatewayProvider'
  >;
  onRetirementFailure?: () => void;
  runsPath: string;
}) {
  const metadata = new GatewayRunMetadataStore(deps.runsPath);
  const seams = createMemberGatewayRuntimeSeams({
    resolveMemberConnection: (...args) => deps.feature.resolveMemberConnection(...args),
    configureOpenCodeLocalProvider: (input, target) =>
      deps.connector.configureGatewayProvider(input, target),
    retireOpenCodeLocalProvider: (target) => deps.connector.retireGatewayProvider(target),
    markRuntimeArtifactActive: (ref) => deps.feature.markRuntimeArtifactActive(ref),
    markRuntimeArtifactRetired: (ref) => deps.feature.markRuntimeArtifactRetired(ref),
    snapshotLaunch: (input) => metadata.snapshotLaunch(input),
    abortUnspawnedLaunch: (id) => metadata.abortUnspawnedLaunch(id),
    confirmLaunchStopped: async (id) => {
      await metadata.confirmLaunchStopped(id);
      await retireStoppedArtifacts().catch(() => deps.onRetirementFailure?.());
    },
    confirmNativeTeamStopped: (teamName) => metadata.confirmNativeTeamStopped(teamName),
  });
  async function retireStoppedArtifacts(): Promise<void> {
    for (const source of await deps.feature.listGatewayUsageSources()) {
      if (
        source.hasActiveBinding ||
        !source.hasRuntimeArtifact ||
        (await metadata.hasUnfinishedRuns(source.gatewayUsageRef))
      )
        continue;
      try {
        await metadata.runWhenStopped(source.gatewayUsageRef, async () => {
          const target = {
            teamName: source.teamName,
            memberName: source.memberName,
            gatewayUsageRef: source.gatewayUsageRef,
          };
          const result = await deps.connector.retireGatewayProvider({
            ...target,
            providerId: toOpenCodeGatewayProviderId(target),
          });
          if (result.retired) await deps.feature.markRuntimeArtifactRetired(source.gatewayUsageRef);
        });
      } catch {
        deps.onRetirementFailure?.();
      }
    }
  }
  return {
    seams,
    retireStoppedArtifacts,
    wrapOpenCodeAdapter<T extends TeamLaunchRuntimeAdapter>(adapter: T): T {
      return new Proxy(adapter, {
        get(target, property) {
          if (property === 'launch')
            return async (input: Parameters<T['launch']>[0]) => {
              const snapshots: string[] = [];
              const sources = await deps.feature.listGatewayUsageSources();
              let result: Awaited<ReturnType<TeamLaunchRuntimeAdapter['launch']>>;
              try {
                for (const member of input.expectedMembers) {
                  const source = sources.find(
                    (source) =>
                      source.teamName === input.teamName &&
                      source.memberName === member.name &&
                      member.model?.startsWith(
                        `${toOpenCodeGatewayProviderId({ teamName: source.teamName, memberName: source.memberName, gatewayUsageRef: source.gatewayUsageRef })}/`
                      )
                  );
                  if (source)
                    snapshots.push(
                      await metadata.snapshotLaunch({
                        teamName: input.teamName,
                        memberName: member.name,
                        providerId: 'opencode',
                        gatewayUsageRef: source.gatewayUsageRef,
                      })
                    );
                }
                const currentSources = await deps.feature.listGatewayUsageSources();
                const missingArtifact = input.expectedMembers.some((member) =>
                  sources.some(
                    (source) =>
                      member.model?.startsWith(
                        `${toOpenCodeGatewayProviderId({ teamName: source.teamName, memberName: source.memberName, gatewayUsageRef: source.gatewayUsageRef })}/`
                      ) &&
                      !currentSources.find(
                        (current) => current.gatewayUsageRef === source.gatewayUsageRef
                      )?.hasRuntimeArtifact
                  )
                );
                if (missingArtifact) {
                  throw new Error(
                    'Gateway provider artifact changed during preparation. Retry the launch.'
                  );
                }
                result = await target.launch(input);
              } catch (error) {
                const cleanup = await Promise.allSettled(
                  snapshots.map((id) => metadata.abortUnspawnedLaunch(id))
                );
                if (cleanup.some((attempt) => attempt.status === 'rejected'))
                  createLogger('GatewayLaunchRuntime').warn(
                    'Could not close all rejected gateway launch snapshots.'
                  );
                throw error;
              }
              if (result.preLaunchGate)
                await Promise.all(snapshots.map((id) => metadata.abortUnspawnedLaunch(id)));
              else
                await metadata.recordOpenCodeSessions(
                  input.teamName,
                  Object.values(result.members),
                  snapshots
                );
              return result;
            };
          if (property === 'stop')
            return async (input: Parameters<T['stop']>[0]) => {
              const result = await target.stop(input);
              await metadata.confirmOpenCodeStopped(input.teamName, Object.values(result.members));
              await retireStoppedArtifacts().catch(() => deps.onRetirementFailure?.());
              return result;
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    async reconcileRuns(runs: readonly TokenUsageRunDto[]): Promise<TokenUsageRunDto[]> {
      const marked = await metadata.reconcileRuns(runs);
      await retireStoppedArtifacts();
      return marked;
    },
  };
}
