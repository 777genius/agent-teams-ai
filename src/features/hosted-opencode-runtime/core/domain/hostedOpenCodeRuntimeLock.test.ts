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
      archiveSha256: 'f9f9418a8072a8fb8f8ed9dbd4cb8700add070d20faa93a9d660b5b295d16de5',
      binarySha256: '033c9c6f4f73e6d84a10c6edc3ab84e5aad078bf5c75f005721e1e94e85b8a02',
      assetUrl:
        'https://github.com/777genius/opencode-anomaly/releases/download/v1.18.4-agentteams.1/opencode-linux-x64.tar.gz',
    });
    expect(lock.platforms['win32-arm64']).toEqual({
      status: 'unavailable',
      reason: 'artifact_digests_pending',
    });
  });
});
