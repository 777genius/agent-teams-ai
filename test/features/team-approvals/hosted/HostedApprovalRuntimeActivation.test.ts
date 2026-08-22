import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  activateHostedApprovalRuntime,
  HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
  HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN,
  type HostedApprovalRuntimeActivationBinding,
  serializeHostedApprovalRuntimeActivationEnvelope,
  verifyHostedApprovalRuntimeActivationEnvelope,
} from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';

import type { OrchestratorLifecycleOwnerProofKey } from '../../../../src/main/composition/hosted/hostedLifecycleOrchestratorReadiness';
import type { Socket } from 'node:net';

const GOLDEN_PATH = 'docs/hosted-approval-activation-v1-golden.json';
const CHALLENGE = 'c'.repeat(64);

interface Golden {
  readonly proof: Readonly<{
    domain: string;
    direction: string;
    keySemantics: string;
  }>;
  readonly secretHex: string;
  readonly binding: HostedApprovalRuntimeActivationBinding;
  readonly admission: unknown;
  readonly serializedUnsignedEnvelope: string;
  readonly controllerProof: string;
  readonly signedEnvelope: string;
}

async function golden(): Promise<Golden> {
  return JSON.parse(await readFile(GOLDEN_PATH, 'utf8')) as Golden;
}

describe('hosted approval activation-v1', () => {
  it('matches the shared byte-for-byte golden with an independent serializer verifier', async () => {
    const fixture = await golden();
    const key = fixture.secretHex as OrchestratorLifecycleOwnerProofKey;
    const serialized = serializeHostedApprovalRuntimeActivationEnvelope(
      key,
      fixture.binding,
      fixture.admission
    );

    expect(serialized).toBe(fixture.signedEnvelope);
    expect(serialized.endsWith(`,"controllerProof":"${fixture.controllerProof}"}`)).toBe(true);
    expect(fixture.proof.domain).toBe(HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN);
    expect(fixture.proof.direction).toBe('admission');
    expect(fixture.proof.keySemantics).toMatch(/integrity/iu);
    expect(fixture.proof.keySemantics).toMatch(/not prove exclusive product authorship/iu);

    const independentlyParsed = independentVerify(serialized, fixture.secretHex, 'admission');
    expect(independentlyParsed.unsigned).toBe(fixture.serializedUnsignedEnvelope);
    expect(independentlyParsed.value.binding).toEqual(fixture.binding);
    expect(independentlyParsed.value.admission).toEqual({
      approvalGeneration: 3,
      authorities: [
        {
          credentialGeneration: 5,
          credentialId: 'credential_activation-golden',
          deliveryOwnerId: `member_${'b'.repeat(32)}`,
          deploymentId: 'deployment_activation-golden',
          laneId: 'primary',
          planGeneration: 7,
          providerId: 'opencode',
          runId: `run_${'9'.repeat(32)}`,
          runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`,
          sessionId: 'session_activation-golden',
          teamId: `team_${'1'.repeat(32)}`,
        },
      ],
      schemaVersion: 1,
    });
  });

  it('rejects proof, binding, signed-manifest, and noncanonical-inner drift', async () => {
    const fixture = await golden();
    const key = fixture.secretHex as OrchestratorLifecycleOwnerProofKey;
    expect(
      verifyHostedApprovalRuntimeActivationEnvelope(fixture.signedEnvelope, key, fixture.binding)
    ).toEqual((JSON.parse(fixture.signedEnvelope) as { admission: unknown }).admission);

    const proofTampered = fixture.signedEnvelope.replace(
      fixture.controllerProof,
      `${fixture.controllerProof.slice(0, -1)}${fixture.controllerProof.endsWith('0') ? '1' : '0'}`
    );
    expect(() =>
      verifyHostedApprovalRuntimeActivationEnvelope(proofTampered, key, fixture.binding)
    ).toThrow(/proof-invalid/u);

    const staleBinding = {
      ...fixture.binding,
      signedManifest: {
        ...fixture.binding.signedManifest,
        manifestDigest: `sha256:${'d'.repeat(64)}` as const,
      },
    };
    expect(() =>
      verifyHostedApprovalRuntimeActivationEnvelope(fixture.signedEnvelope, key, staleBinding)
    ).toThrow(/binding-mismatch/u);

    expect(() =>
      verifyHostedApprovalRuntimeActivationEnvelope(
        ` ${fixture.signedEnvelope}`,
        key,
        fixture.binding
      )
    ).toThrow(/noncanonical/u);

    const admission = structuredClone(fixture.admission) as {
      authorities: Array<Record<string, unknown>>;
    };
    admission.authorities[0]!.teamId = `team_${'2'.repeat(32)}`;
    expect(() =>
      serializeHostedApprovalRuntimeActivationEnvelope(key, fixture.binding, admission)
    ).toThrow(/admission-binding-mismatch/u);
    expect(() =>
      serializeHostedApprovalRuntimeActivationEnvelope(
        key,
        {
          ...fixture.binding,
          approvalDigest: `sha256:${'d'.repeat(64)}`,
        },
        fixture.admission
      )
    ).toThrow(/admission-digest-mismatch/u);
  });

  it('accepts only authenticated exact owner_ready then exact ready and revokes on owner loss', async () => {
    const fixture = await golden();
    const key = fixture.secretHex as OrchestratorLifecycleOwnerProofKey;
    const socket = new ActivationPeerSocket(key);
    const onOwnerLoss = vi.fn();
    const lease = await activateHostedApprovalRuntime({
      binding: fixture.binding,
      admission: fixture.admission,
      proofKey: key,
      generateChallenge: () => CHALLENGE,
      inspectSocketIdentity: async () => fixture.binding.ownerBinding.socketIdentity,
      connect: () => socket as unknown as Socket,
      onOwnerLoss,
    });

    expect(socket.writes).toHaveLength(2);
    expect(JSON.parse(socket.writes[0]!).operation).toBe('approval_activation_prepare');
    expect(JSON.parse(socket.writes[1]!).purpose).toBe('agent-teams.hosted-approval-activation/v1');
    expect(lease.isReady()).toBe(true);
    expect(lease.currentBinding()).toEqual(fixture.binding.ownerBinding);

    socket.loseOwner();
    expect(lease.isReady()).toBe(false);
    expect(lease.currentBinding()).toBeNull();
    expect(onOwnerLoss).toHaveBeenCalledOnce();
  });

  it('does not fall back to a raw legacy-ready peer after activation-v1 negotiation', async () => {
    const fixture = await golden();
    const key = fixture.secretHex as OrchestratorLifecycleOwnerProofKey;
    const socket = new ActivationPeerSocket(key, 'legacy-ready');
    await expect(
      activateHostedApprovalRuntime({
        binding: fixture.binding,
        admission: fixture.admission,
        proofKey: key,
        generateChallenge: () => CHALLENGE,
        inspectSocketIdentity: async () => fixture.binding.ownerBinding.socketIdentity,
        connect: () => socket as unknown as Socket,
        onOwnerLoss: vi.fn(),
      })
    ).rejects.toThrow(/response-invalid/u);
    expect(socket.writes).toHaveLength(1);
  });

  it.each([
    ['stale-owner-ready', 1],
    ['forged-final-ready', 2],
  ] as const)('rejects %s without exposing a ready lease', async (behavior, expectedWrites) => {
    const fixture = await golden();
    const key = fixture.secretHex as OrchestratorLifecycleOwnerProofKey;
    const socket = new ActivationPeerSocket(key, behavior);
    await expect(
      activateHostedApprovalRuntime({
        binding: fixture.binding,
        admission: fixture.admission,
        proofKey: key,
        generateChallenge: () => CHALLENGE,
        inspectSocketIdentity: async () => fixture.binding.ownerBinding.socketIdentity,
        connect: () => socket as unknown as Socket,
        onOwnerLoss: vi.fn(),
      })
    ).rejects.toThrow(/response-invalid/u);
    expect(socket.writes).toHaveLength(expectedWrites);
  });
});

class ActivationPeerSocket extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];

  constructor(
    private readonly proofKey: OrchestratorLifecycleOwnerProofKey,
    private readonly behavior:
      | 'activation-v1'
      | 'legacy-ready'
      | 'stale-owner-ready'
      | 'forged-final-ready' = 'activation-v1'
  ) {
    super();
  }

  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.once(event, listener);
    if (event === 'connect') queueMicrotask(() => this.emit('connect'));
    return this;
  }

  write(chunk: string): boolean {
    const frame = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk;
    this.writes.push(frame);
    if (this.writes.length === 1) {
      const request = independentVerify(frame, this.proofKey, 'owner-ready-request').value;
      const kind = this.behavior === 'legacy-ready' ? 'ready' : 'owner_ready';
      const requestBinding = request.binding as HostedApprovalRuntimeActivationBinding;
      const binding =
        this.behavior === 'stale-owner-ready'
          ? {
              ...requestBinding,
              ownerBinding: {
                ...requestBinding.ownerBinding,
                ownerGeneration: requestBinding.ownerBinding.ownerGeneration + 1,
              },
            }
          : request.binding;
      const unsigned = JSON.stringify({
        schemaVersion: 1,
        kind,
        capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
        challenge: request.challenge,
        binding,
      });
      queueMicrotask(() =>
        this.emit('data', Buffer.from(`${sign(unsigned, this.proofKey, 'owner-ready')}\n`))
      );
      return true;
    }
    const activation = independentVerify(frame, this.proofKey, 'admission').value;
    const unsigned = JSON.stringify({
      schemaVersion: 1,
      kind: 'ready',
      capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
      challenge: CHALLENGE,
      activationDigest: createHash('sha256').update(frame).digest('hex'),
      binding: activation.binding,
    });
    const response =
      this.behavior === 'forged-final-ready'
        ? sign(unsigned, 'ff'.repeat(32), 'ready')
        : sign(unsigned, this.proofKey, 'ready');
    queueMicrotask(() => this.emit('data', Buffer.from(`${response}\n`)));
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  loseOwner(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function sign(unsigned: string, secretHex: string, direction: string): string {
  const proof = createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(`${HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN}\0${direction}\0${unsigned}`)
    .digest('hex');
  return `${unsigned.slice(0, -1)},"controllerProof":"${proof}"}`;
}

function independentVerify(
  source: string,
  secretHex: string,
  direction: string
): Readonly<{ value: Record<string, unknown>; unsigned: string }> {
  const value = JSON.parse(source) as Record<string, unknown>;
  expect(JSON.stringify(value)).toBe(source);
  const proof = value.controllerProof;
  expect(typeof proof).toBe('string');
  const suffix = `,"controllerProof":"${String(proof)}"}`;
  expect(source.endsWith(suffix)).toBe(true);
  const unsigned = `${source.slice(0, -suffix.length)}}`;
  const expected = createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(`${HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN}\0${direction}\0${unsigned}`)
    .digest();
  const supplied = Buffer.from(String(proof), 'hex');
  expect(supplied.byteLength).toBe(expected.byteLength);
  expect(timingSafeEqual(supplied, expected)).toBe(true);
  return Object.freeze({ value, unsigned });
}
