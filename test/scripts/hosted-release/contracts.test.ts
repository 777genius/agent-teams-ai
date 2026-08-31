// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJsonBytes,
  LEGACY_HOSTED_OWNER_LOCK_FILENAME,
  MAX_LOCK_BYTES,
  OWNER_LOCK_FILENAME,
  parseOwnerLock,
  parseStackLock,
  sha256Digest,
  STACK_LOCK_FILENAME,
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

  it('bounds raw bytes before parsing and rejects an explicit UTF-8 BOM', () => {
    const { ownerBytes } = validPair();
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), ownerBytes]);
    expect(() => parseOwnerLock(withBom)).toThrow(/malformed JSON|canonical representation/);
    expect(() => parseOwnerLock(Buffer.alloc(MAX_LOCK_BYTES + 1, 0x20))).toThrow(
      /exceeds the .*byte limit/
    );
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

  it('enforces strict SemVer grammar without leading-zero numeric identifiers', () => {
    for (const validVersion of [
      '0.0.0',
      '1.2.3-alpha.1+build.01',
      '1.2.3-0',
      '1.2.3-01a',
      '1.2.3-123abc',
      '1.2.3-x-y-z.--+build.000',
    ]) {
      const valid = ownerFixture();
      valid.toolchain.nodeVersion = validVersion;
      expect(parseOwnerLock(canonicalJsonBytes(valid)).toolchain.nodeVersion).toBe(validVersion);
    }

    for (const invalidVersion of [
      '01.0.0',
      '1.01.0',
      '1.0.01',
      '1.0.0-01',
      '1.0',
      '1.0.0-',
      '1.0.0-alpha..1',
      '1.0.0+',
      '1.0.0+build..1',
      '1.0.0-alpha+build+second',
      '1.0.0-alpha_beta',
      '1.0.0-α',
    ]) {
      const invalid = ownerFixture();
      invalid.toolchain.nodeVersion = invalidVersion;
      expect(() => parseOwnerLock(canonicalJsonBytes(invalid))).toThrow(/semantic version/);
    }
  });

  it('rejects long adversarial SemVer input within a bounded subprocess', () => {
    const invalid = ownerFixture();
    invalid.toolchain.nodeVersion = `0.0.0-0.${'--.'.repeat(20_000)}`;
    const contractsUrl = new URL('../../../scripts/hosted-release/contracts.mjs', import.meta.url).href;
    const script = `
      import { readFileSync } from 'node:fs';
      import { parseOwnerLock } from ${JSON.stringify(contractsUrl)};
      try {
        parseOwnerLock(readFileSync(0));
        process.stdout.write('accepted');
      } catch (error) {
        process.stdout.write(String(error));
      }
    `;

    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      input: canonicalJsonBytes(invalid),
      timeout: 2_000,
    });
    expect(output).toContain('must be an explicit semantic version');
  });

  it('rejects unsafe paths and non-canonical capability sets', () => {
    for (const unsafePath of [
      '../dist/cli.js',
      'dist\\cli.js',
      'C:/dist/cli.js',
      'https://example.invalid/cli.js',
      'dist/\ncli.js',
      'dist/\tcli.js',
      `dist/${String.fromCharCode(0x7f)}cli.js`,
    ]) {
      const unsafe = ownerFixture();
      unsafe.build.entryPath = unsafePath;
      expect(() => parseOwnerLock(canonicalJsonBytes(unsafe))).toThrow(
        /normalized POSIX relative path/
      );
    }

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

  it('fails closed when absent locks or the legacy lock appear after inspection', async () => {
    const pairRoot = await temporaryRoot();
    const { ownerBytes, stackBytes } = validPair();
    await expect(
      verifyHostedLocksAtRoot(pairRoot, {
        ifPresent: true,
        onEntriesInspected: async () => {
          await Promise.all([
            writeFile(path.join(pairRoot, OWNER_LOCK_FILENAME), ownerBytes),
            writeFile(path.join(pairRoot, STACK_LOCK_FILENAME), stackBytes),
          ]);
        },
      })
    ).rejects.toThrow(/appeared or disappeared during verification/);

    const legacyRoot = await temporaryRoot();
    await expect(
      verifyHostedLocksAtRoot(legacyRoot, {
        ifPresent: true,
        onEntriesInspected: async () => {
          await writeFile(path.join(legacyRoot, LEGACY_HOSTED_OWNER_LOCK_FILENAME), ownerBytes);
        },
      })
    ).rejects.toThrow(/appeared or disappeared during verification/);
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

  it('rejects owner and stack symlinks', async () => {
    const ownerSymlinkRoot = await temporaryRoot();
    const ownerPair = validPair();
    await Promise.all([
      writeFile(path.join(ownerSymlinkRoot, 'owner-target.json'), ownerPair.ownerBytes),
      writeFile(path.join(ownerSymlinkRoot, STACK_LOCK_FILENAME), ownerPair.stackBytes),
    ]);
    await symlink('owner-target.json', path.join(ownerSymlinkRoot, OWNER_LOCK_FILENAME));
    await expect(verifyHostedLocksAtRoot(ownerSymlinkRoot)).rejects.toThrow(
      /regular file.*symlink/
    );

    const stackSymlinkRoot = await temporaryRoot();
    const stackPair = validPair();
    await Promise.all([
      writeFile(path.join(stackSymlinkRoot, OWNER_LOCK_FILENAME), stackPair.ownerBytes),
      writeFile(path.join(stackSymlinkRoot, 'stack-target.json'), stackPair.stackBytes),
    ]);
    await symlink('stack-target.json', path.join(stackSymlinkRoot, STACK_LOCK_FILENAME));
    await expect(verifyHostedLocksAtRoot(stackSymlinkRoot)).rejects.toThrow(
      /regular file.*symlink/
    );
  });

  it('does not treat dangling lock symlinks as absent with ifPresent', async () => {
    const root = await temporaryRoot();
    await symlink('missing-owner.json', path.join(root, OWNER_LOCK_FILENAME));
    await expect(verifyHostedLocksAtRoot(root, { ifPresent: true })).rejects.toThrow(
      /regular file.*symlink/
    );
  });

  it('rejects owner and stack identity collapse through hard links', async () => {
    const root = await temporaryRoot();
    const { ownerBytes } = validPair();
    const ownerPath = path.join(root, OWNER_LOCK_FILENAME);
    await writeFile(ownerPath, ownerBytes);
    await link(ownerPath, path.join(root, STACK_LOCK_FILENAME));
    await expect(verifyHostedLocksAtRoot(root)).rejects.toThrow(/hard-linked file/);
  });

  it('rejects aliases outside the lock pair', async () => {
    const root = await temporaryRoot();
    const { ownerBytes, stackBytes } = validPair();
    const ownerPath = path.join(root, OWNER_LOCK_FILENAME);
    await writeFile(ownerPath, ownerBytes);
    await writeFile(path.join(root, STACK_LOCK_FILENAME), stackBytes);
    await link(ownerPath, path.join(root, 'external-owner-alias.json'));
    await expect(verifyHostedLocksAtRoot(root)).rejects.toThrow(/hard-linked file/);
  });

  it('accepts unrelated directory changes in a shared ancestor', async () => {
    const container = await temporaryRoot();
    const root = path.join(container, 'locks');
    await mkdir(root);
    const { ownerBytes, stackBytes } = validPair();
    await writeFile(path.join(root, OWNER_LOCK_FILENAME), ownerBytes);
    await writeFile(path.join(root, STACK_LOCK_FILENAME), stackBytes);
    await expect(
      verifyHostedLocksAtRoot(root, {
        onFileOpened: async (filename) => {
          await writeFile(path.join(container, `unrelated-${filename}`), 'unrelated job');
        },
      })
    ).resolves.toEqual({ status: 'verified' });
  });

  it('rejects oversized lock files before reading or parsing them', async () => {
    const root = await temporaryRoot();
    const { stackBytes } = validPair();
    await Promise.all([
      writeFile(path.join(root, OWNER_LOCK_FILENAME), Buffer.alloc(MAX_LOCK_BYTES + 1, 0x20)),
      writeFile(path.join(root, STACK_LOCK_FILENAME), stackBytes),
    ]);
    await expect(verifyHostedLocksAtRoot(root)).rejects.toThrow(/exceeds the .*byte limit/);
  });

  it('rejects a symlink in the supplied lock-root ancestry', async () => {
    const container = await temporaryRoot();
    const actualRoot = await mkdtemp(path.join(container, 'actual-'));
    const aliasRoot = path.join(container, 'lock-root-alias');
    const { ownerBytes, stackBytes } = validPair();
    await Promise.all([
      writeFile(path.join(actualRoot, OWNER_LOCK_FILENAME), ownerBytes),
      writeFile(path.join(actualRoot, STACK_LOCK_FILENAME), stackBytes),
    ]);
    await symlink(actualRoot, aliasRoot, 'dir');
    await expect(verifyHostedLocksAtRoot(aliasRoot)).rejects.toThrow(
      /root ancestry.*directories.*symlinks/
    );
  });

  it('fails closed when a lock changes after its descriptor is opened', async () => {
    const root = await temporaryRoot();
    const { ownerBytes, stackBytes } = validPair();
    const ownerPath = path.join(root, OWNER_LOCK_FILENAME);
    await Promise.all([
      writeFile(ownerPath, ownerBytes),
      writeFile(path.join(root, STACK_LOCK_FILENAME), stackBytes),
    ]);

    let changed = false;
    await expect(
      verifyHostedLocksAtRoot(root, {
        onFileOpened: async (filename) => {
          if (!changed && filename === OWNER_LOCK_FILENAME) {
            changed = true;
            await writeFile(ownerPath, Buffer.from('{}\n'));
          }
        },
      })
    ).rejects.toThrow(/changed while it was being read|metadata changed during verification/);
  });

  it('rechecks a completed lock while its sibling read is still pending', async () => {
    const root = await temporaryRoot();
    const { ownerBytes, stackBytes } = validPair();
    const ownerPath = path.join(root, OWNER_LOCK_FILENAME);
    await Promise.all([
      writeFile(ownerPath, ownerBytes),
      writeFile(path.join(root, STACK_LOCK_FILENAME), stackBytes),
    ]);

    let releaseStack!: () => void;
    const stackMayRead = new Promise<void>((resolve) => {
      releaseStack = resolve;
    });
    await expect(
      verifyHostedLocksAtRoot(root, {
        onFileOpened: async (filename) => {
          if (filename === STACK_LOCK_FILENAME) await stackMayRead;
        },
        onFileRead: async (filename) => {
          if (filename !== OWNER_LOCK_FILENAME) return;
          const replacementPath = path.join(root, 'replacement-owner.lock.json');
          await writeFile(replacementPath, ownerBytes);
          await rename(replacementPath, ownerPath);
          releaseStack();
        },
      })
    ).rejects.toThrow(/identity or metadata changed during verification/);
  });

  it('waits for both reads to finish and close when either read fails', async () => {
    const root = await temporaryRoot();
    const { ownerBytes, stackBytes } = validPair();
    const ownerPath = path.join(root, OWNER_LOCK_FILENAME);
    await Promise.all([
      writeFile(ownerPath, ownerBytes),
      writeFile(path.join(root, STACK_LOCK_FILENAME), stackBytes),
    ]);

    let releaseStack!: () => void;
    const stackMayRead = new Promise<void>((resolve) => {
      releaseStack = resolve;
    });
    let markOwnerClosed!: () => void;
    const ownerClosed = new Promise<void>((resolve) => {
      markOwnerClosed = resolve;
    });
    const closed = new Set<string>();
    const verification = verifyHostedLocksAtRoot(root, {
      onFileOpened: async (filename) => {
        if (filename === OWNER_LOCK_FILENAME) {
          await writeFile(ownerPath, Buffer.from('{}\n'));
        } else {
          await stackMayRead;
        }
      },
      onFileClosed: async (filename) => {
        closed.add(filename);
        if (filename === OWNER_LOCK_FILENAME) markOwnerClosed();
      },
    });

    await ownerClosed;
    await expect(
      Promise.race([
        verification.then(
          () => 'returned',
          () => 'returned'
        ),
        new Promise<string>((resolve) => setImmediate(() => resolve('pending'))),
      ])
    ).resolves.toBe('pending');
    releaseStack();
    await expect(verification).rejects.toThrow(
      /changed while it was being read|metadata changed during verification/
    );
    expect(closed).toEqual(new Set([OWNER_LOCK_FILENAME, STACK_LOCK_FILENAME]));
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hosted-release-locks-')));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}
