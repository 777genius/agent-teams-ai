import {
  markNativeModelTargetedLiveness,
  markOpenCodeStrictLaunchDelegation,
  OPEN_CODE_STRICT_LAUNCH_DELEGATION_CONTRACT_VERSION,
} from './TeamProvisioningLaunchPreparationEvidence';

import type {
  TeamProvisioningModelCheckRequest,
  TeamProvisioningPrepareIssue,
  TeamProvisioningPrepareResult,
  TeamProvisioningSupportDiagnostic,
} from '@shared/types';

export function buildPrepareResultWithEvidence(input: {
  ready: boolean;
  message: string;
  details: string[];
  warnings: string[];
  issues: TeamProvisioningPrepareIssue[];
  supportDiagnostics: TeamProvisioningSupportDiagnostic[];
  processedModelChecks: TeamProvisioningModelCheckRequest[];
  nativeModelTargetedLivenessChecks: TeamProvisioningModelCheckRequest[];
  openCodeStrictDelegationChecks: TeamProvisioningModelCheckRequest[];
}): TeamProvisioningPrepareResult {
  const result: TeamProvisioningPrepareResult = {
    ready: input.ready,
    details: input.details.length > 0 ? input.details : undefined,
    message: input.message,
    warnings: input.warnings.length > 0 ? input.warnings : undefined,
    issues: input.issues.length > 0 ? input.issues : undefined,
    supportDiagnostics:
      input.supportDiagnostics.length > 0
        ? input.supportDiagnostics.map((diagnostic) => ({ ...diagnostic }))
        : undefined,
    processedModelChecks: input.processedModelChecks,
  };
  return markOpenCodeStrictLaunchDelegation(
    markNativeModelTargetedLiveness(result, input.nativeModelTargetedLivenessChecks),
    {
      contractVersion: OPEN_CODE_STRICT_LAUNCH_DELEGATION_CONTRACT_VERSION,
      checks: input.openCodeStrictDelegationChecks,
    }
  );
}
