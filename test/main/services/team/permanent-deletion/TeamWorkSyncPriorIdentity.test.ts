import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { observeTeamWorkSyncPriorIdentity } from '@main/services/team/permanent-deletion/TeamWorkSyncPriorIdentity';
import { setAppDataBasePath } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it } from 'vitest';

describe('observeTeamWorkSyncPriorIdentity', () => {
  let tempDir: string;

  afterEach(async () => {
    setAppDataBasePath(null);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not treat Object.prototype keys as an in-memory registry hit', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'work-sync-prior-identity-'));
    setAppDataBasePath(tempDir);
    await expect(
      observeTeamWorkSyncPriorIdentity('constructor', {
        isInitialized: () => true,
        isShuttingDown: () => false,
        registry: () => ({}),
      })
    ).resolves.toBe('absent');
  });
});
