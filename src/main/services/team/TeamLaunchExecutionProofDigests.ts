import { createHash } from 'node:crypto';

import { stableJsonStringify } from '@features/application-command-ledger';

import { captureProjectRootIdentityLease } from './ProjectRootIdentityLease';

import type { ProjectRootIdentity } from './ProjectRootIdentityLease';
import type { TeamProvisioningModelCheckRequest } from '@shared/types';

function digest(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

export function executionProofRequestDigest(input: {
  cwd: string;
  checks: readonly TeamProvisioningModelCheckRequest[];
  allowExperimentalLocalModels?: boolean;
  runtimeRosterRevision?: string | null;
}): string {
  const projectLease = captureProjectRootIdentityLease(input.cwd);
  try {
    return executionProofRequestDigestForIdentity(input, projectLease.identity);
  } finally {
    projectLease.close();
  }
}

export function executionProofRequestDigestForIdentity(
  input: {
    checks: readonly TeamProvisioningModelCheckRequest[];
    allowExperimentalLocalModels?: boolean;
    runtimeRosterRevision?: string | null;
  },
  projectIdentity: ProjectRootIdentity
): string {
  const checks = input.checks.map((check) => ({
    providerId: check.providerId,
    providerBackendId: check.providerBackendId ?? null,
    model: check.model.trim(),
    effort: check.effort ?? null,
  }));
  const normalizedChecks = Array.from(
    new Map(checks.map((check) => [stableJsonStringify(check), check])).values()
  ).sort((left, right) => stableJsonStringify(left).localeCompare(stableJsonStringify(right)));
  return digest({
    projectIdentity,
    checks: normalizedChecks,
    allowExperimentalLocalModels: input.allowExperimentalLocalModels === true,
    runtimeRosterRevision: input.runtimeRosterRevision ?? null,
  });
}
