import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';
import { getTeamsBasePath, setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const human = { reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e' } as const;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-meta-review-flow-'));
  setClaudeBasePathOverride(root);
  await fs.mkdir(path.join(getTeamsBasePath(), 'builders'), { recursive: true });
});
afterEach(async () => {
  setClaudeBasePathOverride(null);
  await fs.rm(root, { recursive: true, force: true });
});

const raw = async () =>
  JSON.parse(
    await fs.readFile(path.join(getTeamsBasePath(), 'builders', 'team.meta.json'), 'utf8')
  ) as Record<string, unknown>;

async function seed(extra: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(getTeamsBasePath(), 'builders', 'team.meta.json'),
    JSON.stringify({ version: 1, cwd: '/p', createdAt: 1, projectContextMode: 'per_project', ...extra })
  );
}

/**
 * The review flow of a per-project team lives next to fields that many writers rebuild from their
 * own view of the team. None of them may drop it, and "never saved" must stay distinct from
 * "follows the default".
 */
describe('TeamMetaStore review flow of a per-project team', () => {
  it('keeps "never saved" and "follows the default" apart', async () => {
    const store = new TeamMetaStore();
    await seed({});
    expect(await store.getMeta('builders')).not.toHaveProperty('reviewFlowSettings');
    await seed({ reviewFlowSettings: null });
    expect((await store.getMeta('builders'))?.reviewFlowSettings).toBeNull();
    await seed({ reviewFlowSettings: { reviewFlow: 'human_approval', reviewFlowPrompt: '  Run e2e ' } });
    expect((await store.getMeta('builders'))?.reviewFlowSettings).toEqual(human);
  });

  it('is kept by writers that do not state it, and changed only by one that does', async () => {
    const store = new TeamMetaStore();
    await seed({ reviewFlowSettings: human });
    // A full write built from a request (it does not know the field).
    await store.writeMeta('builders', { cwd: '/p', createdAt: 1, displayName: 'Builders' });
    expect((await raw()).reviewFlowSettings).toEqual(human);
    // An update that rebuilds the record without spreading the current one.
    await store.updateMeta('builders', () => ({ cwd: '/p', createdAt: 1, model: 'opus' }));
    expect(await raw()).toMatchObject({ reviewFlowSettings: human, model: 'opus' });
    expect(await raw()).not.toHaveProperty('displayName');
    // The usual update keeps it too, and an explicit null is saved as null.
    await store.updateMeta('builders', (current) => ({ ...current!, effort: 'high' }));
    expect((await raw()).reviewFlowSettings).toEqual(human);
    await store.updateMeta('builders', (current) => ({ ...current!, reviewFlowSettings: null }));
    expect(await raw()).toMatchObject({ reviewFlowSettings: null, projectContextMode: 'per_project' });
  });

  it('drops a saved value that is not a complete review flow, like any other invalid field', async () => {
    await seed({ reviewFlowSettings: { reviewFlow: 'everyone' } });
    expect((await new TeamMetaStore().getMeta('builders'))?.reviewFlowSettings).toBeUndefined();
  });
});
