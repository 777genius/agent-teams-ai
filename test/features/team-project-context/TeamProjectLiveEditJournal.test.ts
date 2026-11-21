import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamProjectLiveEditJournal } from '../../../src/features/team-project-context/main/TeamProjectLiveEditJournal';
import { getTeamsBasePath, setClaudeBasePathOverride } from '../../../src/main/utils/pathDecoder';

let root: string;
let marker: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-live-edit-'));
  setClaudeBasePathOverride(root);
  const team = path.join(getTeamsBasePath(), 'builders');
  await fs.mkdir(team, { recursive: true });
  marker = path.join(team, 'project-live-edit.pending');
});
afterEach(async () => {
  setClaudeBasePathOverride(null);
  await fs.rm(root, { recursive: true, force: true });
});

describe('project live edit journal', () => {
  it('persists an exclusive pending marker until explicitly cleared', async () => {
    const journal = new TeamProjectLiveEditJournal();
    expect(await journal.hasPending('builders')).toBe(false);
    await journal.begin('builders');
    expect(await new TeamProjectLiveEditJournal().hasPending('builders')).toBe(true);
    await expect(journal.begin('builders')).rejects.toMatchObject({ code: 'EEXIST' });
    await journal.clear('builders');
    expect(await journal.hasPending('builders')).toBe(false);
  });


  it('syncs both definitions and their directories before removing the marker', async () => {
    const logical = path.dirname(marker);
    const active = path.join(getTeamsBasePath(), 'ptc-a');
    await fs.mkdir(active);
    await fs.writeFile(path.join(logical, 'members.meta.json'), '{}');
    await fs.writeFile(path.join(active, 'members.meta.json'), '{}');
    await fs.writeFile(path.join(active, 'config.json'), '{}');
    const events: string[] = [];
    const syncFile = vi.fn(async (file: string, strict: boolean) => {
      expect(strict).toBe(true);
      expect(await fs.stat(marker)).toBeDefined();
      events.push(file);
    });
    const syncDir = vi.fn(async (dir: string) => { events.push(dir); });
    const journal = new TeamProjectLiveEditJournal(syncFile, syncDir);
    await journal.begin('builders');
    await journal.clear('builders', 'ptc-a');
    expect(events).toEqual([
      path.join(logical, 'members.meta.json'), logical,
      path.join(active, 'members.meta.json'), path.join(active, 'config.json'), active, logical,
    ]);
    expect(await journal.hasPending('builders')).toBe(false);
  });

  it('retains the marker if a file or directory durability barrier fails', async () => {
    const logical = path.dirname(marker);
    const active = path.join(getTeamsBasePath(), 'ptc-a');
    await fs.mkdir(active);
    await fs.writeFile(path.join(active, 'members.meta.json'), '{}');
    const journal = new TeamProjectLiveEditJournal(
      async () => { throw new Error('sync failed'); }, async () => {}
    );
    await journal.begin('builders');
    await expect(journal.clear('builders', 'ptc-a')).rejects.toThrow('sync failed');
    expect(await fs.stat(marker)).toBeDefined();
    const directoryFailure = new TeamProjectLiveEditJournal(async () => {}, async (dir) => {
      if (dir === logical) throw new Error('directory sync failed');
    });
    await expect(directoryFailure.clear('builders', 'ptc-a')).rejects.toThrow('directory sync failed');
    expect(await fs.stat(marker)).toBeDefined();
  });

  it('does not remove a corrupt or foreign marker and refuses unsafe team names', async () => {
    const journal = new TeamProjectLiveEditJournal();
    await fs.writeFile(marker, 'unexpected data');
    expect(await journal.hasPending('builders')).toBe(true);
    await expect(journal.clear('builders')).rejects.toThrow(/marker is unreadable/);
    expect(await fs.readFile(marker, 'utf8')).toBe('unexpected data');
    await expect(journal.begin('../outside')).rejects.toThrow(/Invalid team/);
  });
});
