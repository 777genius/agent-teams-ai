import type { OpenCodeLocalModelRuntimeReadiness } from './TeamProvisioningOpenCodeModelPreparation';
import type { EffortLevel, TeamProvisioningPrepareIssue } from '@shared/types';

export function normalizeOpenCodeExactModelChecks(
  modelIds: readonly string[],
  checks?: readonly { modelId: string; effort?: EffortLevel }[]
): { modelId: string; effort?: EffortLevel }[] {
  return checks?.length ? checks.map((check) => ({ ...check, modelId: check.modelId.trim() })) : modelIds.map((modelId) => ({ modelId }));
}

export function isEligibleExperimentalLocalModelOverride(
  allowed: boolean,
  readiness: OpenCodeLocalModelRuntimeReadiness | null | undefined
): boolean {
  return (
    allowed &&
    readiness?.severity === 'blocking' &&
    readiness.experimentalOverrideAvailable === true
  );
}

export function appendExperimentalLocalModelOverrideOutcome(input: {
  modelId: string;
  readiness: OpenCodeLocalModelRuntimeReadiness;
  details: string[];
  warnings: string[];
  issues: TeamProvisioningPrepareIssue[];
}): void {
  input.details.push(`Selected model ${input.modelId} verified for launch.`);
  const message =
    `Selected model ${input.modelId} passed the real execution probe under the explicitly ` +
    `eligible experimental local-model override. ${input.readiness.message}`;
  if (!input.warnings.includes(message)) input.warnings.push(message);
  input.issues.push({
    providerId: 'opencode', modelId: input.modelId, scope: 'model', severity: 'warning',
    code: input.readiness.code, message, experimentalOverrideAvailable: true,
  });
}
