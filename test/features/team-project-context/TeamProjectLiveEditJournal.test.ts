import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('does not remove a corrupt or foreign marker and refuses unsafe team names', async () => {
    const journal = new TeamProjectLiveEditJournal();
    await fs.writeFile(marker, 'unexpected data');
    expect(await journal.hasPending('builders')).toBe(true);
    await expect(journal.clear('builders')).rejects.toThrow(/marker is unreadable/);
    expect(await fs.readFile(marker, 'utf8')).toBe('unexpected data');
    await expect(journal.begin('../outside')).rejects.toThrow(/Invalid team/);
  });
});
