import { scanTeamReviewFlowOverrides } from '@features/review-flow/main/infrastructure/scanTeamReviewFlowOverrides';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;

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

    expect(await scanTeamReviewFlowOverrides(root)).toEqual({
      overrides: { custom: { reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e' } },
      // Invalid review-flow fields are repairable; plain broken JSON is a wider problem.
      unreadable: ['bad-flow', 'orphan-prompt'],
    });
  });

  it('returns nothing when the teams directory does not exist', async () => {
    expect(await scanTeamReviewFlowOverrides(path.join(root, 'missing'))).toEqual({
      overrides: {},
      unreadable: [],
    });
  });
});
