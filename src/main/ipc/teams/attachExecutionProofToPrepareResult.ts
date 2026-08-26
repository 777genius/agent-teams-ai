import {
  OPEN_CODE_STRICT_LAUNCH_DELEGATION_CONTRACT_VERSION,
  readNativeModelTargetedLiveness,
  readOpenCodeStrictLaunchDelegation,
} from '@main/services/team/provisioning/TeamProvisioningLaunchPreparationEvidence';
import {
  issueAuthoritativeModelExecutionProof,
  releaseAuthoritativeProofEpoch,
} from '@main/services/team/TeamLaunchExecutionProofAuthority';

import type { AuthoritativeProofEpoch } from '@main/services/team/TeamLaunchExecutionProofAuthority';
import type {
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
} from '@shared/types';

function exactCheckKeys(checks: readonly TeamProvisioningModelCheckRequest[]): string[] {
  return checks
    .map((check) =>
      JSON.stringify({
        providerId: check.providerId,
        providerBackendId: Object.hasOwn(check, 'providerBackendId')
          ? (check.providerBackendId ?? null)
          : '<missing>',
        model: check.model.trim(),
        effort: check.effort ?? null,
      })
    )
    .sort();
}

function evidenceExactlyMatches(
  requested: readonly TeamProvisioningModelCheckRequest[],
  observed: readonly TeamProvisioningModelCheckRequest[]
): boolean {
  const requestedKeys = exactCheckKeys(requested);
  const observedKeys = exactCheckKeys(observed);
  return (
    new Set(requestedKeys).size === requestedKeys.length &&
    new Set(observedKeys).size === observedKeys.length &&
    requestedKeys.length === observedKeys.length &&
    requestedKeys.every((key, index) => key === observedKeys[index])
  );
}

export function attachExecutionProofToPrepareResult(input: {
  authorityEpoch: AuthoritativeProofEpoch;
  result: TeamProvisioningPrepareResult;
  cwd: string | undefined;
  mode: TeamProvisioningModelVerificationMode | undefined;
  checks: TeamProvisioningModelCheckRequest[] | undefined;
  allowExperimentalLocalModels?: boolean;
  runtimeRosterRevision?: unknown;
}): TeamProvisioningPrepareResult {
  try {
    if (!input.result.ready || !input.cwd || input.mode !== 'deep' || !input.checks?.length) {
      return input.result;
    }
    if (
      input.runtimeRosterRevision !== undefined &&
      (typeof input.runtimeRosterRevision !== 'string' ||
        input.runtimeRosterRevision.length === 0 ||
        input.runtimeRosterRevision.length > 256_000)
    ) {
      return {
        ...input.result,
        ready: false,
        message: 'runtimeRosterRevision must be a non-empty bounded string',
        executionProof: undefined,
      };
    }
    const exactChecks = input.checks.filter((check) => check.providerId === 'opencode');
    const nativeChecks = input.checks.filter((check) => check.providerId !== 'opencode');
    const openCodeDelegation = readOpenCodeStrictLaunchDelegation(input.result);
    if (
      exactChecks.length > 0 &&
      (openCodeDelegation?.contractVersion !==
        OPEN_CODE_STRICT_LAUNCH_DELEGATION_CONTRACT_VERSION ||
        !evidenceExactlyMatches(exactChecks, openCodeDelegation.checks))
    ) {
      return {
        ...input.result,
        ready: false,
        message:
          'Authoritative preparation did not establish strict OpenCode launch delegation for every provider/backend/model/effort check',
        executionProof: undefined,
      };
    }
    if (!evidenceExactlyMatches(nativeChecks, readNativeModelTargetedLiveness(input.result))) {
      return {
        ...input.result,
        ready: false,
        message:
          'Authoritative preparation did not complete every native model-targeted liveness check',
        executionProof: undefined,
      };
    }
    if (
      input.allowExperimentalLocalModels === true &&
      !input.result.issues?.some(
        (issue) =>
          issue.scope === 'model' &&
          issue.severity === 'warning' &&
          issue.experimentalOverrideAvailable === true
      )
    ) {
      return {
        ...input.result,
        ready: false,
        message: 'Experimental override was not backed by an explicitly eligible model failure',
        executionProof: undefined,
      };
    }
    try {
      return {
        ...input.result,
        executionProof: issueAuthoritativeModelExecutionProof({
          authorityEpoch: input.authorityEpoch,
          cwd: input.cwd,
          checks: input.checks,
          allowExperimentalLocalModels: input.allowExperimentalLocalModels === true,
          runtimeRosterRevision:
            typeof input.runtimeRosterRevision === 'string'
              ? input.runtimeRosterRevision
              : undefined,
        }),
      };
    } catch (error) {
      return {
        ...input.result,
        ready: false,
        message: error instanceof Error ? error.message : 'Launch authorization issuance failed',
        executionProof: undefined,
      };
    }
  } finally {
    releaseAuthoritativeProofEpoch(input.authorityEpoch);
  }
}
