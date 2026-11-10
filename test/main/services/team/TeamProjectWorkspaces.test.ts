import {
  listTeamProjectWorkspaces,
  readTeamProjectWorkspace,
} from '@main/services/team/TeamProjectWorkspaces';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

const teamsBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'team-project-workspaces-'));

afterAll(() => {
  fs.rmSync(teamsBasePath, { recursive: true, force: true });
});

function writeTeam(teamName: string, config: unknown): void {
  fs.mkdirSync(path.join(teamsBasePath, teamName), { recursive: true });
  fs.writeFileSync(
    path.join(teamsBasePath, teamName, 'config.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
    'utf8'
  );
}

describe('readTeamProjectWorkspace', () => {
  it('reads the project path a team was launched against', async () => {
    writeTeam('alpha', { projectPath: 'C:\\workspaces\\alpha', displayName: 'Alpha' });

    await expect(readTeamProjectWorkspace(teamsBasePath, 'alpha')).resolves.toBe(
      'C:\\workspaces\\alpha'
    );
  });

  /**
   * Every "cannot read" is the same answer, and it is `null` rather than a
   * guess: the callers use this to decide whether they may kill a process, so
   * an absent answer has to stay absent all the way up.
   */
  it.each([
    ['a team that does not exist', null],
    ['a config that is not JSON', 'not json at all'],
    ['a config with no project path', { displayName: 'no path here' }],
    ['a project path that is only whitespace', { projectPath: '   ' }],
    ['a project path that is not a string', { projectPath: 42 }],
  ])('answers null for %s', async (label, config) => {
    const teamName = `unreadable-${label.replace(/\W+/g, '-')}`;
    if (config !== null) writeTeam(teamName, config);

    await expect(readTeamProjectWorkspace(teamsBasePath, teamName)).resolves.toBeNull();
  });

  it('trims the stored path rather than returning it padded', async () => {
    writeTeam('padded', { projectPath: '  C:\\workspaces\\padded  ' });

    await expect(readTeamProjectWorkspace(teamsBasePath, 'padded')).resolves.toBe(
      'C:\\workspaces\\padded'
    );
  });
});

describe('listTeamProjectWorkspaces', () => {
  it('lists every readable workspace once and skips the teams it cannot read', async () => {
    const listedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'team-project-workspaces-list-'));
    for (const [teamName, config] of [
      ['one', { projectPath: 'C:\\workspaces\\shared' }],
      // Same directory as `one`: one workspace, not two.
      ['two', { projectPath: 'C:\\workspaces\\shared' }],
      ['three', { projectPath: 'C:\\workspaces\\other' }],
      ['broken', 'not json'],
      ['pathless', { displayName: 'no path' }],
    ] as const) {
      fs.mkdirSync(path.join(listedBase, teamName), { recursive: true });
      fs.writeFileSync(
        path.join(listedBase, teamName, 'config.json'),
        typeof config === 'string' ? config : JSON.stringify(config),
        'utf8'
      );
    }
    // A loose file beside the team directories is not a team.
    fs.writeFileSync(path.join(listedBase, 'index.json'), '{}', 'utf8');

    const workspaces = await listTeamProjectWorkspaces(listedBase);

    expect([...workspaces].sort()).toEqual(['C:\\workspaces\\other', 'C:\\workspaces\\shared']);
    fs.rmSync(listedBase, { recursive: true, force: true });
  });

  /**
   * The fail-safe direction for the whole list. A teams directory this app
   * cannot read yields no workspace at all, which its callers must read as
   * "prove nothing, touch nothing" - never as "no filter".
   */
  it('answers an empty list when the teams directory cannot be read', async () => {
    await expect(
      listTeamProjectWorkspaces(path.join(teamsBasePath, 'does-not-exist'))
    ).resolves.toEqual([]);
  });
});
