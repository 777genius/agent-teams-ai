import type { ProviderPrepareDiagnosticsResult } from './providerPrepareDiagnosticsModels';
import type { TeamProvisioningPrepareResult } from '@shared/types';

type Prepare = (...args: never[]) => Promise<TeamProvisioningPrepareResult>;
/** Keep scope separate from reusable model presentation caches. Every last source read must agree. */
export function withCapturedTeamReadiness<T extends { prepareProvisioning: Prepare }>(
  run: (input: T) => Promise<ProviderPrepareDiagnosticsResult>
): (input: T) => Promise<ProviderPrepareDiagnosticsResult> {
  return async (input) => {
    let proof: TeamProvisioningPrepareResult['capturedTeamReadiness'];
    let createdProof: TeamProvisioningPrepareResult['createdTeamReadiness'];
    const prepareProvisioning = async (...args: Parameters<T['prepareProvisioning']>) => {
      try {
        const result = await input.prepareProvisioning(...args);
        proof = result.ready ? result.capturedTeamReadiness : undefined;
        createdProof = result.ready ? result.createdTeamReadiness : undefined;
        return result;
      } catch (error) {
        proof = undefined;
        createdProof = undefined;
        throw error;
      }
    };
    const result = await run({ ...input, prepareProvisioning } as T);
    return result.status === 'ready'
      ? {
          ...result,
          ...(proof ? { capturedTeamReadiness: proof } : {}),
          ...(createdProof ? { createdTeamReadiness: createdProof } : {}),
        }
      : result;
  };
}
