import type {
  AuthoritativeModelExecutionProof,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningPrepareResult,
} from '@shared/types';

type PrepareProvisioning = (
  cwd?: string,
  providerId?: TeamProviderId,
  providerIds?: TeamProviderId[],
  selectedModels?: string[],
  limitContext?: boolean,
  modelVerificationMode?: 'compatibility' | 'deep',
  selectedModelChecks?: TeamProvisioningModelCheckRequest[],
  allowExperimentalLocalModels?: boolean,
  runtimeRosterRevision?: string
) => Promise<TeamProvisioningPrepareResult>;

export async function commitAuthoritativePrepareCandidate(input: {
  cwd: string;
  leadProviderId: TeamProviderId;
  providerIds: readonly TeamProviderId[];
  checksByProvider: ReadonlyMap<TeamProviderId, readonly TeamProvisioningModelCheckRequest[]>;
  limitContext?: boolean;
  allowExperimentalLocalModels?: boolean;
  runtimeRosterRevision: string;
  prepareProvisioning: PrepareProvisioning;
}): Promise<AuthoritativeModelExecutionProof> {
  const checks = Array.from(input.checksByProvider.values()).flatMap((entries) => [...entries]);
  if (
    checks.length === 0 ||
    checks.some(
      (check) =>
        !check.model.trim() ||
        !Object.hasOwn(check, 'providerBackendId') ||
        (check.providerId !== 'anthropic' &&
          (check.providerBackendId == null ||
            (check.providerBackendId === 'auto' && check.providerId !== 'codex')))
    )
  ) {
    throw new Error('Every launch route requires an exact model and concrete backend identity');
  }
  const result = await input.prepareProvisioning(
    input.cwd,
    input.leadProviderId,
    [...input.providerIds],
    Array.from(new Set(checks.map((check) => check.model))),
    input.limitContext,
    'deep',
    checks,
    input.allowExperimentalLocalModels === true,
    input.runtimeRosterRevision
  );
  if (!result.ready || !result.executionProof) {
    throw new Error(result.message || 'Authoritative exact-model execution proof was not issued');
  }
  return result.executionProof;
}
