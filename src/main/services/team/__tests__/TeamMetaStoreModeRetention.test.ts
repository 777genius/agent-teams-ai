import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamMetaStore } from '../TeamMetaStore';

const roots: string[] = [];
async function makeFixture(): Promise<{ teamDir: string; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-mode-retention-'));
  roots.push(root);
  const teamDir = path.join(root, 'teams', 'alpha');
  await fs.mkdir(teamDir, { recursive: true });
  setClaudeBasePathOverride(root);
  return { teamDir, root };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setClaudeBasePathOverride(null);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('TeamMetaStore project history mode retention', () => {
  it('keeps explicit mode when a later metadata write omits the field', async () => {
    const { teamDir } = await makeFixture();
    const store = new TeamMetaStore();
    await store.writeMeta('alpha', {
      cwd: '/sandbox/a', createdAt: 1, projectContextMode: 'per_project',
    });
    await store.writeMeta('alpha', { cwd: '/sandbox/b', createdAt: 1 });
    const persisted = JSON.parse(await fs.readFile(path.join(teamDir, 'team.meta.json'), 'utf8'));
    expect(persisted).toMatchObject({ cwd: '/sandbox/b', projectContextMode: 'per_project' });
  });

  it('does not erase an existing file if its read times out or returns null', async () => {
    const { teamDir } = await makeFixture();
    const metadataPath = path.join(teamDir, 'team.meta.json');
    const original = '{"version":1,"cwd":"/sandbox/a","projectContextMode":"per_project"}';
    await fs.writeFile(metadataPath, original);
    const store = new TeamMetaStore();
    vi.spyOn(store, 'getMeta').mockResolvedValue(null);
    await expect(store.writeMeta('alpha', { cwd: '/sandbox/b', createdAt: 1 }))
      .rejects.toThrow('refusing to overwrite');
    await expect(store.updateMeta('alpha', (current) => ({
      cwd: '/sandbox/c', createdAt: current?.createdAt ?? 1,
    }))).rejects.toThrow('refusing to overwrite');
    expect(await fs.readFile(metadataPath, 'utf8')).toBe(original);
  });

  it('still allows creating fresh metadata when no prior file exists', async () => {
    const { teamDir } = await makeFixture();
    const store = new TeamMetaStore();
    await store.writeMeta('alpha', { cwd: '/sandbox/new', createdAt: 1 });
    const saved = JSON.parse(await fs.readFile(path.join(teamDir, 'team.meta.json'), 'utf8'));
    expect(saved.cwd).toBe('/sandbox/new');
    expect(Object.hasOwn(saved, 'projectContextMode')).toBe(false);
  });
});
