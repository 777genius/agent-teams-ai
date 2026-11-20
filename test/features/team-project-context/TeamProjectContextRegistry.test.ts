import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TeamProjectContextRegistry,
  TeamProjectContextUnavailableError,
} from '../../../src/features/team-project-context/main';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-project-context-test-'));
  roots.push(root);
  const teamsBasePath = path.join(root, 'teams');
  const tasksBasePath = path.join(root, 'tasks');
  const workspaceA = path.join(root, 'a');
  const workspaceB = path.join(root, 'b');
  await Promise.all([
    mkdir(path.join(teamsBasePath, 'logical-team'), { recursive: true }),
    mkdir(tasksBasePath, { recursive: true }),
    mkdir(workspaceA),
    mkdir(workspaceB),
  ]);
  await claimTeamForThisProfile({
    teamsBasePath, teamName: 'logical-team', reason: 'create', profileScope: 'test-profile',
  });
  const registry = new TeamProjectContextRegistry({
    teamsBasePath, tasksBasePath, profileScope: 'test-profile',
  });
  return { registry, root, teamsBasePath, tasksBasePath, workspaceA, workspaceB };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function simulateNativeProvisioning(f: Awaited<ReturnType<typeof fixture>>, alias: string) {
  await mkdir(path.join(f.teamsBasePath, alias), { recursive: true });
  await mkdir(path.join(f.tasksBasePath, alias), { recursive: true });
  await writeFile(path.join(f.teamsBasePath, alias, 'config.json'), JSON.stringify({ name: alias }));
  await claimTeamForThisProfile({
    teamsBasePath: f.teamsBasePath,
    teamName: alias,
    reason: 'create',
    profileScope: 'test-profile',
  });
}

describe('TeamProjectContextRegistry', () => {
  it('atomically prevents project creation while permanent deletion is in progress', async () => {
    const f = await fixture();
    const first = await f.registry.reserve('logical-team', f.workspaceA);
    await f.registry.beginPermanentDeletion('logical-team');
    await expect(f.registry.reserve('logical-team', f.workspaceB))
      .rejects.toThrow('permanent deletion is in progress');
    await expect(f.registry.reserve('logical-team', f.workspaceA))
      .rejects.toThrow('permanent deletion is in progress');
    await expect(f.registry.listRetained('logical-team'))
      .rejects.toThrow('permanent deletion is in progress');
    await f.registry.cancelPermanentDeletion('logical-team');
    expect(await f.registry.listRetained('logical-team')).toEqual([first]);
    const other = await f.registry.reserve('logical-team', f.workspaceB);
    expect(other.id).not.toBe(first.id);
  });

  it('blocks project operations during soft delete and restores admission on cancellation', async () => {
    const f = await fixture();
    const reserved = await f.registry.reserve('logical-team', f.workspaceA);
    await simulateNativeProvisioning(f, reserved.executionTeamName);
    await f.registry.confirmReady('logical-team', f.workspaceA, reserved.executionTeamName);
    await f.registry.beginSoftDelete('logical-team');
    await expect(f.registry.reserve('logical-team', f.workspaceB)).rejects.toThrow(/deletion|trash/);
    await expect(f.registry.inspect('logical-team', f.workspaceA)).rejects.toThrow(/deleted|trash/);
    await expect(f.registry.confirmReady(
      'logical-team', f.workspaceA, reserved.executionTeamName
    )).rejects.toThrow('being deleted');
    await f.registry.cancelSoftDelete('logical-team');
    expect((await f.registry.find('logical-team', f.workspaceA))?.id).toBe(reserved.id);
    expect((await f.registry.reserve('logical-team', f.workspaceB)).state).toBe('reserved');
  });

  it('does not drop a soft-delete fence when permanent deletion is cancelled', async () => {
    const f = await fixture();
    await f.registry.beginSoftDelete('logical-team');
    await f.registry.beginPermanentDeletion('logical-team');
    await f.registry.cancelPermanentDeletion('logical-team');
    await expect(f.registry.reserve('logical-team', f.workspaceA))
      .rejects.toThrow(/deletion|trash/);
    await f.registry.cancelSoftDelete('logical-team');
    const reserved = await f.registry.reserve('logical-team', f.workspaceA);
    expect(reserved.state).toBe('reserved');
    await f.registry.beginPermanentDeletion('logical-team');
    await expect(f.registry.beginSoftDelete('logical-team'))
      .rejects.toThrow('Permanent deletion is already in progress');
  });

  it('matches mixed-case stored Windows project paths without changing the index on reads', async () => {
    if (process.platform !== 'win32') return;
    const f = await fixture();
    const reserved = await f.registry.reserve('logical-team', f.workspaceA);
    await simulateNativeProvisioning(f, reserved.executionTeamName);
    await f.registry.confirmReady('logical-team', f.workspaceA, reserved.executionTeamName);
    const indexPath = path.join(f.teamsBasePath, 'logical-team', 'project-contexts.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      contexts: { projectKey: string }[];
    };
    const original = index.contexts[0]!.projectKey;
    index.contexts[0]!.projectKey = original.toUpperCase();
    const mixedCaseIndex = JSON.stringify(index);
    await writeFile(indexPath, mixedCaseIndex);
    expect((await f.registry.find('logical-team', f.workspaceA))?.id).toBe(reserved.id);
    expect(await readFile(indexPath, 'utf8')).toBe(mixedCaseIndex);
  });

  it('lists the contexts of a logical team once its index exists', async () => {
    const f = await fixture();
    expect(await f.registry.hasRetainedIndex('logical-team')).toBe(false);
    expect(await f.registry.listRetained('logical-team')).toEqual([]);
    const pending = await f.registry.reserve('logical-team', f.workspaceA);
    expect(await f.registry.hasRetainedIndex('logical-team')).toBe(true);
    expect(await f.registry.listRetained('logical-team')).toEqual([pending]);
  });

  it('is read-only until a context is explicitly created', async () => {
    const f = await fixture();
    expect(await f.registry.find('logical-team', f.workspaceA)).toBeNull();
    await expect(readFile(path.join(f.teamsBasePath, 'logical-team', 'project-contexts.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('assigns separate native team namespaces to A and B, and restores A', async () => {
    const f = await fixture();
    const reservedA = await f.registry.reserve('logical-team', f.workspaceA);
    const reservedB = await f.registry.reserve('logical-team', f.workspaceB);
    await simulateNativeProvisioning(f, reservedA.executionTeamName);
    await simulateNativeProvisioning(f, reservedB.executionTeamName);
    const a = await f.registry.confirmReady('logical-team', f.workspaceA, reservedA.executionTeamName);
    const b = await f.registry.confirmReady('logical-team', f.workspaceB, reservedB.executionTeamName);
    expect(a.executionTeamName).not.toBe(b.executionTeamName);
    expect(a.state).toBe('ready');
    expect(await f.registry.find('logical-team', f.workspaceA)).toEqual(a);
    expect(await f.registry.reserve('logical-team', f.workspaceA)).toEqual(a);
    await writeFile(path.join(f.tasksBasePath, a.executionTeamName, '1.json'), '{"id":"1"}');
    await expect(readFile(path.join(f.tasksBasePath, b.executionTeamName, '1.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('opens saved, owned project history after its worktree folder was deleted', async () => {
    const f = await fixture();
    const reserved = await f.registry.reserve('logical-team', f.workspaceA);
    await simulateNativeProvisioning(f, reserved.executionTeamName);
    const ready = await f.registry.confirmReady(
      'logical-team', f.workspaceA, reserved.executionTeamName
    );
    await writeFile(path.join(f.tasksBasePath, ready.executionTeamName, '7.json'), '{"subject":"saved"}');
    await rm(f.workspaceA, { recursive: true });
    expect(await f.registry.inspect('logical-team', f.workspaceA)).toEqual(ready);
    expect(await f.registry.find('logical-team', f.workspaceA)).toEqual(ready);
    expect(await readFile(path.join(f.tasksBasePath, ready.executionTeamName, '7.json'), 'utf8'))
      .toContain('saved');
    await expect(f.registry.reserve('logical-team', f.workspaceA)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  describe('history of a deleted project below a symlinked directory', () => {
    // Independent of the OS temp dir: the symlink is created here, so Linux and
    // Windows (junction, no privileges needed) exercise the same path as macOS.
    async function symlinkedFixture(ctx: { skip: (note?: string) => never }) {
      const f = await fixture();
      const realParent = path.join(f.root, 'real-parent');
      const linkParent = path.join(f.root, 'link-parent');
      await mkdir(realParent);
      try {
        await symlink(realParent, linkParent, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') ctx.skip('symlink creation is not permitted here');
        throw error;
      }
      return { ...f, realParent, linkParent };
    }

    async function readyContext(
      f: Awaited<ReturnType<typeof symlinkedFixture>>,
      projectDir: string
    ) {
      const reserved = await f.registry.reserve('logical-team', projectDir);
      await simulateNativeProvisioning(f, reserved.executionTeamName);
      return f.registry.confirmReady('logical-team', projectDir, reserved.executionTeamName);
    }

    it('finds saved history through the symlinked and the real path after the folder is deleted', async (ctx) => {
      const f = await symlinkedFixture(ctx);
      const viaLink = path.join(f.linkParent, 'project');
      await mkdir(path.join(f.realParent, 'project'));
      const ready = await readyContext(f, viaLink);
      await rm(path.join(f.realParent, 'project'), { recursive: true });

      expect(await f.registry.inspect('logical-team', viaLink)).toEqual(ready);
      expect(await f.registry.inspect('logical-team', path.join(f.realParent, 'project')))
        .toEqual(ready);
      expect(await f.registry.find('logical-team', viaLink)).toEqual(ready);
    });

    it('keeps different missing paths distinct', async (ctx) => {
      const f = await symlinkedFixture(ctx);
      await mkdir(path.join(f.realParent, 'project'));
      const ready = await readyContext(f, path.join(f.linkParent, 'project'));
      await rm(path.join(f.realParent, 'project'), { recursive: true });

      expect(await f.registry.inspect('logical-team', path.join(f.linkParent, 'other')))
        .toBeNull();
      expect(await f.registry.inspect('logical-team', path.join(f.linkParent, 'project', 'sub')))
        .toBeNull();
      expect(await f.registry.inspect('logical-team', path.join(f.root, 'project'))).toBeNull();
      expect(await f.registry.inspect('logical-team', path.join(f.linkParent, 'project')))
        .toEqual(ready);
    });

    it('does not throw for a path below a regular file and finds nothing there', async (ctx) => {
      const f = await symlinkedFixture(ctx);
      const file = path.join(f.realParent, 'not-a-dir');
      await writeFile(file, 'x');
      expect(await f.registry.inspect('logical-team', path.join(file, 'project'))).toBeNull();
    });

    it('finds history below a missing multi-segment tail', async (ctx) => {
      const f = await symlinkedFixture(ctx);
      await mkdir(path.join(f.realParent, 'G', 'W'), { recursive: true });
      const ready = await readyContext(f, path.join(f.linkParent, 'G', 'W'));
      await rm(path.join(f.realParent, 'G'), { recursive: true });

      expect(await f.registry.inspect('logical-team', path.join(f.linkParent, 'G', 'W')))
        .toEqual(ready);
      // The order of the missing segments is part of the identity.
      expect(await f.registry.inspect('logical-team', path.join(f.linkParent, 'W', 'G')))
        .toBeNull();
      expect(await f.registry.inspect('logical-team', path.join(f.linkParent, 'G'))).toBeNull();
    });

    it('opens the target project, never the deleted one, when a deleted path becomes a link', async (ctx) => {
      // Identity is the real path, exactly as for any existing path (this holds
      // with or without the missing-path handling): a link to project b is
      // project b and never the deleted project a.
      const f = await symlinkedFixture(ctx);
      await mkdir(path.join(f.realParent, 'a'));
      await mkdir(path.join(f.realParent, 'b'));
      const readyA = await readyContext(f, path.join(f.linkParent, 'a'));
      const readyB = await readyContext(f, path.join(f.linkParent, 'b'));
      await rm(path.join(f.realParent, 'a'), { recursive: true });
      await symlink(
        path.join(f.realParent, 'b'), path.join(f.realParent, 'a'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      const opened = await f.registry.inspect('logical-team', path.join(f.linkParent, 'a'));
      expect(opened).toEqual(readyB);
      expect(opened).not.toEqual(readyA);
    });

    it('resolves an existing project path exactly as before', async (ctx) => {
      const f = await symlinkedFixture(ctx);
      await mkdir(path.join(f.realParent, 'project'));
      const ready = await readyContext(f, path.join(f.linkParent, 'project'));
      expect(await f.registry.inspect('logical-team', path.join(f.linkParent, 'project')))
        .toEqual(ready);
      expect(await f.registry.inspect('logical-team', path.join(f.realParent, 'project')))
        .toEqual(ready);
      expect(await f.registry.inspect('logical-team', f.workspaceB)).toBeNull();
    });
  });

  it('does not use a missing-directory fallback for permission or malformed-path errors', async () => {
    const f = await fixture();
    await expect(f.registry.inspect('logical-team', 'relative/workspace'))
      .rejects.toThrow('absolute project folder');
  });

  it('coalesces concurrent creation into one durable context', async () => {
    const f = await fixture();
    const rows = await Promise.all(
      Array.from({ length: 5 }, () => f.registry.reserve('logical-team', f.workspaceA))
    );
    expect(new Set(rows.map((row) => row.executionTeamName)).size).toBe(1);
    expect(rows[0]?.state).toBe('reserved');
    await expect(readFile(path.join(f.teamsBasePath, rows[0]!.executionTeamName, 'config.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cannot mark a reserved alias ready before proven native provisioning', async () => {
    const f = await fixture();
    const reserved = await f.registry.reserve('logical-team', f.workspaceA);
    await expect(f.registry.confirmReady('logical-team', f.workspaceA, reserved.executionTeamName))
      .rejects.toThrow();
    expect(await f.registry.reserve('logical-team', f.workspaceA)).toEqual(reserved);
  });

  it('inspects pending reservations read-only without exposing them as a ready history', async () => {
    const f = await fixture();
    const pending = await f.registry.reserve('logical-team', f.workspaceA);
    expect(await f.registry.inspect('logical-team', f.workspaceA)).toEqual(pending);
    expect(await f.registry.inspect('logical-team', f.workspaceB)).toBeNull();
    expect(await f.registry.find('logical-team', f.workspaceB)).toBeNull();
    await expect(f.registry.find('logical-team', f.workspaceA))
      .rejects.toBeInstanceOf(TeamProjectContextUnavailableError);
  });

  it('permits stopping only a reserved native alias with this profile ownership', async () => {
    const f = await fixture();
    const row = await f.registry.reserve('logical-team', f.workspaceA);
    await expect(f.registry.assertReservedStopOwnership('logical-team', row.executionTeamName))
      .rejects.toThrow();
    await simulateNativeProvisioning(f, row.executionTeamName);
    await expect(f.registry.assertReservedStopOwnership('logical-team', row.executionTeamName))
      .resolves.toBeUndefined();
    await expect(f.registry.assertReservedStopOwnership('logical-team', 'unrelated'))
      .rejects.toThrow('Unknown pending project runtime');
    await writeFile(
      path.join(f.teamsBasePath, row.executionTeamName, '.agent-teams-owner.json'),
      JSON.stringify({ schemaVersion: 1, profileScope: 'foreign', claimedAt: new Date().toISOString(), reason: 'create' })
    );
    await expect(f.registry.assertReservedStopOwnership('logical-team', row.executionTeamName))
      .rejects.toThrow('different or unknown profile');
  });

  it('lists pending reservations without treating them as ready histories', async () => {
    const f = await fixture();
    const reserved = await f.registry.reserve('logical-team', f.workspaceA);
    expect(await f.registry.list('logical-team')).toEqual([reserved]);
    await expect(f.registry.find('logical-team', f.workspaceA))
      .rejects.toBeInstanceOf(TeamProjectContextUnavailableError);
  });

  it('releases only empty failed reservations and allows A to retry after B', async () => {
    const f = await fixture();
    const a = await f.registry.reserve('logical-team', f.workspaceA);
    expect(await f.registry.releaseUnusedReservation(
      'logical-team', a.executionTeamName, 'stale-id'
    )).toBe(false);
    expect(await f.registry.releaseUnusedReservation(
      'logical-team', a.executionTeamName, a.id
    )).toBe(true);
    const b = await f.registry.reserve('logical-team', f.workspaceB);
    const retriedA = await f.registry.reserve('logical-team', f.workspaceA);
    expect(b.executionTeamName).not.toBe(retriedA.executionTeamName);
    expect(retriedA.id).not.toBe(a.id);
    await simulateNativeProvisioning(f, b.executionTeamName);
    await f.registry.confirmReady('logical-team', f.workspaceB, b.executionTeamName);
    expect(await f.registry.releaseUnusedReservation(
      'logical-team', b.executionTeamName, b.id
    )).toBe(false);
  });

  it('keeps failed reservations if any physical task or team directory exists', async () => {
    const f = await fixture();
    const a = await f.registry.reserve('logical-team', f.workspaceA);
    await mkdir(path.join(f.tasksBasePath, a.executionTeamName));
    expect(await f.registry.releaseUnusedReservation(
      'logical-team', a.executionTeamName, a.id
    )).toBe(false);
    expect(await f.registry.list('logical-team')).toEqual([a]);
  });

  it('allows idempotent permanent deletion of exactly owned and fully removed contexts', async () => {
    const f = await fixture();
    const a = await f.registry.reserve('logical-team', f.workspaceA);
    const b = await f.registry.reserve('logical-team', f.workspaceB);
    await simulateNativeProvisioning(f, a.executionTeamName);
    await simulateNativeProvisioning(f, b.executionTeamName);
    await f.registry.confirmReady('logical-team', f.workspaceA, a.executionTeamName);
    await f.registry.confirmReady('logical-team', f.workspaceB, b.executionTeamName);

    expect(await f.registry.listForPermanentDeletion('logical-team')).toHaveLength(2);
    await expect(f.registry.forgetPermanentlyDeletedContext(
      'logical-team', a.executionTeamName, a.id
    )).rejects.toThrow('still exists');

    await rm(path.join(f.teamsBasePath, a.executionTeamName), { recursive: true });
    await rm(path.join(f.tasksBasePath, a.executionTeamName), { recursive: true });
    expect(await f.registry.listForPermanentDeletion('logical-team')).toHaveLength(2);
    expect(await f.registry.forgetPermanentlyDeletedContext(
      'logical-team', a.executionTeamName, a.id
    )).toBe(true);
    expect(await f.registry.forgetPermanentlyDeletedContext(
      'logical-team', a.executionTeamName, a.id
    )).toBe(false);
    const remaining = await f.registry.listForPermanentDeletion('logical-team');
    expect(remaining.map((row) => row.executionTeamName)).toEqual([b.executionTeamName]);
  });

  it('fails closed on orphan tasks without a proven owned team directory', async () => {
    const f = await fixture();
    const row = await f.registry.reserve('logical-team', f.workspaceA);
    await mkdir(path.join(f.tasksBasePath, row.executionTeamName));
    await expect(f.registry.listForPermanentDeletion('logical-team'))
      .rejects.toThrow('unowned orphan');
  });

  it('fails closed for a foreign-owned logical team', async () => {
    const f = await fixture();
    const foreign = new TeamProjectContextRegistry({
      teamsBasePath: f.teamsBasePath, tasksBasePath: f.tasksBasePath, profileScope: 'foreign',
    });
    await expect(foreign.reserve('logical-team', f.workspaceA))
      .rejects.toBeInstanceOf(TeamProjectContextUnavailableError);
  });

  it('recognizes only aliases mapped by an owned manifest for schedule protection', async () => {
    const f = await fixture();
    const reserved = await f.registry.reserve('logical-team', f.workspaceA);
    expect(await f.registry.isOwnedExecutionAlias(reserved.executionTeamName)).toBe(true);
    expect(await f.registry.isOwnedExecutionAlias('ptc-not-owned')).toBe(false);
    expect(await f.registry.isOwnedExecutionAlias('ordinary-team')).toBe(false);
  });

  it('proves many aliases with one lookup and reports each name on its own', async () => {
    const f = await fixture();
    const a = await f.registry.reserve('logical-team', f.workspaceA);
    const b = await f.registry.reserve('logical-team', f.workspaceB);
    const lookups = await f.registry.resolveOwnedExecutionAliases([
      a.executionTeamName,
      b.executionTeamName,
      'ptc-not-owned',
      'ordinary-team',
    ]);
    expect(lookups.get(a.executionTeamName)).toEqual({
      alias: { logicalTeamName: 'logical-team', context: a },
    });
    expect(lookups.get(b.executionTeamName)).toEqual({
      alias: { logicalTeamName: 'logical-team', context: b },
    });
    expect(lookups.get('ptc-not-owned')).toEqual({ alias: null });
    expect(lookups.get('ordinary-team')).toEqual({ alias: null });
  });

  it('does not prove an alias when the index that could own it is unreadable', async () => {
    const f = await fixture();
    const a = await f.registry.reserve('logical-team', f.workspaceA);
    await writeFile(path.join(f.teamsBasePath, 'logical-team', 'project-contexts.json'), '{broken');
    const lookups = await f.registry.resolveOwnedExecutionAliases([a.executionTeamName, 'ordinary']);
    expect(lookups.get(a.executionTeamName)).toHaveProperty('error');
    expect(lookups.get('ordinary')).toEqual({ alias: null });
    await expect(f.registry.resolveOwnedExecutionAlias(a.executionTeamName)).rejects.toBeInstanceOf(
      Error
    );
  });

  it('allows ordinary schedule targets before the native teams root exists', async () => {
    const f = await fixture();
    const missingRoot = new TeamProjectContextRegistry({
      teamsBasePath: path.join(f.root, 'absent-teams'),
      tasksBasePath: f.tasksBasePath,
      profileScope: 'test-profile',
    });
    expect(await missingRoot.isOwnedExecutionAlias('ptc-ordinary-name')).toBe(false);
  });

  it('accepts long legacy identifiers and trailing hyphens for retained-index checks', async () => {
    const f = await fixture();
    const legacyName = 'legacy-' + 'a'.repeat(90) + '-';
    await mkdir(path.join(f.teamsBasePath, legacyName));
    expect(await f.registry.hasRetainedIndex(legacyName)).toBe(false);
    expect(await f.registry.listRetained(legacyName)).toEqual([]);
  });

  it('rejects a corrupt index instead of silently reverting to shared storage', async () => {
    const f = await fixture();
    await writeFile(path.join(f.teamsBasePath, 'logical-team', 'project-contexts.json'), '{broken');
    await expect(f.registry.find('logical-team', f.workspaceA))
      .rejects.toBeInstanceOf(TeamProjectContextUnavailableError);
  });
});
