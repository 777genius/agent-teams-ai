import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const PRODUCTION_CONSTRUCTOR =
  'src/main/composition/hosted/createHostedApprovalProductionComposition.ts';
const PRODUCTION_ENVIRONMENT_COMPOSITION =
  'src/main/composition/hosted/createHostedApprovalProductionCompositionFromEnvironment.ts';
const PRODUCTION_GATE =
  'src/main/services/team/provisioning/HostedApprovalRuntimeAdmissionComposition.ts';

describe('hosted approval production admission', () => {
  it('mounts only activation-v1-ready signed v4 per-team routes without a fallback', async () => {
    await expect(access(PRODUCTION_CONSTRUCTOR)).resolves.toBeUndefined();
    const [standalone, environmentComposition, production, publicHosted, productionGate] =
      await Promise.all([
        readFile('src/main/standalone.ts', 'utf8'),
        readFile(PRODUCTION_ENVIRONMENT_COMPOSITION, 'utf8'),
        readFile(PRODUCTION_CONSTRUCTOR, 'utf8'),
        readFile('src/features/team-approvals/main/hosted.ts', 'utf8'),
        readFile(PRODUCTION_GATE, 'utf8'),
      ]);
    expect(environmentComposition).toMatch(
      /const activationPublication = readHostedApprovalRuntimeActivationPublicationContract\(environment\)/
    );
    expect(environmentComposition).toMatch(
      /return createOptionalHostedApprovalProductionComposition\(\{[\s\S]*activationPublication,[\s\S]*\}\)/
    );
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
    expect(production).toContain('signedManifest: Object.freeze');
    expect(production).toContain('activationLeases.every((lease) => lease.isReady())');
    expect(production).toContain('HostedApprovalRuntimeOrchestratorRouter');
    expect(production).toContain('candidate.teamId === teamId');
    expect(production).toContain(
      'createApprovalRouteMutationLease(admission, route, activationLease)'
    );
    expect(production).toContain('ownerGeneration: route.ownerGeneration');
    expect(production).toContain('ownerSessionId: route.ownerSessionId');
    expect(production).toContain('socketIdentity: route.socketIdentity');
    expect(production).not.toContain('dependencies.mutationLease');
    expect(production).not.toMatch(/currentTeam|selectedTeam/);
    expect(production).not.toMatch(/legacy|fallback/iu);
    expect(publicHosted).not.toMatch(/hostedApprovalRuntimeProductCandidateRequest/);
    expect(publicHosted).toContain('HOSTED_APPROVAL_RUNTIME_WIRE_SCHEMA_VERSION');
    expect(productionGate).toContain('HOSTED_APPROVAL_RUNTIME_PRODUCTION_ELIGIBLE = false');
    expect(productionGate).toContain('HOSTED_APPROVAL_RUNTIME_ORCHESTRATOR_CAPABILITY = false');
  });
});
