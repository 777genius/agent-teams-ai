import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

import {
  canonicalHostedActualOwnerCapabilityAttestationBytes,
  canonicalHostedActualOwnerCapabilityAttestationUnsignedBytes,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_DOMAIN,
  HOSTED_ACTUAL_OWNER_FROZEN_TRANSITION_SHA256,
  hostedActualOwnerCapabilityAttestationSigningBytes,
  HostedActualOwnerCapabilityAttestationValidationError,
  type HostedActualOwnerExternalWriterCapabilityAttestationSubject,
  parseHostedActualOwnerCapabilityAttestation,
} from '@features/hosted-actual-owner-capability-attestation';
import {
  NodeHostedActualOwnerCapabilityAttestationIssuer,
  verifyHostedActualOwnerCapabilityAttestation,
} from '@features/hosted-actual-owner-capability-attestation/main';

const SUBJECT: HostedActualOwnerExternalWriterCapabilityAttestationSubject = Object.freeze({
  runId: '11'.repeat(24),
  teamId: `team_${'22'.repeat(16)}`,
  sessionId: `session_${'11'.repeat(24)}`,
  productPid: 4242,
  productCommit: '44'.repeat(20),
  orchestratorCommit: '55'.repeat(20),
  openCodeCommit: '66'.repeat(20),
  productExecutableSha256: '77'.repeat(32),
  sourceClosureSha256: '88'.repeat(32),
  buildProvenanceSha256: '99'.repeat(32),
  ownerContractSha256: 'aa'.repeat(32),
  frozenTransitionSha256: HOSTED_ACTUAL_OWNER_FROZEN_TRANSITION_SHA256,
  manifestSha256: 'bb'.repeat(32),
  driverSocketIdentity: { device: '10', inode: '20' },
  productSocketIdentity: { device: '10', inode: '21' },
  routeDigest: 'cc'.repeat(32),
  captureDigest: 'dd'.repeat(32),
});

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const NONCE = Uint8Array.from({ length: 32 }, (_, index) => index + 32);

function vector() {
  const issuer = new NodeHostedActualOwnerCapabilityAttestationIssuer({
    testOnlyPrivateKeySeed: SEED,
    randomBytes: () => NONCE,
    now: () => 1_700_000_000_000,
  });
  return { issuer, descriptor: issuer.issue({ subject: SUBJECT }) };
}

function replaceJson(bytes: Uint8Array, transform: (source: string) => string): Uint8Array {
  return Buffer.from(transform(Buffer.from(bytes).toString('utf8')), 'utf8');
}

function moveSignatureBeforeCapability(source: string): string {
  const signatureIndex = source.lastIndexOf(',"signature":');
  const capabilityIndex = source.lastIndexOf(',"capability":');
  const signature = source.slice(signatureIndex + 1, -1);
  return `${source.slice(0, capabilityIndex)},${signature}${source.slice(capabilityIndex, signatureIndex)}}`;
}

describe('HostedActualOwnerExternalWriterCapabilityAttestation v1', () => {
  it('reproduces the deterministic canonical/signature vector', () => {
    const { issuer, descriptor } = vector();
    expect(issuer.publicKey).toBe('A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg');
    expect(issuer.keyId).toBe('56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c');
    expect(descriptor.attestation.signature).toBe(
      'jrnvNjXT1N_R7PXeWyugRE9XSNdGT8lCCtbRtQQUvRH6jbzKGV4WDiMZk-_ddOJJgQm2gG8zOr27S7EoOxC_AA'
    );
    expect(createHash('sha256').update(descriptor.canonicalBytes).digest('hex')).toBe(
      '71fad5300c4a5e30decf715e05f7191ddcb351a72354d3a32fadbb12b6bb3444'
    );
    expect(Object.keys(descriptor.attestation)).toEqual([
      'schemaVersion',
      'purpose',
      'issuer',
      'keyId',
      'algorithm',
      'subject',
      'audience',
      'issuedAtMs',
      'notBeforeMs',
      'expiresAtMs',
      'nonce',
      'capability',
      'signature',
    ]);
    const { signature: _signature, ...unsigned } = descriptor.attestation;
    expect(Buffer.from(hostedActualOwnerCapabilityAttestationSigningBytes(unsigned))).toEqual(
      Buffer.concat([
        Buffer.from(HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_DOMAIN),
        Buffer.of(0),
        Buffer.from(canonicalHostedActualOwnerCapabilityAttestationUnsignedBytes(unsigned)),
      ])
    );
    expect(
      verifyHostedActualOwnerCapabilityAttestation({
        bytes: descriptor.canonicalBytes,
        publicKey: descriptor.publicKey,
        nowMs: 1_700_000_000_001,
      })
    ).toEqual(descriptor.attestation);
    issuer.dispose();
  });

  it('creates a fresh key for each session and unique nonces within a session', () => {
    const first = new NodeHostedActualOwnerCapabilityAttestationIssuer();
    const second = new NodeHostedActualOwnerCapabilityAttestationIssuer();
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.issue({ subject: SUBJECT }).attestation.nonce).not.toBe(
      first.issue({ subject: SUBJECT }).attestation.nonce
    );
    first.dispose();
    second.dispose();
  });

  it('drops issuance authority on idempotent disposal without serializing private material', () => {
    const { issuer } = vector();
    expect(JSON.stringify(issuer)).toBe(
      JSON.stringify({ keyId: issuer.keyId, publicKey: issuer.publicKey })
    );
    expect(Object.keys(issuer)).toEqual(['publicKey', 'keyId']);
    expect(inspect(issuer, { showHidden: true })).not.toMatch(/seed|privateKey|issuedNonces/u);
    issuer.dispose();
    issuer.dispose();
    expect(() => issuer.issue({ subject: SUBJECT })).toThrow(/issuer_disposed/u);
  });

  it('fails closed if an injected entropy source repeats a nonce', () => {
    const { issuer } = vector();
    expect(() => issuer.issue({ subject: SUBJECT })).toThrow(/nonce_reused/u);
    issuer.dispose();
  });

  it('does not reuse one session key for a changed attestation subject', () => {
    const { issuer } = vector();
    expect(() =>
      issuer.issue({
        subject: { ...SUBJECT, teamId: `team_${'ff'.repeat(16)}` },
      })
    ).toThrow(/subject_changed/u);
    issuer.dispose();
  });

  it.each([
    [
      'unknown field',
      (source: string) => source.replace(',"signature"', ',"extra":true,"signature"'),
    ],
    ['signature not last', moveSignatureBeforeCapability],
    [
      'wrong order',
      (source: string) =>
        source
          .replace('{"schemaVersion":1,"purpose"', '{"purpose"')
          .replace(',"issuer"', ',"schemaVersion":1,"issuer"'),
    ],
    [
      'duplicate key',
      (source: string) =>
        source.replace('{"schemaVersion":1', '{"schemaVersion":1,"schemaVersion":1'),
    ],
    [
      'nested duplicate key',
      (source: string) =>
        source.replace(
          '"driverSocketIdentity":{"device":"10"',
          '"driverSocketIdentity":{"device":"10","device":"10"'
        ),
    ],
    [
      'nested unknown field',
      (source: string) =>
        source.replace(
          '"driverSocketIdentity":{"device":"10"',
          '"driverSocketIdentity":{"extra":null,"device":"10"'
        ),
    ],
    ['trailing whitespace', (source: string) => `${source} `],
    ['padded base64url', (source: string) => source.replace(/"nonce":"([^"]+)"/u, '"nonce":"$1="')],
    [
      'non-zero base64url trailing bits',
      (source: string) => source.replace(/("nonce":"[^"]{42})8"/u, '$1_"'),
    ],
    [
      'wrong scalar type',
      (source: string) => source.replace('"productPid":4242', '"productPid":"4242"'),
    ],
    [
      'lifetime over boundary',
      (source: string) =>
        source.replace('"expiresAtMs":1700000005000', '"expiresAtMs":1700000005001'),
    ],
    [
      'unsafe integer',
      (source: string) => source.replace('"productPid":4242', '"productPid":9007199254740992'),
    ],
    ['negative zero', (source: string) => source.replace('"productPid":4242', '"productPid":-0')],
  ])('rejects %s before signature verification', (_label, transform) => {
    const { descriptor } = vector();
    expect(() =>
      parseHostedActualOwnerCapabilityAttestation(replaceJson(descriptor.canonicalBytes, transform))
    ).toThrow(HostedActualOwnerCapabilityAttestationValidationError);
  });

  it('rejects malformed UTF-8 and byte-length boundaries', () => {
    expect(() => parseHostedActualOwnerCapabilityAttestation(Uint8Array.of(0xc3, 0x28))).toThrow(
      /_utf8/u
    );
    expect(() => parseHostedActualOwnerCapabilityAttestation(new Uint8Array())).toThrow(/_length/u);
    expect(() => parseHostedActualOwnerCapabilityAttestation(new Uint8Array(16_385))).toThrow(
      /_length/u
    );
  });

  it('rejects tampering, another session key, and time boundaries', () => {
    const { descriptor } = vector();
    const tampered = {
      ...descriptor.attestation,
      subject: { ...descriptor.attestation.subject, routeDigest: 'ee'.repeat(32) },
    };
    expect(() =>
      verifyHostedActualOwnerCapabilityAttestation({
        bytes: canonicalHostedActualOwnerCapabilityAttestationBytes(tampered),
        publicKey: descriptor.publicKey,
      })
    ).toThrow(/signature_invalid/u);
    const foreign = new NodeHostedActualOwnerCapabilityAttestationIssuer();
    expect(() =>
      verifyHostedActualOwnerCapabilityAttestation({
        bytes: descriptor.canonicalBytes,
        publicKey: foreign.publicKey,
      })
    ).toThrow(/key_id_mismatch/u);
    expect(() =>
      verifyHostedActualOwnerCapabilityAttestation({
        bytes: descriptor.canonicalBytes,
        publicKey: descriptor.publicKey,
        nowMs: descriptor.attestation.expiresAtMs,
      })
    ).toThrow(/time_invalid/u);
    foreign.dispose();
  });

  it('enforces the five-second issuance boundary', () => {
    const issuer = new NodeHostedActualOwnerCapabilityAttestationIssuer({
      testOnlyPrivateKeySeed: SEED,
      randomBytes: () => NONCE,
      now: () => 1_700_000_000_000,
    });
    expect(() => issuer.issue({ subject: SUBJECT, lifetimeMs: 0 })).toThrow(/lifetime_invalid/u);
    expect(() => issuer.issue({ subject: SUBJECT, lifetimeMs: 5_001 })).toThrow(
      /lifetime_invalid/u
    );
    expect(issuer.issue({ subject: SUBJECT, lifetimeMs: 5_000 }).attestation.expiresAtMs).toBe(
      1_700_000_005_000
    );
    issuer.dispose();
  });
});
