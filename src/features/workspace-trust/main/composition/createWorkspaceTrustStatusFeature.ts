import type { LaunchTrustResult, WorkspaceTrustProjectStatusResult } from '../../contracts';
import type { WorkspaceTrustStatusDependencies } from '../application/WorkspaceTrustStatusDependencies';

export interface WorkspaceTrustStatusFeatureFacade {
  getLaunchStatus(request: unknown): Promise<LaunchTrustResult>;
  getProjectStatus(request: unknown): Promise<WorkspaceTrustProjectStatusResult>;
}

export function createWorkspaceTrustStatusFeature(
  dependencies: WorkspaceTrustStatusDependencies
): WorkspaceTrustStatusFeatureFacade {
  const getLaunchStatus = async (request: unknown): Promise<LaunchTrustResult> => {
    const valid = dependencies.validateRequest(request);
    const unknown: LaunchTrustResult = {
      providers: (valid?.providerIds ?? (['anthropic', 'codex'] as const)).map((providerId) => ({
        providerId,
        status: 'unknown',
      })),
    };
    if (!valid) return unknown;
    try {
      if (dependencies.isLocalContext && !dependencies.isLocalContext()) return unknown;
      return await dependencies.createReader().readLaunchStatus(valid);
    } catch {
      return unknown;
    }
  };
  return {
    getLaunchStatus,
    getProjectStatus: async (request) => {
      const result = await getLaunchStatus({
        projectPath:
          request && typeof request === 'object' && !Array.isArray(request)
            ? (request as Record<string, unknown>).projectPath
            : undefined,
        providerIds: ['anthropic'],
      });
      const provider = result.providers.find((entry) => entry.providerId === 'anthropic');
      return { status: provider?.status ?? 'unknown' };
    },
  };
}
