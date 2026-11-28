import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';

import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { admitRegistryTeamNamespace } from '../dist/adapters/team-registry/admitRegistryTeamNamespace.js';
import { FileTeamRegistryStore } from '../dist/adapters/team-registry/FileTeamRegistryStore.js';
import { createTeamRegistryMethods } from '../dist/composition/createTeamCreationMethods.js';
import {
  DEFAULT_HOST_LIMITS,
  hostMethodFrameLimit,
  hostProfileLimitCaps,
} from '../dist/contracts.js';
import { HostOutput } from '../dist/output.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import {
  teamRegistryListSchema,
  teamRegistryRecordSchema,
  teamRegistryReceiptSchema,
} from '../dist/team-registry/contracts.js';
import { pageTeamRegistryCatalog } from '../dist/team-registry/pageTeamRegistryCatalog.js';
import { TeamRegistry } from '../dist/team-registry/TeamRegistry.js';

import type { JsonValue } from '../dist/contracts.js';
import type { TeamRegistryList } from '../dist/team-registry/contracts.js';

function fixture(t: TestContext, count = 18) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-registry-pages-')));
  const lease = acquireProfileWriterLease(root);
  t.after(() => {
    lease.release();
    rmSync(root, { recursive: true, force: true });
  });
  const owner = { ownerId: 'TEST-owner', profileId: 'TEST-profile', revision: 'TEST-revision' };
  const store = new FileTeamRegistryStore(root, () => lease.assertCurrent());
  const registry = new TeamRegistry({
    ownerId: owner.ownerId,
    profileId: owner.profileId,
    principalId: 'TEST-principal',
    contextIds: ['TEST-context', 'TEST-other-context'],
    staticTeams: [],
    store,
    assertWriter: () => lease.assertCurrent(),
    admit: (definition, fresh, published) =>
      admitRegistryTeamNamespace(root, definition.binding, fresh, published),
    attach: (definition) => {
      createFilesystemTeamOwner({
        root,
        binding: definition.binding,
        ...(definition.savedSettings === undefined
          ? {}
          : { savedSettings: definition.savedSettings }),
        members: definition.members.map(({ memberId, name, role, delivery, settings }) => ({
          memberId,
          name,
          role,
          ...(delivery ? { delivery } : {}),
          ...(settings === undefined ? {} : { settings }),
        })),
        grants: definition.grants.map(({ principalId, memberName, permissions, revoked }) => ({
          principalId,
          memberName,
          permissions,
          ...(revoked === undefined ? {} : { revoked }),
        })),
      });
    },
  });
  for (let index = 0; index < count; index++) {
    const receipt = registry.create('TEST-create-' + index, {
      contextId: 'TEST-context',
      teamName: 'test-team-' + index,
      savedSettings: {
        cwd: root,
        displayName: 'Team ' + index,
        description: 'x'.repeat(60_000),
        color: 'blue',
      },
      members: [{ name: 'worker', memberSettings: { role: 'TEST researcher' } }],
    });
    assert.equal(receipt.phase, 'published');
  }
  let reads = 0;
  const methods = () => {
    const selected = createTeamRegistryMethods({
      select(raw) {
        lease.assertCurrent();
        assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
        const input = raw as { owner: unknown; commandId: string; payload: unknown };
        if (JSON.stringify(input.owner) !== JSON.stringify(owner))
          throw new TeamOwnerError('forbidden');
        return {
          registry: {
            create: registry.create.bind(registry),
            lookup: registry.lookup.bind(registry),
            list(contextId) {
              reads++;
              return registry.list(contextId);
            },
          },
          commandId: input.commandId,
          payload: input.payload,
        };
      },
    });
    const method = selected['team.registry.list']!;
    return {
      'team.registry.list': {
        handle: (input: JsonValue) =>
          method.handle(input, {
            requestId: 'TEST-registry-read',
            signal: new AbortController().signal,
          }),
      },
    };
  };
  return { root, owner, registry, store, methods, reads: () => reads };
}

test('small and empty registry catalogs keep the exact legacy JSON shape', async (t) => {
  for (const count of [0, 2]) {
    const f = fixture(t, count),
      expected = f.registry.list('TEST-context');
    const response = await f.methods()['team.registry.list']!.handle({
      owner: f.owner,
      commandId: 'TEST-small',
      payload: { contextId: 'TEST-context' },
    });
    assert.equal(JSON.stringify(success(response)), JSON.stringify(expected));
    assert.equal(f.reads(), 1);
  }
});

test('registry cursor syntax is rejected before any original catalog read', async (t) => {
  const f = fixture(t, 0),
    method = f.methods()['team.registry.list']!;
  for (const cursor of [
    '',
    null,
    1,
    'invalid',
    '0.' + 'a'.repeat(64),
    '1.' + 'a'.repeat(63),
    '1.' + 'A'.repeat(64),
    '1.' + 'a'.repeat(64) + '\n',
    '1.' + 'a'.repeat(64) + '\r',
    '1.' + 'a'.repeat(64) + '\r\n',
  ]) {
    assert.deepEqual(
      await method.handle({
        owner: f.owner,
        commandId: 'TEST-invalid',
        payload: { contextId: 'TEST-context', cursor },
      }),
      { ok: false, code: 'invalid', outcome: 'rejected' }
    );
  }
  assert.deepEqual(
    await method.handle({
      owner: f.owner,
      commandId: 'TEST-extra',
      payload: { contextId: 'TEST-context', extra: true },
    }),
    { ok: false, code: 'invalid', outcome: 'rejected' }
  );
  assert.equal(f.reads(), 0);
});

test('registry continuation retains its original factory, owner and context', async (t) => {
  const f = fixture(t),
    method = f.methods()['team.registry.list']!;
  const first = success(
    await method.handle({
      owner: f.owner,
      commandId: 'TEST-first',
      payload: { contextId: 'TEST-context' },
    })
  );
  assert.equal(first.kind, 'team-registry-page');
  assert.ok(typeof first.nextCursor === 'string');
  const request = {
    owner: f.owner,
    commandId: 'TEST-next',
    payload: { contextId: 'TEST-context', cursor: first.nextCursor },
  };
  for (const response of [
    await f.methods()['team.registry.list']!.handle(request),
    await method.handle({
      ...request,
      payload: { ...request.payload, contextId: 'TEST-other-context' },
    }),
    await method.handle({
      ...request,
      payload: { ...request.payload, cursor: '255.' + 'a'.repeat(64) },
    }),
  ])
    assert.deepEqual(response, { ok: false, code: 'hold', outcome: 'unknown' });
  const reads = f.reads();
  assert.deepEqual(
    await method.handle({ ...request, owner: { ...f.owner, revision: 'changed' } }),
    { ok: false, code: 'forbidden', outcome: 'rejected' }
  );
  assert.equal(f.reads(), reads);
  const original = success(await method.handle(request));
  assert.equal(original.kind, 'team-registry-page');
  assert.deepEqual(success(await method.handle({ ...request, commandId: 'TEST-retry' })), original);
});

test('original receipt phase changes invalidate a cursor without losing held records on a fresh read', async (t) => {
  const f = fixture(t),
    method = f.methods()['team.registry.list']!;
  const first = success(
    await method.handle({
      owner: f.owner,
      commandId: 'TEST-first',
      payload: { contextId: 'TEST-context' },
    })
  );
  assert.ok(typeof first.nextCursor === 'string');
  const saved = f.store.readAll()[0]!;
  f.store.fenced(() => f.store.write({ ...saved, phase: 'held' }));
  assert.deepEqual(
    await method.handle({
      owner: f.owner,
      commandId: 'TEST-next',
      payload: { contextId: 'TEST-context', cursor: first.nextCursor },
    }),
    { ok: false, code: 'hold', outcome: 'unknown' }
  );
  const expected = f.registry.list('TEST-context');
  assert.deepEqual(expected.held, [
    { commandId: saved.commandId, phase: 'held', record: saved.record },
  ]);
  const actual: TeamRegistryList = { teams: [], held: [] };
  let cursor: string | undefined;
  do {
    const value = success(
      await method.handle({
        owner: f.owner,
        commandId: 'TEST-fresh',
        payload: { contextId: 'TEST-context', ...(cursor === undefined ? {} : { cursor }) },
      })
    );
    const parsed = teamRegistryListSchema.parse({ teams: value.teams, held: value.held });
    actual.teams.push(...parsed.teams);
    actual.held.push(...parsed.held);
    assert.ok(value.nextCursor === null || typeof value.nextCursor === 'string');
    cursor = value.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(actual, expected);
});

test('every ordered registry field participates in the continuation revision', (t) => {
  const f = fixture(t),
    original = f.registry.list('TEST-context');
  original.held.push({
    commandId: 'TEST-held',
    phase: 'pending',
    record: {
      ...original.teams[0]!,
      teamId: 'held-team',
      teamName: 'held-team',
      binding: { ...original.teams[0]!.binding, handleId: 'held-handle' },
    },
  });
  const options = { catalog: original, key: 'TEST-key', contextId: 'TEST-context' };
  const first = pageTeamRegistryCatalog(options);
  assert.ok('kind' in first && first.nextCursor);
  const mutations = [
    (value: TeamRegistryList) => {
      value.teams[0]!.description += 'changed';
    },
    (value: TeamRegistryList) => {
      value.teams.reverse();
    },
    (value: TeamRegistryList) => {
      value.teams[0]!.members[0]!.label = 'changed';
    },
    (value: TeamRegistryList) => {
      value.held[0]!.phase = 'held';
    },
  ];
  for (const mutate of mutations) {
    const catalog = structuredClone(original);
    mutate(catalog);
    assert.throws(
      () => pageTeamRegistryCatalog({ ...options, catalog, cursor: first.nextCursor! }),
      (error) => error instanceof TeamOwnerError && error.code === 'hold'
    );
  }
  assert.throws(() =>
    pageTeamRegistryCatalog({ ...options, contextId: 'foreign', cursor: first.nextCursor! })
  );
  assert.throws(() =>
    pageTeamRegistryCatalog({ ...options, key: 'foreign', cursor: first.nextCursor! })
  );
});

function maximumRecord() {
  const escaped = '\u0001',
    id = escaped.repeat(256),
    segment = 't'.repeat(128);
  return teamRegistryRecordSchema.parse({
    contextId: id,
    teamId: segment,
    teamName: segment,
    displayName: id,
    projectContextMode: 'per_project',
    projectContext: {
      logicalTeamId: segment,
      logicalHandleId: id,
      workContextId: id,
      projectKey: 'a'.repeat(64),
      projectPath: escaped.repeat(8192),
    },
    description: escaped.repeat(64 * 1024),
    color: id,
    members: Array.from({ length: 256 }, (_, index) => ({
      memberId: 'm' + String(index).padStart(127, 'x'),
      label: 'u' + String(index).padStart(127, 'x'),
    })),
    binding: {
      schemaVersion: 1,
      handleId: id,
      scope: {
        projectId: id,
        workspaceId: id,
        teamId: segment,
        runId: id,
        memberId: id,
        generation: id,
      },
    },
  });
}

test('maximal strict-schema records and receipts exceed 512 KiB but each fits a complete bounded page', async (t) => {
  const row = maximumRecord();
  const receipt = teamRegistryReceiptSchema.parse({
    commandId: '\u0001'.repeat(256),
    phase: 'published',
    record: {
      ...row,
      teamId: 'r'.repeat(128),
      teamName: 'r'.repeat(128),
      binding: {
        ...row.binding,
        handleId: '\u0002'.repeat(256),
        scope: { ...row.binding.scope, teamId: 'r'.repeat(128) },
      },
    },
  });
  assert.equal(Buffer.byteLength(JSON.stringify(row)), 532_672);
  assert.equal(Buffer.byteLength(JSON.stringify(receipt)), 534_254);
  const catalog = { teams: [row], held: [receipt] };
  for (const profile of [undefined, 'review-v1'] as const) {
    const wire = transport(t, profile),
      rows: TeamRegistryList = { teams: [], held: [] };
    let cursor: string | undefined,
      pages = 0;
    do {
      const page = pageTeamRegistryCatalog({
        catalog,
        key: 'TEST-maximal',
        contextId: row.contextId,
        ...(cursor === undefined ? {} : { cursor }),
      });
      assert.ok('kind' in page);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 768 * 1024);
      rows.teams.push(...page.teams);
      rows.held.push(...page.held);
      const response: JsonValue = JSON.parse(JSON.stringify({ ok: true, value: page }));
      assert.equal(
        wire.output.sendPriority(
          { jsonrpc: '2.0', id: 'TEST-max-' + pages, result: response },
          hostMethodFrameLimit('team.registry.list', profile)
        ),
        true
      );
      cursor = page.nextCursor ?? undefined;
      pages++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (cursor);
    assert.equal(pages, 2);
    assert.deepEqual(rows, catalog);
    assert.deepEqual(wire.failures, []);
    assert.equal(wire.frames.length, 2);
  }
});

function success(response: JsonValue) {
  assert.ok(response && typeof response === 'object' && !Array.isArray(response));
  assert.equal(response.ok, true);
  const value = response.value;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value;
}

function transport(t: TestContext, profile?: 'review-v1') {
  const failures: string[] = [],
    frames: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      frames.push(Buffer.from(chunk));
      callback();
    },
  });
  const output = new HostOutput(
    stream,
    profile === undefined ? DEFAULT_HOST_LIMITS : hostProfileLimitCaps(profile),
    (reason) => {
      failures.push(reason);
    }
  );
  t.after(() => output.stop());
  return { output, frames, failures };
}

for (const profile of [undefined, 'review-v1'] as const) {
  test(
    'actual registry preserves all 18 long descriptions within ordinary HostOutput frames: ' +
      (profile ?? 'default'),
    async (t) => {
      const f = fixture(t),
        expected = f.registry.list('TEST-context');
      assert.equal(expected.teams.length, 18);
      assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 1024 * 1024);
      const wire = transport(t, profile),
        method = f.methods()['team.registry.list']!;
      const limit = hostMethodFrameLimit('team.registry.list', profile);
      assert.equal(limit, DEFAULT_HOST_LIMITS.maxFrameBytes);
      let cursor: string | undefined,
        count = 0;
      do {
        const response = await method.handle({
          owner: f.owner,
          commandId: 'TEST-list',
          payload: { contextId: 'TEST-context', ...(cursor === undefined ? {} : { cursor }) },
        });
        assert.equal(
          wire.output.sendPriority(
            {
              jsonrpc: '2.0',
              id: 'TEST-frame-' + count,
              result: response,
            },
            limit
          ),
          true,
          'every actual registry response must fit the unchanged 1 MiB frame'
        );
        const value = success(response);
        assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 768 * 1024);
        if (value.kind === 'team-registry-page') {
          assert.equal(value.totalTeams, expected.teams.length);
          assert.equal(value.totalHeld, expected.held.length);
          assert.ok(value.nextCursor === null || typeof value.nextCursor === 'string');
          cursor = value.nextCursor ?? undefined;
        } else cursor = undefined;
        assert.ok(++count <= 256);
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (cursor);
      assert.ok(count > 1);
      assert.deepEqual(wire.failures, []);
      assert.equal(wire.frames.length, count);
      const actual: TeamRegistryList = { teams: [], held: [] };
      for (const frame of wire.frames) {
        assert.ok(frame.length <= limit + 1);
        const message = JSON.parse(frame.toString('utf8')) as { result: JsonValue };
        const value = success(message.result);
        const parsed = teamRegistryListSchema.parse({ teams: value.teams, held: value.held });
        actual.teams.push(...parsed.teams);
        actual.held.push(...parsed.held);
      }
      assert.deepEqual(actual, expected);
    }
  );
}
