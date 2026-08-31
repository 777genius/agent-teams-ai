// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LEGACY_HOSTED_OWNER_LOCK_FILENAME,
  OWNER_LOCK_FILENAME,
  STACK_LOCK_FILENAME,
  canonicalJsonBytes,
  parseOwnerLock,
  parseStackLock,
  sha256Digest,
  verifyHostedLockPair,
} from '../../../scripts/hosted-release/contracts.mjs';
import { verifyHostedLocksAtRoot } from '../../../scripts/hosted-release/verify-locks.mjs';

const temporaryDirectories: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const gitId = (character: string): string => character.repeat(40);

function ownerFixture() {
  return {
    schemaVersion: 1,
    lockType: 'hosted-lifecycle-owner',
    source: {
      repository: '777genius/agent_teams_orchestrator',
      commit: gitId('a'),
      tree: gitId('b'),
      tag: 'hosted-owner-v1.0.0-rc.1',
    },
    toolchain: {
      nodeVersion: '24.15.0',
      bunVersion: '1.2.21',
      bunLockSha256: digest('1'),
    },
    build: {
      entryPath: 'dist/local-cli/cli.js',
      entrySha256: digest('2'),
      closureManifestPath: 'dist/hosted-owner-closure.json',
      closureManifestSha256: digest('3'),
      closureSha256: digest('4'),
    },
    artifact: {
      namespace: 'hosted-v1/owner',
      name: 'hosted-owner-linux-x64.tar.gz',
      sha256: digest('5'),
      signatureSha256: digest('6'),
    },
    image: {
      reference: 'ghcr.io/777genius/hosted-owner',
      digest: digest('7'),
    },
    sbom: {
      path: 'release/hosted-owner.spdx.json',
      sha256: digest('8'),
      signatureSha256: digest('9'),
    },
    attestation: {
      path: 'release/hosted-owner.intoto.jsonl',
      sha256: digest('a'),
      signatureSha256: digest('b'),
    },
    protocol: {
      version: '1.0.0',
      digest: digest('c'),
      capabilityDigest: digest('d'),
      capabilities: ['approval.lifecycle', 'approval.owner'],
    },
    durableState: {
      formatVersion: '1.0.0',
      compatibilityDigest: digest('e'),
    },
    eligibility: {
      temporaryRuntime: true,
      productionEligible: false,
      releaseEligible: false,
    },
  };
}

function productFixture() {
  return {
    source: {
      repository: '777genius/agent-teams-ai',
      commit: gitId('1'),
      tree: gitId('2'),
      tag: 'hosted-product-v1.0.0-rc.1',
    },
    toolchain: {
      nodeVersion: '24.15.0',
      pnpmVersion: '10.17.1',
      pnpmLockSha256: digest('f'),
    },
    build: {
      entryPath: 'dist-standalone/index.cjs',
      entrySha256: digest('1'),
      closureManifestPath: 'dist-standalone/closure.json',
      closureManifestSha256: digest('2'),
      closureSha256: digest('3'),
    },
    artifact: {
      namespace: 'hosted-v1/product',
      name: 'hosted-product-linux-x64.tar.gz',
      sha256: digest('4'),
      signatureSha256: digest('5'),
    },
    image: {
      reference: 'ghcr.io/777genius/agent-teams-hosted',
      digest: digest('6'),
    },
  };
}

function openCodeFixture() {
  return {
    source: {
      repository: '777genius/opencode-anomaly',
      commit: gitId('3'),
      tree: gitId('4'),
      tag: 'hosted-opencode-v1.0.0-rc.1',
    },
    toolchain: {
      bunVersion: '1.2.21',
      bunLockSha256: digest('7'),
    },
    build: {
      entryPath: 'dist/opencode',
      entrySha256: digest('8'),
      closureManifestPath: 'dist/opencode-closure.json',
      closureManifestSha256: digest('9'),
      closureSha256: digest('a'),
    },
    artifact: {
      namespace: 'hosted-v1/opencode',
      name: 'hosted-opencode-linux-x64.tar.gz',
      sha256: digest('b'),
      signatureSha256: digest('c'),
    },
    image: {
      reference: 'ghcr.io/777genius/hosted-opencode',
      digest: digest('d'),
    },
    sbom: {
      path: 'release/hosted-opencode.spdx.json',
      sha256: digest('e'),
      signatureSha256: digest('f'),
    },
    attestation: {
      path: 'release/hosted-opencode.intoto.jsonl',
      sha256: digest('1'),
      signatureSha256: digest('2'),
    },
    protocol: {
      version: '1.0.0',
      digest: digest('3'),
      capabilityDigest: digest('4'),
      capabilities: ['approval.effect', 'approval.request'],
    },
  };
}

function validPair() {
  const owner = ownerFixture();
  const ownerBytes = canonicalJsonBytes(owner);
  const product = productFixture();
  const openCode = openCodeFixture();
  const stack = {
    schemaVersion: 1,
    lockType: 'hosted-stack',
    product,
    owner: {
      lockSha256: sha256Digest(ownerBytes),
      source: owner.source,
      toolchain: owner.toolchain,
      build: owner.build,
      artifact: owner.artifact,
      image: owner.image,
      sbom: owner.sbom,
      attestation: owner.attestation,
      protocol: owner.protocol,
      durableState: owner.durableState,
      eligibility: owner.eligibility,
    },
    openCode,
    contracts: {
      hostedProducerProvenanceV2Sha256:
        'sha256:acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498',
      actualOwnerContractV2Sha256: digest('5'),
      stackContractSha256: digest('6'),
    },
    toolchains: {
      productSha256: sha256Digest(canonicalJsonBytes(product.toolchain)),
      ownerSha256: sha256Digest(canonicalJsonBytes(owner.toolchain)),
      openCodeSha256: sha256Digest(canonicalJsonBytes(openCode.toolchain)),
    },
    deploymentRecipe: {
      path: 'docker/hosted-v1.compose.yml',
      sha256: digest('7'),
    },
    eligibility: {
      temporaryRuntime: true,
      productionEligible: false,
      releaseEligible: false,
    },
  };
  return { owner, ownerBytes, stack, stackBytes: canonicalJsonBytes(stack) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('hosted release lock contracts', () => {
  it('accepts one canonical, fully cross-bound lock pair', () => {
    const { ownerBytes, stackBytes } = validPair();
    expect(verifyHostedLockPair(ownerBytes, stackBytes).stack.lockType).toBe('hosted-stack');
  });

  it('rejects malformed, non-canonical, and duplicate-key representations', () => {
    const { owner, ownerBytes } = validPair();
    expect(() => parseOwnerLock(Buffer.from('{'))).toThrow(/malformed JSON/);
    expect(() => parseOwnerLock(Buffer.from(JSON.stringify(owner, null, 2)))).toThrow(
      /not the single canonical representation/
    );
    const duplicated = ownerBytes
      .toString('utf8')
      .replace(
        '"lockType":"hosted-lifecycle-owner",',
        '"lockType":"hosted-lifecycle-owner","lockType":"hosted-lifecycle-owner",'
      );
    expect(() => parseOwnerLock(Buffer.from(duplicated))).toThrow(
      /not the single canonical representation/
    );
    expect(() => parseOwnerLock(Buffer.from([0xff]))).toThrow(/valid UTF-8/);
  });

  it('rejects missing, unknown, malformed, and type-confused identities', () => {
    const missing = ownerFixture() as Record<string, unknown>;
    delete missing.source;
    expect(() => parseOwnerLock(canonicalJsonBytes(missing))).toThrow(/missing=\[source\]/);

    const unknown = ownerFixture() as Record<string, unknown>;
    unknown.platform = 'linux';
    expect(() => parseOwnerLock(canonicalJsonBytes(unknown))).toThrow(/unknown=\[platform\]/);

    const malformed = ownerFixture();
    malformed.source.commit = 'current';
    expect(() => parseOwnerLock(canonicalJsonBytes(malformed))).toThrow(/Git object ID/);

    const confused = ownerFixture() as unknown as { source: { tree: unknown } };
    confused.source.tree = 123;
    expect(() => parseOwnerLock(canonicalJsonBytes(confused))).toThrow(/Git object ID/);
  });

  it('rejects unsafe paths and non-canonical capability sets', () => {
    const unsafe = ownerFixture();
    unsafe.build.entryPath = '../dist/cli.js';
    expect(() => parseOwnerLock(canonicalJsonBytes(unsafe))).toThrow(/without traversal/);

    const duplicateCapabilities = ownerFixture();
    duplicateCapabilities.protocol.capabilities = ['approval.owner', 'approval.owner'];
    expect(() => parseOwnerLock(canonicalJsonBytes(duplicateCapabilities))).toThrow(
      /unique capability IDs/
    );

    const unsortedCapabilities = ownerFixture();
    unsortedCapabilities.protocol.capabilities = ['approval.owner', 'approval.lifecycle'];
    expect(() => parseOwnerLock(canonicalJsonBytes(unsortedCapabilities))).toThrow(
      /canonical sort order/
    );
  });

  it('keeps temporary owner and stack candidates ineligible', () => {
    const owner = ownerFixture();
    owner.eligibility.productionEligible = true;
    expect(() => parseOwnerLock(canonicalJsonBytes(owner))).toThrow(/must equal false/);

    const { stack } = validPair();
    stack.eligibility.releaseEligible = true;
    expect(() => parseStackLock(canonicalJsonBytes(stack))).toThrow(/must equal false/);
  });

  it('rejects inconsistent owner source, build, artifact, and runtime bindings', () => {
    const sourceHybrid = validPair();
    sourceHybrid.stack.owner.source.commit = gitId('5');
    expect(() =>
      verifyHostedLockPair(sourceHybrid.ownerBytes, canonicalJsonBytes(sourceHybrid.stack))
    ).toThrow(/owner\.source.*cross-lock binding/);

    const buildHybrid = validPair();
    buildHybrid.stack.owner.build.entrySha256 = digest('0');
    expect(() =>
      verifyHostedLockPair(buildHybrid.ownerBytes, canonicalJsonBytes(buildHybrid.stack))
    ).toThrow(/owner\.build.*cross-lock binding/);

    const artifactHybrid = validPair();
    artifactHybrid.stack.owner.image.digest = digest('0');
    expect(() =>
      verifyHostedLockPair(artifactHybrid.ownerBytes, canonicalJsonBytes(artifactHybrid.stack))
    ).toThrow(/owner\.image.*cross-lock binding/);

    const runtimeHybrid = validPair();
    runtimeHybrid.stack.owner.protocol.version = '2.0.0';
    expect(() =>
      verifyHostedLockPair(runtimeHybrid.ownerBytes, canonicalJsonBytes(runtimeHybrid.stack))
    ).toThrow(/owner\.protocol.*cross-lock binding/);
  });

  it('rejects stale owner bytes and inconsistent toolchain bindings', () => {
    const staleOwner = validPair();
    staleOwner.stack.owner.lockSha256 = digest('0');
    expect(() =>
      verifyHostedLockPair(staleOwner.ownerBytes, canonicalJsonBytes(staleOwner.stack))
    ).toThrow(/owner\.lockSha256/);

    const staleToolchain = validPair();
    staleToolchain.stack.toolchains.productSha256 = digest('0');
    expect(() =>
      verifyHostedLockPair(staleToolchain.ownerBytes, canonicalJsonBytes(staleToolchain.stack))
    ).toThrow(/toolchains\.productSha256/);
  });

  it('requires the accepted provenance contract and exact repository identities', () => {
    const wrongContract = validPair();
    wrongContract.stack.contracts.hostedProducerProvenanceV2Sha256 = digest('0');
    expect(() => parseStackLock(canonicalJsonBytes(wrongContract.stack))).toThrow(
      /must equal.*acde43e/
    );

    const wrongRepository = validPair();
    wrongRepository.stack.openCode.source.repository = 'anomalyco/opencode';
    expect(() => parseStackLock(canonicalJsonBytes(wrongRepository.stack))).toThrow(
      /777genius\/opencode-anomaly/
    );
  });

  it('allows normal CI to skip two absent future locks but fails on partial materialization', async () => {
    const root = await temporaryRoot();
    await expect(verifyHostedLocksAtRoot(root, { ifPresent: true })).resolves.toEqual({
      status: 'absent',
    });

    const { ownerBytes } = validPair();
    await writeFile(path.join(root, OWNER_LOCK_FILENAME), ownerBytes);
    await expect(verifyHostedLocksAtRoot(root, { ifPresent: true })).rejects.toThrow(
      /must either both exist or both be absent/
    );
  });

  it('verifies materialized fixture files and rejects the superseded legacy name', async () => {
    const root = await temporaryRoot();
    const { ownerBytes, stackBytes } = validPair();
    await Promise.all([
      writeFile(path.join(root, OWNER_LOCK_FILENAME), ownerBytes),
      writeFile(path.join(root, STACK_LOCK_FILENAME), stackBytes),
    ]);
    await expect(verifyHostedLocksAtRoot(root)).resolves.toEqual({ status: 'verified' });

    await writeFile(path.join(root, LEGACY_HOSTED_OWNER_LOCK_FILENAME), ownerBytes);
    await expect(verifyHostedLocksAtRoot(root)).rejects.toThrow(/is superseded/);
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hosted-release-locks-'));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}
