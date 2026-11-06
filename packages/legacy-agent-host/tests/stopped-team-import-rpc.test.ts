import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import {
  FileStoppedSnapshotResolver,
  FileStoppedTeamImport,
  exportStoppedTeam,
  importCategories,
} from '../dist/stopped-team-import/index.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { SnapshotHeader } from '../dist/stopped-team-import/index.js';

function profile(root: string): TeamHostProfile {
  return {
    schemaVersion: 1,
    principalId: 'TEST-human',
    teams: [],
    creation: { contextIds: ['TEST-context'] },
    owner: {
      ownerId: 'TEST-owner',
      profileId: 'TEST-profile',
      revision: 'TEST-revision',
      storageRoot: root,
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: '0'.repeat(64),
      hostEntrySha256: '1'.repeat(64),
    },
  };
}
function openHost(raw: TeamHostProfile) {
  const input = new PassThrough(),
    output = new PassThrough(),
    lines = createInterface({ input: output }),
    frames = lines[Symbol.asyncIterator]();
  const server = createTeamHost(raw, { input, output });
  let sequence = 0;
  return {
    async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
      const id = ++sequence;
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const next = await frames.next();
      assert.equal(next.done, false);
      const frame = JSON.parse(next.value!) as { id: number; result: Record<string, unknown> };
      assert.equal(frame.id, id);
      return frame.result;
    },
    async close() {
      await server.dispose();
      lines.close();
    },
  };
}

test(
  'real Host NDJSON import publishes only exact private snapshot, then cold lookup reuses original source/Team without reread or native launch',
  { timeout: 15000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-import-rpc-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const destination = join(root, 'destination'),
      sourceRoot = join(root, 'source');
    mkdirSync(destination);
    mkdirSync(sourceRoot);
    const roots = importCategories.map((category) => {
      const path = join(sourceRoot, category);
      mkdirSync(path);
      return { category, path };
    });
    const sourcePath = (category: (typeof importCategories)[number], file: string) =>
      join(roots.find((entry) => entry.category === category)!.path, file);
    writeFileSync(
      sourcePath('team', 'config.json'),
      JSON.stringify({ name: 'TEST-old', members: [{ name: 'team-lead' }] })
    );
    writeFileSync(
      sourcePath('tasks', 'TEST-task.json'),
      JSON.stringify({
        id: 'TEST-task',
        subject: 'Retained source task',
        status: 'pending',
        descriptionTaskRefs: [
          { taskId: 'TEST-task', displayId: '1', teamName: 'TEST-old' },
          { taskId: 'TEST-external', displayId: '2', teamName: 'TEST-imported' },
        ],
      })
    );
    const header: SnapshotHeader = {
      sourceOwnerId: 'TEST-old-owner',
      sourceId: 'TEST-source',
      sourceTeamName: 'TEST-old',
      sourceRevision: 'a'.repeat(64),
      savedSettings: { cwd: '/TEST/workspace', providerId: 'codex', skipPermissions: false },
      members: [
        {
          memberId: 'TEST-stable-lead',
          name: 'team-lead',
          role: 'lead',
          settings: { model: 'TEST-model' },
        },
      ],
      obligations: {
        launch: 'released',
        bootstrap: 'released',
        lane: 'released',
        session: 'released',
        stop: 'released',
        command: 'released',
        delivery: 'released',
        custody: 'released',
        background: 'released',
      },
      gaps: [],
    };
    const snapshot = await exportStoppedTeam({
        roots,
        describe: async () => structuredClone(header),
        fenced: (read) => read(),
      }),
      raw = profile(destination),
      request = {
        contextId: 'TEST-context',
        sourceId: header.sourceId,
        snapshotDigest: snapshot.digest,
        teamName: 'TEST-imported',
      };
    const snapshots = new FileStoppedSnapshotResolver({
      root: destination,
      ownerId: raw.owner.ownerId,
      profileId: raw.owner.profileId,
      principalId: raw.principalId,
      contextIds: ['TEST-context'],
      assertCurrent() {},
    });
    snapshots.stage(request, snapshot);
    // An interrupted original remains reserved across actual Host startup; startup cannot finish it implicitly.
    const heldPublisher = new FileStoppedTeamImport({
      root: destination,
      ownerId: raw.owner.ownerId,
      profileId: raw.owner.profileId,
      principalId: raw.principalId,
      contextIds: ['TEST-context'],
      assertWriter() {},
      existingRecords: () => [],
      validateConfiguration() {},
      bindOrigin() {},
      attach() {
        throw new Error('TEST-interruption-before-publication');
      },
    });
    const held = heldPublisher.import(
      'TEST-held-command',
      { ...request, teamName: 'TEST-held' },
      snapshot
    );
    assert.equal(held.phase, 'held');
    let host = openHost(raw);
    t.after(() => host.close());
    await host.rpc('host.handshake', { protocolVersion: 1 });
    const envelope = { owner: raw.owner, commandId: 'TEST-import-command', payload: request };
    assert.equal(
      (
        await host.rpc('team.import.publish', {
          ...envelope,
          owner: { ...raw.owner, profileId: 'TEST-foreign' },
        })
      ).ok,
      false
    );
    assert.equal(
      (
        await host.rpc('team.import.publish', {
          ...envelope,
          payload: { ...request, snapshotPath: '/TEST/no-public-path' },
        })
      ).ok,
      false
    );
    const published = await host.rpc('team.import.publish', envelope);
    assert.equal(published.ok, true);
    const receipt = published.value as {
      commandId: string;
      phase: string;
      record: {
        contextId: string;
        teamId: string;
        teamName: string;
        binding: { handleId: string; scope: unknown };
      };
      source: unknown;
    };
    assert.equal(receipt.phase, 'published');
    assert.deepEqual(receipt.source, {
      sourceId: request.sourceId,
      snapshotDigest: snapshot.digest,
    });
    assert.equal(JSON.stringify(published).includes(destination), false);
    const catalog = await host.rpc('team.registry.list', {
      owner: raw.owner,
      commandId: 'TEST-list',
      payload: { contextId: 'TEST-context' },
    });
    assert.deepEqual((catalog.value as { teams: unknown[] }).teams, [receipt.record]);
    const product = JSON.parse(
      readFileSync(join(destination, 'tasks/TEST-imported/TEST-task.json'), 'utf8')
    ) as { descriptionTaskRefs: { teamName: string }[] };
    assert.equal(product.descriptionTaskRefs[0]!.teamName, 'TEST-imported');
    assert.match(product.descriptionTaskRefs[1]!.teamName, /^legacy-archive:[a-f0-9]{64}$/);
    const collision = await host.rpc('team.registry.create', {
      owner: raw.owner,
      commandId: 'TEST-no-replacement',
      payload: {
        contextId: 'TEST-context',
        teamName: 'TEST-imported',
        savedSettings: header.savedSettings,
        members: [],
      },
    });
    assert.equal(collision.ok, false);
    const heldLookup = await host.rpc('team.import.lookup', {
      owner: raw.owner,
      commandId: 'TEST-held-command',
      payload: { contextId: 'TEST-context' },
    });
    assert.deepEqual(heldLookup, { ok: true, value: held });
    const heldCollision = await host.rpc('team.registry.create', {
      owner: raw.owner,
      commandId: 'TEST-held-collision',
      payload: {
        contextId: 'TEST-context',
        teamName: 'TEST-held',
        savedSettings: header.savedSettings,
        members: [],
      },
    });
    assert.equal(heldCollision.ok, false);
    await host.close();
    rmSync(sourceRoot, { recursive: true });
    rmSync(join(destination, '.host-team-registry/snapshots'), { recursive: true });
    host = openHost(raw);
    await host.rpc('host.handshake', { protocolVersion: 1 });
    assert.deepEqual(
      await host.rpc('team.import.lookup', {
        owner: raw.owner,
        commandId: envelope.commandId,
        payload: { contextId: 'TEST-context' },
      }),
      published
    );
    assert.deepEqual(await host.rpc('team.import.publish', envelope), published);
    assert.deepEqual(
      await host.rpc('team.import.lookup', {
        owner: raw.owner,
        commandId: 'TEST-held-command',
        payload: { contextId: 'TEST-context' },
      }),
      heldLookup
    );
    const coldCatalog = await host.rpc('team.registry.list', {
      owner: raw.owner,
      commandId: 'TEST-cold-list',
      payload: { contextId: 'TEST-context' },
    });
    assert.deepEqual((coldCatalog.value as { teams: unknown[] }).teams, [receipt.record]);
    assert.equal(
      (
        await host.rpc('team.import.lookup', {
          owner: raw.owner,
          commandId: envelope.commandId,
          payload: { contextId: 'TEST-foreign' },
        })
      ).ok,
      false
    );
  }
);
