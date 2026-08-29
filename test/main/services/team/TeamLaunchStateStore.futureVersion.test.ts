import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import {
  TeamLaunchStateStore,
  UnsupportedTeamLaunchStateVersionError,
} from '@main/services/team/TeamLaunchStateStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('TeamLaunchStateStore future-version mutation safety', () => {
  let tempRoot: string;
  let statePath: string;

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'launch-state-future-version-'));
    setClaudeBasePathOverride(tempRoot);
    const teamDir = path.join(tempRoot, 'teams', 'future-team');
    statePath = path.join(teamDir, 'launch-state.json');
    await fs.promises.mkdir(teamDir, { recursive: true });
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('rejects reads, writes, and clears without changing opaque future bytes', async () => {
    const exact = '{"version":999,"teamName":"future-team","opaque":{"keep":true}}\n';
    await fs.promises.writeFile(statePath, exact);
    const store = new TeamLaunchStateStore();
    const replacement = createPersistedLaunchSnapshot({
      teamName: 'future-team',
      expectedMembers: [],
      launchPhase: 'active',
      members: {},
      updatedAt: '2026-08-25T00:00:00.000Z',
    });

    await expect(store.read('future-team')).rejects.toBeInstanceOf(
      UnsupportedTeamLaunchStateVersionError
    );
    await expect(store.write('future-team', replacement)).rejects.toBeInstanceOf(
      UnsupportedTeamLaunchStateVersionError
    );
    await expect(store.clear('future-team')).rejects.toBeInstanceOf(
      UnsupportedTeamLaunchStateVersionError
    );
    await expect(fs.promises.readFile(statePath, 'utf8')).resolves.toBe(exact);
  });

  it('rejects writes and clears without changing malformed existing bytes', async () => {
    const exact = '{"version":3,"teamName":\n';
    await fs.promises.writeFile(statePath, exact);
    const store = new TeamLaunchStateStore();
    const replacement = createPersistedLaunchSnapshot({
      teamName: 'future-team',
      expectedMembers: [],
      launchPhase: 'active',
      members: {},
      updatedAt: '2026-08-25T00:00:00.000Z',
    });

    await expect(store.write('future-team', replacement)).rejects.toThrow(
      'Existing launch-state metadata is malformed'
    );
    await expect(store.clear('future-team')).rejects.toThrow(
      'Existing launch-state metadata is malformed'
    );
    await expect(fs.promises.readFile(statePath, 'utf8')).resolves.toBe(exact);
  });
});
