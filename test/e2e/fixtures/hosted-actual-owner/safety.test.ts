import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACTUAL_OWNER_INTEGRATION_PURPOSE,
  parseActualOwnerCliOptions,
  parseActualOwnerIntegrationManifest,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  verifyActualOwnerArtifact,
  verifyProductExecutable,
} from '../../../../scripts/e2e/hosted-actual-owner/preflight';
import {
  cleanupActualOwnerSandbox,
  createActualOwnerSandbox,
  isPathWithinActualOwnerSandbox,
  type ActualOwnerSandbox,
} from '../../../../scripts/e2e/hosted-actual-owner/sandbox';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function completeArgs(): string[] {
  const root = '/tmp/actual-owner-options';
  return [
    '--evidence-root',
    `${root}/evidence`,
    '--integration-manifest',
    `${root}/integration.json`,
    '--opencode-executable',
    `${root}/opencode`,
    '--opencode-release-manifest',
    `${root}/release-manifest.json`,
    '--opencode-sha256',
    'a'.repeat(64),
    '--opencode-source-ref',
    'b'.repeat(40),
    '--orchestrator-acceptance-entry',
    `${root}/orchestrator/scripts/e2e/hosted-actual-owner-owner.ts`,
    '--orchestrator-ref',
    'c'.repeat(40),
    '--orchestrator-root',
    `${root}/orchestrator`,
    '--orchestrator-source-launcher',
    `${root}/orchestrator/cli-source`,
    '--product-ref',
    'd'.repeat(40),
    '--product-root',
    `${root}/product`,
    '--sandbox-parent',
    `${root}/sandboxes`,
  ];
}

function integrationManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_INTEGRATION_PURPOSE,
    integrations: {
      browserApprovalSurface: 'integrated',
      orchestratorAcceptanceEntry: 'integrated',
      trustedAdmissionPublisher: 'integrated',
    },
    driverBaseUrl: 'http://127.0.0.1:49152/',
    productBaseUrl: 'https://127.0.0.1:49153/',
    approvalPath: '/hosted/approvals',
    processes: {
      opencode: {
        args: ['serve', '--port', '49154'],
        cwd: '<workspace-root>',
        environment: {},
      },
      orchestrator: {
        args: ['hosted-actual-owner-e2e'],
        cwd: '<orchestrator-root>',
        environment: {},
      },
      product: {
        executable: '/usr/bin/pnpm',
        executableSha256: 'f'.repeat(64),
        productRef: 'd'.repeat(40),
        args: ['exec', 'tsx', 'scripts/start.ts'],
        cwd: '<product-root>',
        environment: {},
      },
    },
    timeouts: { browserMs: 60_000, processReadyMs: 30_000, shutdownMs: 5_000 },
  };
}

describe('actual-owner CLI and integration preconditions', () => {
  it('accepts only a complete set of exact immutable refs and artifact digest', () => {
    const parsed = parseActualOwnerCliOptions(completeArgs());
    expect(parsed.productRef).toBe('d'.repeat(40));
    expect(parsed.openCodeSha256).toBe('a'.repeat(64));
  });

  it('rejects short refs, duplicate flags, and unresolved integration state', () => {
    const shortRef = completeArgs();
    shortRef[shortRef.indexOf('--product-ref') + 1] = 'main';
    expect(() => parseActualOwnerCliOptions(shortRef)).toThrow(/unfrozen_ref/u);

    const duplicate = completeArgs();
    duplicate[duplicate.indexOf('--sandbox-parent')] = '--product-root';
    expect(() => parseActualOwnerCliOptions(duplicate)).toThrow(/arguments_invalid/u);

    const manifest = integrationManifest();
    (manifest.integrations as Record<string, unknown>).trustedAdmissionPublisher = 'missing';
    expect(() => parseActualOwnerIntegrationManifest(manifest)).toThrow(/precondition_missing/u);
  });

  it('rejects any fake runtime or in-memory backend launch contract', () => {
    const manifest = integrationManifest();
    const processes = manifest.processes as Record<string, Record<string, unknown>>;
    processes.orchestrator.args = ['--backend', 'in-memory-backend'];
    expect(() => parseActualOwnerIntegrationManifest(manifest)).toThrow(/fake_runtime_forbidden/u);
  });

  it('does not allow launch templates to replace the sandbox isolation environment', () => {
    const manifest = integrationManifest();
    const processes = manifest.processes as Record<string, Record<string, unknown>>;
    processes.product.environment = { HOME: '/real/user/project' };
    expect(() => parseActualOwnerIntegrationManifest(manifest)).toThrow(/environment_invalid/u);
  });
});

describe('marker-owned sandbox cleanup', () => {
  async function sandbox(): Promise<{ parent: string; sandbox: ActualOwnerSandbox }> {
    const parent = await mkdtemp('/tmp/actual-owner-safety-');
    roots.push(parent);
    await chmod(parent, 0o700);
    return { parent, sandbox: await createActualOwnerSandbox(parent) };
  }

  it('removes only the exact marker-bound root and proves absence', async () => {
    const { parent, sandbox: owned } = await sandbox();
    const sibling = join(parent, 'must-survive');
    await writeFile(sibling, 'outside');
    expect(isPathWithinActualOwnerSandbox(join(owned.root, 'workspace'), owned)).toBe(true);
    expect(isPathWithinActualOwnerSandbox(sibling, owned)).toBe(false);
    const cleanup = await cleanupActualOwnerSandbox(owned);
    expect(cleanup).toMatchObject({ markerVerified: true, removed: true, retainedReason: null });
    await expect(readFile(sibling, 'utf8')).resolves.toBe('outside');
  });

  it('retains the root when its ownership marker is altered', async () => {
    const { sandbox: owned } = await sandbox();
    const original = await readFile(owned.markerPath, 'utf8');
    await writeFile(owned.markerPath, '{"schemaVersion":1}\n', { mode: 0o600 });
    const cleanup = await cleanupActualOwnerSandbox(owned);
    expect(cleanup).toMatchObject({ markerVerified: false, removed: false });
    await expect(readFile(owned.markerPath, 'utf8')).resolves.toContain('schemaVersion');

    await writeFile(owned.markerPath, original, { mode: 0o600 });
    await chmod(owned.markerPath, 0o600);
    const restoredCleanup = await cleanupActualOwnerSandbox(owned);
    expect(restoredCleanup.removed).toBe(true);
  });
});

describe('candidate artifact pinning', () => {
  it('requires the exact immutable product process executable digest', async () => {
    const parent = await mkdtemp('/tmp/actual-owner-product-executable-');
    roots.push(parent);
    const executable = join(parent, 'product-launcher');
    const bytes = '#!/bin/sh\nexit 0\n';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(executable, bytes, { mode: 0o500 });
    await expect(
      verifyProductExecutable({ executable, expectedSha256: sha256 })
    ).resolves.toMatchObject({
      executable,
      sha256,
    });
    await expect(
      verifyProductExecutable({ executable, expectedSha256: '0'.repeat(64) })
    ).rejects.toThrow(/digest_mismatch/u);
  });

  it('binds the executable bytes and size to one exact source commit', async () => {
    const parent = await mkdtemp('/tmp/actual-owner-artifact-');
    roots.push(parent);
    const executable = join(parent, 'opencode');
    const releaseManifest = join(parent, 'release-manifest.json');
    const bytes = '#!/bin/sh\nexit 0\n';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sourceRef = 'e'.repeat(40);
    await writeFile(executable, bytes, { mode: 0o500 });
    await writeFile(
      releaseManifest,
      `${JSON.stringify({
        schemaVersion: 1,
        release: { sourceCommit: sourceRef },
        workflow: { name: 'release' },
        assets: [{ binarySha256: sha256, binarySize: Buffer.byteLength(bytes) }],
      })}\n`,
      { mode: 0o600 }
    );

    await expect(
      verifyActualOwnerArtifact({
        executable,
        expectedSha256: sha256,
        releaseManifest,
        sourceRef,
      })
    ).resolves.toMatchObject({ executable, sha256, sourceCommit: sourceRef });

    await chmod(executable, 0o700);
    await writeFile(executable, `${bytes}# rotated\n`);
    await chmod(executable, 0o500);
    await expect(
      verifyActualOwnerArtifact({
        executable,
        expectedSha256: sha256,
        releaseManifest,
        sourceRef,
      })
    ).rejects.toThrow(/digest_mismatch/u);
  });
});
