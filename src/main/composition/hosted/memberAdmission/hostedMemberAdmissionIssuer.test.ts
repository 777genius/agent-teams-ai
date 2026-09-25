import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHostedMemberPrivateKeyFdProvider } from '../../../../features/team-lifecycle/main/adapters/output/orchestrator/hostedMemberPrivateKeyFd';

import {
  memberAdmissionSigningBytes,
  parseCanonicalMemberAdmission,
} from './hostedMemberAdmission';
import { createHostedMemberAdmissionIssuer } from './hostedMemberAdmissionIssuer';

const privateKey = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc4' +
      '4449c5697b326919703bac031cae7f60',
    'hex'
  ),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey(privateKey);
const spkiPin = createHash('sha256')
  .update(publicKey.export({ format: 'der', type: 'spki' }))
  .digest('hex');
const runId = `run_${'b'.repeat(32)}`;
const memberId = `member_${'f'.repeat(32)}`;
const planSha256 = 'd'.repeat(64);
const binding = {
  runId,
  deploymentId: 'deployment_1',
  bootId: 'boot_1',
  workspaceId: `workspace_${'2'.repeat(32)}`,
  runtimeWorkspaceId: `workspace_${'4'.repeat(32)}`,
  teamId: `team_${'1'.repeat(32)}`,
  restoreGeneration: 0,
  mountGeneration: 1,
  ownerGeneration: 1,
  ownerSessionId: 'owner-session_12345678',
  planSha256,
  spkiSha256: spkiPin,
};
const currentMember = {
  kind: 'admitted' as const,
  runId,
  memberId,
  deploymentId: binding.deploymentId,
  bootId: binding.bootId,
  workspaceId: binding.workspaceId,
  runtimeWorkspaceId: binding.runtimeWorkspaceId,
  teamId: binding.teamId,
  restoreGeneration: binding.restoreGeneration,
  mountGeneration: binding.mountGeneration,
  planSha256,
  laneId: `lane_${'3'.repeat(32)}`,
  memberOrdinal: 0,
  memberName: 'Reviewer',
  model: 'openai/gpt-5.1-codex',
  promptSha256: 'b'.repeat(64),
  grantRevision: 'c'.repeat(64),
};
const roots: string[] = [];
const fds: number[] = [];
afterEach(() => {
  for (const fd of fds.splice(0)) {
    try {
      closeSync(fd);
    } catch {
      /* provider consumed it */
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function keyFd(der: Buffer): number {
  const root = mkdtempSync(join(tmpdir(), 'member-issuer-key-'));
  roots.push(root);
  const path = join(root, 'private.pk8');
  writeFileSync(path, der, { mode: 0o600 });
  const fd = openSync(path, 'r');
  fds.push(fd);
  unlinkSync(path);
  return fd;
}

function fixture(overrides: { keyDer?: Buffer; fdPin?: string } = {}) {
  let current: typeof currentMember | null = currentMember;
  let ownerSession = binding.ownerSessionId;
  let ownerGeneration = binding.ownerGeneration;
  const resolve = vi.fn(async () => current);
  const assertCurrent = vi.fn(async () => {
    if (ownerSession !== binding.ownerSessionId || ownerGeneration !== binding.ownerGeneration) {
      throw new Error('owner-binding-changed');
    }
  });
  const keyDer =
    overrides.keyDer ?? (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer);
  const fd = keyFd(keyDer);
  const privateKeyProvider = createHostedMemberPrivateKeyFdProvider({
    fd,
    spkiSha256: overrides.fdPin ?? spkiPin,
  });
  const issuer = createHostedMemberAdmissionIssuer({
    trustedBinding: binding,
    memberReader: { resolve },
    ownerAuthority: { assertCurrent },
    privateKeyProvider,
    now: () => 1_800_000_000_000,
    randomAdmissionId: () => '0123456789abcdef0123456789abcdef',
  });
  return {
    issuer,
    resolve,
    assertCurrent,
    fd,
    revokeProduct: () => {
      current = null;
    },
    changeOwnerSession: () => {
      ownerSession = 'owner-session_changed';
    },
    changeOwnerGeneration: () => {
      ownerGeneration += 1;
    },
  };
}

describe('inactive hosted member admission issuer', () => {
  it('requires key disposal when trusted composition constructs the issuer', () => {
    expect(() =>
      createHostedMemberAdmissionIssuer({
        trustedBinding: binding,
        memberReader: { resolve: async () => currentMember },
        ownerAuthority: { assertCurrent: async () => {} },
        privateKeyProvider: { loadPrivateKey: async () => privateKey } as never,
      })
    ).toThrow('member-admission-issuer-ports-invalid');
  });

  it('emits the v2 canonical golden signature for one exact Product member', async () => {
    const f = fixture();
    const wire = await f.issuer.issue(runId, memberId);
    const envelope = parseCanonicalMemberAdmission(wire);
    expect(envelope.signature).toBe(
      '0PCnK3ZKVyVGstTr20uIZqbb7Qe4E4e0_4sOh7NVkqhOr5opvGCNEmkoWNwVw7a-TEBt8x2w43se489zKxGHCQ'
    );
    expect(
      verify(
        null,
        memberAdmissionSigningBytes(envelope.payload),
        publicKey,
        Buffer.from(envelope.signature, 'base64url')
      )
    ).toBe(true);
    expect(envelope.payload).toMatchObject({
      runId,
      memberId,
      ownerSessionId: binding.ownerSessionId,
      grantRevision: currentMember.grantRevision,
    });
    expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(f.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed requested run/member and a stale Product resolution', async () => {
    const f = fixture();
    await expect(f.issuer.issue(`run_${'0'.repeat(32)}`, memberId)).rejects.toThrow(
      'member-admission-run-mismatch'
    );
    expect(() => fstatSync(f.fd)).toThrow();
    await expect(f.issuer.issue(runId, `member_${'0'.repeat(32)}`)).rejects.toThrow(
      'member-admission-current-member-unavailable'
    );
    f.revokeProduct();
    await expect(f.issuer.issue(runId, memberId)).rejects.toThrow(
      'member-admission-current-member-unavailable'
    );
    const changedMount = fixture();
    changedMount.resolve.mockResolvedValue({ ...currentMember, mountGeneration: 2 });
    await expect(changedMount.issuer.issue(runId, memberId)).rejects.toThrow(
      'member-admission-current-member-unavailable'
    );
  });

  it('rejects Owner session change and Product revocation during repeated current checks', async () => {
    const owner = fixture();
    owner.changeOwnerSession();
    await expect(owner.issuer.issue(runId, memberId)).rejects.toThrow('owner-binding-changed');
    const generation = fixture();
    generation.changeOwnerGeneration();
    await expect(generation.issuer.issue(runId, memberId)).rejects.toThrow('owner-binding-changed');
    const product = fixture();
    product.resolve
      .mockImplementationOnce(async () => currentMember)
      .mockImplementationOnce(async () => null);
    await expect(product.issuer.issue(runId, memberId)).rejects.toThrow(
      'member-admission-current-member-unavailable'
    );
    const late = fixture();
    late.resolve
      .mockImplementationOnce(async () => currentMember)
      .mockImplementationOnce(async () => currentMember)
      .mockImplementationOnce(async () => null);
    await expect(late.issuer.issue(runId, memberId)).rejects.toThrow(
      'member-admission-current-member-unavailable'
    );
    const changedGrant = fixture();
    changedGrant.resolve
      .mockImplementationOnce(async () => currentMember)
      .mockImplementationOnce(async () => ({ ...currentMember, grantRevision: 'e'.repeat(64) }));
    await expect(changedGrant.issuer.issue(runId, memberId)).rejects.toThrow(
      'member-admission-current-member-changed'
    );
  });

  it('rejects a different FD private key even if its own FD pin is valid', async () => {
    const other = generateKeyPairSync('ed25519');
    const otherDer = other.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const otherPin = createHash('sha256')
      .update(other.publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex');
    const f = fixture({ keyDer: otherDer, fdPin: otherPin });
    await expect(f.issuer.issue(runId, memberId)).rejects.toThrow(
      'member-admission-key-pin-mismatch'
    );
  });
});
