import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseDirectoryFingerprint, parseTeamAdoptionIntentId,
  parseTeamIdentityChecksum,
} from '@features/internal-storage/contracts';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { createReservedDraftConfigurationAttribution } from '@features/team-configuration/main/hosted';
import { createHostedDraftPublicationFeature } from '@features/team-lifecycle/main/composition';
import { parseActorId, parseDeploymentId, parseWorkspaceId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  HostedTeamConfigurationStorageCreateResult,
  TeamDraftPublicationStorageGateway, TeamIdentityPublicationGateway,
} from '@features/internal-storage/contracts';
import type { HostedDraftPublicationFeature } from '@features/team-lifecycle/main';

const resources: { root: string; workers: InternalStorageWorkerCore[]; features: HostedDraftPublicationFeature[] }[] = [];
const workspaceId = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const binding = {
  actorId: parseActorId(`actor_${'2'.repeat(32)}`),
  deploymentId: parseDeploymentId(`deployment_${'3'.repeat(32)}`),
  runtimeWorkspaceId: parseWorkspaceId(`workspace_${'4'.repeat(32)}`), bindingGeneration: 7,
};
const create = {
  workspaceId, idempotencyKey: 'idempotency_draft-publication-original', payloadHash: 'a'.repeat(64),
  metadata: { name: 'Editable display name' }, members: [{ name: 'lead' }],
  publicationBinding: binding, deadlineAtMs: Number.MAX_SAFE_INTEGER,
};
const timestamp = '2026-09-07T00:00:00.000Z';

function identityGateway(worker: InternalStorageWorkerCore): TeamIdentityPublicationGateway {
  return {
    listTeamIdentities: async () => worker.handle('teamIdentity.list', {}) as never,
    getTeamIdentity: async (teamId) => worker.handle('teamIdentity.get', { teamId }) as never,
    reserveTeamIdentity: async (input) => worker.handle('teamIdentity.reserve', input) as never,
    prepareReservedTeamAdoption: async (input) => worker.handle('teamIdentity.prepareReserved', input) as never,
    recordTeamIdentityFilePublished: async (input) => worker.handle('teamIdentity.recordPublished', input) as never,
    commitTeamAdoption: async (input) => worker.handle('teamIdentity.commitAdoption', input) as never,
    tombstoneTeamIdentity: async (input) => worker.handle('teamIdentity.tombstone', input) as never,
  };
}

async function fixture(shared = false) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'canonical-draft-publication-'));
  const owned = { root, workers: [] as InternalStorageWorkerCore[], features: [] as HostedDraftPublicationFeature[] };
  resources.push(owned);
  const openWorker = (databasePath: string, readOnly = false) => {
    const worker = new InternalStorageWorkerCore({
      databasePath, ...(readOnly ? { mode: 'team-identity-read-only' as const } : {}),
      createDatabase: (file, options) => new Database(file, options) as never,
      now: () => new Date(timestamp),
    });
    owned.workers.push(worker);
    worker.handle(readOnly ? 'teamIdentity.list' : 'ping', {});
    return worker;
  };
  const draftPath = path.join(root, 'auth', 'storage', 'app.db');
  const canonicalPath = shared ? draftPath : path.join(root, 'canonical', 'storage', 'app.db');
  const drafts = openWorker(draftPath);
  const canonical = shared ? drafts : openWorker(canonicalPath);
  const claudeRoot = path.join(root, 'claude');
  await fs.mkdir(claudeRoot, { mode: 0o700 });
  await fs.mkdir(path.join(claudeRoot, 'teams'), { mode: 0o700 });
  const created = drafts.handle('hostedTeamConfiguration.create', create) as Extract<HostedTeamConfigurationStorageCreateResult, { kind: 'created' }>;
  const scope = { workspaceId, teamId: created.teamId, actorId: binding.actorId, deploymentId: binding.deploymentId };
  const journal: TeamDraftPublicationStorageGateway = {
    lookupTeamDraftPublication: async (input) => drafts.handle('draftPublication.lookup', input) as never,
    readTeamDraftPublication: async (input) => drafts.handle('draftPublication.read', input) as never,
    settleTeamDraftPublication: async (input) => drafts.handle('draftPublication.settle', input) as never,
  };
  const load = async () => (await journal.readTeamDraftPublication(scope))!;
  const identities = identityGateway(canonical);
  const makeFeature = async (gateway = identities) => {
    const feature = await createHostedDraftPublicationFeature({ claudeRoot, identities: gateway, now: () => new Date(timestamp) });
    owned.features.push(feature);
    return feature;
  };
  const attempt = async (feature: HostedDraftPublicationFeature, assertCurrent = async () => {}) => {
    const operation = await load();
    return feature.publishDraft({
      publication: operation, assertCurrent,
      recordDirectory: async (directoryFingerprint) => {
        if (!directoryFingerprint) throw new Error('missing observed fingerprint');
        await journal.settleTeamDraftPublication({ ...scope, operationId: operation.operationId,
          directoryFingerprint, state: operation.state, deadlineAtMs: Number.MAX_SAFE_INTEGER });
      },
    });
  };
  return { root, drafts, canonical, canonicalPath, claudeRoot, created, scope, load, identities, makeFeature, attempt, openWorker, journal };
}

afterEach(async () => {
  for (const owned of resources.splice(0)) {
    for (const feature of owned.features) await feature.dispose();
    for (const worker of owned.workers) worker.handle('close', {});
    // Only the exact fresh fixture root is removed; no user/project runtime is opened.
    await fs.rm(owned.root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'linux')('canonical draft publication source integration', () => {
  it.each([false, true])('publishes the original identity with shared worker=%s', async (shared) => {
    const f = await fixture(shared);
    const feature = await f.makeFeature();
    expect(await f.attempt(feature)).toMatchObject({ kind: 'published' });
    const operation = await f.load();
    const identity = await f.identities.getTeamIdentity(f.created.teamId);
    expect(identity).toMatchObject({ state: 'active', teamId: f.created.teamId,
      legacyKey: operation.legacyKey, createdAt: timestamp,
      workspaceBinding: { workspaceId: binding.runtimeWorkspaceId, generation: binding.bindingGeneration } });
    const folder = path.join(f.claudeRoot, 'teams', operation.legacyKey);
    const stat = await fs.lstat(folder, { bigint: true });
    expect(identity?.directoryFingerprint).toBe(createHash('sha256').update(JSON.stringify({
      schemaVersion: 1, canonicalPath: folder, device: stat.dev.toString(), inode: stat.ino.toString(),
    })).digest('hex'));
    expect(JSON.parse(await fs.readFile(path.join(folder, 'config.json'), 'utf8')))
      .toEqual({ name: operation.legacyKey, pendingCreate: true });
    expect(JSON.parse(await fs.readFile(path.join(folder, 'team.identity.json'), 'utf8')))
      .toEqual({ schemaVersion: 1, teamId: f.created.teamId, createdAt: timestamp, originDeploymentId: binding.deploymentId });
    const replay = f.drafts.handle('hostedTeamConfiguration.create', create);
    expect(replay).toEqual({ ...f.created, outcome: 'idempotent_replay' });
    expect(await f.load()).toEqual(operation);
    await feature.dispose();
    expect(await f.attempt(await f.makeFeature())).toMatchObject({ kind: 'published' });
    const reader = f.openWorker(f.canonicalPath, true);
    expect(reader.handle('teamIdentity.list', {})).toEqual([identity]);
    expect(() => reader.handle('teamIdentity.reserve', {
      teamId: f.created.teamId, legacyKey: operation.legacyKey,
      directoryFingerprint: operation.directoryFingerprint!, workspaceBinding: identity!.workspaceBinding,
      createdAt: timestamp,
    })).toThrow('read-only-operation-rejected');
    if (!shared) expect(f.drafts.handle('teamIdentity.list', {})).toEqual([]);
  });

  it('keeps strict create validation before replay and publication intent mutation', async () => {
    const f = await fixture();
    const before = await f.load();
    expect(() => f.drafts.handle('hostedTeamConfiguration.create', {
      ...create, members: [{ name: 'lead' }, { name: 'LEAD' }],
    })).toThrow();
    expect(await f.load()).toEqual(before);
    expect(f.drafts.handle('hostedTeamConfiguration.create', { ...create, payloadHash: 'b'.repeat(64) }))
      .toEqual({ kind: 'conflict', reason: 'idempotency_mismatch' });
    expect(await f.journal.readTeamDraftPublication({ ...f.scope, actorId: parseActorId(`actor_${'5'.repeat(32)}`) })).toBeNull();
  });

  it.each(['reserveTeamIdentity', 'prepareReservedTeamAdoption', 'recordTeamIdentityFilePublished', 'commitTeamAdoption'] as const)(
    'reconciles a lost %s acknowledgement using the same operation', async (method) => {
      const f = await fixture();
      let dropped = false;
      const gateway = { ...f.identities, [method]: async (...args: unknown[]) => {
        const result = await (f.identities[method] as (...values: unknown[]) => Promise<unknown>)(...args);
        if (!dropped) { dropped = true; throw new Error('lost response after commit'); }
        return result;
      } } as TeamIdentityPublicationGateway;
      const initial = await f.makeFeature(gateway);
      expect(await f.attempt(initial)).toEqual({ kind: 'recovery_required' });
      const operation = await f.load();
      await initial.dispose();
      expect(await f.attempt(await f.makeFeature())).toMatchObject({ kind: 'published' });
      expect((await f.load()).operationId).toBe(operation.operationId);
      expect(await f.identities.listTeamIdentities()).toHaveLength(1);
    }
  );

  it('attributes reserved configuration to the fresh public grant without returning launch authority', async () => {
    const f = await fixture();
    const feature = await f.makeFeature({ ...f.identities,
      prepareReservedTeamAdoption: async () => { throw new Error('interrupted after reservation'); },
    });
    expect(await f.attempt(feature)).toEqual({ kind: 'recovery_required' });
    expect((await f.identities.getTeamIdentity(f.created.teamId))?.state).toBe('reserved');
    const resolve = createReservedDraftConfigurationAttribution({ publications: f.journal, identities: f.identities });
    expect(await resolve(f.scope, binding.runtimeWorkspaceId))
      .toEqual({ kind: 'found', runtimeWorkspaceId: binding.runtimeWorkspaceId });
    expect(await resolve(f.scope, workspaceId)).toEqual({ kind: 'unavailable' });
    const identity = await f.identities.getTeamIdentity(f.created.teamId);
    expect(identity?.identityChecksum).toBeNull();
  });

  it('recovers durable files before the publication-record commit', async () => {
    const f = await fixture();
    const feature = await f.makeFeature({ ...f.identities,
      recordTeamIdentityFilePublished: async () => { throw new Error('crash before recording publication'); },
    });
    expect(await f.attempt(feature)).toEqual({ kind: 'recovery_required' });
    const operation = await f.load();
    expect((await f.identities.getTeamIdentity(operation.teamId))?.state).toBe('adoption_prepared');
    expect(await fs.readdir(path.join(f.claudeRoot, 'teams', operation.legacyKey)))
      .toContain('team.identity.json');
    expect(await f.attempt(await f.makeFeature())).toMatchObject({ kind: 'published' });
  });

  it('recovers the durable directory marker before draft fingerprint settlement or reservation', async () => {
    const f = await fixture();
    const feature = await f.makeFeature();
    expect(await feature.publishDraft({ publication: await f.load(), assertCurrent: async () => {},
      recordDirectory: async () => { throw new Error('crash before fingerprint commit'); } }))
      .toEqual({ kind: 'recovery_required' });
    expect((await f.load()).directoryFingerprint).toBeNull();
    expect(await f.identities.listTeamIdentities()).toEqual([]);
    await feature.dispose();
    expect(await f.attempt(await f.makeFeature())).toMatchObject({ kind: 'published' });
  });

  it('resumes exact config bytes durable before the identity file exists', async () => {
    const f = await fixture();
    const operation = await f.load();
    const feature = await f.makeFeature({ ...f.identities, prepareReservedTeamAdoption: async (input) => {
      await f.identities.prepareReservedTeamAdoption(input);
      const folder = path.join(f.claudeRoot, 'teams', operation.legacyKey);
      const config = await fs.open(path.join(folder, 'config.json'), 'wx', 0o600);
      try {
        await config.writeFile(`${JSON.stringify({ name: operation.legacyKey, pendingCreate: true }, null, 2)}\n`);
        await config.sync();
      } finally { await config.close(); }
      const directory = await fs.open(folder, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      throw new Error('crash after config publication before identity publication');
    } });
    expect(await f.attempt(feature)).toEqual({ kind: 'recovery_required' });
    await expect(fs.lstat(path.join(f.claudeRoot, 'teams', operation.legacyKey, 'team.identity.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await feature.dispose();
    expect(await f.attempt(await f.makeFeature())).toMatchObject({ kind: 'published' });
  });

  it.each(['prepareReservedTeamAdoption', 'recordTeamIdentityFilePublished'] as const)(
    'fences a tombstone while interrupted before %s', async (method) => {
      const f = await fixture();
      const feature = await f.makeFeature({ ...f.identities,
        [method]: async () => { throw new Error('interrupted publication'); } });
      expect(await f.attempt(feature)).toEqual({ kind: 'recovery_required' });
      const operation = await f.load();
      await f.identities.tombstoneTeamIdentity({ teamId: operation.teamId, legacyKey: operation.legacyKey,
        reason: 'draft_deleted', tombstonedAt: timestamp });
      await feature.dispose();
      expect(await f.attempt(await f.makeFeature())).toEqual({ kind: 'recovery_required' });
      expect((await f.identities.getTeamIdentity(operation.teamId))?.state).toBe('tombstoned');
    }
  );

  it('preserves reserved timestamps and rejects a different operation or workspace binding', async () => {
    const f = await fixture();
    const operation = await f.load();
    const reservation = { teamId: operation.teamId, legacyKey: operation.legacyKey,
      directoryFingerprint: parseDirectoryFingerprint('c'.repeat(64)),
      workspaceBinding: { workspaceId: binding.runtimeWorkspaceId, generation: binding.bindingGeneration },
      createdAt: timestamp };
    await f.identities.reserveTeamIdentity(reservation);
    const prepare = { ...reservation, intentId: operation.operationId,
      expectedIdentityChecksum: parseTeamIdentityChecksum('d'.repeat(64)), preparedAt: timestamp };
    await expect(f.identities.prepareReservedTeamAdoption({ ...prepare,
      preparedAt: '2026-09-07T00:00:01.000Z' })).rejects.toThrow();
    await expect(f.identities.prepareReservedTeamAdoption({ ...prepare,
      intentId: parseTeamAdoptionIntentId(`adoption_${'9'.repeat(32)}`) })).rejects.toThrow();
    await expect(f.identities.prepareReservedTeamAdoption({ ...prepare,
      workspaceBinding: { ...reservation.workspaceBinding, generation: 8 } })).rejects.toThrow();
    const prepared = await f.identities.prepareReservedTeamAdoption(prepare);
    expect(prepared.identity.createdAt).toBe(timestamp);
    expect(prepared.reservation.reservedAt).toBe(timestamp);
    expect(prepared.intent.preparedAt).toBe(timestamp);
    await f.identities.tombstoneTeamIdentity({ teamId: operation.teamId, legacyKey: operation.legacyKey,
      reason: 'draft_deleted', tombstonedAt: timestamp });
    await expect(f.identities.prepareReservedTeamAdoption(prepare)).rejects.toThrow();
  });

  it.each(['root', 'teams', 'directory', 'symlink', 'config', 'identity'] as const)(
    'refuses %s substitution without attaching or overwriting files', async (replacement) => {
      const f = await fixture();
      const feature = await f.makeFeature();
      expect(await f.attempt(feature)).toMatchObject({ kind: 'published' });
      const operation = await f.load();
      const folder = path.join(f.claudeRoot, 'teams', operation.legacyKey);
      if (replacement === 'config' || replacement === 'identity') {
        const name = replacement === 'config' ? 'config.json' : 'team.identity.json';
        await fs.writeFile(path.join(folder, name), 'foreign bytes');
      } else {
        const replaced = replacement === 'root' ? f.claudeRoot
          : replacement === 'teams' ? path.dirname(folder) : folder;
        const moved = `${replaced}.retired`;
        await fs.rename(replaced, moved);
        if (replacement === 'symlink') await fs.symlink(moved, replaced);
        else await fs.mkdir(replaced, { mode: 0o700 });
      }
      expect(await f.attempt(feature)).toEqual({ kind: 'recovery_required' });
    }
  );

  it('refuses an unexplained preexisting directory and does not publish into it', async () => {
    const f = await fixture();
    const operation = await f.load();
    const folder = path.join(f.claudeRoot, 'teams', operation.legacyKey);
    await fs.mkdir(folder, { mode: 0o700 });
    expect(await f.attempt(await f.makeFeature())).toEqual({ kind: 'recovery_required' });
    expect(await fs.readdir(folder)).toEqual([]);
    expect(await f.identities.getTeamIdentity(operation.teamId)).toBeNull();
  });

  it('retains partial publication bytes as recovery-required instead of activating or overwriting', async () => {
    const f = await fixture();
    const operation = await f.load();
    const feature = await f.makeFeature({ ...f.identities,
      prepareReservedTeamAdoption: async (input) => {
        const result = await f.identities.prepareReservedTeamAdoption(input);
        await fs.writeFile(path.join(f.claudeRoot, 'teams', operation.legacyKey, 'config.json'), '{partial',
          { flag: 'wx', mode: 0o600 });
        return result;
      },
    });
    expect(await f.attempt(feature)).toEqual({ kind: 'recovery_required' });
    expect(await f.attempt(await f.makeFeature())).toEqual({ kind: 'recovery_required' });
    expect((await f.identities.getTeamIdentity(operation.teamId))?.state).toBe('adoption_prepared');
    expect(await fs.readFile(path.join(f.claudeRoot, 'teams', operation.legacyKey, 'config.json'), 'utf8')).toBe('{partial');
  });

  it('fences deletion after activation and preserves the original create replay', async () => {
    const f = await fixture();
    const feature = await f.makeFeature();
    await f.attempt(feature);
    const operation = await f.load();
    await f.identities.tombstoneTeamIdentity({ teamId: operation.teamId, legacyKey: operation.legacyKey,
      reason: 'draft_deleted', tombstonedAt: timestamp });
    f.drafts.handle('hostedTeamConfiguration.delete', { workspaceId, teamId: f.created.teamId,
      expectedRevision: f.created.revision, publicationBinding: binding, deadlineAtMs: Number.MAX_SAFE_INTEGER });
    expect((await f.load()).state).toBe('tombstoned');
    expect(await f.attempt(feature)).toEqual({ kind: 'recovery_required' });
    expect(f.drafts.handle('hostedTeamConfiguration.create', create)).toEqual({ ...f.created, outcome: 'idempotent_replay' });
    expect((await f.identities.getTeamIdentity(operation.teamId))?.state).toBe('tombstoned');
  });
});
