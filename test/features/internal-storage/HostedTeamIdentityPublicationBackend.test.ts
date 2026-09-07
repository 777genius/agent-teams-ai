import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHostedTeamIdentityPublicationBackend } from '@features/internal-storage/main/composition';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamIdentityPublicationGateway } from '@features/internal-storage/contracts';

const worker = vi.hoisted(() => ({ opened: vi.fn(), ping: vi.fn<() => Promise<{ connectionFileIdentity: string }>>(), close: vi.fn(async () => {}),
  list: vi.fn(async () => []), get: vi.fn(async () => null) }));
vi.mock('@features/internal-storage/main/infrastructure/InternalStorageWorkerClient', () => ({
  InternalStorageWorkerClient: class {
    constructor(options: unknown) { worker.opened(options); }
    ping = worker.ping;
    close = worker.close;
    identityPublication = { listTeamIdentities: worker.list, getTeamIdentity: worker.get };
  },
}));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });
async function setup() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'draft-db-topology-'));
  roots.push(root);
  const appDataRoot = path.join(root, 'canonical');
  const authRoot = path.join(root, 'auth');
  for (const folder of [appDataRoot, authRoot]) {
    await fs.mkdir(path.join(folder, 'storage'), { recursive: true, mode: 0o700 });
    // Topology-only fixture; actual schema/publication is covered by HostedDraftPublication.test.ts.
    await fs.writeFile(path.join(folder, 'storage', 'app.db'), 'topology fixture', { mode: 0o600 });
  }
  const gateway = { listTeamIdentities: vi.fn(async () => []), getTeamIdentity: vi.fn(async () => null) } as unknown as TeamIdentityPublicationGateway;
  const authStat = await fs.lstat(path.join(authRoot, 'storage', 'app.db'), { bigint: true });
  const canonicalStat = await fs.lstat(path.join(appDataRoot, 'storage', 'app.db'), { bigint: true });
  worker.ping.mockResolvedValue({ connectionFileIdentity: `${canonicalStat.dev}:${canonicalStat.ino}` });
  const drafts = { databasePath: path.join(authRoot, 'storage', 'app.db'),
    initialize: vi.fn(async () => `${authStat.dev}:${authStat.ino}`), identityPublication: gateway };
  return { root, appDataRoot, authRoot, drafts, gateway };
}
describe('canonical publication database topology', () => {
  it('reuses the exact admitted auth worker and never closes it through the borrowed facade', async () => {
    const f = await setup();
    const backend = await createHostedTeamIdentityPublicationBackend({ appDataRoot: f.authRoot, drafts: f.drafts });
    expect(backend.sharedWorker).toBe(true);
    expect(worker.opened).not.toHaveBeenCalled();
    expect(f.gateway.listTeamIdentities).toHaveBeenCalledOnce();
    await backend.dispose();
    expect(worker.close).not.toHaveBeenCalled();
  });
  it('opens a narrow writer for a distinct existing canonical database', async () => {
    const f = await setup();
    const backend = await createHostedTeamIdentityPublicationBackend(f);
    expect(backend.sharedWorker).toBe(false);
    expect(worker.opened).toHaveBeenCalledWith({ databasePath: path.join(f.appDataRoot, 'storage', 'app.db'), mode: 'team-identity-publication' });
    await backend.dispose();
    expect(worker.close).toHaveBeenCalledOnce();
  });
  it('refuses sharing when an existing worker still owns the database replaced at the same path', async () => {
    const f = await setup();
    await fs.rename(f.drafts.databasePath, `${f.drafts.databasePath}.old`);
    await fs.writeFile(f.drafts.databasePath, 'replacement', { mode: 0o600 });
    await expect(createHostedTeamIdentityPublicationBackend({ appDataRoot: f.authRoot, drafts: f.drafts }))
      .rejects.toThrow('canonical-draft-worker-identity-mismatch');
    expect(worker.opened).not.toHaveBeenCalled();
  });
  it.each(['missing', 'symlink', 'hardlink'] as const)('refuses %s before starting a canonical writer', async (kind) => {
    const f = await setup();
    const target = path.join(f.appDataRoot, 'storage', 'app.db');
    await fs.unlink(target);
    if (kind === 'symlink') await fs.symlink(f.drafts.databasePath, target);
    if (kind === 'hardlink') await fs.link(f.drafts.databasePath, target);
    await expect(createHostedTeamIdentityPublicationBackend(f)).rejects.toThrow();
    expect(worker.opened).not.toHaveBeenCalled();
  });
  it('fences root replacement before any subsequent worker call', async () => {
    const f = await setup();
    const backend = await createHostedTeamIdentityPublicationBackend(f);
    await fs.rename(f.appDataRoot, `${f.appDataRoot}.old`);
    await fs.mkdir(path.join(f.appDataRoot, 'storage'), { recursive: true });
    await fs.writeFile(path.join(f.appDataRoot, 'storage', 'app.db'), 'replacement');
    await expect(backend.gateway.listTeamIdentities()).rejects.toThrow('canonical-database-replaced');
    expect(worker.list).toHaveBeenCalledOnce();
    await backend.dispose();
  });
});
