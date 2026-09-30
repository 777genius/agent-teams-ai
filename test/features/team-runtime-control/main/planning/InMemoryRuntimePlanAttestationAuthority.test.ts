import {
  createCompositeRuntimePlan,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  type RuntimePlanAttestationBinding,
  type Sha256Hash,
} from '@features/team-runtime-control';
import { mountHostedRuntimeAuthority } from '@features/team-runtime-control/main/composition/mountHostedRuntimeAuthority';
import { InMemoryRuntimePlanAttestationAuthority } from '@features/team-runtime-control/main/infrastructure/planning/InMemoryRuntimePlanAttestationAuthority';
import { planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const AUTHORITY_ID = 'authority:test';
const BOOT_ID = 'boot:test';

let nextToken = 0;
function deterministicCrypto() {
  return {
    randomBytes: (length: number) => new Uint8Array(length),
    base64UrlEncode: () => `${String(nextToken++).padStart(43, 'a')}`,
    secureEqual: (left: string, right: string) => left === right,
  };
}

function deterministicMountedCrypto() {
  let nextUuid = 0;
  return {
    ...deterministicCrypto(),
    randomUuid: () => `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, '0')}`,
  };
}

function createRuntimePlanAttestationAuthority(
  options: Omit<
    ConstructorParameters<typeof InMemoryRuntimePlanAttestationAuthority>[0],
    'crypto'
  > & {
    crypto?: ReturnType<typeof deterministicCrypto>;
  }
) {
  return new InMemoryRuntimePlanAttestationAuthority({
    ...options,
    crypto: options.crypto ?? deterministicCrypto(),
  });
}

function plan({ run = 'b', generation = 1 }: { run?: string; generation?: number } = {}) {
  const laneId = parseLaneId('primary');
  return createCompositeRuntimePlan({
    teamId: parseTeamId(`team_${'a'.repeat(32)}`),
    runId: parseRunId(`run_${run.repeat(32)}`),
    generation,
    leadProviderId: 'anthropic',
    lanePlanResult: planTeamRuntimeLanes({
      leadProviderId: 'anthropic',
      members: [{ name: 'worker', providerId: 'anthropic' }],
    }),
    rosterGeneration: 1,
    memberBindings: [
      {
        memberId: parseMemberId(`member_${'c'.repeat(32)}`),
        memberRevision: 1,
        legacyMemberKey: parseLegacyMemberKey('worker'),
        providerId: 'anthropic',
        laneId,
        policy: 'required',
      },
    ],
    laneCredentials: [{ laneId, requiredCredentialExposureSet: { secretRefs: [] } }],
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'d'.repeat(32)}`),
      registrationRevision: 1,
      bindingGeneration: 1,
      mountGeneration: 1,
    },
    executionUnits: [
      {
        executionUnitId: parseExecutionUnitId('unit-authority-test'),
        backendBinding: {
          backend: 'provisioning_cli',
          bindingId: parseRuntimeBackendBindingId('binding-authority-test'),
          bindingRevision: 1,
        },
        laneId,
        binaryPolicy: {
          policy: 'registered_exact_binary',
          binaryId: parseRuntimeBinaryId('binary-authority-test'),
          binaryRevision: 1,
          binaryHash: `sha256:${'e'.repeat(64)}` as Sha256Hash,
        },
        environmentPolicy: { policy: 'explicit_allowlist', variables: [] },
        credentialExposureSet: { secretRefs: [] },
        resourcePolicy: {
          maxRuntimeMs: 30_000,
          gracefulStopMs: 2_000,
          maxOutputBytes: 100_000,
          maxProcessCount: 2,
        },
      },
    ],
  });
}

function binding(overrides: Partial<RuntimePlanAttestationBinding> = {}) {
  return {
    authorityId: AUTHORITY_ID,
    bootId: BOOT_ID,
    laneId: parseLaneId('primary'),
    operation: 'launch' as const,
    operationId: 'operation:test',
    ...overrides,
  };
}

function planSource(authoritative: ReturnType<typeof plan>, revision = 1) {
  return {
    reconstruct: vi.fn(async () => ({ plan: authoritative, revision })),
    currentRevision: vi.fn(() => revision as number | null),
  };
}

describe('InMemoryRuntimePlanAttestationAuthority', () => {
  it('rejects an issued predecessor after a newer run becomes current for the team', async () => {
    const authority = mountHostedRuntimeAuthority({}, deterministicMountedCrypto());
    const predecessor = plan();
    const current = plan({ run: 'f' });
    const ownerBinding = binding({
      authorityId: authority.authorityId,
      bootId: authority.bootId,
    });
    authority.rememberReconstructedPlan(predecessor);
    const stale = await authority.issue({ candidate: predecessor, binding: ownerBinding });
    if (!stale) throw new Error('expected predecessor attestation');

    authority.rememberReconstructedPlan(current);

    await expect(authority.redeem(stale, ownerBinding)).resolves.toEqual({
      status: 'rejected',
      reason: 'unavailable',
    });
  });

  it('issues only for the exact current run and preserves exact-plan remembrance', async () => {
    const authority = mountHostedRuntimeAuthority({}, deterministicMountedCrypto());
    const predecessor = plan();
    const current = plan({ generation: 2 });
    const ownerBinding = binding({
      authorityId: authority.authorityId,
      bootId: authority.bootId,
      operationId: 'operation:current-run',
    });
    authority.rememberReconstructedPlan(predecessor);
    authority.rememberReconstructedPlan(current);
    authority.rememberReconstructedPlan(current);

    await expect(
      authority.issue({ candidate: predecessor, binding: ownerBinding })
    ).resolves.toBeNull();
    const issued = await authority.issue({ candidate: current, binding: ownerBinding });
    if (!issued) throw new Error('expected current attestation');
    await expect(authority.redeem(issued, ownerBinding)).resolves.toEqual({
      status: 'redeemed',
      plan: current,
    });
  });

  it('issues one boot-local CSPRNG bearer for an authoritative reconstructed plan', async () => {
    const authoritative = plan();
    const plans = planSource(authoritative);
    const authority = createRuntimePlanAttestationAuthority({
      authorityId: AUTHORITY_ID,
      bootId: BOOT_ID,
      plans,
      nowEpochMs: () => Date.parse('2026-08-07T01:00:00.000Z'),
    });

    const first = await authority.issue({ candidate: authoritative, binding: binding() });
    const repeated = await authority.issue({ candidate: authoritative, binding: binding() });

    expect(first).toMatchObject({
      authorityId: AUTHORITY_ID,
      bootId: BOOT_ID,
      planHash: authoritative.planHash,
      operation: 'launch',
    });
    expect(first?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repeated).toBe(first);
    expect(plans.reconstruct).toHaveBeenCalledOnce();
  });

  it('rejects unknown, forged, expired, reused, wrong-authority, and wrong-boot proofs', async () => {
    let now = Date.parse('2026-08-07T01:00:00.000Z');
    const authoritative = plan();
    const authority = createRuntimePlanAttestationAuthority({
      authorityId: AUTHORITY_ID,
      bootId: BOOT_ID,
      plans: planSource(authoritative),
      nowEpochMs: () => now,
      ttlMs: 1_000,
    });
    const issued = await authority.issue({ candidate: authoritative, binding: binding() });
    if (!issued) throw new Error('expected attestation');

    const unknownToken = `${issued.token[0] === 'x' ? 'y' : 'x'}${issued.token.slice(1)}`;
    await expect(authority.redeem({ ...issued, token: unknownToken }, binding())).resolves.toEqual({
      status: 'rejected',
      reason: 'unknown',
    });
    await expect(
      authority.redeem({ ...issued, planHash: `sha256:${'f'.repeat(64)}` }, binding())
    ).resolves.toEqual({ status: 'rejected', reason: 'binding_mismatch' });
    await expect(
      authority.redeem(issued, binding({ authorityId: 'authority:wrong' }))
    ).resolves.toEqual({ status: 'rejected', reason: 'binding_mismatch' });
    await expect(authority.redeem(issued, binding({ bootId: 'boot:wrong' }))).resolves.toEqual({
      status: 'rejected',
      reason: 'binding_mismatch',
    });
    await expect(authority.redeem(issued, binding({ operation: 'observe' }))).resolves.toEqual({
      status: 'rejected',
      reason: 'binding_mismatch',
    });
    await expect(
      authority.redeem(issued, binding({ laneId: parseLaneId('secondary') }))
    ).resolves.toEqual({ status: 'rejected', reason: 'binding_mismatch' });

    await expect(authority.redeem(issued, binding())).resolves.toEqual({
      status: 'redeemed',
      plan: authoritative,
    });
    await expect(authority.redeem(issued, binding())).resolves.toEqual({
      status: 'rejected',
      reason: 'consumed',
    });

    const expiringBinding = binding({ operationId: 'operation:expired' });
    const expiring = await authority.issue({ candidate: authoritative, binding: expiringBinding });
    if (!expiring) throw new Error('expected expiring attestation');
    now += 1_000;
    await expect(authority.redeem(expiring, expiringBinding)).resolves.toEqual({
      status: 'rejected',
      reason: 'expired',
    });
  });

  it('atomically permits only one redemption for concurrent duplicate delivery', async () => {
    const authoritative = plan();
    const authority = createRuntimePlanAttestationAuthority({
      authorityId: AUTHORITY_ID,
      bootId: BOOT_ID,
      plans: planSource(authoritative),
    });
    const issued = await authority.issue({ candidate: authoritative, binding: binding() });
    if (!issued) throw new Error('expected attestation');

    const outcomes = await Promise.all([
      authority.redeem(issued, binding()),
      authority.redeem(issued, binding()),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'redeemed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([
      { status: 'rejected', reason: 'consumed' },
    ]);
  });

  it('serializes concurrent issuance per binding across asynchronous reconstruction', async () => {
    const authoritative = plan();
    let release: ((value: { plan: typeof authoritative; revision: number }) => void) | undefined;
    const reconstruct = vi.fn(
      async () =>
        await new Promise<{ plan: typeof authoritative; revision: number }>((resolve) => {
          release = resolve;
        })
    );
    const authority = createRuntimePlanAttestationAuthority({
      authorityId: AUTHORITY_ID,
      bootId: BOOT_ID,
      plans: { reconstruct, currentRevision: () => 1 },
    });

    const firstPromise = authority.issue({ candidate: authoritative, binding: binding() });
    const secondPromise = authority.issue({ candidate: authoritative, binding: binding() });
    await Promise.resolve();
    expect(reconstruct).toHaveBeenCalledOnce();
    release?.({ plan: authoritative, revision: 1 });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('retains consumed tombstones until expiry and then releases capacity', async () => {
    const authoritative = plan();
    let now = Date.parse('2026-08-07T01:00:00.000Z');
    const authority = createRuntimePlanAttestationAuthority({
      authorityId: AUTHORITY_ID,
      bootId: BOOT_ID,
      plans: planSource(authoritative),
      maxRecords: 1,
      ttlMs: 1_000,
      nowEpochMs: () => now,
    });
    const issued = await authority.issue({ candidate: authoritative, binding: binding() });
    if (!issued) throw new Error('expected attestation');

    await expect(authority.redeem(issued, binding())).resolves.toMatchObject({
      status: 'redeemed',
    });
    await expect(
      authority.issue({ candidate: authoritative, binding: binding() })
    ).resolves.toBeNull();
    await expect(
      authority.issue({
        candidate: authoritative,
        binding: binding({ operationId: 'operation:after-consumed-capacity' }),
      })
    ).resolves.toBeNull();

    now += 1_000;
    const replacementBinding = binding({ operationId: 'operation:after-expiry' });
    const replacement = await authority.issue({
      candidate: authoritative,
      binding: replacementBinding,
    });
    expect(replacement).not.toBeNull();
    await expect(authority.redeem(replacement, replacementBinding)).resolves.toMatchObject({
      status: 'redeemed',
    });
    await expect(authority.redeem(issued, binding())).resolves.toEqual({
      status: 'rejected',
      reason: 'unknown',
    });
  });

  it('invalidates a stale outstanding token when the authoritative plan revision changes', async () => {
    const authoritative = plan();
    let revision = 1;
    const authority = createRuntimePlanAttestationAuthority({
      authorityId: AUTHORITY_ID,
      bootId: BOOT_ID,
      plans: {
        reconstruct: async () => ({ plan: authoritative, revision }),
        currentRevision: () => revision,
      },
    });
    const stale = await authority.issue({ candidate: authoritative, binding: binding() });
    if (!stale) throw new Error('expected attestation');

    revision += 1;
    await expect(authority.redeem(stale, binding())).resolves.toEqual({
      status: 'rejected',
      reason: 'unavailable',
    });
    const current = await authority.issue({ candidate: authoritative, binding: binding() });
    expect(current?.token).not.toBe(stale.token);
    await expect(authority.redeem(stale, binding())).resolves.toEqual({
      status: 'rejected',
      reason: 'unknown',
    });
    await expect(authority.redeem(current, binding())).resolves.toMatchObject({
      status: 'redeemed',
    });
  });

  it('rejects reconstruction that becomes stale before issuance completes', async () => {
    const authoritative = plan();
    let revision = 1;
    let release: ((value: { plan: typeof authoritative; revision: number }) => void) | undefined;
    const authority = createRuntimePlanAttestationAuthority({
      authorityId: AUTHORITY_ID,
      bootId: BOOT_ID,
      plans: {
        reconstruct: async () =>
          await new Promise<{ plan: typeof authoritative; revision: number }>((resolve) => {
            release = resolve;
          }),
        currentRevision: () => revision,
      },
    });

    const issuing = authority.issue({ candidate: authoritative, binding: binding() });
    await Promise.resolve();
    revision = 2;
    release?.({ plan: authoritative, revision: 1 });

    await expect(issuing).resolves.toBeNull();
  });

  it('never turns a caller-supplied raw plan into authority without reconstruction', async () => {
    const candidate = plan();
    const authority = createRuntimePlanAttestationAuthority({
      authorityId: AUTHORITY_ID,
      bootId: BOOT_ID,
      plans: { reconstruct: async () => null, currentRevision: () => null },
    });

    await expect(authority.issue({ candidate, binding: binding() })).resolves.toBeNull();
    await expect(authority.redeem(candidate, binding())).resolves.toEqual({
      status: 'rejected',
      reason: 'binding_mismatch',
    });
  });
});
