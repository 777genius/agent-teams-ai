// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import lock from '../../legacy-host.lock.json';
import { stageNode } from '../../scripts/legacy-agent-host/stage-node';

const roots: string[] = [];
const platform = 'darwin-arm64';

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'TEST-legacy-host-node-stage-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('selected standalone Node artifact integrity', () => {
  it('refuses a corrupted cached archive without downloading or extracting it', async () => {
    const root = await sandbox();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected download'));
    const cache = join(root, 'cache');
    await mkdir(cache);
    await writeFile(join(cache, lock.platforms[platform].archive), 'corrupt archive');

    await expect(stageNode(platform, join(root, 'resources'), cache)).rejects.toThrow(
      'Cached Node checksum mismatch'
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses changed staged executable bytes rather than trusting manifest metadata', async () => {
    const root = await sandbox();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected download'));
    const resources = join(root, 'resources');
    const folder = join(resources, 'node', `v${lock.nodeVersion}`, platform);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'node'), 'changed executable');
    await writeFile(
      join(folder, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        platform,
        version: lock.nodeVersion,
        executable: 'node',
        archiveSha256: lock.platforms[platform].sha256,
        binarySha256: '0'.repeat(64),
      })
    );

    await expect(stageNode(platform, resources, join(root, 'cache'))).rejects.toThrow(
      'Existing staged Node differs from selected profile'
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
