import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const PRODUCTION_CONSTRUCTOR =
  'src/main/composition/hosted/createHostedApprovalProductionComposition.ts';
const PRODUCTION_ENVIRONMENT_COMPOSITION =
  'src/main/composition/hosted/createHostedApprovalProductionCompositionFromEnvironment.ts';
const PRODUCTION_GATE =
  'src/main/services/team/provisioning/HostedApprovalRuntimeAdmissionComposition.ts';

describe('hosted approval production admission', () => {
  it('mounts only activation-v2-ready signed v4 per-team routes without a fallback', async () => {
    await expect(access(PRODUCTION_CONSTRUCTOR)).resolves.toBeUndefined();
    const [
      standalone,
      environmentComposition,
      production,
      publicHosted,
      productionGate,
      actualOwnerEvidence,
      actualOwnerProcesses,
    ] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile(PRODUCTION_ENVIRONMENT_COMPOSITION, 'utf8'),
      readFile(PRODUCTION_CONSTRUCTOR, 'utf8'),
      readFile('src/features/team-approvals/main/hosted.ts', 'utf8'),
      readFile(PRODUCTION_GATE, 'utf8'),
      readFile('scripts/e2e/hosted-actual-owner/evidence.ts', 'utf8'),
      readFile('scripts/e2e/hosted-actual-owner/processes.ts', 'utf8'),
    ]);
    expect(environmentComposition).toContain(
      'const activationPublication =\n      readHostedApprovalRuntimeActivationPublicationContract(environment);'
    );
    expect(environmentComposition).toContain(
      'const composition = await createOptionalHostedApprovalProductionComposition({'
    );
    expect(environmentComposition).toContain('hosted-production-producer-provenance-required');
    expect(environmentComposition).toContain('installProductHostedProducerProvenance');
    expect(standalone).toMatch(
      /hostedOperatorProduction\s*=\s*await createHostedApprovalProductionCompositionFromEnvironment\(\s*hostedBootstrapEnvironment,/
    );
    expect(production).toContain('ownerAdmission.approvalRoutes.length === 0');
    expect(production).toContain('createHostedApprovalAdmissionAuthority');
    expect(production).toContain('activateHostedApprovalRuntime');
    expect(production).toContain('activationPublication');
    expect(production).toContain('dependencies.activationPublication.admissionDocument');
    expect(production).not.toContain('route.admissionDocument');
    expect(production).toContain('sameHostedApprovalActivationOwner');
    expect(production).toContain('const signedManifest = Object.freeze({');
    expect(production).toContain('activationLeases.every((lease) => lease.isReady())');
    expect(production).toContain('HostedApprovalRuntimeOrchestratorRouter');
    expect(production).toContain('candidate.teamId === teamId');
    expect(production).toContain('captureHostedApprovalRouteAuthority(dependencies, admission)');
    expect(production).toContain(
      "throw new Error('hosted-approval-production-route-binding-invalid')"
    );
    expect(production).toContain('dependencies.authentication !== version.authentication');
    expect(production).toContain('dependencies.approvalStorage !== version.approvalStorage');
    expect(production).toContain(
      'dependencies.approvalStorage[method] !== version.approvalStorageMethods[method]'
    );
    expect(production).toContain(
      'createApprovalRouteMutationLease(\n          route.socketPath,\n          request.ownerBinding,\n          activationLease\n        )'
    );
    expect(production).toContain('ownerGeneration: route.ownerGeneration');
    expect(production).toContain('ownerSessionId: route.ownerSessionId');
    expect(production).toContain('socketIdentity: Object.freeze({ ...route.socketIdentity })');
    expect(production).not.toContain('dependencies.mutationLease');
    expect(production).not.toMatch(/currentTeam|selectedTeam/);
    expect(production).not.toMatch(/legacy|fallback/iu);
    expect(publicHosted).not.toMatch(/hostedApprovalRuntimeProductCandidateRequest/);
    expect(publicHosted).toContain('HOSTED_APPROVAL_RUNTIME_WIRE_SCHEMA_VERSION');
    expect(productionGate).toContain('HOSTED_APPROVAL_RUNTIME_PRODUCTION_ELIGIBLE = false');
    expect(productionGate).toContain('HOSTED_APPROVAL_RUNTIME_ORCHESTRATOR_CAPABILITY = false');
    expect(actualOwnerEvidence).not.toContain('export function runtimeCaptureDocument');
    expect(actualOwnerEvidence).toContain('parseNativeRuntimeCapture');
    expect(actualOwnerEvidence).toContain('p3c_runtime_capture_producer_proof');
    expect(actualOwnerEvidence).toContain('p3c_runtime_capture_semantic_mapping_unavailable');
    expect(actualOwnerEvidence).not.toContain('recordType.startsWith');
    expect(actualOwnerProcesses).toContain('writerDescriptorsClosed');
    expect(actualOwnerProcesses).toContain("parentClose.closedErrno !== 'EBADF'");
  });
});
