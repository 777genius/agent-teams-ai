import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseHostedOpenCodeRuntimeLock } from './hostedOpenCodeRuntimeLock';

describe('hosted OpenCode official runtime lock', () => {
  it('accepts the official release lock and exact Linux x64 artifact', async () => {
    const raw = await readFile(resolve(process.cwd(), 'opencode-hosted-runtime.lock.json'), 'utf8');
    const lock = parseHostedOpenCodeRuntimeLock(JSON.parse(raw));

    expect(lock.productionEligible).toBe(true);
    expect(lock.releaseRepository).toBe('anomalyco/opencode');
    expect(lock.source.commit).toBe('545f51d26cc39a907d2867492d498d9607ea5fa4');
    expect(lock.source.repository).toBe(lock.releaseRepository);
    expect(lock.platforms['linux-x64']).toEqual({
      status: 'available',
      file: 'opencode-linux-x64.tar.gz',
      archiveKind: 'tar.gz',
      binaryName: 'opencode',
      archiveSha256: '3046e0404fdc60fb80307e7a47824ba07477364178a4d09baa8548496dd6d43b',
      binarySha256: '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080',
      assetUrl:
        'https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-linux-x64.tar.gz',
    });
    expect(lock.platforms['win32-arm64'].status).toBe('available');
  });
});
