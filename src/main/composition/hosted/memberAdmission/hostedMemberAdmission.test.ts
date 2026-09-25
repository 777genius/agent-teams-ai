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
import { memberStartOperationId } from './hostedMemberStartResolution';

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
const SHA_PLAN = 'd'.repeat(64);
const RUN_ID = `run_${'b'.repeat(32)}`;
const MEMBER_ID = `member_${'f'.repeat(32)}`;
const TEAM_ID = `team_${'1'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'2'.repeat(32)}`;
const LANE_ID = `lane_${'3'.repeat(32)}`;
const OPERATION_ID = 'start_89fca1ff37e680c24c36381ab6a78ba1da0ee332c520cff5625c74720bd90459';
const SHA_PROMPT = 'b'.repeat(64);
const SHA_GRANT = 'c'.repeat(64);
const NOW = 1_800_000_000_000;

function frozenRecord(): FrozenMemberAdmissionRecord {
  return {
    operationId: OPERATION_ID,
    deploymentId: 'deployment_1',
    bootId: 'boot_1',
    restoreGeneration: 0,
    ownerGeneration: 1,
    ownerSessionId: 'owner-session_12345678',
    workspaceId: WORKSPACE_ID,
    mountGeneration: 1,
    grantRevision: SHA_GRANT,
    planSha256: SHA_PLAN,
    planGeneration: `plan-generation_${SHA_PLAN}`,
    teamId: TEAM_ID,
    runId: RUN_ID,
    laneId: LANE_ID,
    memberId: MEMBER_ID,
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

describe('hosted member admission v2', () => {
  it('emits exact canonical signed bytes for one frozen member', async () => {
    const { sign, assertCurrent, resolveFrozenMember, loadPrivateKey } = signer();
    const wire = await sign.issue(RUN_ID, MEMBER_ID);
    const envelope = parseCanonicalMemberAdmission(wire);
    expect(envelope.signature).toBe(
      '0PCnK3ZKVyVGstTr20uIZqbb7Qe4E4e0_4sOh7NVkqhOr5opvGCNEmkoWNwVw7a-TEBt8x2w43se489zKxGHCQ'
    );
    const expectedPayload =
      '{"admissionId":"0123456789abcdef0123456789abcdef","bootId":"boot_1","deploymentId":"deployment_1","expiresAtMs":1800000060000,"format":"agent-teams.hosted-opencode-member-admission/v2","grantRevision":"' +
      SHA_GRANT +
      '","issuedAtMs":1800000000000,"laneId":"' +
      LANE_ID +
      '","memberId":"' +
      MEMBER_ID +
      '","memberName":"Reviewer","memberOrdinal":0,"model":"openai/gpt-5.1-codex","mountGeneration":1,"operationId":"' +
      OPERATION_ID +
      '","ownerGeneration":1,"ownerSessionId":"owner-session_12345678","planGeneration":"plan-generation_' +
      SHA_PLAN +
      '","planSha256":"' +
      SHA_PLAN +
      '","policyId":"hosted-opencode-member-v1","promptSha256":"' +
      SHA_PROMPT +
      '","restoreGeneration":0,"runId":"' +
      RUN_ID +
      '","teamId":"' +
      TEAM_ID +
      '","workspaceId":"' +
      WORKSPACE_ID +
      '"}';
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
    expect(resolveFrozenMember).toHaveBeenCalledWith(RUN_ID, MEMBER_ID);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(loadPrivateKey).toHaveBeenCalledTimes(1);
  });

  it('rejects changed signed authority fields and forged signature', async () => {
    const wire = await signer().sign.issue(RUN_ID, MEMBER_ID);
    const { payload, signature } = parseCanonicalMemberAdmission(wire);
    for (const changed of [
      { ...payload, grantRevision: 'd'.repeat(64) },
      {
        ...payload,
        memberId: `member_${'2'.repeat(32)}`,
        operationId: memberStartOperationId(RUN_ID, `member_${'2'.repeat(32)}`, SHA_PLAN),
      },
      { ...payload, model: 'openai/other' },
      {
        ...payload,
        planSha256: 'e'.repeat(64),
        planGeneration: `plan-generation_${'e'.repeat(64)}`,
        operationId: memberStartOperationId(RUN_ID, MEMBER_ID, 'e'.repeat(64)),
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
    await expect(sign.issue(RUN_ID, MEMBER_ID)).rejects.toThrow('stale-grant-or-plan');
    expect(loadPrivateKey).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('keeps the original Product fence and key custody methods across async port mutation', async () => {
    const originalResolve = vi.fn(async () => frozenRecord());
    const originalAssert = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('grant-revoked-during-key-load'));
    const replacementAssert = vi.fn(async () => {});
    const authority = {
      resolveFrozenMember: originalResolve,
      assertCurrent: originalAssert,
    };
    const replacementLoad = vi.fn(async () => TEST_PRIVATE_KEY);
    const originalLoad = vi.fn(async () => {
      authority.assertCurrent = replacementAssert;
      return TEST_PRIVATE_KEY;
    });
    const keyProvider = { loadPrivateKey: originalLoad };
    const sign = createMemberAdmissionSigner({
      productAuthority: authority,
      privateKeyProvider: keyProvider,
      now: () => NOW,
      randomAdmissionId: () => '0123456789abcdef0123456789abcdef',
    });
    authority.resolveFrozenMember = vi.fn(async () => ({ ...frozenRecord(), memberId: 'forged' }));
    keyProvider.loadPrivateKey = replacementLoad;
    await expect(sign.issue(RUN_ID, MEMBER_ID)).rejects.toThrow('grant-revoked-during-key-load');
    expect(originalResolve).toHaveBeenCalledOnce();
    expect(originalAssert).toHaveBeenCalledTimes(2);
    expect(originalLoad).toHaveBeenCalledOnce();
    expect(replacementAssert).not.toHaveBeenCalled();
    expect(replacementLoad).not.toHaveBeenCalled();
  });

  it('rejects missing authority or key custody ports before issuing', () => {
    expect(() =>
      createMemberAdmissionSigner({
        productAuthority: null as never,
        privateKeyProvider: { loadPrivateKey: async () => TEST_PRIVATE_KEY },
      })
    ).toThrow('member-admission-ports-invalid');
    expect(() =>
      createMemberAdmissionSigner({
        productAuthority: {
          resolveFrozenMember: async () => frozenRecord(),
          assertCurrent: null as never,
        },
        privateKeyProvider: { loadPrivateKey: async () => TEST_PRIVATE_KEY },
      })
    ).toThrow('member-admission-ports-invalid');
  });

  it('fails closed on wrong plan/member, expiry, duplicate keys, and unknown options', async () => {
    const wrongPlan = { ...frozenRecord(), planSha256: 'e'.repeat(64) };
    await expect(signer(wrongPlan).sign.issue(RUN_ID, MEMBER_ID)).rejects.toThrow(
      'member-admission-resolver-mismatch'
    );
    await expect(
      signer({ ...frozenRecord(), runId: `run_${'a'.repeat(32)}` }).sign.issue(RUN_ID, MEMBER_ID)
    ).rejects.toThrow('member-admission-resolver-mismatch');
    await expect(
      signer({ ...frozenRecord(), operationId: `start_${'a'.repeat(64)}` }).sign.issue(
        RUN_ID,
        MEMBER_ID
      )
    ).rejects.toThrow('member-admission-resolver-mismatch');
    await expect(signer().sign.issue('run_1', MEMBER_ID)).rejects.toThrow(
      'member-admission-selector-invalid'
    );
    await expect(
      signer({ ...frozenRecord(), memberId: 'member_2' }).sign.issue(RUN_ID, MEMBER_ID)
    ).rejects.toThrow('member-admission-resolver-mismatch');
    const wire = await signer().sign.issue(RUN_ID, MEMBER_ID);
    const { payload, signature } = parseCanonicalMemberAdmission(wire);
    const canonical = canonicalMemberAdmissionPayload(payload).toString('utf8');
    const expired = canonical.replace('"expiresAtMs":1800000060000', '"expiresAtMs":1800000060001');
    expect(() =>
      parseCanonicalMemberAdmission(
        Buffer.from(`{"payload":${expired},"signature":"${signature}"}`)
      )
    ).toThrow('member-admission-envelope-invalid');
    const duplicate = canonical.replace(
      `"memberId":"${MEMBER_ID}",`,
      `"memberId":"${MEMBER_ID}","memberId":"${MEMBER_ID}",`
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
    const oldFormat = canonical.replace(
      'agent-teams.hosted-opencode-member-admission/v2',
      'agent-teams.hosted-opencode-member-admission/v1'
    );
    expect(() =>
      parseCanonicalMemberAdmission(
        Buffer.from(`{"payload":${oldFormat},"signature":"${signature}"}`)
      )
    ).toThrow('member-admission-envelope-invalid');
  });
});
