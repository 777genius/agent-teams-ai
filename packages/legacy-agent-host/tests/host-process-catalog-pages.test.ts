import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { DEFAULT_HOST_LIMITS, hostMethodFrameLimit, hostProfileLimitCaps } from '../dist/contracts.js';
import { HostOutput } from '../dist/output.js';
import { createTeamProcessMethods } from '../dist/process/createTeamProcessMethods.js';
import type { JsonValue } from '../dist/contracts.js';

function fixture(t: TestContext, count = 250) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-desktop-process-pages-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const team = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-process-pages' };
  const delivery = { ...team, runId: 'TEST-run', memberId: 'TEST-member', generation: '1' };
  const owner = createFilesystemTeamOwner({
    root, binding: team,
    members: [{ memberId: 'TEST-lead', name: 'lead', role: 'lead' },
      { memberId: 'TEST-member', name: 'alice', role: 'member', delivery }],
    grants: [{ principalId: 'alice', memberName: 'alice',
      permissions: ['read', 'admin', 'process.write'] }],
  });
  const writer = owner.processCommands('alice', { registrar: () => delivery });
  for (let index = 0; index < count; index++)
    assert.equal(writer.register('TEST-register-' + index, {
      pid: 2000 + index, label: 'TEST original service ' + index,
      command: 'x'.repeat(4096),
    }).phase, 'completed');
  const port = owner.processCommands('alice');
  const binding = {
    schemaVersion: 1, handleId: 'TEST-original-handle',
    owner: { ownerId: 'TEST-owner', revision: 'TEST-revision', storageRoot: root },
    scope: { teamId: team.teamId, projectId: 'TEST-project', workspaceId: 'TEST-workspace' },
  };
  let current = true, reads = 0;
  const assertCurrent = () => {
    if (!current) throw new Error('process:forbidden');
  };
  const counted = (original: typeof port) => ({
    ...original, list() { reads++; return original.list(); },
  });
  const commands = counted(port);
  const methods = (selected?: typeof commands) => createTeamProcessMethods({
    resolve(raw) {
      assertCurrent();
      assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
      const input = raw as typeof binding;
      assert.deepEqual(input.owner, binding.owner);
      assert.deepEqual(input.scope, binding.scope);
      assert.equal(input.schemaVersion, 1);
      assert.ok(['TEST-original-handle', 'TEST-other-handle'].includes(input.handleId));
      // Real composition creates a fresh command facade for every request.
      return { commands: selected ?? counted(owner.processCommands('alice')), assertCurrent };
    },
  });
  return { owner, port, binding, commands, methods,
    reads: () => reads, revoke() { current = false; } };
}

function success(response: JsonValue) {
  assert.ok(response && typeof response === 'object' && !Array.isArray(response));
  assert.equal(response.ok, true);
  return response.value;
}

function page(response: JsonValue) {
  const value = success(response);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.kind, 'process-catalog-page');
  const rows = value.processes, next = value.nextCursor;
  assert.ok(Array.isArray(rows));
  assert.ok(next === null || typeof next === 'string');
  return { rows, next, total: value.total };
}

function transport(t: TestContext, profile?: 'review-v1') {
  const failures: string[] = [], frames: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      frames.push(Buffer.from(chunk));
      callback();
    },
  });
  const output = new HostOutput(stream,
    profile === undefined ? DEFAULT_HOST_LIMITS : hostProfileLimitCaps(profile),
    reason => { failures.push(reason); });
  t.after(() => output.stop());
  return { output, failures, frames };
}

test('actual Desktop handler sends all 250 canonical 4KiB registrations through bounded HostOutput frames',
  async t => {
    const f = fixture(t), expected = f.port.list();
    assert.equal(expected.length, 250);
    assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 1024 * 1024);
    for (const profile of [undefined, 'review-v1'] as const) {
      const bounded = transport(t, profile), method = f.methods()['team.process.list']!;
      const limit = hostMethodFrameLimit('team.process.list', profile);
      assert.equal(limit, DEFAULT_HOST_LIMITS.maxFrameBytes);
      let cursor: string | undefined, count = 0;
      do {
        const response = await method.handle({
          binding: f.binding, commandId: 'TEST-list-' + count,
          payload: cursor === undefined ? {} : { cursor },
        });
        assert.equal(bounded.output.sendPriority({
          jsonrpc: '2.0', id: 'TEST-frame-' + count, result: response,
        }, limit), true, 'the actual Desktop response must fit its unchanged priority limit');
        const value = page(response);
        assert.equal(value.total, expected.length);
        assert.ok(Buffer.byteLength(JSON.stringify(success(response))) <= 240 * 1024);
        cursor = value.next ?? undefined;
        assert.ok(++count < 128);
        await new Promise<void>(resolve => setImmediate(resolve));
      } while (cursor);
      assert.ok(count > 1);
      assert.deepEqual(bounded.failures, []);
      assert.equal(bounded.frames.length, count);
      const decoded = bounded.frames.flatMap(frame => {
        assert.ok(frame.length <= limit + 1);
        const message = JSON.parse(frame.toString('utf8')) as { result: JsonValue };
        return page(message.result).rows;
      });
      assert.deepEqual(decoded, expected);
      bounded.output.stop();
    }
  });

test('Desktop continuations cannot cross a validated binding or a new Host factory with identical rows',
  async t => {
    const f = fixture(t), method = f.methods()['team.process.list']!;
    const first = page(await method.handle({
      binding: f.binding, commandId: 'TEST-first', payload: {},
    }));
    assert.ok(first.next);
    const request = { binding: f.binding, commandId: 'TEST-next', payload: { cursor: first.next } };
    const anotherHandle = await method.handle({
      ...request, binding: { ...f.binding, handleId: 'TEST-other-handle' },
    });
    const anotherHost = await f.methods()['team.process.list']!.handle(request);
    for (const response of [anotherHandle, anotherHost]) {
      assert.ok(response && typeof response === 'object' && !Array.isArray(response));
      assert.equal(response.ok, false);
      assert.equal(response.code, 'hold');
    }
    assert.ok(page(await method.handle(request)).rows.length > 0,
      'the original continuation remains available after foreign read refusals');
  });

test('Desktop cursor payload rejects malformed and unknown fields before reading the Owner', async t => {
  const f = fixture(t, 0), method = f.methods()['team.process.list']!;
  for (const payload of [
    { cursor: '' }, { cursor: 'invalid' }, { cursor: 1 }, { cursor: null },
    { cursor: '0.' + 'a'.repeat(64) }, { cursor: '1.' + 'a'.repeat(63) },
    { cursor: '1.' + 'A'.repeat(64) }, { cursor: '1.' + 'a'.repeat(64) + '\n' },
    { cursor: '1.' + 'a'.repeat(64) + '\r' }, { cursor: '1.' + 'a'.repeat(64) + '\r\n' },
    { extra: true },
    { cursor: '1.' + 'a'.repeat(64), extra: true },
  ]) {
    assert.deepEqual(await method.handle({
      binding: f.binding, commandId: 'TEST-invalid', payload,
    }), { ok: false, code: 'invalid', outcome: 'not-dispatched' });
  }
  assert.equal(f.reads(), 0);
});

test('Desktop process small and empty catalogs preserve the existing complete array shape', async t => {
  for (const count of [0, 2]) {
    const f = fixture(t, count), expected = f.port.list();
    const response = await f.methods()['team.process.list']!.handle({
      binding: f.binding, commandId: 'TEST-small', payload: {},
    });
    assert.deepEqual(success(response), expected);
    assert.equal(f.reads(), 1);
  }
});

test('changed process metadata invalidates the original Desktop continuation without publishing a prefix',
  async t => {
    const f = fixture(t), method = f.methods()['team.process.list']!;
    const first = page(await method.handle({
      binding: f.binding, commandId: 'TEST-first', payload: {},
    }));
    assert.ok(first.next);
    const original = f.port.list()[0]!;
    f.port.metadata('TEST-metadata-stop', 'metadata-stop', { id: original.id });
    const response = await method.handle({
      binding: f.binding, commandId: 'TEST-next', payload: { cursor: first.next },
    });
    assert.deepEqual(response, { ok: false, code: 'hold', outcome: 'unknown' });
  });

test('the Desktop list retains async Windows observation and fences revocation before publication', async t => {
  const f = fixture(t, 1), original = f.port.list()[0]!;
  let settle!: () => void, started = false;
  const barrier = new Promise<void>(resolve => { settle = resolve; });
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected native effect'); };
  const windows: NonNullable<typeof f.port.windows> = {
    reconcileNaturalAbsence: unexpected, register: unexpected, terminate: unexpected, lookup: unexpected,
    async list(deadline) {
      started = true;
      assert.ok(deadline > performance.now());
      assert.ok(deadline <= performance.now() + 10_000);
      await barrier;
      return [{ ...original, observation: 'same-live', canTerminate: true }];
    },
  };
  const selected = { ...f.commands, windows };
  const response = f.methods(selected)['team.process.list']!.handle({
    binding: f.binding, commandId: 'TEST-original-windows-read', payload: {},
  });
  assert.equal(started, true);
  assert.equal(f.reads(), 0, 'a Windows list never falls back to the synchronous snapshot port');
  f.revoke();
  settle();
  assert.deepEqual(await response, { ok: false, code: 'forbidden', outcome: 'unknown' });
});
