import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KeyedMutex } from '@features/internal-storage/main';
import { TeamPermanentDeletionIdentity } from '@main/services/team/permanent-deletion/TeamPermanentDeletionIdentity';
import { TeamWorkSyncIdentityAccess } from '@main/services/team/permanent-deletion/TeamWorkSyncIdentityAccess';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('TeamWorkSyncIdentityAccess', () => {
  let root: string;
  let teamRoot: string;
  let priorIdentity: boolean;
  let deleting: boolean;
  let access: TeamWorkSyncIdentityAccess;
  let claim: ReturnType<typeof vi.fn>;
  let fence: KeyedMutex;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-identity-test-'));
    setClaudeBasePathOverride(root);
    teamRoot = join(getTeamsBasePath(), 'sandbox');
    await mkdir(teamRoot, { recursive: true });
    priorIdentity = false;
    deleting = false;
    fence = new KeyedMutex();
    const owner = new TeamPermanentDeletionIdentity(() => deleting);
    claim = vi.fn((teamName: string, identityId: string) =>
      owner.claimIdentityMarker(teamName, identityId, true)
    );
    access = new TeamWorkSyncIdentityAccess({
      withFence: (teamName, operation) => fence.run(teamName, operation),
      isFenced: async () => deleting,
      observePriorIdentity: async () => (priorIdentity ? 'known' : 'absent'),
      claimMarker: claim,
    });
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await rm(root, { recursive: true, force: true });
  });

  async function config(identityId?: string): Promise<void> {
    await writeFile(
      join(teamRoot, 'config.json'),
      JSON.stringify({
        name: 'sandbox',
        ...(identityId ? { _backupIdentityId: identityId } : {}),
      })
    );
  }

  it('read is non-mutating and two legacy adopters share the existing owner marker', async () => {
    await config();
    expect(await access.readCurrent('sandbox')).toEqual({
      status: 'unidentified',
      reason: 'missing_marker',
    });
    expect(claim).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      access.adoptLegacy('sandbox'),
      access.adoptLegacy('sandbox'),
    ]);
    expect(first).toEqual(second);
    expect(first.status).toBe('identified');
    expect(claim).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(await readFile(join(teamRoot, 'config.json'), 'utf8'));
    expect(first).toEqual({ status: 'identified', identityId: saved._backupIdentityId });
  });

  it('does not silently replace a lost identity known to the lifecycle owner', async () => {
    await config();
    priorIdentity = true;
    expect(await access.adoptLegacy('sandbox')).toEqual({
      status: 'unidentified',
      reason: 'identity_lost',
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('preserves logical identity across physical restore and refuses stale recreate writes', async () => {
    await config('original');
    await rename(teamRoot, `${teamRoot}.old`);
    await mkdir(teamRoot);
    await config('original');
    expect(await access.readCurrent('sandbox')).toEqual({
      status: 'identified',
      identityId: 'original',
    });
    await config('replacement');
    const commit = vi.fn(async () => 'committed');
    expect(await access.withCurrent('sandbox', 'original', commit)).toEqual({
      current: false,
      identity: { status: 'identified', identityId: 'replacement' },
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('distinguishes absent source from a present directory with invalid config', async () => {
    expect(await access.readCurrent('sandbox')).toEqual({
      status: 'unidentified',
      reason: 'invalid_config',
    });
    await writeFile(join(teamRoot, 'config.json'), '{');
    expect(await access.adoptLegacy('sandbox')).toEqual({
      status: 'unidentified',
      reason: 'invalid_config',
    });
    await rm(teamRoot, { recursive: true });
    expect(await access.readCurrent('sandbox')).toEqual({ status: 'absent' });
    expect(claim).not.toHaveBeenCalled();
  });

  it('does not adopt or commit while deletion owns the identity', async () => {
    await config('original');
    deleting = true;
    expect(await access.adoptLegacy('sandbox')).toEqual({ status: 'deleting' });
    const commit = vi.fn(async () => undefined);
    expect(await access.withCurrent('sandbox', 'original', commit)).toEqual({
      current: false,
      identity: { status: 'deleting' },
    });
    expect(commit).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('does not treat a config read failure as a missing marker', async () => {
    await mkdir(join(teamRoot, 'config.json'));
    expect(await access.adoptLegacy('sandbox')).toEqual({ status: 'unavailable' });
    expect(claim).not.toHaveBeenCalled();
  });

  it('returns unavailable when the existing owner cannot persist adoption', async () => {
    await config();
    claim.mockRejectedValueOnce(new Error('EIO'));
    expect(await access.adoptLegacy('sandbox')).toEqual({ status: 'unavailable' });
    expect(
      JSON.parse(await readFile(join(teamRoot, 'config.json'), 'utf8'))._backupIdentityId
    ).toBeUndefined();
  });

  it('returns the actual winning marker rather than a losing proposed UUID', async () => {
    await config();
    claim.mockImplementationOnce(async () => {
      await config('other-adopter');
      return { status: 'different', identityId: 'other-adopter' };
    });
    expect(await access.adoptLegacy('sandbox')).toEqual({
      status: 'identified',
      identityId: 'other-adopter',
    });
  });

  it('keeps the lifecycle fence while the authority callback is physically pending', async () => {
    await config('original');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = access.withCurrent('sandbox', 'original', async () => {
      entered();
      await pending;
      return 'written';
    });
    await started;
    const deletion = fence.run('sandbox', async () => {
      deleting = true;
    });
    await Promise.resolve();
    expect(deleting).toBe(false);
    release();
    expect(await commit).toEqual({ current: true, value: 'written' });
    await deletion;
    expect(deleting).toBe(true);
  });
});
