import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseHostedOpenCodeRuntimeLock } from './hostedOpenCodeRuntimeLock';

describe('hosted OpenCode candidate lock', () => {
  it('accepts the externally materialized release lock and exact Linux x64 artifact', async () => {
    const raw = await readFile(resolve(process.cwd(), 'opencode-hosted-runtime.lock.json'), 'utf8');
    const lock = parseHostedOpenCodeRuntimeLock(JSON.parse(raw));

    expect(lock.productionEligible).toBe(false);
    expect(lock.source.repository).toBe(lock.releaseRepository);
    expect(lock.platforms['linux-x64']).toEqual({
      status: 'available',
      file: 'opencode-linux-x64.tar.gz',
      archiveKind: 'tar.gz',
      binaryName: 'opencode',
      archiveSha256: '86bb966110001cd3bb5b90b33cbb413f03f207c9a5e4a23241a8a23038464923',
      binarySha256: '7858adb4fdf140d7a3bc0a982e559418482333feb9b3d75389d25a0828a8a32d',
      assetUrl:
        'https://github.com/777genius/opencode-anomaly/releases/download/v1.18.4-agentteams.1/opencode-linux-x64.tar.gz',
    });
    expect(lock.platforms['win32-arm64']).toEqual({
      status: 'unavailable',
      reason: 'artifact_digests_pending',
    });
  });
});
