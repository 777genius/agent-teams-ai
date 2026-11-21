import { ReviewFlowValidationError } from '@features/review-flow/core/application';
import { TeamKanbanReviewFlowGateway } from '@features/review-flow/main/adapters/output/TeamKanbanReviewFlowGateway';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewFlowTeamKind } from '@features/review-flow';
import type { ProjectTeamReviewFlowPorts } from '@features/review-flow/core/application';

const HUMAN = { reviewFlow: 'human_approval', reviewFlowPrompt: '' } as const;
let teamsDir: string;

beforeEach(() => {
  teamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-gateway-'));
});
afterEach(() => fs.rmSync(teamsDir, { recursive: true, force: true }));

function createGateway(kind: ReviewFlowTeamKind | Error = 'board') {
  const events: string[] = [];
  const writer = {
    setReviewFlowSettings: vi.fn(async (teamName: string) => {
      events.push(`board ${teamName}`);
    }),
  };
  const projectTeams = {
    kindOf: vi.fn(async () => {
      if (kind instanceof Error) throw kind;
      return kind;
    }),
    withTeamLock: vi.fn(async (teamName: string, operation: () => Promise<void>) => {
      events.push(`lock ${teamName}`);
      await operation();
      events.push(`unlock ${teamName}`);
    }),
    readProjectTeam: vi.fn(async () => {
      events.push('list');
      return {
        saved: undefined,
        projects: [
          { executionTeamName: 'ptc-a', projectPath: '/projects/a' },
          { executionTeamName: 'ptc-b', projectPath: '/projects/b' },
        ],
      };
    }),
    readTeamSetting: vi.fn(async () => undefined),
    saveTeamSetting: vi.fn(async (teamName: string) => {
      events.push(`team ${teamName}`);
    }),
  } satisfies ProjectTeamReviewFlowPorts;
  return {
    events,
    writer,
    projectTeams,
    gateway: new TeamKanbanReviewFlowGateway(writer, () => teamsDir, projectTeams),
  };
}

describe('TeamKanbanReviewFlowGateway', () => {
  it('writes the board of an ordinary team exactly as before', async () => {
    fs.mkdirSync(path.join(teamsDir, 'alpha'));
    fs.writeFileSync(path.join(teamsDir, 'alpha', 'config.json'), '{}');
    const { gateway, writer, projectTeams } = createGateway('board');
    await gateway.writeOverride('alpha', HUMAN);
    await gateway.writeOverride('alpha', null);
    expect(writer.setReviewFlowSettings.mock.calls).toEqual([
      ['alpha', HUMAN],
      ['alpha', null],
    ]);
    expect(projectTeams.withTeamLock).not.toHaveBeenCalled();
    expect(projectTeams.saveTeamSetting).not.toHaveBeenCalled();
  });

  it('refuses a deleted team instead of recreating its directory', async () => {
    const { gateway, writer } = createGateway('board');
    await expect(gateway.writeOverride('gone', HUMAN)).rejects.toBeInstanceOf(ReviewFlowValidationError);
    expect(writer.setReviewFlowSettings).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(teamsDir, 'gone'))).toBe(false);
  });

  it('saves a per-project team once and applies it to every project board inside the team lock', async () => {
    const { gateway, events } = createGateway('project-team');
    await gateway.writeOverride('builders', HUMAN);
    // Listed before anything is written; the team's setting before the boards; all under the lock.
    expect(events).toEqual([
      'lock builders',
      'list',
      'team builders',
      'board ptc-a',
      'board ptc-b',
      'unlock builders',
    ]);
  });

  it('keeps the team setting and the other boards when one board fails, and names that project', async () => {
    const { gateway, writer, projectTeams } = createGateway('project-team');
    writer.setReviewFlowSettings.mockImplementation(async (teamName: string) => {
      if (teamName === 'ptc-a') throw new Error('board lock timed out');
    });
    const saved = gateway.writeOverride('builders', null);
    await expect(saved).rejects.toThrow(/saved for the team.*\/projects\/a \(board lock timed out\)/);
    expect(projectTeams.saveTeamSetting).toHaveBeenCalledWith('builders', null);
    expect(writer.setReviewFlowSettings).toHaveBeenCalledWith('ptc-b', null);
  });

  it('writes nothing when the projects of the team cannot be listed', async () => {
    const { gateway, writer, projectTeams } = createGateway('project-team');
    projectTeams.readProjectTeam.mockRejectedValue(new Error('Team permanent deletion is in progress'));
    await expect(gateway.writeOverride('builders', HUMAN)).rejects.toThrow(/deletion is in progress/);
    expect(projectTeams.saveTeamSetting).not.toHaveBeenCalled();
    expect(writer.setReviewFlowSettings).not.toHaveBeenCalled();
  });

  it('refuses the project copy of a per-project team: its review flow is the team\'s', async () => {
    const { gateway, writer, projectTeams } = createGateway('project-copy');
    const refused = gateway.writeOverride('ptc-a', HUMAN);
    await expect(refused).rejects.toBeInstanceOf(ReviewFlowValidationError);
    await expect(refused).rejects.toThrow(/project copy/);
    expect(writer.setReviewFlowSettings).not.toHaveBeenCalled();
    expect(projectTeams.saveTeamSetting).not.toHaveBeenCalled();
  });

  it('fails closed when the kind of the team cannot be read', async () => {
    fs.mkdirSync(path.join(teamsDir, 'alpha'));
    fs.writeFileSync(path.join(teamsDir, 'alpha', 'config.json'), '{}');
    const { gateway, writer, projectTeams } = createGateway(new Error('Team metadata is unreadable'));
    const refused = gateway.writeOverride('alpha', HUMAN);
    await expect(refused).rejects.toBeInstanceOf(ReviewFlowValidationError);
    await expect(refused).rejects.toThrow(/unreadable/);
    expect(writer.setReviewFlowSettings).not.toHaveBeenCalled();
    expect(projectTeams.saveTeamSetting).not.toHaveBeenCalled();
  });

  it('rejects unsafe team names before touching the file system', async () => {
    const { gateway, writer, projectTeams } = createGateway('board');
    for (const name of ['../outside', 'a/b', '', '  ']) {
      await expect(gateway.writeOverride(name, HUMAN)).rejects.toBeInstanceOf(ReviewFlowValidationError);
    }
    expect(projectTeams.kindOf).not.toHaveBeenCalled();
    expect(writer.setReviewFlowSettings).not.toHaveBeenCalled();
  });
});
