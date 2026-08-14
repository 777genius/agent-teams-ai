import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const PRODUCTION_CONSTRUCTOR =
  'src/main/composition/hosted/createHostedApprovalProductionComposition.ts';

describe('hosted approval production admission', () => {
  it('mounts only signed v4 per-team routes without a current-team fallback', async () => {
    await expect(access(PRODUCTION_CONSTRUCTOR)).resolves.toBeUndefined();
    const [standalone, production, publicHosted] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile(PRODUCTION_CONSTRUCTOR, 'utf8'),
      readFile('src/features/team-approvals/main/hosted.ts', 'utf8'),
    ]);
    expect(standalone).toMatch(/createOptionalHostedApprovalProductionComposition/);
    expect(production).toContain('ownerAdmission.approvalRoutes.length === 0');
    expect(production).toContain('createHostedApprovalAdmissionAuthority');
    expect(production).toContain('HostedApprovalRuntimeOrchestratorRouter');
    expect(production).toContain('candidate.teamId === teamId');
    expect(production).toContain('createApprovalRouteMutationLease(admission, route)');
    expect(production).toContain('ownerGeneration: route.ownerGeneration');
    expect(production).toContain('ownerSessionId: route.ownerSessionId');
    expect(production).toContain('socketIdentity: route.socketIdentity');
    expect(production).not.toContain('dependencies.mutationLease');
    expect(production).not.toMatch(/currentTeam|selectedTeam/);
    expect(publicHosted).not.toMatch(/hostedApprovalRuntimeProductCandidateRequest/);
    expect(publicHosted).toContain('HOSTED_APPROVAL_RUNTIME_WIRE_SCHEMA_VERSION');
  });
});
