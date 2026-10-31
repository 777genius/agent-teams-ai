import { CancelRuntimeRecoveries } from '@features/team-runtime-recovery/core/application';
import {
  JsonTeamRuntimeRecoveryRepository,
  TeamRuntimeRecoveryStorePaths,
} from '@features/team-runtime-recovery/main';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
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

  describe('no-op updates', () => {
    const NOW = '2026-10-30T10:00:00.000Z';

    function stateWithJob(teamName: string, status: 'pending' | 'completed') {
      return {
        schemaVersion: 1,
        teamName,
        jobs: [
          {
            id: 'job-1',
            status,
            signal: {
              id: 'signal-1',
              source: 'lead_stream',
              phase: 'terminal',
              observedAt: NOW,
              contextId: 'local',
              teamName,
              memberName: 'team-lead',
              targetKind: 'lead',
              detail: 'rate limited',
            },
            reasonCode: 'rate_limited',
            normalizedDetailHash: 'detail-hash',
            circuitKey: 'circuit-1',
            attempt: 0,
            nextAttemptAt: NOW,
            expiresAt: '2026-10-30T11:00:00.000Z',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        circuits: [],
        processedSignalIds: ['signal-1'],
        updatedAt: NOW,
      };
    }

    async function setUp(state?: ReturnType<typeof stateWithJob>) {
      const { root, paths, repository } = await createRepository();
      const teamDir = join(root, 'sandbox-team');
      await mkdir(teamDir, { recursive: true });
      await writeFile(join(teamDir, 'config.json'), '{"name":"sandbox-team"}\n', 'utf8');
      if (state) {
        await mkdir(paths.getTeamDir('sandbox-team'), { recursive: true });
        await writeFile(paths.getStatePath('sandbox-team'), JSON.stringify(state), 'utf8');
      }
      const cancel = new CancelRuntimeRecoveries({
        clock: { now: () => new Date('2026-10-30T10:05:00.000Z') },
        repository,
      });
      return { teamDir, paths, cancel };
    }

    async function fileIdentity(filePath: string) {
      const info = await stat(filePath);
      return { ino: info.ino, mtimeMs: info.mtimeMs, bytes: await readFile(filePath, 'utf8') };
    }

    it('creates no recovery directory, lock or state file when there is nothing to cancel', async () => {
      const { teamDir, cancel } = await setUp();

      await expect(
        cancel.execute({ teamName: 'sandbox-team', reason: 'team_stopped' })
      ).resolves.toBe(0);

      expect(await readdir(teamDir)).toEqual(['config.json']);
    });

    it('does not rewrite a state that has no cancellable job', async () => {
      const { paths, cancel } = await setUp(stateWithJob('sandbox-team', 'completed'));
      const before = await fileIdentity(paths.getStatePath('sandbox-team'));

      await expect(
        cancel.execute({ teamName: 'sandbox-team', reason: 'team_stopped' })
      ).resolves.toBe(0);

      expect(await fileIdentity(paths.getStatePath('sandbox-team'))).toEqual(before);
      expect(await readdir(paths.getTeamDir('sandbox-team'))).toEqual(['state.json']);
    });

    it('rechecks under the lock and writes nothing when the change is already gone', async () => {
      const { paths } = await setUp();
      const repository = new JsonTeamRuntimeRecoveryRepository(paths);
      let calls = 0;

      // The unlocked read saw something to change; by the time the lock is
      // held, another writer has already made the state what this update wants.
      await repository.update('sandbox-team', (state) => {
        calls += 1;
        return {
          state: calls === 1 ? { ...state, processedSignalIds: ['signal-1'] } : state,
          result: undefined,
        };
      });

      expect(calls).toBe(2);
      await expect(readFile(paths.getStatePath('sandbox-team'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('still persists a real cancellation', async () => {
      const { paths, cancel } = await setUp(stateWithJob('sandbox-team', 'pending'));

      await expect(
        cancel.execute({ teamName: 'sandbox-team', reason: 'team_stopped' })
      ).resolves.toBe(1);

      const persisted = JSON.parse(await readFile(paths.getStatePath('sandbox-team'), 'utf8'));
      expect(persisted.jobs).toEqual([
        expect.objectContaining({ id: 'job-1', status: 'cancelled', lastError: 'team_stopped' }),
      ]);
      expect(persisted.updatedAt).toBe('2026-10-30T10:05:00.000Z');
    });
  });

  it('rejects path traversal team names', async () => {
    const { repository } = await createRepository();
    await expect(repository.read('../escape')).rejects.toThrow(
      'Invalid team runtime recovery store path'
    );
  });
});
