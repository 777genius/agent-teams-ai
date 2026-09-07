import { constants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { createHostedDraftPublicationFeature } from '@features/team-lifecycle/main/composition';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamDraftPublication, TeamIdentityPublicationGateway } from '@features/internal-storage/contracts';

// Spy on the same concrete object the publisher uses, including when its module was cached.
// A replacement node:fs/promises module does not rebind previously captured host methods.
const actualOpen = fs.open;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  vi.spyOn(fs, 'open').mockImplementation(actualOpen);
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'draft-effect-authority-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const claudeRoot = path.join(root, 'claude');
  await fs.mkdir(claudeRoot, { mode: 0o700 });
  await fs.mkdir(path.join(claudeRoot, 'teams'), { mode: 0o700 });
  const core = new InternalStorageWorkerCore({ databasePath: path.join(root, 'app.db'),
    createDatabase: (file, options) => new Database(file, options) });
  cleanup.push(async () => { core.close(); });
  const identities: TeamIdentityPublicationGateway = {
    listTeamIdentities: async () => core.handle('teamIdentity.list', {}) as never,
    getTeamIdentity: async (teamId) => core.handle('teamIdentity.get', { teamId }) as never,
    reserveTeamIdentity: async (input) => core.handle('teamIdentity.reserve', input) as never,
    prepareReservedTeamAdoption: async (input) => core.handle('teamIdentity.prepareReserved', input) as never,
    recordTeamIdentityFilePublished: async (input) => core.handle('teamIdentity.recordPublished', input) as never,
    commitTeamAdoption: async (input) => core.handle('teamIdentity.commitAdoption', input) as never,
    tombstoneTeamIdentity: async (input) => core.handle('teamIdentity.tombstone', input) as never,
  };
  const binding = { actorId: 'actor_effect-fixture', deploymentId: 'deployment_effect-fixture',
    runtimeWorkspaceId: `workspace_${'b'.repeat(32)}`, bindingGeneration: 1 };
  const workspaceId = `workspace_${'a'.repeat(32)}`;
  const created = core.handle('hostedTeamConfiguration.create', {
    workspaceId, idempotencyKey: 'idempotency_effect-fixture', payloadHash: 'c'.repeat(64),
    metadata: { name: 'Fixture' }, members: [{ name: 'lead' }], publicationBinding: binding,
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  } as never) as { teamId: string };
  const scope = { workspaceId, teamId: created.teamId, actorId: binding.actorId, deploymentId: binding.deploymentId };
  const load = () => core.handle('draftPublication.read', scope as never) as TeamDraftPublication;
  const publisher = await createHostedDraftPublicationFeature({ claudeRoot, identities });
  cleanup.push(() => publisher.dispose());
  const attempt = (assertCurrent: () => Promise<void>) => publisher.publishDraft({
    publication: load(), assertCurrent,
    recordDirectory: async (directoryFingerprint) => {
      core.handle('draftPublication.settle', { ...scope, operationId: load().operationId,
        directoryFingerprint, state: 'pending', deadlineAtMs: Number.MAX_SAFE_INTEGER } as never);
    },
  });
  return { root, load, attempt, identities, directory: path.join(claudeRoot, 'teams', load().legacyKey) };
}

describe.skipIf(process.platform !== 'linux')('concrete publication effect authority', () => {
  it('rechecks authority between exclusive file creation and writing its bytes', async () => {
    const f = await fixture();
    let revoked = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0) revoked = true;
      return handle;
    });
    const result = await f.attempt(async () => { if (revoked) throw new Error('request-revoked'); });
    expect(revoked).toBe(true); // Prove the interceptor reached the concrete effect boundary.
    expect(result).toEqual({ kind: 'recovery_required' });
    expect(await fs.readFile(path.join(f.directory, '.hosted-draft-publication.json'), 'utf8')).toBe('');
    await expect(fs.stat(path.join(f.directory, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.identities.listTeamIdentities()).toEqual([]);
    vi.mocked(fs.open).mockImplementation(actualOpen);
    expect(await f.attempt(async () => {})).toEqual({ kind: 'recovery_required' });
  });

  it.each(['.hosted-draft-publication.json', 'config.json'])('revocation during %s write prevents subsequent effects and permits exact recovery', async (name) => {
    const f = await fixture();
    let revoked = false;
    const createdFiles: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0) {
        createdFiles.push(path.basename(String(args[0])));
        if (String(args[0]).endsWith(`/${name}`)) {
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...writeArgs) => {
            await write(...writeArgs);
            revoked = true; // Authority changes while the actual first/config write is awaited.
          });
        }
      }
      return handle;
    });
    const result = await f.attempt(async () => { if (revoked) throw new Error('request-revoked'); });
    expect(revoked).toBe(true); // Prove the interceptor reached the concrete effect boundary.
    expect(result).toEqual({ kind: 'recovery_required' });
    expect(createdFiles).toEqual(name === 'config.json' ? ['.hosted-draft-publication.json', 'config.json'] : [name]);
    await expect(fs.stat(path.join(f.directory, 'team.identity.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.identities.listTeamIdentities()).some((identity) => identity.state === 'active')).toBe(false);
    const retainedBytes = await fs.readFile(path.join(f.directory, name));
    vi.mocked(fs.open).mockImplementation(actualOpen);
    expect(await f.attempt(async () => {})).toMatchObject({ kind: 'published' });
    expect(await fs.readFile(path.join(f.directory, name))).toEqual(retainedBytes);
    expect(await f.identities.listTeamIdentities()).toHaveLength(1);
  });

  it('retains an interrupted partial file without overwriting it during explicit recovery', async () => {
    const f = await fixture();
    let interrupted = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0 && String(args[0]).endsWith('/config.json')) {
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
          await handle.write(Buffer.from('{'));
          interrupted = true;
          throw new Error('interrupted-write');
        });
      }
      return handle;
    });
    const result = await f.attempt(async () => {});
    expect(interrupted).toBe(true);
    expect(result).toEqual({ kind: 'recovery_required' });
    vi.mocked(fs.open).mockImplementation(actualOpen);
    expect(await f.attempt(async () => {})).toEqual({ kind: 'recovery_required' });
    expect(await fs.readFile(path.join(f.directory, 'config.json'), 'utf8')).toBe('{');
    await expect(fs.stat(path.join(f.directory, 'team.identity.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.identities.listTeamIdentities())[0]?.state).toBe('adoption_prepared');
  });
});
