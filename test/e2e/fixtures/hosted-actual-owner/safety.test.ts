import { createHash, createHmac } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertActualOwnerAnchorPathIdentity,
  stageActualOwnerExecutable,
  stageActualOwnerSourceFile,
} from '../../../../scripts/e2e/hosted-actual-owner/anchors';
import {
  ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH,
  ACTUAL_OWNER_DESCRIPTOR_TOKENS,
  ACTUAL_OWNER_INHERITED_FDS,
  ACTUAL_OWNER_INTEGRATION_PURPOSE,
  expandActualOwnerToken,
  parseActualOwnerCliOptions,
  parseActualOwnerContractBundle,
  parseActualOwnerIntegrationManifest,
  validateActualOwnerTimelineEvent,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  assertActualOwnerTimelineCaptureCurrent,
  readActualOwnerTimelineCapture,
} from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import {
  verifyActualOwnerArtifact,
  verifyProductExecutable,
} from '../../../../scripts/e2e/hosted-actual-owner/preflight';
import {
  actualOwnerBootstrapFrame,
  actualOwnerInheritedStdio,
} from '../../../../scripts/e2e/hosted-actual-owner/processes';
import {
  assertArgumentsWithinRoots,
  assertRootsDisjoint,
  candidateWithinRoots,
  filesystemArgument,
  uriArgument,
} from '../../../../scripts/e2e/hosted-actual-owner/run';
import {
  type ActualOwnerSandbox,
  cleanupActualOwnerSandbox,
  createActualOwnerSandbox,
  isPathWithinActualOwnerSandbox,
} from '../../../../scripts/e2e/hosted-actual-owner/sandbox';
import {
  atomicAnchoredPrivateFile,
  readAnchoredPrivateFile,
  withAnchoredOutputPath,
} from '../../../../scripts/e2e/hosted-actual-owner/secure-files';

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
    '--product-release-manifest',
    `${root}/product-release-manifest.json`,
    '--playwright-release-manifest',
    `${root}/playwright-release-manifest.json`,
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
        cwd: '${SANDBOX_ROOT}/workspace/project',
        environment: {},
      },
      orchestrator: {
        args: ['hosted-actual-owner-e2e'],
        cwd: '${ORCHESTRATOR_ROOT}',
        environment: {},
      },
      product: {
        executable: '/usr/bin/pnpm',
        executableSha256: 'f'.repeat(64),
        productRef: 'd'.repeat(40),
        args: ['exec', 'tsx', '${PRODUCT_ROOT}/scripts/start.ts'],
        cwd: '${PRODUCT_ROOT}',
        environment: {},
      },
    },
    timeouts: { browserMs: 60_000, processReadyMs: 30_000, shutdownMs: 5_000 },
  };
}

describe('actual-owner CLI and integration preconditions', () => {
  it('publishes one canonical product-owned contract bundle with fixed inherited FD roles', async () => {
    const bytes = await readFile(join(process.cwd(), ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH));
    const bundle = parseActualOwnerContractBundle(bytes);
    expect(bundle).toMatchObject({ byteCount: bytes.byteLength });
    expect(ACTUAL_OWNER_INHERITED_FDS).toEqual({
      launcherLeaseFd: 6,
      livenessFd: 7,
      bootstrapFd: 8,
    });
    expect(actualOwnerInheritedStdio(10, 11, 12)).toEqual([
      'ignore',
      10,
      11,
      'ignore',
      'ignore',
      'ignore',
      12,
      'pipe',
      'pipe',
    ]);
    const frame = actualOwnerBootstrapFrame({
      contractSha256: bundle.sha256,
      ownerSessionId: `session_${'a'.repeat(48)}`,
      ownerToken: 'b'.repeat(64),
      runId: 'a'.repeat(48),
    });
    expect(frame.at(-1)).toBe(0x0a);
    const parsedFrame = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
    expect(parsedFrame).toMatchObject({
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e.bootstrap/v1',
      contractSha256: bundle.sha256,
    });
    const { authentication, ...unsigned } = parsedFrame;
    expect(authentication).toBe(
      createHmac('sha256', 'b'.repeat(64)).update(JSON.stringify(unsigned)).digest('hex')
    );
    expect(() => parseActualOwnerContractBundle(Buffer.concat([bytes, Buffer.from('\n')]))).toThrow(
      /not_canonical/u
    );
  });
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

  it('expands only the four descriptor-bound cross-harness tokens', () => {
    const replacements = {
      [ACTUAL_OWNER_DESCRIPTOR_TOKENS.sandboxRoot]: '/sandbox',
      [ACTUAL_OWNER_DESCRIPTOR_TOKENS.productRoot]: '/product',
      [ACTUAL_OWNER_DESCRIPTOR_TOKENS.orchestratorRoot]: '/orchestrator',
      [ACTUAL_OWNER_DESCRIPTOR_TOKENS.openCodeExecutable]: '/sandbox/runtime/opencode',
    };
    expect(expandActualOwnerToken('${OPENCODE_EXECUTABLE}', replacements)).toBe(
      '/sandbox/runtime/opencode'
    );
    expect(() => expandActualOwnerToken('${UNDECLARED_ROOT}/x', replacements)).toThrow(
      /token_unresolved/u
    );
  });

  it('shares the owner-WAL approval/null reconciliation timeline contract', () => {
    const base = {
      schemaVersion: 1 as const,
      runId: 'a'.repeat(48),
      sequence: 1,
      at: '2026-08-14T00:00:00.000Z',
      generation: 'generation_1',
      effectId: null,
      requestId: 'request_shared',
      routeId: 'route_approval_decision',
      sessionId: `session_${'a'.repeat(48)}`,
    };
    expect(
      validateActualOwnerTimelineEvent({
        ...base,
        event: 'ingress_durable',
        approvalId: 'approval_shared_12345678',
      })
    ).toMatchObject({ approvalId: 'approval_shared_12345678' });
    expect(
      validateActualOwnerTimelineEvent({
        ...base,
        event: 'poll_ingress',
        approvalId: null,
        requestId: null,
      })
    ).toMatchObject({ approvalId: null });
    expect(() =>
      validateActualOwnerTimelineEvent({ ...base, event: 'ingress_durable', approvalId: null })
    ).toThrow(/timeline_event_invalid/u);
    expect(() =>
      validateActualOwnerTimelineEvent({
        ...base,
        event: 'poll_ingress',
        approvalId: 'approval_shared_12345678',
      })
    ).toThrow(/timeline_event_invalid/u);
    expect(() =>
      validateActualOwnerTimelineEvent({
        ...base,
        event: 'implementation_defined_success',
        approvalId: 'approval_shared_12345678',
      })
    ).toThrow(/timeline_event_invalid/u);
    expect(() =>
      validateActualOwnerTimelineEvent({
        ...base,
        at: '2026-02-30T00:00:00.000Z',
        event: 'ingress_durable',
        approvalId: 'approval_shared_12345678',
      })
    ).toThrow(/timeline_event_invalid/u);
  });
});

describe('filesystem argument containment', () => {
  it('recognizes equals-form absolute paths and file URLs', () => {
    expect(filesystemArgument('--config=/outside/config.json', '/sandbox')).toBe(
      '/outside/config.json'
    );
    expect(filesystemArgument('file:///outside/config.json', '/sandbox')).toBe(
      '/outside/config.json'
    );
  });

  it('rejects non-file URI arguments instead of bypassing path containment', async () => {
    for (const value of [
      'https:attacker.invalid',
      'file:/etc/passwd',
      '--callback=https://attacker.invalid/capture',
      '--callback=file:/etc/passwd',
      'custom+scheme:opaque',
    ]) {
      expect(uriArgument(value)).toBe(true);
      await expect(
        assertArgumentsWithinRoots([value], ['/sandbox'], 'product', '/sandbox')
      ).rejects.toThrow(/argument_escaped_allowed_roots/u);
    }
    await expect(
      assertArgumentsWithinRoots(['ordinary-value'], ['/sandbox'], 'product', '/sandbox')
    ).resolves.toBeUndefined();
  });

  it('rejects symlink escapes and repository/evidence overlap', async () => {
    const parent = await mkdtemp('/tmp/actual-owner-containment-');
    roots.push(parent);
    const sandbox = join(parent, 'sandbox');
    const outside = join(parent, 'outside');
    await Promise.all([mkdir(sandbox), mkdir(outside)]);
    await symlink(outside, join(sandbox, 'escape'));
    await expect(candidateWithinRoots(join(sandbox, 'escape', 'file'), [sandbox])).resolves.toBe(
      false
    );
    await expect(assertRootsDisjoint([sandbox, join(sandbox, 'evidence')])).rejects.toThrow(
      /roots_not_disjoint/u
    );
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

describe('dirfd-anchored private publication', () => {
  it('binds exact timeline NDJSON bytes to digest, byte count, and file identity', async () => {
    const parent = await mkdtemp('/tmp/actual-owner-timeline-');
    roots.push(parent);
    const target = join(parent, 'timeline.ndjson');
    const value = {
      schemaVersion: 1,
      at: '2026-08-14T00:00:00.000Z',
      routeId: 'route_approval_decision',
      sessionId: `session_${'a'.repeat(48)}`,
      runId: 'a'.repeat(48),
      generation: 'generation_1',
      approvalId: 'approval_shared_12345678',
      requestId: 'request_shared',
      effectId: null,
      event: 'ingress_durable',
      sequence: 1,
    };
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    await writeFile(target, bytes, { mode: 0o600 });
    const capture = await readActualOwnerTimelineCapture(target);
    expect(capture.events).toHaveLength(1);
    expect(capture.evidence).toMatchObject({
      byteCount: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      path: target,
    });
    await writeFile(target, `${JSON.stringify({ ...value, sequence: 2 })}\n`, { mode: 0o600 });
    await expect(assertActualOwnerTimelineCaptureCurrent(capture.evidence)).rejects.toThrow(
      /capture_rotated/u
    );
    await writeFile(target, JSON.stringify(value), { mode: 0o600 });
    await expect(readActualOwnerTimelineCapture(target)).rejects.toThrow(/ndjson_bytes_invalid/u);
  });

  it('atomically replaces a symlink without touching its target and rejects symlink capture', async () => {
    const parent = await mkdtemp('/tmp/actual-owner-publication-');
    roots.push(parent);
    const outside = join(parent, 'outside.json');
    const target = join(parent, 'evidence.json');
    await writeFile(outside, 'must-survive', { mode: 0o600 });
    await symlink(outside, target);
    await atomicAnchoredPrivateFile(target, Buffer.from('published'));
    await expect(readFile(outside, 'utf8')).resolves.toBe('must-survive');
    await expect(readFile(target, 'utf8')).resolves.toBe('published');

    await rm(target);
    await symlink(outside, target);
    await expect(
      readAnchoredPrivateFile(target, { minimumBytes: 1, maximumBytes: 1024 })
    ).rejects.toThrow();
  });

  it('refuses a symlink output leaf and never clobbers its target', async () => {
    const parent = await mkdtemp('/tmp/actual-owner-output-leaf-');
    roots.push(parent);
    const outside = join(parent, 'outside.zip');
    const output = join(parent, 'trace.zip');
    await writeFile(outside, 'must-survive', { mode: 0o600 });
    await symlink(outside, output);
    await expect(
      withAnchoredOutputPath(output, async (path) => writeFile(path, 'clobbered'))
    ).rejects.toThrow();
    await expect(readFile(outside, 'utf8')).resolves.toBe('must-survive');
  });
});

describe('candidate artifact pinning', () => {
  it('requires the exact immutable product process executable digest', async () => {
    const parent = await mkdtemp('/tmp/actual-owner-product-executable-');
    roots.push(parent);
    const executable = join(parent, 'product-launcher');
    const bytes = '#!/bin/sh\nexit 0\n';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const releaseManifest = join(parent, 'product-release.json');
    const sourceRef = 'd'.repeat(40);
    const contract = {
      repositoryPath: ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH,
      sha256: '9'.repeat(64),
      byteCount: 1545,
      gitBlob: '8'.repeat(40),
      playwrightReleaseManifest: {
        byteCount: 1234,
        sha256: '7'.repeat(64),
      },
    };
    await writeFile(executable, bytes, { mode: 0o500 });
    await writeFile(
      releaseManifest,
      `${JSON.stringify({
        schemaVersion: 1,
        release: { sourceCommit: sourceRef },
        workflow: { name: 'release' },
        assets: [{ binarySha256: sha256, binarySize: Buffer.byteLength(bytes) }],
        actualOwnerContract: {
          repositoryPath: contract.repositoryPath,
          sha256: contract.sha256,
          byteCount: contract.byteCount,
          gitBlob: contract.gitBlob,
        },
        playwrightReleaseManifest: contract.playwrightReleaseManifest,
      })}\n`,
      { mode: 0o600 }
    );
    await expect(
      verifyProductExecutable({
        executable,
        expectedSha256: sha256,
        releaseManifest,
        sourceRef,
        contract,
      })
    ).resolves.toMatchObject({
      executable,
      sha256,
    });
    await expect(
      verifyProductExecutable({
        executable,
        expectedSha256: '0'.repeat(64),
        releaseManifest,
        sourceRef,
        contract,
      })
    ).rejects.toThrow(/digest_mismatch/u);
    await expect(
      verifyProductExecutable({
        executable,
        expectedSha256: sha256,
        releaseManifest,
        sourceRef,
        contract: { ...contract, sha256: '8'.repeat(64) },
      })
    ).rejects.toThrow(/contract_binding_mismatch/u);
    await expect(
      verifyProductExecutable({
        executable,
        expectedSha256: sha256,
        releaseManifest,
        sourceRef,
        contract: { ...contract, gitBlob: '7'.repeat(40) },
      })
    ).rejects.toThrow(/contract_binding_mismatch/u);
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

  it('refuses a pathname replacement before creating the descriptor-bound staged copy', async () => {
    const parent = await mkdtemp('/tmp/actual-owner-stage-');
    roots.push(parent);
    const executable = join(parent, 'candidate');
    const stageRoot = join(parent, 'stage');
    await mkdir(stageRoot, { mode: 0o700 });
    const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(executable, bytes, { mode: 0o500 });
    const verified = await verifyProductExecutable({
      executable,
      expectedSha256: sha256,
      releaseManifest: await productReleaseManifest(parent, sha256, bytes.length),
      sourceRef: 'd'.repeat(40),
      contract: {
        repositoryPath: ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH,
        sha256: '9'.repeat(64),
        byteCount: 1545,
        gitBlob: '8'.repeat(40),
        playwrightReleaseManifest: {
          byteCount: 1234,
          sha256: '7'.repeat(64),
        },
      },
    });
    await rm(executable);
    await writeFile(executable, bytes, { mode: 0o500 });
    await expect(
      stageActualOwnerExecutable({ label: 'product', source: verified, stageRoot })
    ).rejects.toThrow(/rotated_before_stage/u);
  });

  it('stages launcher scripts at private paths without inherited fixed-FD execution', async () => {
    const parent = await mkdtemp('/tmp/actual-owner-source-stage-');
    roots.push(parent);
    const sourcePath = join(parent, 'cli-source');
    const stageRoot = join(parent, 'stage');
    await mkdir(stageRoot, { mode: 0o700 });
    const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(sourcePath, bytes, { mode: 0o500 });
    const stat = await lstat(sourcePath);
    const anchor = await stageActualOwnerSourceFile({
      executable: true,
      label: 'orchestrator-launcher',
      source: {
        device: String(stat.dev),
        gitBlob: '8'.repeat(40),
        inode: String(stat.ino),
        mode: stat.mode & 0o777,
        path: sourcePath,
        repositoryPath: 'cli-source',
        sha256,
        size: bytes.length,
        sourceCommit: 'b'.repeat(40),
      },
      stageRoot,
    });
    expect(anchor.path).not.toContain('/proc/self/fd/');
    await expect(assertActualOwnerAnchorPathIdentity(anchor)).resolves.toBeUndefined();
    await rm(anchor.path);
    await writeFile(anchor.path, bytes, { mode: 0o500 });
    await expect(assertActualOwnerAnchorPathIdentity(anchor)).rejects.toThrow(/anchor_rotated/u);
    await anchor.handle.close();
  });
});

async function productReleaseManifest(
  parent: string,
  sha256: string,
  size: number
): Promise<string> {
  const path = join(parent, `product-release-${sha256.slice(0, 8)}.json`);
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      release: { sourceCommit: 'd'.repeat(40) },
      workflow: { name: 'release' },
      assets: [{ binarySha256: sha256, binarySize: size }],
      actualOwnerContract: {
        repositoryPath: ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH,
        sha256: '9'.repeat(64),
        byteCount: 1545,
        gitBlob: '8'.repeat(40),
      },
      playwrightReleaseManifest: {
        byteCount: 1234,
        sha256: '7'.repeat(64),
      },
    })}\n`,
    { mode: 0o600 }
  );
  return path;
}
