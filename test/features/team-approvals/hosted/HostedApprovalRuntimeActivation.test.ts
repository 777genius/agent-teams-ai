import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signDetached,
  timingSafeEqual,
  verify as verifyDetached,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  activateHostedApprovalRuntime,
  HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV,
  HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
  HOSTED_APPROVAL_ACTIVATION_CONTRACT_DIGEST_ENV,
  HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN,
  HOSTED_APPROVAL_ACTIVATION_PUBLIC_KEY_DIGEST_ENV,
  HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV,
  type HostedApprovalRuntimeActivationBinding,
  readHostedApprovalRuntimeActivationPublicationContract,
  readHostedApprovalRuntimeActivationSigningIdentity,
  serializeHostedApprovalRuntimeActivationEnvelope,
  serializeHostedApprovalRuntimeActivationPublication,
  verifyHostedApprovalRuntimeActivationEnvelope,
  verifyHostedApprovalRuntimeActivationPublication,
} from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';

import type { OrchestratorLifecycleOwnerProofKey } from '../../../../src/main/composition/hosted/hostedLifecycleOrchestratorReadiness';
import type { Socket } from 'node:net';

const GOLDEN_PATH = 'docs/hosted-approval-activation-v2-golden.json';
const CONTRACT_PATH = 'docs/hosted-approval-activation-v2-contract.json';
const CHALLENGE = '3'.repeat(64);

interface Golden {
  readonly proof: Readonly<{
    domain: string;
    testOnlySecretHex: string;
  }>;
  readonly signing: Readonly<{
    contract: string;
    testOnlyPrivateKeyPkcs8Pem: string;
    publicKeySpkiDerBase64url: string;
    publicKeyDigest: `sha256:${string}`;
    contractDigest: `sha256:${string}`;
  }>;
  readonly binding: HostedApprovalRuntimeActivationBinding;
  readonly digestDistinction: Readonly<{
    ownerArtifactDigest: `sha256:${string}`;
    openCodeArtifactDigest: `sha256:${string}`;
    intentionallyDifferent: true;
  }>;
  readonly admissionDocument: string;
  readonly prepare: GoldenProofVector;
  readonly ownerReady: GoldenProofVector;
  readonly publication: Readonly<{
    direction: string;
    serializedUnsignedEnvelope: string;
    controllerProof: string;
    serializedSignedEnvelope: string;
    serializedSignatureStatement: string;
    signature: string;
    bytes: string;
    activationDigest: string;
    transportBytes: string;
  }>;
  readonly ready: GoldenProofVector;
  readonly expectedDerivedTeamView: Readonly<{
    teamId: string;
    admissionGeneration: string;
    approvalDigest: `sha256:${string}`;
    admissionDocumentDigest: `sha256:${string}`;
    routes: readonly Record<string, unknown>[];
    actorMembers: Readonly<Record<string, string>>;
  }>;
}

interface GoldenProofVector {
  readonly direction: string;
  readonly serializedUnsigned: string;
  readonly controllerProof: string;
  readonly bytes: string;
  readonly transportBytes: string;
}

async function golden(): Promise<Golden> {
  return JSON.parse(await readFile(GOLDEN_PATH, 'utf8')) as Golden;
}

describe('hosted approval activation-v2', () => {
  it('matches the shared byte-for-byte golden with an independent serializer verifier', async () => {
    const fixture = await golden();
    const key = fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey;
    const serialized = serializeHostedApprovalRuntimeActivationEnvelope(
      key,
      fixture.binding,
      fixture.admissionDocument
    );
    const publication = serializeHostedApprovalRuntimeActivationPublication(
      key,
      signingIdentity(fixture),
      fixture.binding,
      fixture.admissionDocument
    );

    expect(serialized).toBe(fixture.publication.serializedSignedEnvelope);
    expect(publication).toBe(fixture.publication.bytes);
    const contractBytes = await readFile(CONTRACT_PATH);
    expect(`sha256:${createHash('sha256').update(contractBytes).digest('hex')}`).toBe(
      fixture.signing.contractDigest
    );
    expect(contractBytes.at(-1)).toBe(0x0a);
    expect(contractBytes.subarray(0, -1).includes(0x0a)).toBe(false);
    expect(fixture.signing.contract).toBe(
      'agent-teams.hosted-approval-activation-product-authorship/v2'
    );
    expect(
      serialized.endsWith(`,"controllerProof":"${fixture.publication.controllerProof}"}`)
    ).toBe(true);
    expect(fixture.proof.domain).toBe(HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN);
    expect(fixture.publication.direction).toBe('admission');
    expect(fixture.digestDistinction.intentionallyDifferent).toBe(true);
    expect(fixture.digestDistinction.ownerArtifactDigest).not.toBe(
      fixture.digestDistinction.openCodeArtifactDigest
    );

    assertGoldenProofVector(fixture.prepare, key, 'owner-ready-request', {
      schemaVersion: 2,
      operation: 'approval_activation_prepare',
      capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
      challenge: CHALLENGE,
      binding: fixture.binding,
    });
    assertGoldenProofVector(fixture.ownerReady, key, 'owner-ready', {
      schemaVersion: 2,
      kind: 'owner_ready',
      capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
      challenge: CHALLENGE,
      binding: fixture.binding,
    });
    assertGoldenProofVector(fixture.ready, key, 'ready', {
      schemaVersion: 2,
      kind: 'ready',
      capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
      challenge: CHALLENGE,
      activationDigest: fixture.publication.activationDigest,
      binding: fixture.binding,
    });

    const independentlyParsed = independentVerify(
      fixture.publication.serializedSignedEnvelope,
      fixture.proof.testOnlySecretHex,
      'admission'
    );
    expect(independentlyParsed.unsigned).toBe(fixture.publication.serializedUnsignedEnvelope);
    expect(independentlyParsed.value.binding).toEqual(fixture.binding);
    expect(independentlyParsed.value.admission).toEqual(JSON.parse(fixture.admissionDocument));
    expect(fixture.publication.serializedSignedEnvelope).toBe(
      appendIndependentProof(
        fixture.publication.serializedUnsignedEnvelope,
        fixture.publication.controllerProof
      )
    );
    expect(fixture.publication.transportBytes).toBe(`${fixture.publication.bytes}\n`);

    const publicationValue = JSON.parse(fixture.publication.bytes) as {
      schemaVersion: number;
      envelope: Record<string, unknown>;
      authorship: {
        algorithm: string;
        publicKeyDigest: string;
        contractDigest: string;
        signature: string;
      };
    };
    expect(JSON.stringify(publicationValue)).toBe(fixture.publication.bytes);
    expect(publicationValue.schemaVersion).toBe(2);
    expect(JSON.stringify(publicationValue.envelope)).toBe(
      fixture.publication.serializedSignedEnvelope
    );
    expect(publicationValue.authorship).toEqual({
      algorithm: 'Ed25519',
      publicKeyDigest: fixture.signing.publicKeyDigest,
      contractDigest: fixture.signing.contractDigest,
      signature: fixture.publication.signature,
    });
    const independentlySerializedStatement = serializeIndependentSignatureStatement(
      fixture.publication.serializedSignedEnvelope,
      fixture.signing.publicKeyDigest,
      fixture.signing.contractDigest
    );
    expect(fixture.publication.serializedSignatureStatement).toBe(independentlySerializedStatement);
    expect(
      verifyDetached(
        null,
        Buffer.from(independentlySerializedStatement),
        createPublicKey({
          key: Buffer.from(fixture.signing.publicKeySpkiDerBase64url, 'base64url'),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(fixture.publication.signature, 'base64url')
      )
    ).toBe(true);
    expect(createHash('sha256').update(fixture.publication.bytes).digest('hex')).toBe(
      fixture.publication.activationDigest
    );

    const admission = JSON.parse(fixture.admissionDocument) as {
      admissionGeneration: string;
      routes: Array<Record<string, unknown> & { authority: Record<string, unknown> }>;
      actorMembers: Record<string, string>;
    };
    expect(fixture.admissionDocument).toBe(`${JSON.stringify(admission)}\n`);
    const approvalSnapshot = {
      schemaVersion: 1,
      approvalGeneration: fixture.binding.approvalGeneration,
      authorities: admission.routes.map((route) => route.authority),
    };
    expect(
      `sha256:${createHash('sha256').update(JSON.stringify(approvalSnapshot)).digest('hex')}`
    ).toBe(fixture.expectedDerivedTeamView.approvalDigest);
    expect(`sha256:${createHash('sha256').update(fixture.admissionDocument).digest('hex')}`).toBe(
      fixture.expectedDerivedTeamView.admissionDocumentDigest
    );
    const teamRoutes = admission.routes.filter(
      (route) => route.authority.teamId === fixture.binding.teamId
    );
    const teamActorIds = new Set(
      teamRoutes.map((route) => (route.scope as { principalId: string }).principalId)
    );
    expect(fixture.expectedDerivedTeamView).toEqual({
      teamId: fixture.binding.teamId,
      admissionGeneration: admission.admissionGeneration,
      approvalDigest: fixture.binding.approvalDigest,
      admissionDocumentDigest: fixture.binding.admissionDocumentDigest,
      routes: teamRoutes,
      actorMembers: Object.fromEntries(
        Object.entries(admission.actorMembers).filter(([actorId]) => teamActorIds.has(actorId))
      ),
    });
    expect(
      verifyHostedApprovalRuntimeActivationPublication(
        fixture.publication.bytes,
        key,
        publicVerifier(fixture),
        fixture.binding
      )
    ).toEqual(JSON.parse(fixture.admissionDocument));
  });

  it('rejects proof, binding, signed-manifest, and noncanonical-inner drift', async () => {
    const fixture = await golden();
    const key = fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey;
    expect(
      verifyHostedApprovalRuntimeActivationEnvelope(
        fixture.publication.serializedSignedEnvelope,
        key,
        fixture.binding
      )
    ).toEqual(
      (JSON.parse(fixture.publication.serializedSignedEnvelope) as { admission: unknown }).admission
    );

    const proofTampered = fixture.publication.serializedSignedEnvelope.replace(
      fixture.publication.controllerProof,
      `${fixture.publication.controllerProof.slice(0, -1)}${fixture.publication.controllerProof.endsWith('0') ? '1' : '0'}`
    );
    expect(() =>
      verifyHostedApprovalRuntimeActivationEnvelope(proofTampered, key, fixture.binding)
    ).toThrow(/proof-invalid/u);

    const envelopeValue = JSON.parse(fixture.publication.serializedSignedEnvelope) as Record<
      string,
      unknown
    >;
    const legacyUnsigned = JSON.stringify({
      schemaVersion: 1,
      purpose: envelopeValue.purpose,
      binding: envelopeValue.binding,
      admission: envelopeValue.admission,
    });
    expect(() =>
      verifyHostedApprovalRuntimeActivationEnvelope(
        sign(legacyUnsigned, key, 'admission'),
        key,
        fixture.binding
      )
    ).toThrow(/binding-mismatch/u);
    const reorderedUnsigned = JSON.stringify({
      purpose: envelopeValue.purpose,
      schemaVersion: 2,
      binding: envelopeValue.binding,
      admission: envelopeValue.admission,
    });
    expect(() =>
      verifyHostedApprovalRuntimeActivationEnvelope(
        sign(reorderedUnsigned, key, 'admission'),
        key,
        fixture.binding
      )
    ).toThrow(/noncanonical|order/u);
    const unknownUnsigned = JSON.stringify({
      schemaVersion: 2,
      purpose: envelopeValue.purpose,
      binding: envelopeValue.binding,
      admission: envelopeValue.admission,
      unknown: true,
    });
    expect(() =>
      verifyHostedApprovalRuntimeActivationEnvelope(
        sign(unknownUnsigned, key, 'admission'),
        key,
        fixture.binding
      )
    ).toThrow(/noncanonical|order/u);

    const staleBinding = {
      ...fixture.binding,
      signedManifest: {
        ...fixture.binding.signedManifest,
        manifestDigest: `sha256:${'d'.repeat(64)}` as const,
      },
    };
    expect(() =>
      verifyHostedApprovalRuntimeActivationEnvelope(
        fixture.publication.serializedSignedEnvelope,
        key,
        staleBinding
      )
    ).toThrow(/binding-mismatch/u);

    expect(() =>
      verifyHostedApprovalRuntimeActivationEnvelope(
        ` ${fixture.publication.serializedSignedEnvelope}`,
        key,
        fixture.binding
      )
    ).toThrow(/noncanonical/u);

    const forgedPublication = fixture.publication.bytes.replace(
      fixture.publication.signature,
      Buffer.alloc(64).toString('base64url')
    );
    expect(() =>
      verifyHostedApprovalRuntimeActivationPublication(
        forgedPublication,
        key,
        publicVerifier(fixture),
        fixture.binding
      )
    ).toThrow(/authorship-invalid/u);
    expect(() =>
      verifyHostedApprovalRuntimeActivationPublication(
        fixture.publication.serializedSignedEnvelope,
        key,
        publicVerifier(fixture),
        fixture.binding
      )
    ).toThrow(/publication|order/u);
    expect(() =>
      verifyHostedApprovalRuntimeActivationPublication(
        fixture.publication.bytes,
        key,
        { ...publicVerifier(fixture), contractDigest: `sha256:${'f'.repeat(64)}` },
        fixture.binding
      )
    ).toThrow(/authorship-pin-mismatch/u);
    const repinned = JSON.parse(fixture.publication.bytes) as {
      authorship: { contractDigest: `sha256:${string}` };
    };
    repinned.authorship.contractDigest = `sha256:${'f'.repeat(64)}`;
    expect(() =>
      verifyHostedApprovalRuntimeActivationPublication(
        JSON.stringify(repinned),
        key,
        { ...publicVerifier(fixture), contractDigest: repinned.authorship.contractDigest },
        fixture.binding
      )
    ).toThrow(/authorship-invalid/u);

    const admission = JSON.parse(fixture.admissionDocument) as {
      routes: Array<{ authority: Record<string, unknown> }>;
    };
    admission.routes[0]!.authority.teamId = `team_${'2'.repeat(32)}`;
    expect(() =>
      serializeHostedApprovalRuntimeActivationEnvelope(
        key,
        fixture.binding,
        `${JSON.stringify(admission)}\n`
      )
    ).toThrow(/route-invalid/u);
    expect(() =>
      serializeHostedApprovalRuntimeActivationEnvelope(
        key,
        {
          ...fixture.binding,
          approvalDigest: `sha256:${'d'.repeat(64)}`,
        },
        fixture.admissionDocument
      )
    ).toThrow(/admission-digest-mismatch/u);
  });

  it('rejects an authenticated authority reorder with the original canonical approval digest', async () => {
    const fixture = await golden();
    const key = fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey;
    const admission = JSON.parse(fixture.admissionDocument) as {
      routes: Array<{ authority: Record<string, unknown> }>;
    };
    const canonicalApprovalDigest =
      'sha256:a3b3bdaa631d8f55e49cb8676b84d0d808ddfecf955d3e0ab54b4befcc0834af';
    const canonicalApprovalSnapshot = JSON.stringify({
      schemaVersion: 1,
      approvalGeneration: fixture.binding.approvalGeneration,
      authorities: admission.routes.map((route) => route.authority),
    });
    expect(`sha256:${createHash('sha256').update(canonicalApprovalSnapshot).digest('hex')}`).toBe(
      canonicalApprovalDigest
    );
    expect(fixture.binding.approvalDigest).toBe(canonicalApprovalDigest);

    const originalAuthority = admission.routes[0]!.authority;
    admission.routes[0]!.authority = {
      teamId: originalAuthority.teamId,
      deploymentId: originalAuthority.deploymentId,
      ...Object.fromEntries(
        Object.entries(originalAuthority).filter(
          ([name]) => name !== 'teamId' && name !== 'deploymentId'
        )
      ),
    };
    expect(admission.routes[0]!.authority).toEqual(originalAuthority);
    expect(Object.keys(admission.routes[0]!.authority).slice(0, 2)).toEqual([
      'teamId',
      'deploymentId',
    ]);
    const admissionDocument = `${JSON.stringify(admission)}\n`;
    expect(admissionDocument).not.toBe(fixture.admissionDocument);
    const binding = {
      ...fixture.binding,
      approvalDigest: canonicalApprovalDigest,
      admissionDocumentDigest: `sha256:${createHash('sha256')
        .update(admissionDocument)
        .digest('hex')}` as const,
    };
    const unsignedEnvelope = JSON.stringify({
      schemaVersion: 2,
      purpose: 'agent-teams.hosted-approval-activation/v2',
      binding,
      admission,
    });
    const signedEnvelope = sign(unsignedEnvelope, key, 'admission');
    expect(independentVerify(signedEnvelope, key, 'admission').unsigned).toBe(unsignedEnvelope);

    const signatureStatement = serializeIndependentSignatureStatement(
      signedEnvelope,
      fixture.signing.publicKeyDigest,
      fixture.signing.contractDigest
    );
    const signature = signDetached(
      null,
      Buffer.from(signatureStatement),
      signingIdentity(fixture).privateKey
    ).toString('base64url');
    const publication = JSON.stringify({
      schemaVersion: 2,
      envelope: JSON.parse(signedEnvelope),
      authorship: {
        algorithm: 'Ed25519',
        publicKeyDigest: fixture.signing.publicKeyDigest,
        contractDigest: fixture.signing.contractDigest,
        signature,
      },
    });
    expect(
      verifyDetached(
        null,
        Buffer.from(signatureStatement),
        createPublicKey({
          key: Buffer.from(fixture.signing.publicKeySpkiDerBase64url, 'base64url'),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true);
    expect(() =>
      verifyHostedApprovalRuntimeActivationPublication(
        publication,
        key,
        publicVerifier(fixture),
        binding
      )
    ).toThrow(/order/u);
  });

  it.each([
    ['RSA-512', generateKeyPairSync('rsa', { modulusLength: 512 }).publicKey],
    ['EC P-256', generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey],
  ])('rejects a pinned %s verifier for an Ed25519 publication', async (_label, publicKey) => {
    const fixture = await golden();
    const publicKeySpkiDer = publicKey.export({ format: 'der', type: 'spki' });
    const publicKeyDigest = `sha256:${createHash('sha256')
      .update(publicKeySpkiDer)
      .digest('hex')}` as const;
    const repinned = JSON.parse(fixture.publication.bytes) as {
      authorship: { publicKeyDigest: `sha256:${string}` };
    };
    repinned.authorship.publicKeyDigest = publicKeyDigest;

    expect(() =>
      verifyHostedApprovalRuntimeActivationPublication(
        JSON.stringify(repinned),
        fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey,
        {
          publicKeySpkiDer,
          publicKeyDigest,
          contractDigest: fixture.signing.contractDigest,
        },
        fixture.binding
      )
    ).toThrow(/authorship-pin-mismatch/u);
  });

  it('consumes one manifest-wide admission for multiple teams and repeated member sessions', async () => {
    const fixture = await golden();
    const document = JSON.parse(fixture.admissionDocument) as Record<string, unknown> & {
      routes: Array<
        Record<string, unknown> & {
          authority: Record<string, unknown>;
          scope: Record<string, unknown>;
        }
      >;
    };
    const secondTeamId = `team_${'2'.repeat(32)}`;
    const second = structuredClone(document.routes[0]!);
    second.routeId = 'route_activation-golden-second-session';
    second.authority.teamId = secondTeamId;
    second.authority.runId = `run_${'8'.repeat(32)}`;
    second.authority.laneId = 'secondary';
    second.authority.sessionId = 'session_activation-golden-second';
    second.scope.teamId = secondTeamId;
    document.routes.push(second);
    document.routes.sort((left, right) =>
      String(left.routeId).localeCompare(String(right.routeId))
    );
    const admissionDocument = `${JSON.stringify(document)}\n`;
    const authorities = document.routes.map((route) => route.authority);
    const approvalDigest = `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: 1,
          approvalGeneration: fixture.binding.approvalGeneration,
          authorities,
        })
      )
      .digest('hex')}` as const;
    const admissionDocumentDigest = `sha256:${createHash('sha256')
      .update(admissionDocument)
      .digest('hex')}` as const;
    const firstBinding = { ...fixture.binding, approvalDigest, admissionDocumentDigest };
    const secondBinding = {
      ...firstBinding,
      teamId: secondTeamId,
      ownerBinding: {
        ...firstBinding.ownerBinding,
        ownerGeneration: firstBinding.ownerBinding.ownerGeneration + 1,
        ownerSessionId: 'owner-session_activation-golden-second',
      },
    };

    expect(() =>
      serializeHostedApprovalRuntimeActivationEnvelope(
        fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey,
        firstBinding,
        admissionDocument
      )
    ).not.toThrow();
    expect(() =>
      serializeHostedApprovalRuntimeActivationEnvelope(
        fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey,
        secondBinding,
        admissionDocument
      )
    ).not.toThrow();
  });

  it('loads only the pinned Ed25519 PKCS8 identity from a stable private 0600 file', async () => {
    const fixture = await golden();
    const root = await mkdtemp(join(tmpdir(), 'hosted-activation-key-'));
    const path = join(root, 'product-activation.pkcs8.pem');
    const link = join(root, 'linked-key.pem');
    const admissionPath = join(root, 'admission.json');
    const environment = {
      [HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV]: path,
      [HOSTED_APPROVAL_ACTIVATION_PUBLIC_KEY_DIGEST_ENV]: fixture.signing.publicKeyDigest,
      [HOSTED_APPROVAL_ACTIVATION_CONTRACT_DIGEST_ENV]: fixture.signing.contractDigest,
    };
    try {
      expect(readHostedApprovalRuntimeActivationSigningIdentity({})).toBeNull();
      expect(() =>
        readHostedApprovalRuntimeActivationSigningIdentity({
          [HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV]: path,
        })
      ).toThrow(/signing-contract-invalid/u);
      expect(() =>
        readHostedApprovalRuntimeActivationSigningIdentity({
          ...environment,
          [HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV]: join(root, 'missing.pem'),
        })
      ).toThrow(/key-file-invalid/u);
      await writeFile(path, fixture.signing.testOnlyPrivateKeyPkcs8Pem, { mode: 0o600 });
      expect(readHostedApprovalRuntimeActivationSigningIdentity(environment)).toMatchObject({
        publicKeyDigest: fixture.signing.publicKeyDigest,
        contractDigest: fixture.signing.contractDigest,
      });
      expect(() => readHostedApprovalRuntimeActivationPublicationContract(environment)).toThrow(
        /signing-contract-invalid/u
      );
      await writeFile(admissionPath, fixture.admissionDocument, { mode: 0o600 });
      expect(
        readHostedApprovalRuntimeActivationPublicationContract({
          ...environment,
          [HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV]: admissionPath,
        })
      ).toMatchObject({ admissionDocument: fixture.admissionDocument });

      await chmod(path, 0o400);
      expect(() => readHostedApprovalRuntimeActivationSigningIdentity(environment)).toThrow(
        /key-file-invalid/u
      );
      await chmod(path, 0o600);
      expect(() =>
        readHostedApprovalRuntimeActivationSigningIdentity({
          ...environment,
          [HOSTED_APPROVAL_ACTIVATION_PUBLIC_KEY_DIGEST_ENV]: `sha256:${'f'.repeat(64)}`,
        })
      ).toThrow(/pin-mismatch/u);
      await symlink(path, link);
      expect(() =>
        readHostedApprovalRuntimeActivationSigningIdentity({
          ...environment,
          [HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV]: link,
        })
      ).toThrow(/key-file-invalid/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'owner generation',
      (document: ActivationDocument) => {
        document.admissionGeneration = 'approval-admission-generation_3_owner_8';
      },
    ],
    [
      'outer authority',
      (document: ActivationDocument) => {
        document.outerAuthority.restoreGeneration = 5;
      },
    ],
    [
      'scope authority generation',
      (document: ActivationDocument) => {
        document.routes[0]!.scope.authorityGeneration = 'invalid';
      },
    ],
    [
      'actor mapping',
      (document: ActivationDocument) => {
        document.actorMembers['actor_activation-golden-a'] = `member_${'c'.repeat(32)}`;
      },
    ],
    [
      'plan generation',
      (document: ActivationDocument) => {
        document.routes[0]!.openCodeBinding.planGeneration = 8;
      },
    ],
    [
      'session projection fingerprint',
      (document: ActivationDocument) => {
        document.routes[0]!.openCodeBinding.sessionRecordFingerprint = 'invalid';
      },
    ],
    [
      'live effect fingerprint',
      (document: ActivationDocument) => {
        document.routes[0]!.openCodeBinding.liveEffectFingerprint = 'invalid';
      },
    ],
  ] as const)('rejects %s drift before publication', async (_name, mutate) => {
    const fixture = await golden();
    const document = JSON.parse(fixture.admissionDocument) as ActivationDocument;
    mutate(document);
    expect(() =>
      serializeHostedApprovalRuntimeActivationEnvelope(
        fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey,
        fixture.binding,
        `${JSON.stringify(document)}\n`
      )
    ).toThrow(/generation-mismatch|binding-mismatch|route-invalid|actor-mapping-invalid/u);
  });

  it('accepts only authenticated exact owner_ready then exact ready and revokes on owner loss', async () => {
    const fixture = await golden();
    const key = fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey;
    const socket = new ActivationPeerSocket(key);
    const onOwnerLoss = vi.fn();
    const lease = await activateHostedApprovalRuntime({
      binding: fixture.binding,
      admissionDocument: fixture.admissionDocument,
      proofKey: key,
      signingIdentity: signingIdentity(fixture),
      generateChallenge: () => CHALLENGE,
      inspectSocketIdentity: async () => fixture.binding.ownerBinding.socketIdentity,
      connect: () => socket as unknown as Socket,
      onOwnerLoss,
    });

    expect(socket.writes).toHaveLength(2);
    expect(JSON.parse(socket.writes[0]!).operation).toBe('approval_activation_prepare');
    expect(JSON.parse(socket.writes[1]!).envelope.purpose).toBe(
      'agent-teams.hosted-approval-activation/v2'
    );
    expect(lease.isReady()).toBe(true);
    expect(lease.currentBinding()).toEqual(fixture.binding.ownerBinding);

    socket.loseOwner();
    expect(lease.isReady()).toBe(false);
    expect(lease.currentBinding()).toBeNull();
    expect(onOwnerLoss).toHaveBeenCalledOnce();
  });

  it('does not fall back to a raw legacy-ready peer after activation-v2 negotiation', async () => {
    const fixture = await golden();
    const key = fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey;
    const socket = new ActivationPeerSocket(key, 'legacy-ready');
    await expect(
      activateHostedApprovalRuntime({
        binding: fixture.binding,
        admissionDocument: fixture.admissionDocument,
        proofKey: key,
        signingIdentity: signingIdentity(fixture),
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
    const key = fixture.proof.testOnlySecretHex as OrchestratorLifecycleOwnerProofKey;
    const socket = new ActivationPeerSocket(key, behavior);
    await expect(
      activateHostedApprovalRuntime({
        binding: fixture.binding,
        admissionDocument: fixture.admissionDocument,
        proofKey: key,
        signingIdentity: signingIdentity(fixture),
        generateChallenge: () => CHALLENGE,
        inspectSocketIdentity: async () => fixture.binding.ownerBinding.socketIdentity,
        connect: () => socket as unknown as Socket,
        onOwnerLoss: vi.fn(),
      })
    ).rejects.toThrow(/response-invalid/u);
    expect(socket.writes).toHaveLength(expectedWrites);
  });
});

interface ActivationDocument {
  admissionGeneration: string;
  outerAuthority: { restoreGeneration: number };
  actorMembers: Record<string, string>;
  routes: Array<{
    scope: { authorityGeneration: string };
    openCodeBinding: {
      planGeneration: number;
      openCodeArtifactDigest: string;
      sessionRecordFingerprint: string;
      liveEffectFingerprint: string;
    };
  }>;
}

class ActivationPeerSocket extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];

  constructor(
    private readonly proofKey: OrchestratorLifecycleOwnerProofKey,
    private readonly behavior:
      | 'activation-v2'
      | 'legacy-ready'
      | 'stale-owner-ready'
      | 'forged-final-ready' = 'activation-v2'
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
        schemaVersion: 2,
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
    const publication = JSON.parse(frame) as { envelope: Record<string, unknown> };
    const envelope = JSON.stringify(publication.envelope);
    const activation = independentVerify(envelope, this.proofKey, 'admission').value;
    const unsigned = JSON.stringify({
      schemaVersion: 2,
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

function signingIdentity(fixture: Golden) {
  return {
    privateKey: createPrivateKey({
      key: fixture.signing.testOnlyPrivateKeyPkcs8Pem,
      format: 'pem',
      type: 'pkcs8',
    }),
    publicKeySpkiDer: Buffer.from(fixture.signing.publicKeySpkiDerBase64url, 'base64url'),
    publicKeyDigest: fixture.signing.publicKeyDigest,
    contractDigest: fixture.signing.contractDigest,
  };
}

function publicVerifier(fixture: Golden) {
  return {
    publicKeySpkiDer: Buffer.from(fixture.signing.publicKeySpkiDerBase64url, 'base64url'),
    publicKeyDigest: fixture.signing.publicKeyDigest,
    contractDigest: fixture.signing.contractDigest,
  };
}

function sign(unsigned: string, secretHex: string, direction: string): string {
  const proof = createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(`${HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN}\0${direction}\0${unsigned}`)
    .digest('hex');
  return `${unsigned.slice(0, -1)},"controllerProof":"${proof}"}`;
}

function appendIndependentProof(unsigned: string, proof: string): string {
  return `${unsigned.slice(0, -1)},"controllerProof":"${proof}"}`;
}

function serializeIndependentSignatureStatement(
  envelope: string,
  publicKeyDigest: string,
  contractDigest: string
): string {
  return `{"schemaVersion":2,"algorithm":"Ed25519","publicKeyDigest":"${publicKeyDigest}","contractDigest":"${contractDigest}","envelope":${envelope}}`;
}

function assertGoldenProofVector(
  vector: GoldenProofVector,
  secretHex: string,
  expectedDirection: 'owner-ready-request' | 'owner-ready' | 'ready',
  expectedUnsignedValue: Record<string, unknown>
): void {
  expect(vector.direction).toBe(expectedDirection);
  expect(vector.serializedUnsigned).toBe(JSON.stringify(expectedUnsignedValue));
  expect(vector.bytes).toBe(
    appendIndependentProof(vector.serializedUnsigned, vector.controllerProof)
  );
  expect(vector.transportBytes).toBe(`${vector.bytes}\n`);
  const verified = independentVerify(vector.bytes, secretHex, expectedDirection);
  expect(verified.unsigned).toBe(vector.serializedUnsigned);
  expect(verified.value).toEqual({
    ...expectedUnsignedValue,
    controllerProof: vector.controllerProof,
  });
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
