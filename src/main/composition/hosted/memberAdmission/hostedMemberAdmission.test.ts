import { createPrivateKey, createPublicKey, verify } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  canonicalMemberAdmissionPayload,
  createMemberAdmissionSigner,
  type FrozenMemberAdmissionRecord,
  type MemberAdmissionPayload,
  memberAdmissionSigningBytes,
  parseCanonicalMemberAdmission,
} from './hostedMemberAdmission';

// RFC 8032 test seed: deterministic public test key, never a production credential.
const TEST_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc4' +
      '4449c5697b326919703bac031cae7f60',
    'hex'
  ),
  format: 'der',
  type: 'pkcs8',
});
const TEST_PUBLIC_KEY = createPublicKey(TEST_PRIVATE_KEY);
const SHA_PLAN = 'a'.repeat(64);
const SHA_PROMPT = 'b'.repeat(64);
const SHA_GRANT = 'c'.repeat(64);
const NOW = 1_800_000_000_000;

function frozenRecord(): FrozenMemberAdmissionRecord {
  return {
    operationId: 'operation_1',
    deploymentId: 'deployment_1',
    bootId: 'boot_1',
    restoreGeneration: 0,
    ownerGeneration: 1,
    ownerSessionId: 'owner-session_12345678',
    workspaceId: 'workspace_1',
    mountGeneration: 1,
    grantId: 'grant_12345678',
    grantRevision: SHA_GRANT,
    authorizationGeneration: 'authorization-generation_12345678',
    planSha256: SHA_PLAN,
    planGeneration: `plan-generation_${SHA_PLAN}`,
    teamId: 'team_1',
    runId: 'run_1',
    laneId: 'lane_1',
    memberId: 'member_1',
    memberName: 'Reviewer',
    memberOrdinal: 0,
    model: 'openai/gpt-5.1-codex',
    promptSha256: SHA_PROMPT,
    policyId: 'hosted-opencode-member-v1',
  };
}

function signer(record = frozenRecord(), assertCurrent = vi.fn(async () => {})) {
  const resolveFrozenMember = vi.fn(async () => record);
  const loadPrivateKey = vi.fn(async () => TEST_PRIVATE_KEY);
  return {
    sign: createMemberAdmissionSigner({
      productAuthority: { resolveFrozenMember, assertCurrent },
      privateKeyProvider: { loadPrivateKey },
      now: () => NOW,
      randomAdmissionId: () => '0123456789abcdef0123456789abcdef',
    }),
    assertCurrent,
    resolveFrozenMember,
    loadPrivateKey,
  };
}

describe('hosted member admission v1', () => {
  it('emits exact canonical signed bytes for one frozen member', async () => {
    const { sign, assertCurrent, resolveFrozenMember, loadPrivateKey } = signer();
    const wire = await sign.issue('operation_1', 'member_1');
    const envelope = parseCanonicalMemberAdmission(wire);
    expect(envelope.signature).toBe(
      'r9TVAIMyF9lV2fOxwKbUJ2WNuudrQOQZ69m4920vIf1RxVqWySA5i9FnrXWiJC93W1frzHSlA4lPRIo07lKUCw'
    );
    const expectedPayload =
      '{"admissionId":"0123456789abcdef0123456789abcdef","authorizationGeneration":"authorization-generation_12345678","bootId":"boot_1","deploymentId":"deployment_1","expiresAtMs":1800000060000,"format":"agent-teams.hosted-opencode-member-admission/v1","grantId":"grant_12345678","grantRevision":"' +
      SHA_GRANT +
      '","issuedAtMs":1800000000000,"laneId":"lane_1","memberId":"member_1","memberName":"Reviewer","memberOrdinal":0,"model":"openai/gpt-5.1-codex","mountGeneration":1,"operationId":"operation_1","ownerGeneration":1,"ownerSessionId":"owner-session_12345678","planGeneration":"plan-generation_' +
      SHA_PLAN +
      '","planSha256":"' +
      SHA_PLAN +
      '","policyId":"hosted-opencode-member-v1","promptSha256":"' +
      SHA_PROMPT +
      '","restoreGeneration":0,"runId":"run_1","teamId":"team_1","workspaceId":"workspace_1"}';
    expect(canonicalMemberAdmissionPayload(envelope.payload).toString('utf8')).toBe(
      expectedPayload
    );
    expect(wire.toString('utf8')).toBe(
      `{"payload":${expectedPayload},"signature":"${envelope.signature}"}`
    );
    expect(
      verify(
        null,
        memberAdmissionSigningBytes(envelope.payload),
        TEST_PUBLIC_KEY,
        Buffer.from(envelope.signature, 'base64url')
      )
    ).toBe(true);
    expect(resolveFrozenMember).toHaveBeenCalledWith('operation_1', 'member_1');
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(loadPrivateKey).toHaveBeenCalledTimes(1);
  });

  it('rejects changed signed authority fields and forged signature', async () => {
    const wire = await signer().sign.issue('operation_1', 'member_1');
    const { payload, signature } = parseCanonicalMemberAdmission(wire);
    for (const changed of [
      { ...payload, grantRevision: 'd'.repeat(64) },
      { ...payload, memberId: 'member_2' },
      { ...payload, model: 'openai/other' },
      {
        ...payload,
        planSha256: 'd'.repeat(64),
        planGeneration: `plan-generation_${'d'.repeat(64)}`,
      },
    ] as MemberAdmissionPayload[]) {
      expect(
        verify(
          null,
          memberAdmissionSigningBytes(changed),
          TEST_PUBLIC_KEY,
          Buffer.from(signature, 'base64url')
        )
      ).toBe(false);
    }
    const forged = Buffer.from(signature, 'base64url');
    forged[0] ^= 1;
    expect(verify(null, memberAdmissionSigningBytes(payload), TEST_PUBLIC_KEY, forged)).toBe(false);
  });

  it('rechecks the current grant and frozen plan after awaiting key custody', async () => {
    const assertCurrent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('stale-grant-or-plan'));
    const { sign, loadPrivateKey } = signer(frozenRecord(), assertCurrent);
    await expect(sign.issue('operation_1', 'member_1')).rejects.toThrow('stale-grant-or-plan');
    expect(loadPrivateKey).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('fails closed on wrong plan/member, expiry, duplicate keys, and unknown options', async () => {
    const wrongPlan = { ...frozenRecord(), planSha256: 'd'.repeat(64) };
    await expect(signer(wrongPlan).sign.issue('operation_1', 'member_1')).rejects.toThrow(
      'member-admission-payload-invalid'
    );
    await expect(
      signer({ ...frozenRecord(), memberId: 'member_2' }).sign.issue('operation_1', 'member_1')
    ).rejects.toThrow('member-admission-resolver-mismatch');
    const wire = await signer().sign.issue('operation_1', 'member_1');
    const { payload, signature } = parseCanonicalMemberAdmission(wire);
    const canonical = canonicalMemberAdmissionPayload(payload).toString('utf8');
    const expired = canonical.replace('"expiresAtMs":1800000060000', '"expiresAtMs":1800000060001');
    expect(() =>
      parseCanonicalMemberAdmission(
        Buffer.from(`{"payload":${expired},"signature":"${signature}"}`)
      )
    ).toThrow('member-admission-envelope-invalid');
    const duplicate = canonical.replace(
      '"memberId":"member_1",',
      '"memberId":"member_1","memberId":"member_2",'
    );
    expect(() =>
      parseCanonicalMemberAdmission(
        Buffer.from(`{"payload":${duplicate},"signature":"${signature}"}`)
      )
    ).toThrow('member-admission-not-canonical');
    const extra = canonical.replace('"model":', '"hostPath":"/tmp/forged","model":');
    expect(() =>
      parseCanonicalMemberAdmission(Buffer.from(`{"payload":${extra},"signature":"${signature}"}`))
    ).toThrow('member-admission-envelope-invalid');
  });
});
