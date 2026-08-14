import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type AuthoritativeHostedApprovalRuntimeBinding,
  HostedApprovalRuntimeAdmissionPublisher,
  HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE,
} from '../HostedApprovalRuntimeAdmissionPublisher';

const ARTIFACT = `sha256:${'a'.repeat(64)}` as const;
const TEAM_ID = parseTeamId(`team_${'1'.repeat(32)}`);
const MEMBER_ID = parseMemberId(`member_${'2'.repeat(32)}`);
const cleanup: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = join('/tmp', `approval-publisher-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function binding(
  overrides: {
    ownerGeneration?: number;
    sessionId?: string;
    memberId?: typeof MEMBER_ID;
    artifactDigest?: `sha256:${string}`;
    toolApprovalMode?: 'manual' | 'auto';
    capabilityProtocol?: string;
    capabilityGeneration?: string;
    ownerPid?: number;
  } = {}
): AuthoritativeHostedApprovalRuntimeBinding {
  const memberId = overrides.memberId ?? MEMBER_ID;
  const runtimeInstanceId = `runtime_instance_${'3'.repeat(32)}`;
  const authority = {
    deploymentId: parseDeploymentId('deployment_approval-test'),
    teamId: TEAM_ID,
    runId: parseRunId(`run_${'4'.repeat(32)}`),
    planGeneration: 7,
    laneId: 'primary',
    providerId: 'opencode' as const,
    credentialGeneration: 5,
    credentialId: 'credential_approval-test',
    sessionId: overrides.sessionId ?? 'session_approval-test',
    runtimeInstanceId,
    deliveryOwnerId: memberId,
  };
  return {
    outerAuthority: {
      deploymentId: authority.deploymentId,
      bootId: 'boot_approval-test',
      workspaceId: 'workspace_approval-test',
      teamId: TEAM_ID,
      restoreGeneration: 2,
      mountBinding: { mountGeneration: 3, declaredRootHash: '5'.repeat(64) },
    },
    memberIdsByName: { lead: memberId },
    actorMembers: { actor_owner: memberId },
    owner: {
      teamId: TEAM_ID,
      ownerAuthority: 'owner-authority_approval-test',
      ownerGeneration: overrides.ownerGeneration ?? 1,
      ownerSessionId: `owner-session_approval-test-${overrides.ownerGeneration ?? 1}`,
      socketPath: '/run/agent-teams-orchestrator/approval.sock',
      socketIdentity: { device: '10', inode: '11', uid: 1000, gid: 1000, mode: 0o660 },
      processIdentity: {
        pid: overrides.ownerPid ?? 2345,
        startIdentity: 'process-start_approval-test',
      },
    },
    capability: {
      schemaVersion: 2,
      protocol: (overrides.capabilityProtocol ??
        'agent-teams-hosted-approval-v2') as 'agent-teams-hosted-approval-v2',
      authentication: 'opencode-basic',
      runtimeInstanceId,
      configGeneration: overrides.capabilityGeneration ?? `config_generation_${'6'.repeat(32)}`,
    },
    routes: [
      {
        routeId: 'route_approval-test',
        authority,
        scope: {
          principalId: 'actor_owner',
          workspaceId: 'workspace_approval-test',
          teamId: TEAM_ID,
          authorityGeneration: 'generation_approval-test',
          restoreGeneration: 2,
        },
        memberName: 'lead',
        openCodeBinding: {
          toolApprovalMode: (overrides.toolApprovalMode ?? 'manual') as 'manual',
          planGeneration: authority.planGeneration,
          credentialGeneration: authority.credentialGeneration,
          credentialId: authority.credentialId,
          runtimeInstanceId,
          deliveryOwnerId: memberId,
          openCodeArtifactDigest: overrides.artifactDigest ?? ARTIFACT,
          sessionRecordFingerprint: '7'.repeat(64),
          liveEffectFingerprint: '8'.repeat(64),
        },
      },
    ],
  };
}

async function harness(initial = binding()) {
  const directory = await temporaryDirectory();
  const admissionPath = join(directory, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE);
  let current: AuthoritativeHostedApprovalRuntimeBinding | null = initial;
  let expectedDigest: `sha256:${string}` | null = ARTIFACT;
  let beforeCommit: (() => Promise<void>) | undefined;
  const publisher = new HostedApprovalRuntimeAdmissionPublisher({
    resolveAdmissionPath: () => admissionPath,
    resolveAuthoritativeBinding: async () => current,
    resolveExpectedOpenCodeArtifactDigest: async () => expectedDigest,
    beforeCommit: async () => beforeCommit?.(),
  });
  return {
    admissionPath,
    publisher,
    setBinding(value: AuthoritativeHostedApprovalRuntimeBinding | null) {
      current = value;
    },
    setExpectedDigest(value: `sha256:${string}` | null) {
      expectedDigest = value;
    },
    setBeforeCommit(value: (() => Promise<void>) | undefined) {
      beforeCommit = value;
    },
  };
}

describe('HostedApprovalRuntimeAdmissionPublisher', () => {
  it('publishes canonical exact-schema private JSON and requests the second generation', async () => {
    const { admissionPath, publisher } = await harness();
    const result = await publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });

    expect(result).toMatchObject({ state: 'restart_required', approvalGeneration: 1 });
    const raw = await readFile(admissionPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(raw).toBe(`${JSON.stringify(parsed)}\n`);
    expect(Object.keys(parsed)).toEqual([
      'schemaVersion',
      'admissionGeneration',
      'outerAuthority',
      'routes',
      'actorMembers',
    ]);
    expect(parsed.admissionGeneration).toBe('approval-admission-generation_1_owner_1');
    expect((await lstat(admissionPath)).mode & 0o777).toBe(0o600);
  });

  it('activates only on a later owner generation pinned to the exact published bytes', async () => {
    const state = await harness();
    const first = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });
    expect(first.state).toBe('restart_required');
    if (first.state !== 'restart_required') throw new Error('unexpected state');
    state.setBinding(binding({ ownerGeneration: 2 }));

    await expect(
      state.publisher.reconcile('team-a', {
        state: 'active',
        ownerGeneration: 2,
        approvalGeneration: first.approvalGeneration,
        approvalDigest: first.approvalDigest,
      })
    ).resolves.toEqual({
      state: 'active',
      ownerGeneration: 2,
      approvalGeneration: first.approvalGeneration,
      approvalDigest: first.approvalDigest,
    });
  });

  it('rotates and increments generation on every authoritative binding change', async () => {
    const state = await harness();
    const first = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });
    state.setBinding(binding({ ownerGeneration: 2, sessionId: 'session_rotated' }));
    const rotated = await state.publisher.reconcile('team-a', {
      state: 'restart_required',
      ownerGeneration: 2,
      approvalGeneration: 1,
    });

    expect(first).toMatchObject({ approvalGeneration: 1 });
    expect(rotated).toMatchObject({ state: 'restart_required', approvalGeneration: 2 });
    expect(JSON.parse(await readFile(state.admissionPath, 'utf8')).admissionGeneration).toBe(
      'approval-admission-generation_2_owner_2'
    );
  });

  it.each([
    ['session unavailable', null, ARTIFACT],
    ['artifact unavailable', binding(), null],
    ['wrong artifact', binding({ artifactDigest: `sha256:${'b'.repeat(64)}` }), ARTIFACT],
    ['automatic mode', binding({ toolApprovalMode: 'auto' }), ARTIFACT],
    [
      'capability drift',
      binding({ capabilityProtocol: 'agent-teams-hosted-approval-v1' }),
      ARTIFACT,
    ],
  ] as const)('revokes on %s', async (_label, nextBinding, digest) => {
    const state = await harness();
    await state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 });
    state.setBinding(nextBinding);
    state.setExpectedDigest(digest);

    await expect(
      state.publisher.reconcile('team-a', {
        state: 'restart_required',
        ownerGeneration: 1,
        approvalGeneration: 1,
      })
    ).resolves.toMatchObject({ state: 'revoked' });
    await expect(readFile(state.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revokes immediately on stop', async () => {
    const state = await harness();
    await state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 });
    await expect(state.publisher.revoke('team-a')).resolves.toEqual({
      state: 'revoked',
      reason: 'stopped',
    });
    await expect(readFile(state.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the prior complete generation when publication crashes before rename', async () => {
    const state = await harness();
    await state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 });
    const original = await readFile(state.admissionPath, 'utf8');
    state.setBinding(binding({ ownerGeneration: 2, sessionId: 'session_crash-rotation' }));
    state.setBeforeCommit(vi.fn(async () => Promise.reject(new Error('simulated-crash'))));

    await expect(
      state.publisher.reconcile('team-a', {
        state: 'restart_required',
        ownerGeneration: 2,
        approvalGeneration: 1,
      })
    ).resolves.toMatchObject({ state: 'revoked' });
    // Failed candidate publication never exposes partial JSON. Reconciliation revokes the stale
    // authority after the atomic writer leaves the previous generation intact.
    await expect(readFile(state.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(original).admissionGeneration).toBe(
      'approval-admission-generation_1_owner_1'
    );
  });

  it('rejects an active pin from the publishing owner generation', async () => {
    const state = await harness();
    const first = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });
    if (first.state !== 'restart_required') throw new Error('unexpected state');

    await expect(
      state.publisher.reconcile('team-a', {
        state: 'active',
        ownerGeneration: 1,
        approvalGeneration: first.approvalGeneration,
        approvalDigest: first.approvalDigest,
      })
    ).resolves.toEqual({ state: 'revoked', reason: 'two-generation-admission-mismatch' });
  });

  it.each([
    ['owner process', { ownerGeneration: 2, ownerPid: 9876 }],
    [
      'capability generation',
      { ownerGeneration: 2, capabilityGeneration: `config_generation_${'9'.repeat(32)}` },
    ],
  ] as const)('revokes the active bytes and rotates for %s drift', async (_label, overrides) => {
    const state = await harness();
    const first = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });
    if (first.state !== 'restart_required') throw new Error('unexpected state');
    state.setBinding(binding({ ownerGeneration: 2 }));
    const activeLifecycle = {
      state: 'active' as const,
      ownerGeneration: 2,
      approvalGeneration: first.approvalGeneration,
      approvalDigest: first.approvalDigest,
    };
    await expect(state.publisher.reconcile('team-a', activeLifecycle)).resolves.toMatchObject({
      state: 'active',
    });

    state.setBinding(binding(overrides));
    await expect(state.publisher.reconcile('team-a', activeLifecycle)).resolves.toMatchObject({
      state: 'restart_required',
      approvalGeneration: 2,
    });
  });
});
