// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileTeamModelProbeIntents } from '../../../src/features/agent-backend/main/infrastructure/FileTeamModelProbeIntents';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const rootId = 'team-preflight-TEST-root';
describe('immutable Main model intent routing', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'TEST-team-model-intents-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const folder = (directory: string) => join(directory, digest(rootId));
  const alias = (directory: string, id: string) =>
    join(folder(directory), `preparation-${digest(id)}.json`);

  it('preserves every preparation ID across newer checks and cold store instances', async () => {
    const first = new FileTeamModelProbeIntents(directory);
    expect(await first.read(rootId, 'TEST-A')).toEqual({ commandId: rootId, retained: false });
    expect(await first.admit(rootId, 'TEST-A', rootId, false)).toBe(rootId);
    const second = await first.admit(rootId, 'TEST-B', rootId, true);
    expect(second).not.toBe(rootId);
    expect(await first.read(rootId, 'TEST-C')).toEqual({ commandId: second, retained: false });
    expect(await first.admit(rootId, 'TEST-C', second, false)).toBe(second);
    const third = await first.admit(rootId, 'TEST-D', second, true);
    const cold = new FileTeamModelProbeIntents(directory);
    for (const [preparation, commandId] of [
      ['TEST-A', rootId],
      ['TEST-B', second],
      ['TEST-C', second],
      ['TEST-D', third],
    ])
      expect(await cold.read(rootId, preparation!)).toEqual({ commandId, retained: true });
    expect(await cold.admit(rootId, 'TEST-A', third, true)).toBe(rootId);
    expect(await readdir(folder(directory))).toHaveLength(6);
    const record = JSON.parse(await readFile(alias(directory, 'TEST-B'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(record).sort()).toEqual([
      'commandId',
      'digest',
      'key',
      'kind',
      'rootId',
      'schemaVersion',
    ]);
  });

  it('concurrent Main instances publish one successor and retain one ID for each requesting preparation', async () => {
    const stores = Array.from({ length: 12 }, () => new FileTeamModelProbeIntents(directory));
    const ids = await Promise.all(
      stores.map((store, index) => store.admit(rootId, `TEST-${index % 2}`, rootId, true))
    );
    expect(new Set(ids).size).toBe(1);
    expect(await readdir(folder(directory))).toHaveLength(3);
    expect(await stores[0]!.read(rootId, 'TEST-0')).toEqual({ commandId: ids[0], retained: true });
    expect(await stores[1]!.read(rootId, 'TEST-1')).toEqual({ commandId: ids[0], retained: true });
  });

  it('refuses a corrupt retained ID and never treats a corrupt association as absence', async () => {
    const store = new FileTeamModelProbeIntents(directory);
    await store.admit(rootId, 'TEST-A', rootId, false);
    const path = alias(directory, 'TEST-A');
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...value, commandId: 'TEST-corrupt-replacement' }), {
      mode: 0o600,
    });
    await expect(store.read(rootId, 'TEST-A')).rejects.toThrow('unavailable');
    await expect(store.admit(rootId, 'TEST-A', rootId, true)).rejects.toThrow('unavailable');
  });

  it('refuses symlinked records and invalid application IDs', async () => {
    const store = new FileTeamModelProbeIntents(directory);
    await store.admit(rootId, 'TEST-A', rootId, false);
    const path = alias(directory, 'TEST-A');
    const target = join(directory, 'TEST-symlink-target.json');
    await writeFile(target, await readFile(path), { mode: 0o600 });
    await unlink(path);
    await symlink(target, path);
    await expect(store.read(rootId, 'TEST-A')).rejects.toThrow('unavailable');
    await expect(store.read(rootId, '../outside')).rejects.toThrow('Invalid model intent');
  });
});
