import { ReviewFlowValidationError } from '@features/review-flow/core/application';
import { TeamKanbanReviewFlowGateway } from '@features/review-flow/main/adapters/output/TeamKanbanReviewFlowGateway';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HUMAN = { reviewFlow: 'human_approval', reviewFlowPrompt: '' } as const;
let teamsDir: string;

beforeEach(() => {
  teamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-gateway-'));
});
afterEach(() => fs.rmSync(teamsDir, { recursive: true, force: true }));

function createGateway() {
  const writer = { setReviewFlowSettings: vi.fn(async () => undefined) };
  return { writer, gateway: new TeamKanbanReviewFlowGateway(writer, () => teamsDir) };
}

describe('TeamKanbanReviewFlowGateway', () => {
  it('writes through the team writer only for an existing team', async () => {
    fs.mkdirSync(path.join(teamsDir, 'alpha'));
    fs.writeFileSync(path.join(teamsDir, 'alpha', 'config.json'), '{}');
    const { gateway, writer } = createGateway();
    await gateway.writeOverride('alpha', HUMAN);
    await gateway.writeOverride('alpha', null);
    expect(writer.setReviewFlowSettings.mock.calls).toEqual([
      ['alpha', HUMAN],
      ['alpha', null],
    ]);
  });

  it('refuses a deleted team instead of recreating its directory', async () => {
    const { gateway, writer } = createGateway();
    await expect(gateway.writeOverride('gone', HUMAN)).rejects.toBeInstanceOf(ReviewFlowValidationError);
    expect(writer.setReviewFlowSettings).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(teamsDir, 'gone'))).toBe(false);
  });

  it('refuses a per-project team (no board of its own) and says where its review flow lives', async () => {
    fs.mkdirSync(path.join(teamsDir, 'builders'));
    fs.writeFileSync(
      path.join(teamsDir, 'builders', 'team.meta.json'),
      JSON.stringify({ version: 1, createdAt: 1, cwd: '', projectContextMode: 'per_project' })
    );
    const { gateway, writer } = createGateway();
    const refused = gateway.writeOverride('builders', HUMAN);
    await expect(refused).rejects.toBeInstanceOf(ReviewFlowValidationError);
    await expect(refused).rejects.toThrow(/separate history per project/);
    expect(writer.setReviewFlowSettings).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(teamsDir, 'builders', 'kanban-state.json'))).toBe(false);
  });

  it('rejects unsafe team names before touching the file system', async () => {
    const { gateway, writer } = createGateway();
    for (const name of ['../outside', 'a/b', '', '  ']) {
      await expect(gateway.writeOverride(name, HUMAN)).rejects.toBeInstanceOf(ReviewFlowValidationError);
    }
    expect(writer.setReviewFlowSettings).not.toHaveBeenCalled();
  });
});
