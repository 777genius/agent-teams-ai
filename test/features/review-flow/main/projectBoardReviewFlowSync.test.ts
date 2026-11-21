import { createProjectBoardReviewFlowSync } from '@features/review-flow/main';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewFlowSettings } from '@features/review-flow';

const HUMAN: ReviewFlowSettings = { reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e' };
let teamsDir: string;

beforeEach(() => {
  teamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-sync-'));
});
afterEach(() => fs.rmSync(teamsDir, { recursive: true, force: true }));

function board(team: string, state: unknown): void {
  fs.mkdirSync(path.join(teamsDir, team), { recursive: true });
  fs.writeFileSync(path.join(teamsDir, team, 'kanban-state.json'), JSON.stringify(state));
}

function sync(saved: ReviewFlowSettings | null | undefined) {
  const writer = { setReviewFlowSettings: vi.fn(async () => undefined) };
  const run = createProjectBoardReviewFlowSync({
    teamWriter: writer,
    getTeamsDir: () => teamsDir,
    projectTeams: { readProjectTeam: vi.fn(async () => ({ saved, projects: [] })) },
  });
  return { writer, run: () => run('builders', 'ptc-a') };
}

describe('review flow of a project copy at launch', () => {
  it('leaves the board alone while the team never saved a setting (migration)', async () => {
    board('ptc-a', { teamName: 'ptc-a', reviewers: [], tasks: {}, reviewFlow: 'lead_then_human' });
    const { writer, run } = sync(undefined);
    await expect(run()).resolves.toBe(false);
    expect(writer.setReviewFlowSettings).not.toHaveBeenCalled();
  });

  it('copies the team setting into a new copy and into a board that differs', async () => {
    const fresh = sync(HUMAN);
    await expect(fresh.run()).resolves.toBe(true);
    expect(fresh.writer.setReviewFlowSettings).toHaveBeenCalledWith('ptc-a', HUMAN);

    board('ptc-a', { teamName: 'ptc-a', reviewers: [], tasks: {}, reviewFlow: 'agent_approval' });
    const stale = sync(HUMAN);
    await expect(stale.run()).resolves.toBe(true);
    expect(stale.writer.setReviewFlowSettings).toHaveBeenCalledWith('ptc-a', HUMAN);
  });

  it('does not rewrite a board that already carries the team setting', async () => {
    board('ptc-a', { teamName: 'ptc-a', reviewers: [], tasks: {}, ...HUMAN });
    const same = sync(HUMAN);
    await expect(same.run()).resolves.toBe(false);
    const followsDefault = sync(null);
    fs.rmSync(path.join(teamsDir, 'ptc-a'), { recursive: true });
    await expect(followsDefault.run()).resolves.toBe(false);
    expect(same.writer.setReviewFlowSettings).not.toHaveBeenCalled();
    expect(followsDefault.writer.setReviewFlowSettings).not.toHaveBeenCalled();
  });

  it('removes an override when the team follows the default, and repairs an unreadable one', async () => {
    board('ptc-a', { teamName: 'ptc-a', reviewers: [], tasks: {}, reviewFlow: 'agent_approval' });
    const cleared = sync(null);
    await expect(cleared.run()).resolves.toBe(true);
    expect(cleared.writer.setReviewFlowSettings).toHaveBeenCalledWith('ptc-a', null);

    board('ptc-a', { teamName: 'ptc-a', reviewers: [], tasks: {}, reviewFlowPrompt: 'orphan' });
    const repaired = sync(HUMAN);
    await expect(repaired.run()).resolves.toBe(true);
    expect(repaired.writer.setReviewFlowSettings).toHaveBeenCalledWith('ptc-a', HUMAN);
  });
});
