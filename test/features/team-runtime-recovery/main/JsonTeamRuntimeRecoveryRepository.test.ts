import {
  JsonTeamRuntimeRecoveryRepository,
  TeamRuntimeRecoveryStorePaths,
} from '@features/team-runtime-recovery/main';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

describe('JsonTeamRuntimeRecoveryRepository', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRepository() {
    const root = await mkdtemp(join(tmpdir(), 'runtime-recovery-'));
    roots.push(root);
    const paths = new TeamRuntimeRecoveryStorePaths(root);
    return { root, paths, repository: new JsonTeamRuntimeRecoveryRepository(paths) };
  }

  it('persists updates across repository instances', async () => {
    const { paths, repository } = await createRepository();
    await repository.update('sandbox-team', (state) => ({
      state: { ...state, processedSignalIds: ['signal-1'], updatedAt: new Date().toISOString() },
      result: undefined,
    }));

    const restarted = new JsonTeamRuntimeRecoveryRepository(paths);
    expect((await restarted.read('sandbox-team')).processedSignalIds).toEqual(['signal-1']);
  });

  it('serializes concurrent writers under a file lock', async () => {
    const { repository } = await createRepository();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.update('sandbox-team', (state) => ({
          state: {
            ...state,
            processedSignalIds: [...state.processedSignalIds, `signal-${index}`],
            updatedAt: new Date().toISOString(),
          },
          result: undefined,
        }))
      )
    );

    expect(new Set((await repository.read('sandbox-team')).processedSignalIds).size).toBe(20);
  });

  it('quarantines corrupt state and starts from an empty schema', async () => {
    const { paths, repository } = await createRepository();
    await mkdir(paths.getTeamDir('sandbox-team'), { recursive: true });
    await writeFile(paths.getStatePath('sandbox-team'), '{not-json', 'utf8');

    expect((await repository.read('sandbox-team')).jobs).toEqual([]);
    const files = await readdir(paths.getTeamDir('sandbox-team'));
    expect(files.some((file) => file.startsWith('state.json.invalid.'))).toBe(true);
  });

  it('quarantines syntactically valid state with invalid job semantics', async () => {
    const { paths, repository } = await createRepository();
    await mkdir(paths.getTeamDir('sandbox-team'), { recursive: true });
    await writeFile(
      paths.getStatePath('sandbox-team'),
      JSON.stringify({
        schemaVersion: 1,
        teamName: 'sandbox-team',
        jobs: [
          {
            id: 'broken-job',
            status: 'pending',
            signal: { teamName: 'sandbox-team' },
            nextAttemptAt: 'not-a-date',
          },
        ],
        circuits: [],
        processedSignalIds: [],
        updatedAt: new Date().toISOString(),
      }),
      'utf8'
    );

    expect((await repository.read('sandbox-team')).jobs).toEqual([]);
    const files = await readdir(paths.getTeamDir('sandbox-team'));
    expect(files.some((file) => file.startsWith('state.json.invalid.'))).toBe(true);
  });

  it('rejects path traversal team names', async () => {
    const { repository } = await createRepository();
    await expect(repository.read('../escape')).rejects.toThrow(
      'Invalid team runtime recovery store path'
    );
  });
});
