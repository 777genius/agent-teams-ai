import { createHash } from 'node:crypto';

import { createHostedApprovalAdmissionAuthority } from '@features/team-approvals/main/hosted';
import { parseRuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';
import { describe, expect, it } from 'vitest';

const authority = parseRuntimePermissionApprovalIngressAuthority({
  deploymentId: 'deployment_approval-pin',
  teamId: `team_${'1'.repeat(32)}`,
  runId: `run_${'2'.repeat(32)}`,
  planGeneration: 1,
  laneId: 'primary',
  providerId: 'anthropic',
  credentialGeneration: 1,
  credentialId: 'credential-1',
  sessionId: 'session-1',
  runtimeInstanceId: 'runtime-1',
  deliveryOwnerId: `member_${'3'.repeat(32)}`,
});

describe('createHostedApprovalAdmissionAuthority', () => {
  it('admits an exact authority only through the launcher-pinned canonical digest', async () => {
    const snapshot = { schemaVersion: 1 as const, approvalGeneration: 2, authorities: [authority] };
    const approvalDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex')}` as const;
    const admitted = createHostedApprovalAdmissionAuthority({
      pin: { state: 'active', approvalGeneration: 2, approvalDigest, ownerGeneration: 4 },
      snapshot,
    });
    expect(admitted).not.toBeNull();
    await expect(admitted!.getAdmittedIngressAuthority(authority)).resolves.toEqual(authority);
    expect(
      createHostedApprovalAdmissionAuthority({
        pin: {
          state: 'active',
          approvalGeneration: 2,
          approvalDigest: `sha256:${'0'.repeat(64)}`,
          ownerGeneration: 4,
        },
        snapshot,
      })
    ).toBeNull();
  });

  it.each([
    { state: 'provisioning' } as const,
    { state: 'restart_required', approvalGeneration: 2 } as const,
  ])('fails closed while lifecycle approval admission is $state', (pin) => {
    expect(createHostedApprovalAdmissionAuthority({ pin, snapshot: null })).toBeNull();
  });
});
