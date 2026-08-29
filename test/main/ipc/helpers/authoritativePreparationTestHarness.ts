import { attachExecutionProofToPrepareResult } from '@main/ipc/teams/attachExecutionProofToPrepareResult';
import {
  markNativeModelTargetedLiveness,
  markOpenCodeStrictLaunchDelegation,
} from '@main/services/team/provisioning/TeamProvisioningLaunchPreparationEvidence';
import { captureAuthoritativeProofEpoch } from '@main/services/team/TeamLaunchExecutionProofAuthority';

import type {
  AuthoritativeModelExecutionProof,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningPrepareResult,
} from '@shared/types';

/**
 * Lower-level tests use the production preparation coordinator to obtain proof.
 * Only TeamLaunchExecutionProofAuthority ledger unit tests may call its issuer directly.
 */
export function prepareAuthoritativeExecutionProof(input: {
  cwd: string;
  checks: TeamProvisioningModelCheckRequest[];
  runtimeRosterRevision?: string;
  allowExperimentalLocalModels?: boolean;
}): AuthoritativeModelExecutionProof {
  const nativeChecks = input.checks.filter((check) => check.providerId !== 'opencode');
  const openCodeChecks = input.checks.filter((check) => check.providerId === 'opencode');
  let result: TeamProvisioningPrepareResult = {
    ready: true,
    message: 'Fake exact-model probe completed',
    processedModelChecks: input.checks,
  };
  if (nativeChecks.length > 0) {
    result = markNativeModelTargetedLiveness(result, nativeChecks);
  }
  if (openCodeChecks.length > 0) {
    result = markOpenCodeStrictLaunchDelegation(result, {
      contractVersion: 1,
      checks: openCodeChecks,
    });
  }
  const prepared = attachExecutionProofToPrepareResult({
    authorityEpoch: captureAuthoritativeProofEpoch(input.cwd),
    result,
    cwd: input.cwd,
    mode: 'deep',
    checks: input.checks,
    runtimeRosterRevision: input.runtimeRosterRevision,
    allowExperimentalLocalModels: input.allowExperimentalLocalModels,
  });
  if (!prepared.ready || !prepared.executionProof) {
    throw new Error(prepared.message || 'Production preparation authority did not issue proof');
  }
  return prepared.executionProof;
}
