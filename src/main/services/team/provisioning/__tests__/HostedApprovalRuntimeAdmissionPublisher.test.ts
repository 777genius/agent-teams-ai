import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { parseLaneId } from '@features/team-runtime-control/contracts';
import {
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHostedApprovalRuntimeAdmissionComposition } from '../HostedApprovalRuntimeAdmissionComposition';
import {
  type AuthoritativeHostedApprovalRuntimeBinding,
  type AuthoritativeHostedApprovalRuntimeBindingLease,
  buildHostedApprovalAuthoritySnapshot,
  digestHostedApprovalAuthoritySnapshot,
  HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE,
  HostedApprovalRuntimeAdmissionPublisher,
} from '../HostedApprovalRuntimeAdmissionPublisher';
import { DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore } from '../HostedApprovalRuntimeAdmissionStateStore';
import { openTrustedDirectoryCapability } from '../HostedApprovalRuntimeDescriptorStorage';

const ARTIFACT = `sha256:${'a'.repeat(64)}` as const;
const TEAM_ID = parseTeamId(`team_${'1'.repeat(32)}`);
const MEMBER_ID = parseMemberId(`member_${'2'.repeat(32)}`);
const SECOND_MEMBER_ID = parseMemberId(`member_${'9'.repeat(32)}`);
const cleanup: string[] = [];
const runChild = promisify(execFile);

async function temporaryDirectory(label: string): Promise<string> {
  const path = join('/tmp', `approval-${label}-${randomUUID()}`);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface BindingOverrides {
  ownerGeneration?: number;
  ownerSessionId?: string;
  sessionId?: string;
  memberId?: typeof MEMBER_ID;
  artifactDigest?: `sha256:${string}`;
  toolApprovalMode?: 'manual' | 'auto';
  capabilityProtocol?: string;
  capabilityGeneration?: string;
  ownerPid?: number;
  actorMembers?: Readonly<Record<string, string>>;
  memberIdsByName?: Readonly<Record<string, string>>;
}

function binding(overrides: BindingOverrides = {}): AuthoritativeHostedApprovalRuntimeBinding {
  const memberId = overrides.memberId ?? MEMBER_ID;
  const runtimeInstanceId = `runtime_instance_${'3'.repeat(32)}`;
  const authority = {
    deploymentId: parseDeploymentId('deployment_approval-test'),
    teamId: TEAM_ID,
    runId: parseRunId(`run_${'4'.repeat(32)}`),
    planGeneration: 7,
    laneId: parseLaneId('primary'),
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
    memberIdsByName: overrides.memberIdsByName ?? { lead: memberId },
    actorMembers: overrides.actorMembers ?? { actor_owner: memberId },
    owner: {
      teamId: TEAM_ID,
      ownerAuthority: 'owner-authority_approval-test',
      ownerGeneration: overrides.ownerGeneration ?? 1,
      ownerSessionId: overrides.ownerSessionId ?? 'owner-session_approval-test',
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
  const directory = await temporaryDirectory('team');
  const stateDirectory = await temporaryDirectory('state');
  const admissionPath = join(directory, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE);
  let current: AuthoritativeHostedApprovalRuntimeBinding | null = initial;
  let expectedDigest: `sha256:${string}` | null = ARTIFACT;
  let beforeReread: (() => Promise<void>) | undefined;
  let afterConsume: (() => Promise<void>) | undefined;
  let assertPinned: ((assertion: number) => Promise<boolean>) | undefined;
  let pinAssertions = 0;
  const stateStore = new DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore(() =>
    openTrustedDirectoryCapability(stateDirectory)
  );
  const publisher = new HostedApprovalRuntimeAdmissionPublisher({
    openTeamDirectory: async () => openTrustedDirectoryCapability(directory),
    acquireAuthoritativeBinding: async () => {
      if (!current) return null;
      const candidate = current;
      let consumed = false;
      const lease: AuthoritativeHostedApprovalRuntimeBindingLease = {
        token: `lease_${randomUUID()}`,
        binding: candidate,
        consume: async () => {
          if (consumed) throw new Error('lease-already-consumed');
          consumed = true;
          if (!current) return null;
          const pinned = current;
          const fingerprint = JSON.stringify(pinned);
          return {
            binding: pinned,
            assertCurrent: async () => {
              pinAssertions += 1;
              return (
                current !== null &&
                JSON.stringify(current) === fingerprint &&
                (await (assertPinned?.(pinAssertions) ?? true))
              );
            },
            release: async () => undefined,
          };
        },
      };
      return lease;
    },
    resolveExpectedOpenCodeArtifactDigest: async () => expectedDigest,
    stateStore,
    beforeAuthoritativeReread: async () => beforeReread?.(),
    afterLeaseConsume: async () => afterConsume?.(),
  });
  return {
    admissionPath,
    directory,
    publisher,
    stateDirectory,
    stateStore,
    setBinding(value: AuthoritativeHostedApprovalRuntimeBinding | null) {
      current = value;
    },
    setExpectedDigest(value: `sha256:${string}` | null) {
      expectedDigest = value;
    },
    setBeforeReread(value: (() => Promise<void>) | undefined) {
      beforeReread = value;
    },
    setAfterConsume(value: (() => Promise<void>) | undefined) {
      afterConsume = value;
    },
    setPinAssertion(value: ((assertion: number) => Promise<boolean>) | undefined) {
      assertPinned = value;
    },
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('HostedApprovalRuntimeAdmissionPublisher', () => {
  it('publishes canonical exact-schema private JSON with distinct contract and document digests', async () => {
    const state = await harness();
    const result = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });

    expect(result).toMatchObject({ state: 'restart_required', approvalGeneration: 1 });
    if (result.state !== 'restart_required') throw new Error('unexpected state');
    const raw = await readFile(state.admissionPath, 'utf8');
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
    expect((await lstat(state.admissionPath)).mode & 0o777).toBe(0o600);
    const snapshot = buildHostedApprovalAuthoritySnapshot(binding(), 1);
    expect(JSON.stringify(snapshot)).toBe(
      '{"schemaVersion":1,"approvalGeneration":1,"authorities":[{"deploymentId":"deployment_approval-test","teamId":"team_11111111111111111111111111111111","runId":"run_44444444444444444444444444444444","planGeneration":7,"laneId":"primary","providerId":"opencode","credentialGeneration":5,"credentialId":"credential_approval-test","sessionId":"session_approval-test","runtimeInstanceId":"runtime_instance_33333333333333333333333333333333","deliveryOwnerId":"member_22222222222222222222222222222222"}]}'
    );
    expect(result.approvalDigest).toBe(digestHostedApprovalAuthoritySnapshot(binding(), 1));
    expect(result.approvalDigest).toBe(sha256(JSON.stringify(snapshot)));
    expect(result.admissionDocumentDigest).toBe(sha256(raw));
    expect(result.admissionDocumentDigest).not.toBe(result.approvalDigest);
  });

  it('activates only on a later owner generation pinned to the consumer snapshot digest', async () => {
    const state = await harness();
    const first = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });
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
      admissionDocumentDigest: first.admissionDocumentDigest,
    });
  });

  it('rotates and increments generation on authoritative session drift', async () => {
    const state = await harness();
    await state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 });
    state.setBinding(binding({ ownerGeneration: 2, sessionId: 'session_rotated' }));
    const rotated = await state.publisher.reconcile('team-a', {
      state: 'restart_required',
      ownerGeneration: 2,
      approvalGeneration: 1,
    });

    expect(rotated).toMatchObject({ state: 'restart_required', approvalGeneration: 2 });
    expect(JSON.parse(await readFile(state.admissionPath, 'utf8')).admissionGeneration).toBe(
      'approval-admission-generation_2_owner_2'
    );
  });

  it('rotates when an owner generation changes outside the active handoff', async () => {
    const state = await harness();
    await state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 });
    state.setBinding(binding({ ownerGeneration: 2 }));

    await expect(
      state.publisher.reconcile('team-a', {
        state: 'restart_required',
        ownerGeneration: 2,
        approvalGeneration: 1,
      })
    ).resolves.toMatchObject({ state: 'restart_required', approvalGeneration: 2 });
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
  ] as const)('durably revokes on %s', async (_label, nextBinding, digest) => {
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

  it('requires actorMembers to be the exact authorized roster projection', async () => {
    const variants = [
      binding({ actorMembers: { actor_owner: MEMBER_ID, actor_extra: SECOND_MEMBER_ID } }),
      binding({ memberIdsByName: { lead: MEMBER_ID, reviewer: SECOND_MEMBER_ID } }),
      binding({ actorMembers: { actor_owner: SECOND_MEMBER_ID } }),
    ];
    for (const candidate of variants) {
      const state = await harness(candidate);
      await expect(
        state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 })
      ).resolves.toMatchObject({
        state: 'revoked',
        reason: 'hosted-approval-runtime-actor-mapping-invalid',
      });
    }
  });

  it('rejects authoritative evidence with fields outside the exact binding schema', async () => {
    const candidate = { ...binding(), unexpectedAuthority: 'not-admitted' };
    const state = await harness(candidate);
    await expect(
      state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 })
    ).resolves.toMatchObject({
      state: 'revoked',
      reason: 'hosted-approval-runtime-binding-invalid',
    });
  });

  it('moves the adversarial hook before the single-use authoritative reread', async () => {
    const state = await harness();
    state.setBeforeReread(
      vi.fn(async () => state.setBinding(binding({ sessionId: 'session_commit-drift' })))
    );

    await expect(
      state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 })
    ).resolves.toMatchObject({
      state: 'revoked',
      reason: 'hosted-approval-runtime-authority-drift',
    });
    await expect(readFile(state.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fences authority mutation after the single-use lease is consumed', async () => {
    const mutable = binding() as AuthoritativeHostedApprovalRuntimeBinding & {
      routes: Array<AuthoritativeHostedApprovalRuntimeBinding['routes'][number]>;
    };
    const state = await harness(mutable);
    state.setAfterConsume(async () => {
      mutable.routes[0] = {
        ...mutable.routes[0],
        memberName: 'mutated-after-consume',
      };
    });
    await expect(
      state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 })
    ).resolves.toMatchObject({
      state: 'revoked',
      reason: 'hosted-approval-runtime-authority-drift',
    });
    await expect(readFile(state.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holds and revalidates the final authority pin through rename and directory fsync', async () => {
    const state = await harness();
    state.setPinAssertion(async (assertion) => assertion < 4);
    await expect(
      state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 })
    ).resolves.toEqual({ state: 'revoked', reason: 'hosted-approval-runtime-authority-drift' });
    await expect(readFile(state.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(state.stateStore.load(TEAM_ID)).resolves.toMatchObject({
      generationHighWater: 1,
      revision: 2,
    });
    state.setPinAssertion(undefined);
    await expect(
      state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 })
    ).resolves.toMatchObject({ state: 'restart_required', approvalGeneration: 2 });
  });

  it('does not mutate high-water before the final pin and never reuses committed generations', async () => {
    const state = await harness();
    state.setBeforeReread(vi.fn(async () => Promise.reject(new Error('simulated-crash'))));
    await state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 });
    state.setBeforeReread(undefined);
    const second = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });
    expect(second).toMatchObject({ approvalGeneration: 1 });
    await writeFile(state.admissionPath, '{}\n', { mode: 0o600 });
    await expect(
      state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 })
    ).resolves.toMatchObject({ state: 'restart_required', approvalGeneration: 2 });
    await state.publisher.revoke('team-a');

    const recreated = new HostedApprovalRuntimeAdmissionPublisher({
      openTeamDirectory: async () => openTrustedDirectoryCapability(state.directory),
      acquireAuthoritativeBinding: async () => ({
        token: 'lease_recreated',
        binding: binding(),
        consume: async () => ({
          binding: binding(),
          assertCurrent: async () => true,
          release: async () => undefined,
        }),
      }),
      resolveExpectedOpenCodeArtifactDigest: async () => ARTIFACT,
      stateStore: state.stateStore,
    });
    await expect(
      recreated.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 })
    ).resolves.toMatchObject({ state: 'restart_required', approvalGeneration: 3 });
  });

  it('never reports revoked when unlink and verified absence cannot be confirmed', async () => {
    const state = await harness();
    await state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 1 });
    await rm(state.admissionPath);
    await mkdir(state.admissionPath, { mode: 0o700 });

    await expect(state.publisher.revoke('team-a')).rejects.toThrow(
      'hosted-approval-runtime-revocation-unconfirmed'
    );
  });

  it('serializes durable CAS across independent state-store instances', async () => {
    const stateDirectory = await temporaryDirectory('state-cas');
    const createStore = () =>
      new DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore(() =>
        openTrustedDirectoryCapability(stateDirectory)
      );
    const first = createStore();
    const second = createStore();
    const candidate = {
      schemaVersion: 1 as const,
      revision: 1,
      generationHighWater: 1,
      authoritativeFingerprint: 'a'.repeat(64),
    };

    const results = await Promise.all([
      first.compareAndSwap(TEAM_ID, null, candidate),
      second.compareAndSwap(TEAM_ID, null, candidate),
    ]);
    expect(results.toSorted()).toEqual([false, true]);
    await expect(first.load(TEAM_ID)).resolves.toEqual(candidate);
  });

  it.runIf(process.platform === 'linux')(
    'serializes divergent child-process fingerprints and prevents publication rollback',
    async () => {
      const stateDirectory = await temporaryDirectory('state-cas-child');
      const teamDirectory = await temporaryDirectory('team-cas-child');
      const gatePath = join(stateDirectory, 'start.gate');
      const helper = join(
        process.cwd(),
        'src/main/services/team/provisioning/__tests__/fixtures/hostedApprovalStateCasChild.ts'
      );
      const launch = (fingerprint: string, delay: number) =>
        runChild(
          process.execPath,
          [
            '--import',
            'tsx',
            helper,
            stateDirectory,
            teamDirectory,
            TEAM_ID,
            fingerprint,
            gatePath,
            String(delay),
          ],
          { encoding: 'utf8' }
        );
      const first = launch('a'.repeat(64), 75);
      const second = launch('b'.repeat(64), 0);
      await writeFile(gatePath, 'start\n', { mode: 0o600 });
      const children = await Promise.all([first, second]);
      const outcomes = children.map(
        ({ stdout }) =>
          JSON.parse(stdout.trim()) as {
            generationHighWater: number;
            authoritativeFingerprint: string;
          }
      );
      expect(outcomes.map((outcome) => outcome.generationHighWater).toSorted()).toEqual([1, 2]);
      const winner = outcomes.find((outcome) => outcome.generationHighWater === 2);
      const store = new DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore(() =>
        openTrustedDirectoryCapability(stateDirectory)
      );
      await expect(store.load(TEAM_ID)).resolves.toMatchObject({
        revision: 2,
        generationHighWater: 2,
        authoritativeFingerprint: winner?.authoritativeFingerprint,
      });
      await expect(readFile(join(teamDirectory, 'child-publication.json'), 'utf8')).resolves.toBe(
        `${JSON.stringify({ generation: 2, fingerprint: winner?.authoritativeFingerprint })}\n`
      );
    }
  );

  it('revokes stale publication without reserving a generation when the final pin fails', async () => {
    const state = await harness();
    const first = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });
    expect(first).toMatchObject({ state: 'restart_required', approvalGeneration: 1 });
    const committed = await state.stateStore.load(TEAM_ID);
    if (!committed) throw new Error('missing committed admission state');
    state.setBinding(binding({ ownerGeneration: 2, sessionId: 'session_rotated' }));
    state.setBeforeReread(async () => {
      throw new Error('simulated-publication-failure');
    });

    await expect(
      state.publisher.reconcile('team-a', { state: 'provisioning', ownerGeneration: 2 })
    ).resolves.toEqual({ state: 'revoked', reason: 'simulated-publication-failure' });
    await expect(readFile(state.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(state.stateStore.load(TEAM_ID)).resolves.toMatchObject({
      revision: 1,
      generationHighWater: 1,
      authoritativeFingerprint: committed.authoritativeFingerprint,
    });

    state.setBeforeReread(undefined);
    const recovered = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 2,
    });
    expect(recovered).toMatchObject({ state: 'restart_required', approvalGeneration: 2 });
  });

  it('revokes an active mismatch, then rotates only on an explicit lifecycle transition', async () => {
    const state = await harness();
    const first = await state.publisher.reconcile('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });
    if (first.state !== 'restart_required') throw new Error('unexpected state');
    state.setBinding(binding({ ownerGeneration: 2, ownerPid: 9876 }));

    await expect(
      state.publisher.reconcile('team-a', {
        state: 'active',
        ownerGeneration: 2,
        approvalGeneration: first.approvalGeneration,
        approvalDigest: first.approvalDigest,
      })
    ).resolves.toEqual({ state: 'revoked', reason: 'two-generation-admission-mismatch' });
    await expect(readFile(state.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const rotated = await state.publisher.reconcile('team-a', {
      state: 'restart_required',
      ownerGeneration: 2,
      approvalGeneration: first.approvalGeneration,
    });
    expect(rotated).toMatchObject({ state: 'restart_required', approvalGeneration: 2 });
    if (rotated.state !== 'restart_required') throw new Error('unexpected state');
    state.setBinding(binding({ ownerGeneration: 3, ownerPid: 9876 }));
    await expect(
      state.publisher.reconcile('team-a', {
        state: 'active',
        ownerGeneration: 3,
        approvalGeneration: rotated.approvalGeneration,
        approvalDigest: rotated.approvalDigest,
      })
    ).resolves.toMatchObject({ state: 'active', ownerGeneration: 3 });
  });

  it('production composition writes transitions and revokes before every destructive effect', async () => {
    const directory = await temporaryDirectory('composition-team');
    const stateDirectory = await temporaryDirectory('composition-state');
    const admissionPath = join(directory, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE);
    let current = binding();
    const composition = createHostedApprovalRuntimeAdmissionComposition({
      resolveTeamDirectoryPath: () => directory,
      stateDirectoryPath: stateDirectory,
      authoritativeEvidence: {
        currentLifecycle: async () => ({
          state: 'provisioning',
          ownerGeneration: current.owner.ownerGeneration,
        }),
        acquireRosterSessionBootstrapProcessLease: async () => {
          const candidate = current;
          return {
            token: `lease_${randomUUID()}`,
            binding: candidate,
            consume: async () => ({
              binding: current,
              assertCurrent: async () => true,
              release: async () => undefined,
            }),
          };
        },
        expectedInstalledArtifactDigest: async () => ARTIFACT,
      },
    });
    const provisioning = await composition.transition('team-a', {
      state: 'provisioning',
      ownerGeneration: 1,
    });
    if (provisioning.state !== 'restart_required') throw new Error('unexpected state');
    await expect(
      composition.transition('team-a', {
        state: 'restart_required',
        ownerGeneration: 1,
        approvalGeneration: provisioning.approvalGeneration,
      })
    ).resolves.toMatchObject({ state: 'restart_required', approvalGeneration: 1 });
    current = binding({ ownerGeneration: 2 });
    await expect(
      composition.transition('team-a', {
        state: 'active',
        ownerGeneration: 2,
        approvalGeneration: provisioning.approvalGeneration,
        approvalDigest: provisioning.approvalDigest,
      })
    ).resolves.toMatchObject({ state: 'active', ownerGeneration: 2 });
    await composition.beforeStop('team-a', async () => {
      await expect(readFile(admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    current = binding({ ownerGeneration: 3 });

    const assertRevokedBefore = async (effect: () => Promise<void>) => {
      const published = await composition.transition('team-a', {
        state: 'provisioning',
        ownerGeneration: current.owner.ownerGeneration,
      });
      expect(published.state).toBe('restart_required');
      await expect(readFile(admissionPath, 'utf8')).resolves.toContain('admissionGeneration');
      await effect();
      await expect(readFile(admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
      current = binding({ ownerGeneration: current.owner.ownerGeneration + 1 });
    };

    await assertRevokedBefore(() =>
      composition.beforeCancel('team-a', async () => {
        await expect(readFile(admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
      })
    );
    await assertRevokedBefore(() => composition.beforeFailure('team-a', async () => undefined));
    await assertRevokedBefore(() => composition.beforeStop('team-a', async () => undefined));
    await assertRevokedBefore(() => composition.beforeOwnerLoss('team-a', async () => undefined));
    await assertRevokedBefore(() =>
      composition.beforeShutdown(['team-a', 'team-a'], async () => undefined)
    );
  });
});
