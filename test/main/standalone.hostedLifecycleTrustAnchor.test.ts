import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { readHostedLifecycleOrchestratorTrustAnchor } from '@main/standalone';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const key = 'a1'.repeat(32);
const runtimeInstance = createRuntimeInstanceContext({
  deploymentId: 'deployment_hosted-lifecycle-trust-anchor-test',
  bootId: 'boot_hosted-lifecycle-trust-anchor-test',
  claudeRoot: { kind: 'claude', reference: 'isolated:claude' },
  appDataRoot: { kind: 'app-data', reference: 'isolated:app-data' },
  workspaceRoots: [],
  tempRoot: { kind: 'temp', reference: 'isolated:temp' },
  logsRoot: { kind: 'logs', reference: 'isolated:logs' },
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('standalone hosted lifecycle trust anchor', () => {
  it('keeps inline marker-owned test configuration explicit and rejects ambiguous sources', () => {
    expect(
      readHostedLifecycleOrchestratorTrustAnchor(runtimeInstance, {
        HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR: key,
        HOSTED_LIFECYCLE_ORCHESTRATOR_TEST_ONLY_INLINE_TRUST_ANCHOR: '1',
      })
    ).toBe(key);
    expect(() =>
      readHostedLifecycleOrchestratorTrustAnchor(runtimeInstance, {
        HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR: key,
      })
    ).toThrow('orchestrator-lifecycle-owner-proof-key-inline-production-forbidden');
    expect(() =>
      readHostedLifecycleOrchestratorTrustAnchor(runtimeInstance, {
        HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR: key,
        HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE: '/run/secrets/anchor',
        HOSTED_LIFECYCLE_ORCHESTRATOR_TEST_ONLY_INLINE_TRUST_ANCHOR: '1',
      })
    ).toThrow('orchestrator-lifecycle-owner-proof-key-source-ambiguous');
  });

  const itLinux = process.platform === 'linux' ? it : it.skip;

  itLinux('descriptor-reads one immutable regular-file trust anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-trust-anchor-'));
    roots.push(root);
    const anchorPath = join(root, 'anchor');
    await writeFile(anchorPath, `${key}\n`, { mode: 0o400 });

    expect(
      readHostedLifecycleOrchestratorTrustAnchor(runtimeInstance, {
        HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE: anchorPath,
      })
    ).toBe(key);

    for (const unsafeMode of [0o600, 0o444, 0o040, 0o004]) {
      await chmod(anchorPath, unsafeMode);
      expect(() =>
        readHostedLifecycleOrchestratorTrustAnchor(runtimeInstance, {
          HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE: anchorPath,
        })
      ).toThrow('orchestrator-lifecycle-owner-proof-key-file-invalid');
    }
  });

  itLinux('rejects a symlinked trust-anchor path before opening it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-trust-anchor-link-'));
    roots.push(root);
    const targetPath = join(root, 'target');
    const anchorPath = join(root, 'anchor');
    await writeFile(targetPath, key, { mode: 0o400 });
    await symlink(targetPath, anchorPath);

    expect(() =>
      readHostedLifecycleOrchestratorTrustAnchor(runtimeInstance, {
        HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE: anchorPath,
      })
    ).toThrow();
  });
});
