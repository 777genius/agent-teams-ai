import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { resolveRuntimeProviderStatusCheck } from '@main/services/runtime/providerStatusCheckContract';
import { describe, expect, it } from 'vitest';

/** The finite peer must satisfy Main's actual wire validator without granting real-provider authority. */
describe('finite legacy provider status wire', () => {
  it.each([true, false])('passes the original Main validator with summary=%s', async (summary) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
    try {
      for (const name of ['home', 'tmp', 'claude', 'workspace']) {
        await mkdir(join(root, name), { mode: 0o700 });
      }
      const result = spawnSync(process.execPath, [
        resolve('tools/owned-process-broker/fixtures/legacyBootstrapPeer.mjs'),
        'runtime', 'status', '--json', '--provider', 'anthropic', ...(summary ? ['--summary'] : []),
      ], {
        cwd: join(root, 'workspace'), encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024,
        env: {
          HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
          CLAUDE_ROOT: join(root, 'claude'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
          PATH: dirname(process.execPath), TEST_LEGACY_BOOTSTRAP: 'current-solo-v1',
          TEST_LEGACY_BOOTSTRAP_ROOT: root, TEST_LEGACY_BOOTSTRAP_REPO: root,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const response = JSON.parse(result.stdout) as { providers: { anthropic: Record<string, unknown> } };
      expect(resolveRuntimeProviderStatusCheck(response.providers.anthropic, 'anthropic')).toEqual({
        statusCheckOutcome: 'authoritative', statusCheckErrorCode: undefined,
      });
      // The production refusal remains intact for a partial response from this same peer.
      const partial = { ...response.providers.anthropic };
      delete partial.backend;
      expect(resolveRuntimeProviderStatusCheck(partial, 'anthropic')).toEqual({
        statusCheckOutcome: 'pending', statusCheckErrorCode: 'partial_response',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
