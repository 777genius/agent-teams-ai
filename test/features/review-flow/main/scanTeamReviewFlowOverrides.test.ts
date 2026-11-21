import { scanTeamReviewFlowOverrides } from '@features/review-flow/main/infrastructure/scanTeamReviewFlowOverrides';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReviewFlowSettings } from '@features/review-flow';

let root: string;
const noTeamSettings = async (): Promise<undefined> => undefined;

function writeState(team: string, content: unknown): void {
  fs.mkdirSync(path.join(root, team), { recursive: true });
  fs.writeFileSync(
    path.join(root, team, 'kanban-state.json'),
    typeof content === 'string' ? content : JSON.stringify(content)
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-scan-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('scanTeamReviewFlowOverrides', () => {
  it('lists teams with their own flow and flags the ones with invalid review-flow fields', async () => {
    writeState('custom', { reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e', tasks: {} });
    writeState('follows-default', { teamName: 'follows-default', tasks: {} });
    writeState('broken', '{not json');
    writeState('bad-flow', { reviewFlow: 'everyone', tasks: {} });
    writeState('orphan-prompt', { reviewFlowPrompt: 'no flow', tasks: {} });
    fs.mkdirSync(path.join(root, 'no-state'));
    fs.writeFileSync(path.join(root, 'stray-file.txt'), 'x');

    expect(await scanTeamReviewFlowOverrides(root, noTeamSettings)).toEqual({
      overrides: { custom: { reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e' } },
      // Invalid review-flow fields are repairable; plain broken JSON is a wider problem.
      unreadable: ['bad-flow', 'orphan-prompt'],
      projectTeams: {},
    });
  });

  it('adds each per-project team with what it saved and its projects, and skips unreadable ones', async () => {
    for (const team of ['saved', 'follows-default', 'never-saved', 'ordinary', 'unreadable-meta']) {
      fs.mkdirSync(path.join(root, team));
    }
    const lead: ReviewFlowSettings = { reviewFlow: 'lead_then_human', reviewFlowPrompt: '' };
    const projects = [{ executionTeamName: 'ptc-a', projectPath: '/p/a' }];
    const scan = await scanTeamReviewFlowOverrides(root, async (team) => {
      if (team === 'unreadable-meta') throw new Error('Team metadata is unreadable');
      if (team === 'ordinary') return undefined;
      return { saved: { saved: lead, 'follows-default': null }[team], projects };
    });
    expect(scan.projectTeams).toEqual({
      saved: { saved: true, settings: lead, projects },
      'follows-default': { saved: true, settings: null, projects },
      'never-saved': { saved: false, settings: null, projects },
    });
  });

  it('returns nothing when the teams directory does not exist', async () => {
    expect(await scanTeamReviewFlowOverrides(path.join(root, 'missing'), noTeamSettings)).toEqual({
      overrides: {},
      unreadable: [],
      projectTeams: {},
    });
  });
});
