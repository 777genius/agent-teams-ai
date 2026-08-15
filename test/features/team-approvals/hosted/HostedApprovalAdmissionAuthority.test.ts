import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseRuntimePermissionApprovalIngressAuthority } from '@features/team-approvals/contracts';
import { createHostedApprovalAdmissionAuthority } from '@features/team-approvals/main/hosted';
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
  it('consumes the orchestrator release-pinned canonical authority golden', async () => {
    const golden = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          'test/fixtures/hosted-approval-runtime-admission-v1.release-golden.json'
        ),
        'utf8'
      )
    ) as { canonicalJson: string; sha256: `sha256:${string}` };
    const snapshot = JSON.parse(golden.canonicalJson) as {
      readonly authorities: readonly unknown[];
    };
    const goldenAuthority = parseRuntimePermissionApprovalIngressAuthority(snapshot.authorities[0]);
    const admitted = createHostedApprovalAdmissionAuthority({
      pin: {
        state: 'active',
        approvalGeneration: 1,
        approvalDigest: golden.sha256,
        ownerGeneration: 2,
      },
      snapshot,
    });
    expect(admitted).not.toBeNull();
    await expect(admitted!.getAdmittedIngressAuthority(goldenAuthority)).resolves.toEqual(
      goldenAuthority
    );
  });

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
