import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';

import { record } from './fixtures/native-claude-team/model.ts';
import { fileHash, startHost, treeHash } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

// Finishes observation of one completed original TEST capture. No original user
// intent, tool or agent input is resubmitted. Only exact-ID receipt replays occur.
test('reconciles original mixed capture notifications, activity, shutdown and receipt restart without repeating native effects', { timeout: 60_000 }, async () => {
  assert.equal(process.env.LEGACY_NATIVE_MIXED_RECONCILE_GO, '1');
  const selected = process.env.LEGACY_NATIVE_MIXED_CAPTURE_ROOT;
  assert.ok(selected);
  const root = await realpath(selected);
  assert.equal(root, selected);
  assert.equal(root, join(await realpath(tmpdir()), basename(root)));
  assert.match(basename(root), /^TEST-native-mixed-host-/);
  const originalBytes = await readFile(join(root, 'receipt.json'));
  const originalSha256 = createHash('sha256').update(originalBytes).digest('hex');
  assert.equal(originalSha256, process.env.LEGACY_NATIVE_MIXED_CAPTURE_SHA256);
  const original = record(JSON.parse(originalBytes.toString('utf8')));
  assert.equal(original.status, 'INCOMPLETE');
  assert.equal(original.cleanupConfirmed, true);
  assert.ok((original.hosts as unknown[]).map(record).every((host) => host.exitCode === 0 && host.signalCode === null && host.stdoutValid === true));
  assert.deepEqual(original.modelFailures, [[], [], []]);
  const repo = resolve(import.meta.dirname, '../../..');
  const pkg = join(repo, 'packages/legacy-agent-host');
  const node = await realpath(join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node'));
  assert.equal(await realpath(process.execPath), node);
  const artifacts = record(original.artifacts);
  assert.equal(await treeHash(join(pkg, 'src'), '.ts'), artifacts.source);
  assert.equal(await treeHash(join(pkg, 'dist'), '.js'), artifacts.dist);
  const entry = join(pkg, 'dist/cli.js');
  assert.equal(await fileHash(entry), artifacts.entry);
  const profilePath = join(root, 'profile.json');
  const bytes = await readFile(profilePath, 'utf8');
  const profile = JSON.parse(bytes) as TeamHostProfile;
  assert.equal(profile.owner.storageRoot, join(root, 'store'));
  const scope = profile.teams[0]!.scope;
  const binding = { schemaVersion: 1, handleId: 'TEST-mixed-handle', owner: profile.owner, scope };
  const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
  const receipts = (original.businessReceipts as unknown[]).map(record);
  assert.equal(receipts.length, 6);
  const beforeEffects = await Promise.all(['alice', 'bob', 'carol'].map((name) => readFile(join(root, name, 'workspace/native-effect.txt'), 'utf8')));
  assert.deepEqual(beforeEffects, ['ONE\nTWO\n', 'ONE\nTWO\n', 'ONE\nTWO\n']);
  const host = startHost({ node, entry, root, profile: profilePath, profileHash: createHash('sha256').update(bytes).digest('hex') });
  const snapshots: Record<string, unknown> = {};
  let passed = false, cleanupConfirmed = false;
  try {
    await host.rpc('host.handshake', { protocolVersion: 1 });
    const tasksReply = await host.rpc('team.tasks.list', envelope('TEST-reconcile-tasks', null));
    assert.equal(tasksReply.ok, true);
    const tasks = (tasksReply.value as unknown[]).map(record);
    assert.equal(tasks.length, 3);
    const allInputIds = new Set<unknown>();
    for (const name of ['alice', 'bob', 'carol']) {
      const memberId = name + '-id';
      const read = await host.rpc('runtime.read', envelope('TEST-reconcile-read', { memberId }));
      assert.equal(read.ok, true);
      const state = record(read.value);
      assert.equal(state.attached, false);
      assert.equal(state.phase, 'closed');
      assert.equal(state.custody, 'released');
      const inputs = (state.inputs as unknown[]).map(record);
      const ids = new Set(inputs.map((input) => input.inputId));
      assert.ok(inputs.length >= 2);
      for (const input of inputs) {
        assert.equal(input.phase, 'terminal'); assert.equal(input.terminal, 'succeeded');
        assert.equal(allInputIds.has(input.inputId), false, 'different members have disjoint input identities');
        allInputIds.add(input.inputId);
        assert.match(String(input.inputId), /^[a-f0-9-]{36}$/);
        const outbox = record(JSON.parse(await readFile(join(root, 'store/teams/test-native-team/.host-owner/outbox', String(input.inputId) + '.json'), 'utf8')));
        assert.equal(record(outbox.binding).memberId, memberId);
        assert.equal(outbox.inputId, input.inputId); assert.equal(outbox.phase, 'admitted');
      }
      for (const receipt of receipts.filter((row) => row.memberId === memberId))
        assert.ok(ids.has(receipt.inputId));
      const activityReply = await host.rpc('runtime.activity.snapshot', envelope('TEST-reconcile-activity', { memberId }));
      assert.equal(activityReply.ok, true);
      const activity = record(activityReply.value), latest = record(activity.latest);
      const events = [...latest.text as unknown[], ...latest.tools as unknown[]].map(record);
      assert.ok(events.length > 0);
      assert.ok(events.every((event) => ids.has(event.inputId)), 'activity belongs to original member inputs, including notifications');
      const task = tasks.find((row) => row.owner === name);
      assert.ok(task); assert.equal(task.status, 'completed'); assert.equal(task.createdBy, name);
      assert.ok((task.historyEvents as unknown[]).map(record).every((event) => event.actor === name));
      assert.equal(record((task.comments as unknown[])[0]).author, name);
      snapshots[memberId] = { state, activity };
    }
    const inbox = (JSON.parse(await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')) as unknown[]).map(record);
    const replies = inbox.filter((row) => String(row.text).startsWith('REPLY_'));
    assert.equal(replies.length, 6);
    assert.equal(new Set(replies.map((row) => row.messageId)).size, 6);
    for (const name of ['alice', 'bob', 'carol']) assert.equal(replies.filter((row) => row.from === name).length, 2);
    for (const row of receipts) {
      assert.deepEqual(await host.rpc('team.lookup', row.command), row.receipt);
      assert.deepEqual(await host.rpc('team.execute', row.command), row.receipt);
    }
    assert.deepEqual(await Promise.all(['alice', 'bob', 'carol'].map((name) => readFile(join(root, name, 'workspace/native-effect.txt'), 'utf8'))), beforeEffects);
    passed = true;
  } finally {
    try { await host.close(); cleanupConfirmed = true; }
    finally {
      await writeFile(join(root, 'reconcile-receipt.json'), JSON.stringify({ status: passed && cleanupConfirmed ? 'PASS' : 'INCOMPLETE',
        originalReceiptSha256: originalSha256, scope: 'Original mixed native effects plus corrected notification-aware observation and captured Host restart/receipt replay; no native re-execution',
        snapshots, host: host.facts(), cleanupConfirmed, nativeInputsResubmitted: 0,
        harnessSha256: await fileHash(import.meta.filename) }, null, 2), { mode: 0o600, flag: 'wx' });
    }
  }
});
