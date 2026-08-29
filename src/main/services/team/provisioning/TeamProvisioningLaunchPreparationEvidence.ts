import type {
  TeamProvisioningModelCheckRequest,
  TeamProvisioningPrepareResult,
} from '@shared/types';

export const OPEN_CODE_STRICT_LAUNCH_DELEGATION_CONTRACT_VERSION = 1 as const;

interface LaunchPreparationEvidence {
  nativeModelTargetedLivenessChecks: readonly TeamProvisioningModelCheckRequest[];
  openCodeStrictLaunchDelegation?: {
    contractVersion: typeof OPEN_CODE_STRICT_LAUNCH_DELEGATION_CONTRACT_VERSION;
    checks: readonly TeamProvisioningModelCheckRequest[];
  };
}

const evidenceByResult = new WeakMap<TeamProvisioningPrepareResult, LaunchPreparationEvidence>();

function cloneChecks(
  checks: readonly TeamProvisioningModelCheckRequest[]
): TeamProvisioningModelCheckRequest[] {
  return checks.map((check) => ({ ...check }));
}

function updateEvidence(
  result: TeamProvisioningPrepareResult,
  update: Partial<LaunchPreparationEvidence>
): TeamProvisioningPrepareResult {
  const current = evidenceByResult.get(result);
  evidenceByResult.set(result, {
    nativeModelTargetedLivenessChecks:
      update.nativeModelTargetedLivenessChecks ?? current?.nativeModelTargetedLivenessChecks ?? [],
    ...(update.openCodeStrictLaunchDelegation
      ? { openCodeStrictLaunchDelegation: update.openCodeStrictLaunchDelegation }
      : current?.openCodeStrictLaunchDelegation
        ? { openCodeStrictLaunchDelegation: current.openCodeStrictLaunchDelegation }
        : {}),
  });
  return result;
}

export function markNativeModelTargetedLiveness(
  result: TeamProvisioningPrepareResult,
  checks: readonly TeamProvisioningModelCheckRequest[]
): TeamProvisioningPrepareResult {
  return updateEvidence(result, {
    nativeModelTargetedLivenessChecks: cloneChecks(checks),
  });
}

export function markOpenCodeStrictLaunchDelegation(
  result: TeamProvisioningPrepareResult,
  input: {
    contractVersion: typeof OPEN_CODE_STRICT_LAUNCH_DELEGATION_CONTRACT_VERSION;
    checks: readonly TeamProvisioningModelCheckRequest[];
  }
): TeamProvisioningPrepareResult {
  return updateEvidence(result, {
    openCodeStrictLaunchDelegation: {
      contractVersion: input.contractVersion,
      checks: cloneChecks(input.checks),
    },
  });
}

export function copyLaunchPreparationEvidence(
  source: TeamProvisioningPrepareResult,
  target: TeamProvisioningPrepareResult
): TeamProvisioningPrepareResult {
  const evidence = evidenceByResult.get(source);
  if (!evidence) return target;
  evidenceByResult.set(target, {
    nativeModelTargetedLivenessChecks: cloneChecks(evidence.nativeModelTargetedLivenessChecks),
    ...(evidence.openCodeStrictLaunchDelegation
      ? {
          openCodeStrictLaunchDelegation: {
            contractVersion: evidence.openCodeStrictLaunchDelegation.contractVersion,
            checks: cloneChecks(evidence.openCodeStrictLaunchDelegation.checks),
          },
        }
      : {}),
  });
  return target;
}

export function readNativeModelTargetedLiveness(
  result: TeamProvisioningPrepareResult
): readonly TeamProvisioningModelCheckRequest[] {
  return evidenceByResult.get(result)?.nativeModelTargetedLivenessChecks ?? [];
}

export function readOpenCodeStrictLaunchDelegation(result: TeamProvisioningPrepareResult):
  | {
      contractVersion: typeof OPEN_CODE_STRICT_LAUNCH_DELEGATION_CONTRACT_VERSION;
      checks: readonly TeamProvisioningModelCheckRequest[];
    }
  | undefined {
  return evidenceByResult.get(result)?.openCodeStrictLaunchDelegation;
}
