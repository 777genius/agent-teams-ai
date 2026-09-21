// @vitest-environment node
import { createHash, generateKeyPairSync, sign as signDetached } from 'node:crypto';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { access, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalJsonBytes, createTestHostedTrustedReleaseAdapter, resolveCommittedHostedLockPair } from '../../../scripts/hosted-release/contracts.mjs';
import {
  materializeHostedLockPair as materializeHostedLockPairWithTrust,
  materializeHostedLocksAtRoot as materializeHostedLocksAtRootWithTrust,
  recomputeHostedLockDigests,
} from '../../../scripts/hosted-release/materialize-locks.mjs';
import { verifyHostedLocksAtRoot } from '../../../scripts/hosted-release/verify-locks.mjs';

import type { HostedActualOwnerIdentity, HostedOpenCodeIdentity, HostedOwnerIdentity, HostedProductIdentity, HostedSourceIdentity, HostedTrustedReleaseAdapter, HostedTrustedReleasePolicy } from '../../../scripts/hosted-release/contracts.mjs';
import type {
  HostedLockEvidence,
  HostedMaterializerInput,
} from '../../../scripts/hosted-release/materialize-locks.mjs';

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const releaseKeys = generateKeyPairSync('ed25519');
const git = (c: string) => c.repeat(40);
const signed = (name: string) => ({ path: `release/${name}`, sha256: digest('a'), signatureSha256: digest('b') });
const build = (name: string) => ({ entryPath: `dist/${name}`, entrySha256: digest('c'), closureManifestPath: `dist/${name}.closure.json`, closureManifestSha256: digest('d'), closureSha256: digest('e') });
const source = (repository: string, c: string, tag: string) => ({ repository, commit: git(c), tree: git(String.fromCharCode(c.charCodeAt(0) + 1)), tag });
type Fixture = HostedMaterializerInput & {
  evidence: HostedLockEvidence;
  trustedRelease: HostedTrustedReleasePolicy;
  trustedAdapter: HostedTrustedReleaseAdapter;
};
type FixtureSeed = Omit<Fixture, 'evidence' | 'trustedRelease' | 'trustedAdapter'>;
type Identity = HostedProductIdentity | HostedOwnerIdentity | HostedOpenCodeIdentity;
const materializeHostedLockPair = (value: Fixture) => materializeHostedLockPairWithTrust(value, value.trustedAdapter);
const materializeHostedLocksAtRoot = (root: string, value: Fixture, options?: { onStaged?: (details: { stagingRoot: string; temporary: string[] }) => Promise<void> | void; onPublished?: (details: { paths: string[] }) => Promise<void> | void; onMarkerReady?: (details: { markerPath: string }) => Promise<void> | void; onCleanup?: () => Promise<void> | void; onCommittedCleanup?: () => Promise<void> | void }) => materializeHostedLocksAtRootWithTrust(root, value, value.trustedAdapter, options);

function input(ownerGeneration = 1) {
  const actualOwner: HostedActualOwnerIdentity = { ownerAuthority: 'authority-1', ownerGeneration, ownerSessionId: 'session-1', socketIdentity: { device: '1', inode: '2', uid: 1000, gid: 1000, mode: 0o660 } };
  const owner: HostedOwnerIdentity = { source: source('777genius/agent_teams_orchestrator', 'a', 'owner-v1.0.0'), toolchain: { nodeVersion: '24.15.0', bunVersion: '1.2.21', bunLockSha256: digest('1') }, build: build('owner'), artifact: { namespace: 'owner', name: 'owner.tgz', sha256: digest('2'), signatureSha256: digest('3') }, image: { reference: 'owner:image', digest: digest('4') }, sbom: signed('owner.sbom'), attestation: signed('owner.attestation'), protocol: { version: '1.0.0', digest: digest('5'), capabilityDigest: digest('6'), capabilities: ['owner.ready'] }, durableState: { formatVersion: '1.0.0', compatibilityDigest: digest('7') }, actualOwner, eligibility: { temporaryRuntime: true, productionEligible: false, releaseEligible: false } };
  const product: HostedProductIdentity = { source: source('777genius/agent-teams-ai', 'b', 'product-v1.0.0'), toolchain: { nodeVersion: '24.15.0', pnpmVersion: '11.22.0', pnpmLockSha256: digest('8') }, build: build('product'), artifact: { namespace: 'product', name: 'product.tgz', sha256: digest('9'), signatureSha256: digest('a') }, image: { reference: 'product:image', digest: digest('b') } };
  const openCode: HostedOpenCodeIdentity = { source: source('777genius/opencode-anomaly', 'c', 'opencode-v1.0.0'), toolchain: { bunVersion: '1.2.21', bunLockSha256: digest('c') }, build: build('opencode'), artifact: { namespace: 'opencode', name: 'opencode.tgz', sha256: digest('d'), signatureSha256: digest('e') }, image: { reference: 'opencode:image', digest: digest('f') }, sbom: signed('opencode.sbom'), attestation: signed('opencode.attestation'), protocol: { version: '1.0.0', digest: digest('1'), capabilityDigest: digest('2'), capabilities: ['runtime.exec'] } };
  const result: FixtureSeed = { product, owner, openCode, actualOwner, contracts: { hostedProducerProvenanceV2Sha256: 'sha256:ef6aa8ac1f139d2b5e9312da8ff1e6dac21da788d46eefbd6e3d43da27da23ba', actualOwnerContractV2Sha256: digest('3'), stackContractSha256: digest('4') }, deploymentRecipe: { path: 'docker/hosted.yml', sha256: digest('5') } };
  return addEvidence(result);
}

function addEvidence(value: FixtureSeed): Fixture {
  const bytes = (label: string) => Buffer.from(`evidence:${label}`);
  const sha = (data: Uint8Array) => `sha256:${createHash('sha256').update(Buffer.from(data)).digest('hex')}`;
  const makeSource = (identity: HostedSourceIdentity, label: string) => {
    const treeBytes = Buffer.concat([Buffer.from('100644 fixture\0'), Buffer.alloc(20, 7)]);
    const tree = createHash('sha1').update(`tree ${treeBytes.length}\0`).update(treeBytes).digest('hex');
    const commitBytes = Buffer.from(`tree ${tree}\nauthor fixture <fixture@example.invalid> 0 +0000\ncommitter fixture <fixture@example.invalid> 0 +0000\n\n${label}\n`);
    identity.commit = createHash('sha1').update(`commit ${commitBytes.length}\0`).update(commitBytes).digest('hex');
    identity.tree = tree;
    return { commitBytes, treeBytes, tag: identity.tag, repository: identity.repository };
  };
  const makeBaseFacts = (identity: Identity, label: string) => {
    const source = makeSource(identity.source, label);
    const entryBytes = bytes(`${label}:entry`); identity.build.entrySha256 = sha(entryBytes);
    const dependencyBytes = bytes(`${label}:dependency`);
    const members = [
      { path: identity.build.entryPath, bytes: entryBytes },
      { path: `dist/${label}.dependency`, bytes: dependencyBytes },
    ].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    const closureMembers = members.map((member) => ({ path: member.path, sha256: sha(member.bytes) }));
    const closureManifestBytes = canonicalJsonBytes({ entryPath: identity.build.entryPath, members: closureMembers }); identity.build.closureManifestSha256 = sha(closureManifestBytes);
    const closureBytes = canonicalJsonBytes({ entryPath: identity.build.entryPath, members: closureMembers }); identity.build.closureSha256 = sha(closureBytes);
    const artifactBytes = tarGzip(members); identity.artifact.sha256 = sha(artifactBytes);
    const artifactSubject = { source: identity.source, artifact: { namespace: identity.artifact.namespace, name: identity.artifact.name, sha256: identity.artifact.sha256 } };
    const artifactSubjectBytes = canonicalJsonBytes(artifactSubject);
    const artifactSignatureBytes = signEvidence('artifact', artifactBytes, artifactSubjectBytes); identity.artifact.signatureSha256 = sha(artifactSignatureBytes);
    const imageSubject = { source: identity.source, image: { reference: identity.image.reference } };
    const manifestBytes = canonicalJsonBytes({ manifest: `${label}:image`, subject: imageSubject }); identity.image.digest = sha(manifestBytes);
    return { source, build: { entryPath: identity.build.entryPath, closureManifestPath: identity.build.closureManifestPath, entryBytes, closureManifestBytes, closureBytes }, artifact: { namespace: identity.artifact.namespace, name: identity.artifact.name, bytes: artifactBytes, signatureBytes: artifactSignatureBytes, subjectBytes: artifactSubjectBytes }, image: { reference: identity.image.reference, manifestBytes }, artifactSubject };
  };
  const makeSignedFacts = (identity: HostedOwnerIdentity | HostedOpenCodeIdentity, label: string, artifactSubject: { source: HostedSourceIdentity; artifact: { namespace: string; name: string; sha256: string } }) => {
    const document = (name: 'sbom' | 'attestation') => {
      const declared = identity[name], subject = { ...artifactSubject, document: { path: declared.path } };
      const payload = canonicalJsonBytes({ payload: `${label}:${name}`, subject });
      declared.sha256 = sha(payload);
      const signature = signEvidence(name, payload, canonicalJsonBytes(subject));
      declared.signatureSha256 = sha(signature);
      return { path: declared.path, bytes: payload, signatureBytes: signature };
    };
    const protocolBytes = bytes(`${label}:protocol`), capabilityBytes = canonicalJsonBytes(identity.protocol.capabilities);
    identity.protocol.digest = sha(protocolBytes); identity.protocol.capabilityDigest = sha(capabilityBytes);
    return { sbom: document('sbom'), attestation: document('attestation'), protocol: { version: identity.protocol.version, bytes: protocolBytes, capabilityBytes } };
  };
  const productBase = makeBaseFacts(value.product, 'product');
  const productLock = bytes('product:pnpm'); value.product.toolchain.pnpmLockSha256 = sha(productLock);
  const productEvidence: HostedLockEvidence['product'] = { role: 'product', ...productBase, toolchain: { nodeVersion: value.product.toolchain.nodeVersion, pnpmVersion: value.product.toolchain.pnpmVersion, pnpmLockBytes: productLock } };
  const ownerBase = makeBaseFacts(value.owner, 'owner');
  const ownerLock = bytes('owner:bun'); value.owner.toolchain.bunLockSha256 = sha(ownerLock);
  const ownerDurable = bytes('owner:durable'); value.owner.durableState.compatibilityDigest = sha(ownerDurable);
  const ownerEvidence: HostedLockEvidence['owner'] = { role: 'owner', ...ownerBase, ...makeSignedFacts(value.owner, 'owner', ownerBase.artifactSubject), toolchain: { nodeVersion: value.owner.toolchain.nodeVersion, bunVersion: value.owner.toolchain.bunVersion, bunLockBytes: ownerLock }, durableState: { formatVersion: value.owner.durableState.formatVersion, bytes: ownerDurable }, actualOwner: value.actualOwner, socketIdentity: value.actualOwner.socketIdentity };
  const openCodeBase = makeBaseFacts(value.openCode, 'openCode');
  const openCodeLock = bytes('openCode:bun'); value.openCode.toolchain.bunLockSha256 = sha(openCodeLock);
  const openCodeEvidence: HostedLockEvidence['openCode'] = { role: 'openCode', ...openCodeBase, ...makeSignedFacts(value.openCode, 'openCode', openCodeBase.artifactSubject), toolchain: { bunVersion: value.openCode.toolchain.bunVersion, bunLockBytes: openCodeLock } };
  const evidence: HostedLockEvidence = { product: productEvidence, owner: ownerEvidence, openCode: openCodeEvidence, contracts: { hostedProducerProvenanceV2Bytes: Buffer.alloc(0), actualOwnerContractV2Bytes: Buffer.alloc(0), stackContractBytes: Buffer.alloc(0) }, path: value.deploymentRecipe.path, deploymentRecipeBytes: bytes('deployment'), release: { payloadBytes: Buffer.alloc(0), signatureBytes: Buffer.alloc(0) } };
  value.deploymentRecipe.sha256 = sha(evidence.deploymentRecipeBytes);
  const actualOwnerContractV2Bytes = bytes('contract:actual-owner-v2');
  const stackContractBytes = bytes('contract:stack');
  const hostedProducerProvenanceV2Bytes = readFileSync(path.resolve(process.cwd(), 'src/features/hosted-producer-provenance/contracts/hosted-producer-provenance-v2.schema.json'));
  value.contracts.actualOwnerContractV2Sha256 = sha(actualOwnerContractV2Bytes);
  value.contracts.stackContractSha256 = sha(stackContractBytes);
  value.contracts.hostedProducerProvenanceV2Sha256 = sha(hostedProducerProvenanceV2Bytes);
  evidence.contracts = { actualOwnerContractV2Bytes, stackContractBytes, hostedProducerProvenanceV2Bytes };
  const payload = canonicalJsonBytes({
    repository: '777genius/agent-teams-ai',
    releaseId: 'fixture-release-1',
    policyVersion: '1',
    trustAdapterId: 'fixture-pinned-release-adapter',
    composition: { product: value.product, owner: value.owner, openCode: value.openCode, actualOwner: value.actualOwner, contracts: value.contracts, deploymentRecipe: value.deploymentRecipe },
  });
  evidence.release = {
    payloadBytes: payload,
    signatureBytes: signDetached(null, Buffer.concat([Buffer.from('hosted-lock-release-v1\0'), payload]), releaseKeys.privateKey),
  };
  const trustedRelease = { adapterId: 'fixture-pinned-release-adapter', repository: '777genius/agent-teams-ai', releaseId: 'fixture-release-1', policyVersion: '1', publicKey: releaseKeys.publicKey };
  return { ...value, evidence, trustedRelease, trustedAdapter: createTestHostedTrustedReleaseAdapter(trustedRelease) };
}

function signEvidence(role: string, bytes: Buffer, subjectBytes: Buffer) {
  return signDetached(null, Buffer.concat([Buffer.from(`hosted-lock-${role}-v1\0`), subjectBytes, bytes]), releaseKeys.privateKey);
}

function tarGzip(members: ReadonlyArray<{ path: string; bytes: Buffer }>) {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const header = Buffer.alloc(512);
    header.write(member.path, 0, 100, 'utf8');
    writeTarNumber(header, 100, 8, 0o644); writeTarNumber(header, 124, 12, member.bytes.length);
    header[156] = 48; header.write('ustar', 257, 'ascii'); header.write('00', 263, 'ascii');
    header.fill(32, 148, 156); writeTarNumber(header, 148, 8, header.reduce((total, byte) => total + byte, 0));
    blocks.push(header, member.bytes, Buffer.alloc((512 - (member.bytes.length % 512)) % 512));
  }
  return Buffer.from(gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
}

function tarHeaderGzip(memberPath: string, size: number) {
  const header = Buffer.alloc(512);
  header.write(memberPath, 0, 100, 'utf8');
  writeTarNumber(header, 100, 8, 0o644); writeTarNumber(header, 124, 12, size);
  header[156] = 48; header.write('ustar', 257, 'ascii'); header.write('00', 263, 'ascii');
  header.fill(32, 148, 156); writeTarNumber(header, 148, 8, header.reduce((total, byte) => total + byte, 0));
  return Buffer.from(gzipSync(header));
}

function gzipBomb() {
  return Buffer.concat(Array.from({ length: 257 }, () => gzipSync(Buffer.alloc(1024 * 1024))));
}

function replaceArtifact(value: Fixture, role: 'product' | 'owner' | 'openCode', artifactBytes: Buffer) {
  const identity = value[role], evidence = value.evidence[role];
  identity.artifact.sha256 = sha256(artifactBytes);
  const subject = canonicalJsonBytes({ source: identity.source, artifact: { namespace: identity.artifact.namespace, name: identity.artifact.name, sha256: identity.artifact.sha256 } });
  evidence.artifact.bytes = artifactBytes;
  evidence.artifact.subjectBytes = subject;
  evidence.artifact.signatureBytes = signEvidence('artifact', artifactBytes, subject);
  identity.artifact.signatureSha256 = sha256(evidence.artifact.signatureBytes);
  resignRelease(value);
}

function replaceClosureEntryPath(value: Fixture, role: 'product' | 'owner' | 'openCode', entryPath: string) {
  const closure = JSON.parse(value.evidence[role].build.closureBytes.toString()) as {
    entryPath: string;
    members: unknown[];
  };
  closure.entryPath = entryPath;
  value.evidence[role].build.closureBytes = canonicalJsonBytes(closure);
  value[role].build.closureSha256 = sha256(value.evidence[role].build.closureBytes);
  resignRelease(value);
}

function resignRelease(value: Fixture) {
  const payload = canonicalJsonBytes({ repository: value.trustedRelease.repository, releaseId: value.trustedRelease.releaseId, policyVersion: value.trustedRelease.policyVersion, trustAdapterId: value.trustedRelease.adapterId, composition: { product: value.product, owner: value.owner, openCode: value.openCode, actualOwner: value.actualOwner, contracts: value.contracts, deploymentRecipe: value.deploymentRecipe } });
  value.evidence.release.payloadBytes = payload;
  value.evidence.release.signatureBytes = signDetached(null, Buffer.concat([Buffer.from('hosted-lock-release-v1\0'), payload]), releaseKeys.privateKey);
}

function writeTarNumber(header: Buffer, offset: number, length: number, value: number) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

describe('hosted lock materializer', () => {
  it('emits canonical paired bytes and independently recomputes bindings', async () => {
    const result = await materializeHostedLockPair(input());
    const independent = input();
    expect((await recomputeHostedLockDigests(result.ownerBytes, result.stackBytes, independent.evidence, independent.trustedAdapter)).ownerSha256).toBe(result.ownerSha256);
    expect(result.ownerBytes).toEqual(canonicalJsonBytes(JSON.parse(result.ownerBytes.toString())));
  });

  it('normalizes envelope-free owner evidence but rejects a tampered generated pair', async () => {
    const value = input();
    const pair = await materializeHostedLockPair(value);
    const tampered = JSON.parse(pair.ownerBytes.toString()) as Record<string, unknown>;
    tampered.schemaVersion = 2;
    await expect(recomputeHostedLockDigests(canonicalJsonBytes(tampered), pair.stackBytes, value.evidence, value.trustedAdapter)).rejects.toThrow(/schemaVersion/);
  });

  it('rejects an artifact whose bytes do not match its declared digest', async () => {
    const invalid = input(); invalid.evidence.product.artifact.bytes = Buffer.from('wrong');
    await expect(materializeHostedLockPair(invalid)).rejects.toThrow(/artifact digest/);
  });

  it('rejects unsigned, forged, stale, and foreign-release provenance', async () => {
    const unsigned = input(); Reflect.deleteProperty(unsigned.evidence.release as Record<string, unknown>, 'signatureBytes');
    await expect(materializeHostedLockPair(unsigned)).rejects.toThrow(/release provenance signature/);
    const forged = input(); forged.evidence.release.signatureBytes[0] ^= 1;
    await expect(materializeHostedLockPair(forged)).rejects.toThrow(/unsigned, forged, or from a foreign key/);
    const stale = input(); stale.trustedRelease = { ...stale.trustedRelease, releaseId: 'next-release' }; stale.trustedAdapter = createTestHostedTrustedReleaseAdapter(stale.trustedRelease);
    await expect(materializeHostedLockPair(stale)).rejects.toThrow(/stale or bound to a different release/);
    const foreign = input(); foreign.trustedRelease = { ...foreign.trustedRelease, repository: 'foreign/repository' }; foreign.trustedAdapter = createTestHostedTrustedReleaseAdapter(foreign.trustedRelease);
    await expect(materializeHostedLockPair(foreign)).rejects.toThrow(/stale or bound to a different release/);
    const attacker = input();
    const attackerKeys = generateKeyPairSync('ed25519');
    attacker.evidence.release.signatureBytes = signDetached(null, Buffer.concat([Buffer.from('hosted-lock-release-v1\0'), attacker.evidence.release.payloadBytes]), attackerKeys.privateKey);
    await expect(materializeHostedLockPair(attacker)).rejects.toThrow(/foreign key/);
    const substituted = input();
    const attackerPolicy = { ...substituted.trustedRelease, publicKey: attackerKeys.publicKey };
    await expect(materializeHostedLockPairWithTrust(substituted, createTestHostedTrustedReleaseAdapter(attackerPolicy))).rejects.toThrow(/foreign key/);
  });

  it('binds the complete signed composition and evidence role at runtime', async () => {
    const composition = input();
    const statement = JSON.parse(composition.evidence.release.payloadBytes.toString()) as Record<string, unknown>;
    const contents = statement.composition as Record<string, unknown>;
    contents.deploymentRecipe = { path: 'docker/attacker.yml', sha256: composition.deploymentRecipe.sha256 };
    composition.evidence.release.payloadBytes = canonicalJsonBytes(statement);
    composition.evidence.release.signatureBytes = signDetached(null, Buffer.concat([Buffer.from('hosted-lock-release-v1\0'), composition.evidence.release.payloadBytes]), releaseKeys.privateKey);
    await expect(materializeHostedLockPair(composition)).rejects.toThrow(/release provenance/);
    const wrongRole = input();
    // @ts-expect-error explicit negative assertion: a product role is not an owner role.
    wrongRole.evidence.owner.role = 'openCode';
    await expect(materializeHostedLockPair(wrongRole)).rejects.toThrow(/role discriminant/);
  });

  it('derives closure only from a valid artifact archive', async () => {
    const plainLabel = input(); replaceArtifact(plainLabel, 'product', Buffer.from('plain artifact label'));
    await expect(materializeHostedLockPair(plainLabel)).rejects.toThrow(/gzip tar/);
    const incomplete = input(); replaceArtifact(incomplete, 'owner', tarGzip([{ path: incomplete.owner.build.entryPath, bytes: incomplete.evidence.owner.build.entryBytes }]));
    await expect(materializeHostedLockPair(incomplete)).rejects.toThrow(/complete declared closure/);
    const traversal = input(); replaceArtifact(traversal, 'openCode', tarGzip([{ path: '../escape', bytes: Buffer.from('no') }]));
    await expect(materializeHostedLockPair(traversal)).rejects.toThrow(/duplicate, traversal, or oversized/);
    const compressedBomb = input(); replaceArtifact(compressedBomb, 'product', gzipBomb());
    await expect(materializeHostedLockPair(compressedBomb)).rejects.toThrow(/decompressed artifact exceeds limit/);
    const oversizedMember = input(); replaceArtifact(oversizedMember, 'product', tarHeaderGzip('dist/oversized', 64 * 1024 * 1024 + 1));
    await expect(materializeHostedLockPair(oversizedMember)).rejects.toThrow(/duplicate, traversal, or oversized/);
  });

  it('rejects a re-signed closure whose entry differs from its manifest during materialization and digest recomputation', async () => {
    const value = input();
    const pair = await materializeHostedLockPair(value);
    replaceClosureEntryPath(value, 'product', 'dist/rebound-product');
    await expect(materializeHostedLockPair(value)).rejects.toThrow(
      /closure is incomplete or unrelated to the declared entry/
    );

    const stack = JSON.parse(pair.stackBytes.toString()) as { product: { build: { closureSha256: string } } };
    stack.product.build.closureSha256 = value.product.build.closureSha256;
    await expect(
      recomputeHostedLockDigests(pair.ownerBytes, canonicalJsonBytes(stack), value.evidence, value.trustedAdapter)
    ).rejects.toThrow(/closure is incomplete or unrelated to the declared entry/);
  });

  it.each(['darwin', 'win32'] as const)(
    'rejects %s publication and committed resolution before touching an absent root',
    async (platform) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), `hosted-lock-unsupported-${platform}-`));
      const root = path.join(parent, 'absent-root');
      try {
        await withPlatform(platform, async () => {
          await expect(materializeHostedLocksAtRoot(root, input())).rejects.toThrow(/unsupported on this platform/);
          await expect(resolveCommittedHostedLockPair(root)).rejects.toThrow(/unsupported on this platform/);
          await expect(resolveCommittedHostedLockPair(root, { ifPresent: true })).rejects.toThrow(/unsupported on this platform/);
        });
        await expect(lstat(root)).rejects.toThrow();
        await expect(readdir(parent)).resolves.toEqual([]);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
  );

  const describeLinuxFilesystemPublication = process.platform === 'linux' ? describe : describe.skip;
  describeLinuxFilesystemPublication('Linux filesystem publication', () => {
    beforeAll(async () => {
      await access('/proc/self/fd', fsConstants.R_OK | fsConstants.X_OK);
      await access('/usr/bin/python3', fsConstants.X_OK);
    });

    it('publishes a committed generation atomically and refuses stale or legacy names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-materializer-'));
    try {
      const result = await materializeHostedLocksAtRoot(root, input());
      expect(await readFile(result.ownerPath)).toBeTruthy();
      expect(await readFile(result.stackPath)).toBeTruthy();
      expect((await resolveCommittedHostedLockPair(root)).ownerBytes).toEqual(result.ownerBytes);
      await expect(verifyHostedLocksAtRoot(root)).resolves.toEqual({ status: 'verified' });
      expect(await readFile(path.join(root, '.hosted-lock-commit.json'), 'utf8')).toContain('transactionName');
      const marker = await lstat(path.join(root, '.hosted-lock-commit.json'), { bigint: true });
      const generationMarker = (await readdir(path.dirname(result.ownerPath))).find((name) => name.startsWith('.hosted-lock-commit.json.'));
      expect(generationMarker).toBeDefined();
      const stagedMarker = await lstat(path.join(path.dirname(result.ownerPath), generationMarker!), { bigint: true });
      expect({ device: marker.dev, inode: marker.ino }).toEqual({ device: stagedMarker.dev, inode: stagedMarker.ino });
      await expect(readFile(path.join(root, 'hosted-stack.lock.json'))).rejects.toThrow();
      await expect(materializeHostedLocksAtRoot(root, input())).rejects.toThrow(/committed/);
      const legacyRoot = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-legacy-'));
      try {
        await writeFile(path.join(legacyRoot, 'hosted-lifecycle-owner-runtime.lock.json'), '{}');
        await expect(materializeHostedLocksAtRoot(legacyRoot, input())).rejects.toThrow(/already exists/);
      } finally {
        await rm(legacyRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    });

  it('lets the authoritative verifier accept only an unchanged marker-selected generation', async () => {
    const roots = await Promise.all(Array.from({ length: 6 }, () => mkdtemp(path.join(os.tmpdir(), 'hosted-lock-verifier-'))));
    try {
      const [staleRoot, malformedRoot, missingGenerationRoot, directParent, symlinkRoot, markerRaceRoot] = roots;
      const stale = await materializeHostedLocksAtRoot(staleRoot, input());
      await writeFile(path.join(staleRoot, 'hosted-lifecycle-owner.lock.json'), stale.ownerBytes);
      await expect(verifyHostedLocksAtRoot(staleRoot, { ifPresent: true })).rejects.toThrow(/stale root-level/);

      await writeFile(path.join(malformedRoot, '.hosted-lock-commit.json'), canonicalJsonBytes({ schemaVersion: 2 }));
      await expect(verifyHostedLocksAtRoot(malformedRoot, { ifPresent: true })).rejects.toThrow(/incomplete or invalid|bounded standalone file/);
      await rm(path.join(malformedRoot, '.hosted-lock-commit.json'));
      await writeFile(path.join(malformedRoot, '.hosted-lock-commit.json.tmp'), 'temporary marker');
      await expect(verifyHostedLocksAtRoot(malformedRoot, { ifPresent: true })).rejects.toThrow(/temporary hosted lock commit marker/);

      const missingGeneration = await materializeHostedLocksAtRoot(missingGenerationRoot, input());
      await rm(path.dirname(missingGeneration.ownerPath), { recursive: true, force: true });
      await expect(verifyHostedLocksAtRoot(missingGenerationRoot)).rejects.toThrow(/ENOENT|no such file|committed|bounded standalone file/);

      const directGeneration = path.join(directParent, '.hosted-lock-transaction-123e4567-e89b-12d3-a456-426614174000');
      await mkdir(directGeneration);
      await expect(verifyHostedLocksAtRoot(directGeneration, { ifPresent: true })).rejects.toThrow(/uncommitted hosted lock generation/);

      const symlinked = await materializeHostedLocksAtRoot(symlinkRoot, input());
      const generationPath = path.dirname(symlinked.ownerPath);
      const replacementPath = `${generationPath}-replacement`;
      await rename(generationPath, replacementPath);
      await symlink(replacementPath, generationPath, 'dir');
      await expect(verifyHostedLocksAtRoot(symlinkRoot)).rejects.toThrow();

      await materializeHostedLocksAtRoot(markerRaceRoot, input());
      await expect(verifyHostedLocksAtRoot(markerRaceRoot, {
        onMarkerRead: () => writeFile(path.join(markerRaceRoot, '.hosted-lock-commit.json'), '{}\n'),
      })).rejects.toThrow(/marker/);
    } finally {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it('refuses a symlinked publication root before creating a reservation', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-symlink-target-'));
    const parent = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-symlink-parent-'));
    const root = path.join(parent, 'redirected-root');
    try {
      await symlink(target, root);
      await expect(materializeHostedLocksAtRoot(root, input())).rejects.toThrow();
      await expect(readdir(target)).resolves.toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it('serializes concurrent publishers; a rejected pre-commit transaction is only a tombstone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-race-'));
    try {
      const first = input(1);
      const second = input(2);
      const results = await Promise.allSettled([
        materializeHostedLocksAtRoot(root, first),
        materializeHostedLocksAtRoot(root, second),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const winner = results.find((result) => result.status === 'fulfilled');
      if (winner?.status !== 'fulfilled') throw new Error('missing publication winner');
      expect(await readFile(winner.value.ownerPath)).toBeTruthy();
      expect(await readFile(winner.value.stackPath)).toBeTruthy();
      await expect(readFile(path.join(root, '.hosted-lock-commit.json'), 'utf8')).resolves.toContain('ownerSha256');
      await expect(verifyHostedLocksAtRoot(root)).resolves.toEqual({ status: 'verified' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const interruptedRoot = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-interrupted-'));
    const interrupted = ['', '{"schemaVersion":1', '{"foreign":"state"}\n'];
    try {
      await Promise.all(interrupted.map((contents, index) => writeFile(path.join(interruptedRoot, `.hosted-lock-transaction-123e4567-e89b-12d3-a456-42661417400${index}.json`), contents)));
      await expect(materializeHostedLocksAtRoot(interruptedRoot, input())).resolves.toMatchObject({ warnings: [] });
      await Promise.all(interrupted.map((contents, index) => expect(readFile(path.join(interruptedRoot, `.hosted-lock-transaction-123e4567-e89b-12d3-a456-42661417400${index}.json`), 'utf8')).resolves.toBe(contents)));
    } finally { await rm(interruptedRoot, { recursive: true, force: true }); }

    const partialRoot = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-partial-'));
    try {
      await expect(materializeHostedLocksAtRoot(partialRoot, input(), {
        onCleanup: () => { throw new Error('cleanup failure'); },
      })).rejects.toThrow();
      await expect(readFile(path.join(partialRoot, '.hosted-lock-commit.json'))).rejects.toThrow();
      expect((await readdir(partialRoot)).some((name) => name.startsWith('.hosted-lock-transaction-'))).toBe(true);
      expect((await materializeHostedLocksAtRoot(partialRoot, input())).warnings).toEqual([]);
      await expect(verifyHostedLocksAtRoot(partialRoot)).resolves.toEqual({ status: 'verified' });
    } finally {
      await rm(partialRoot, { recursive: true, force: true });
    }
  });

  it('records a post-staging failure before commit, so no reader can accept a partial pair', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-failure-'));
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), {
        onPublished: async () => {
          await expect(resolveCommittedHostedLockPair(root)).rejects.toThrow(/no complete committed/);
          await expect(verifyHostedLocksAtRoot(root, { ifPresent: true })).resolves.toEqual({ status: 'absent' });
          throw new Error('adversarial publication failure');
        },
      })).rejects.toThrow(/adversarial publication failure/);
      const names = await readdir(root);
      expect(names.some((name) => name.startsWith('.hosted-lock-transaction-'))).toBe(true);
      expect(names).not.toContain('.hosted-lock-commit.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cannot commit after a verifier-rejected root lock appears during publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-root-race-'));
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), { onPublished: () => writeFile(path.join(root, 'hosted-stack.lock.json'), '{}\n') })).rejects.toThrow(/stale materialization/);
      await expect(verifyHostedLocksAtRoot(root, { ifPresent: true })).rejects.toThrow(/stale root-level/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('binds materialization and verification to the caller root across marker callbacks', async () => {
    const materializeRoot = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-root-binding-materialize-'));
    const displacedMaterializeRoot = `${materializeRoot}-displaced`;
    const verifyRoot = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-root-binding-verify-'));
    const displacedVerifyRoot = `${verifyRoot}-displaced`;
    try {
      await expect(materializeHostedLocksAtRoot(materializeRoot, input(), {
        onMarkerReady: async () => {
          await rename(materializeRoot, displacedMaterializeRoot);
          await mkdir(materializeRoot);
        },
      })).rejects.toThrow(/root pathname was renamed or replaced/);
      await expect(readFile(path.join(materializeRoot, '.hosted-lock-commit.json'))).rejects.toThrow();

      await materializeHostedLocksAtRoot(verifyRoot, input());
      await expect(verifyHostedLocksAtRoot(verifyRoot, {
        onMarkerRead: async () => {
          await rename(verifyRoot, displacedVerifyRoot);
          await mkdir(verifyRoot);
        },
      })).rejects.toThrow(/root pathname was renamed or replaced/);
    } finally {
      await rm(materializeRoot, { recursive: true, force: true });
      await rm(displacedMaterializeRoot, { recursive: true, force: true });
      await rm(verifyRoot, { recursive: true, force: true });
      await rm(displacedVerifyRoot, { recursive: true, force: true });
    }
  });

  it('rejects a generation entry replaced after its descriptor was opened', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-generation-entry-race-'));
    const displaced = `${root}-displaced`;
    try {
      const result = await materializeHostedLocksAtRoot(root, input());
      const generation = path.dirname(result.ownerPath);
      await expect(verifyHostedLocksAtRoot(root, {
        onGenerationOpened: async () => {
          await rename(generation, displaced);
          await mkdir(generation);
        },
      })).rejects.toThrow(/generation was renamed or replaced/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(displaced, { recursive: true, force: true });
    }
  });

  it('rejects a replaced temporary marker before it can become authoritative', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-temp-marker-replace-'));
    const foreign = Buffer.from('foreign temporary marker');
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), {
        onMarkerReady: async ({ markerPath }) => {
          await unlink(markerPath);
          await writeFile(markerPath, foreign);
        },
      })).rejects.toThrow(/staged path was replaced/);
      const generation = (await readdir(root)).find((name) => name.startsWith('.hosted-lock-transaction-') && !name.endsWith('.json'));
      expect(generation).toBeDefined();
      const marker = (await readdir(path.join(root, generation!))).find((name) => name.startsWith('.hosted-lock-commit.json.'));
      expect(marker).toBeDefined();
      await expect(readFile(path.join(root, generation!, marker!))).resolves.toEqual(foreign);
      await expect(readFile(path.join(root, '.hosted-lock-commit.json'))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('records cleanup failure before commit instead of returning an accepted pair', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-cleanup-failure-'));
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), { onCleanup: () => { throw new Error('injected cleanup failure'); } })).rejects.toThrow(/injected cleanup failure/);
      await expect(readFile(path.join(root, '.hosted-lock-commit.json'))).rejects.toThrow();
      expect((await readdir(root)).some((name) => name.startsWith('.hosted-lock-transaction-'))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns an authoritative result when post-commit cleanup reports an error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-post-commit-cleanup-'));
    try {
      const result = await materializeHostedLocksAtRoot(root, input(), { onCommittedCleanup: () => { throw new Error('post-commit cleanup failure'); } });
      expect(result.warnings).toContain('post-commit cleanup failure');
      await expect(resolveCommittedHostedLockPair(root)).resolves.toMatchObject({ ownerBytes: result.ownerBytes });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['onStaged', (root: string, temporary: string[]) => link(temporary[0], path.join(root, 'owner-alias'))],
    ['onCommittedCleanup', async (root: string) => link(path.join(root, await generationName(root), 'hosted-stack.lock.json'), path.join(root, 'stack-alias'))],
  ])('rejects a staged lock hard-link alias introduced by %s', async (_phase, attack) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-hard-link-'));
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), {
        onStaged: ({ temporary }) => _phase === 'onStaged' ? attack(root, temporary) : undefined,
        onCommittedCleanup: () => _phase === 'onCommittedCleanup' ? attack(root, []) : undefined,
      })).rejects.toThrow(/link count changed/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['a root-level lock', (root: string) => writeFile(path.join(root, 'hosted-stack.lock.json'), '{}\n')],
    ['a temporary root commit marker', (root: string) => writeFile(path.join(root, '.hosted-lock-commit.json.foreign'), '{}\n')],
  ])('rejects root entries introduced by committed cleanup: %s', async (_name, attack) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-post-cleanup-root-entry-'));
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), { onCommittedCleanup: () => attack(root) })).rejects.toThrow(/stale materialization|temporary hosted lock commit marker/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['marker in-place corruption', async (root: string) => writeFile(path.join(root, '.hosted-lock-commit.json'), '{}\n'), /staged (identity|bytes) changed/],
    ['owner in-place corruption', async (root: string) => writeFile(path.join(root, (await generationName(root)), 'hosted-lifecycle-owner.lock.json'), '{}\n'), /staged (identity|bytes) changed/],
    ['owner replacement', async (root: string) => { const target = path.join(root, await generationName(root), 'hosted-lifecycle-owner.lock.json'); await unlink(target); await writeFile(target, '{}\n'); }, /staged (path was replaced|link count changed)/],
    ['stack in-place corruption', async (root: string) => writeFile(path.join(root, (await generationName(root)), 'hosted-stack.lock.json'), '{}\n'), /staged (identity|bytes) changed/],
    ['stack replacement', async (root: string) => { const target = path.join(root, await generationName(root), 'hosted-stack.lock.json'); await unlink(target); await writeFile(target, '{}\n'); }, /staged (path was replaced|link count changed)/],
    ['generation rename', async (root: string) => { const generation = path.join(root, await generationName(root)); await rename(generation, `${generation}-displaced`); await mkdir(generation); }, /directory identity changed/],
    ['root replacement', async (root: string) => { await rename(root, `${root}-displaced`); await mkdir(root); }, /root pathname was renamed or replaced/],
  ])('rejects post-cleanup %s before reporting publication success', async (_name, attack, expected) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-post-cleanup-revalidation-'));
    const displaced = `${root}-displaced`;
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), { onCommittedCleanup: () => attack(root) })).rejects.toThrow(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(displaced, { recursive: true, force: true });
    }
  });

  it('rejects a replaced temp-marker pathname during post-commit cleanup while preserving the foreign entry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-marker-replace-'));
    const foreign = Buffer.from('foreign marker');
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), { onCommittedCleanup: async () => {
        const generation = (await readdir(root)).find((name) => name.startsWith('.hosted-lock-transaction-') && !name.endsWith('.json'))!;
        const marker = (await readdir(path.join(root, generation))).find((name) => name.startsWith('.hosted-lock-commit.json.'))!;
        const markerPath = path.join(root, generation, marker); await unlink(markerPath); await writeFile(markerPath, foreign);
      } })).rejects.toThrow(/link count changed|marker topology changed|staged path was replaced/);
      const generation = (await readdir(root)).find((name) => name.startsWith('.hosted-lock-transaction-') && !name.endsWith('.json'))!;
      const marker = (await readdir(path.join(root, generation))).find((name) => name.startsWith('.hosted-lock-commit.json.'))!;
      await expect(readFile(path.join(root, generation, marker))).resolves.toEqual(foreign);
      await expect(resolveCommittedHostedLockPair(root)).rejects.toThrow(/bounded standalone file/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects removal of the temporary marker link after publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-marker-unlink-'));
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), { onCommittedCleanup: async () => {
        const generation = await generationName(root);
        const marker = (await readdir(path.join(root, generation))).find((name) => name.startsWith('.hosted-lock-commit.json.'))!;
        await unlink(path.join(root, generation, marker));
        await link(path.join(root, '.hosted-lock-commit.json'), path.join(root, 'marker-alias'));
      } })).rejects.toThrow(/ENOENT|link count changed|marker topology changed/);
      await expect(resolveCommittedHostedLockPair(root)).rejects.toThrow(/bounded standalone file|ENOENT/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a third hard-link alias for the commit marker after publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-marker-third-link-'));
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), { onCommittedCleanup: async () => {
        await link(path.join(root, '.hosted-lock-commit.json'), path.join(root, 'marker-alias'));
      } })).rejects.toThrow(/link count changed|marker topology changed/);
      await expect(resolveCommittedHostedLockPair(root)).rejects.toThrow(/bounded standalone file/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a replaced staging path and preserves its foreign tombstone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-lock-staging-replace-'));
    const replacement = Buffer.from('foreign staged bytes');
    try {
      await expect(materializeHostedLocksAtRoot(root, input(), {
        onStaged: async ({ temporary }) => {
          await unlink(temporary[0]);
          await writeFile(temporary[0], replacement);
        },
      })).rejects.toThrow(/staged (path was replaced|link count changed)/);
      const staging = (await readdir(root)).find((name) => name.startsWith('.hosted-lock-transaction-') && !name.endsWith('.json'));
      expect(staging).toBeDefined();
      await expect(readFile(path.join(root, staging!, 'hosted-lifecycle-owner.lock.json'))).resolves.toEqual(replacement);
      await expect(readFile(path.join(root, '.hosted-lock-commit.json'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  });

  it('compares the actual-owner tuple canonically rather than by property insertion order', async () => {
    const value = input();
    value.actualOwner = {
      socketIdentity: { mode: 0o660, gid: 1000, uid: 1000, inode: '2', device: '1' },
      ownerSessionId: 'session-1',
      ownerGeneration: 1,
      ownerAuthority: 'authority-1',
    };
    value.evidence.owner.actualOwner = value.actualOwner;
    value.evidence.owner.socketIdentity = value.actualOwner.socketIdentity;
    await expect(materializeHostedLockPair(value)).resolves.toBeTruthy();
  });

  it.each([
    ['missing author', (value: Fixture) => replaceCommit(value, 'tree TREE\n\nmessage\n')],
    ['duplicate author', (value: Fixture) => replaceCommit(value, 'tree TREE\nauthor fixture <fixture@example.invalid> 0 +0000\nauthor fixture <fixture@example.invalid> 0 +0000\ncommitter fixture <fixture@example.invalid> 0 +0000\n\nmessage\n')],
    ['malformed header', (value: Fixture) => replaceCommit(value, 'tree TREE\ninvalid-header\nauthor fixture <fixture@example.invalid> 0 +0000\ncommitter fixture <fixture@example.invalid> 0 +0000\n\nmessage\n')],
    ['invalid tree mode', (value: Fixture) => replaceTree(value, Buffer.concat([Buffer.from('00000 fixture\0'), Buffer.alloc(20, 7)]))],
    ['duplicate tree name', (value: Fixture) => replaceTree(value, Buffer.concat([Buffer.from('100644 fixture\0'), Buffer.alloc(20, 7), Buffer.from('100755 fixture\0'), Buffer.alloc(20, 8)]))],
    ['noncanonical tree order', (value: Fixture) => replaceTree(value, Buffer.concat([Buffer.from('100644 z\0'), Buffer.alloc(20, 7), Buffer.from('100644 a\0'), Buffer.alloc(20, 8)]))],
  ])('rejects malformed Git objects: %s', async (_name, mutate) => {
    const value = input();
    mutate(value);
    await expect(materializeHostedLockPair(value)).rejects.toThrow(/source\.(commit|tree).*malformed|canonically ordered/);
  });

  it.each([
    ['artifact', (value: Fixture) => swapArtifact(value)],
    ['artifact signature', (value: Fixture) => swapArtifactSignature(value)],
    ['SBOM', (value: Fixture) => swapDocument(value, 'sbom')],
    ['attestation', (value: Fixture) => swapDocument(value, 'attestation')],
    ['image', (value: Fixture) => swapImage(value)],
  ])('rejects swapped %s evidence even when its digest declaration is updated', async (_name, mutate) => {
    const value = input();
    mutate(value);
    await expect(materializeHostedLockPair(value)).rejects.toThrow(/complete|mixed|subject|signature|release provenance/);
  });

  it('requires the exact fixed producer-provenance contract bytes', async () => {
    const missing = input();
    Reflect.deleteProperty(missing.evidence.contracts as Record<string, unknown>, 'hostedProducerProvenanceV2Bytes');
    await expect(materializeHostedLockPair(missing)).rejects.toThrow(/producer provenance contract evidence is unavailable/);
    const changed = input();
    changed.evidence.contracts.hostedProducerProvenanceV2Bytes = Buffer.from('not the fixed contract');
    await expect(materializeHostedLockPair(changed)).rejects.toThrow(/producer provenance contract digest/);
  });

  it('returns a recomputed value for every declared digest class, including lowercase sha256', async () => {
    const value = input();
    const pair = await materializeHostedLockPair(value);
    const actual = (await recomputeHostedLockDigests(pair.ownerBytes, pair.stackBytes, value.evidence, value.trustedAdapter)).declaredDigests;
    expect(actual).toEqual(collectDigestDeclarations({
      owner: JSON.parse(pair.ownerBytes.toString()),
      stack: JSON.parse(pair.stackBytes.toString()),
    }));
    expect(actual).toMatchObject({
      'owner.artifact.sha256': value.owner.artifact.sha256,
      'owner.sbom.sha256': value.owner.sbom.sha256,
      'owner.attestation.signatureSha256': value.owner.attestation.signatureSha256,
      'stack.product.toolchain.pnpmLockSha256': value.product.toolchain.pnpmLockSha256,
      'stack.product.build.closureSha256': value.product.build.closureSha256,
      'stack.product.image.digest': value.product.image.digest,
      'stack.owner.lockSha256': pair.ownerSha256,
      'stack.openCode.protocol.capabilityDigest': value.openCode.protocol.capabilityDigest,
      'stack.contracts.hostedProducerProvenanceV2Sha256': value.contracts.hostedProducerProvenanceV2Sha256,
      'stack.toolchains.productSha256': JSON.parse(pair.stackBytes.toString()).toolchains.productSha256,
      'stack.deploymentRecipe.sha256': value.deploymentRecipe.sha256,
    });
    expect(Object.keys(actual)).toHaveLength(56);
  });
});

async function withPlatform<T>(platform: NodeJS.Platform, operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor!);
  }
}

async function generationName(root: string) {
  const name = (await readdir(root)).find((entry) => entry.startsWith('.hosted-lock-transaction-') && !entry.endsWith('.json'));
  if (!name) throw new Error('missing staged generation');
  return name;
}

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`;
}

function gitObject(type: string, bytes: Uint8Array) {
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(Buffer.from(bytes)).digest('hex');
}

function replaceCommit(value: Fixture, template: string) {
  const facts = value.evidence.product.source;
  facts.commitBytes = Buffer.from(template.replace('TREE', value.product.source.tree));
  value.product.source.commit = gitObject('commit', facts.commitBytes);
}

function replaceTree(value: Fixture, treeBytes: Buffer) {
  const facts = value.evidence.product.source;
  facts.treeBytes = treeBytes;
  value.product.source.tree = gitObject('tree', treeBytes);
  replaceCommit(value, 'tree TREE\nauthor fixture <fixture@example.invalid> 0 +0000\ncommitter fixture <fixture@example.invalid> 0 +0000\n\nmessage\n');
}

function swapArtifact(value: Fixture) {
  value.evidence.product.artifact.bytes = value.evidence.owner.artifact.bytes;
  value.evidence.product.artifact.subjectBytes = value.evidence.owner.artifact.subjectBytes;
  value.product.artifact.sha256 = sha256(value.evidence.product.artifact.bytes);
}

function swapArtifactSignature(value: Fixture) {
  value.evidence.product.artifact.signatureBytes = value.evidence.owner.artifact.signatureBytes;
  value.product.artifact.signatureSha256 = sha256(value.evidence.product.artifact.signatureBytes);
}

function swapDocument(value: Fixture, document: 'sbom' | 'attestation') {
  value.evidence.owner[document] = value.evidence.openCode[document];
  value.owner[document].sha256 = sha256(value.evidence.owner[document].bytes);
  value.owner[document].signatureSha256 = sha256(value.evidence.owner[document].signatureBytes);
}

function swapImage(value: Fixture) {
  value.evidence.product.image.manifestBytes = value.evidence.owner.image.manifestBytes;
  value.product.image.digest = sha256(value.evidence.product.image.manifestBytes);
}

function collectDigestDeclarations(value: unknown) {
  const result: Record<string, string> = {};
  const visit = (node: unknown, prefix = '') => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const current = prefix ? `${prefix}.${key}` : key;
      if (
        typeof child === 'string' &&
        /^sha256:[a-f0-9]{64}$/u.test(child) &&
        (key === 'sha256' || key === 'digest' || key.endsWith('Sha256') || key.endsWith('Digest'))
      ) result[current] = child;
      visit(child, current);
    }
  };
  visit(value);
  return result;
}
