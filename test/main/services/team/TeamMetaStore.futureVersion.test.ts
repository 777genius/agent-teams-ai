import { TeamMetaStore, UnsupportedTeamMetaVersionError } from '@main/services/team/TeamMetaStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('TeamMetaStore future-version mutation safety', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'team-meta-future-version-'));
    setClaudeBasePathOverride(tempRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('fails closed for write, update, and delete mutations while preserving opaque bytes', async () => {
    const teamDir = path.join(tempRoot, 'teams', 'future-team');
    const metaPath = path.join(teamDir, 'team.meta.json');
    await fs.promises.mkdir(teamDir, { recursive: true });
    const opaqueBytes = '{"version":999,"cwd":"/safe","opaque":{"keep":"exact"}}\n';
    await fs.promises.writeFile(metaPath, opaqueBytes);
    const update = vi.fn(() => ({ cwd: '/replacement', createdAt: 2 }));
    const store = new TeamMetaStore();

    await expect(
      store.writeMeta('future-team', { cwd: '/replacement', createdAt: 2 })
    ).rejects.toBeInstanceOf(UnsupportedTeamMetaVersionError);
    await expect(store.updateMeta('future-team', update)).rejects.toBeInstanceOf(
      UnsupportedTeamMetaVersionError
    );
    await expect(store.deleteMeta('future-team')).rejects.toBeInstanceOf(
      UnsupportedTeamMetaVersionError
    );

    expect(update).not.toHaveBeenCalled();
    await expect(fs.promises.readFile(metaPath, 'utf8')).resolves.toBe(opaqueBytes);
  });

  it('preserves malformed existing JSON across write, update, and delete', async () => {
    const teamDir = path.join(tempRoot, 'teams', 'corrupt-team');
    const metaPath = path.join(teamDir, 'team.meta.json');
    const exact = '{"version":2,"cwd":\n';
    await fs.promises.mkdir(teamDir, { recursive: true });
    await fs.promises.writeFile(metaPath, exact);
    const update = vi.fn(() => ({ cwd: '/replacement', createdAt: 2 }));
    const store = new TeamMetaStore();

    await expect(
      store.writeMeta('corrupt-team', { cwd: '/replacement', createdAt: 2 })
    ).rejects.toThrow('Existing team metadata is malformed');
    await expect(store.updateMeta('corrupt-team', update)).rejects.toThrow(
      'Existing team metadata is malformed'
    );
    await expect(store.deleteMeta('corrupt-team')).rejects.toThrow(
      'Existing team metadata is malformed'
    );
    expect(update).not.toHaveBeenCalled();
    await expect(fs.promises.readFile(metaPath, 'utf8')).resolves.toBe(exact);
  });

  it('creates current metadata when the file is truly absent', async () => {
    const store = new TeamMetaStore();
    await store.writeMeta('new-team', { cwd: '/safe-test-project', createdAt: 1 });

    await expect(
      fs.promises.readFile(path.join(tempRoot, 'teams', 'new-team', 'team.meta.json'), 'utf8')
    ).resolves.toContain('"version": 2');
  });
});
