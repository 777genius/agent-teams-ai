import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { AttachmentReference } from '../dist/attachments/uploadContracts.js';

const nodeExecutable = realpathSync(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);

const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

test(
  'changed private profile refuses before writer or product state creation',
  { timeout: 10000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-profile-refusal-')));
    const profile = join(root, 'profile.json');
    writeFileSync(
      profile,
      JSON.stringify({ schemaVersion: 1, secretMarker: 'TEST-private-marker' })
    );
    const child = spawn(
      nodeExecutable,
      [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
      {
        cwd: root,
        env: {
          HOME: root,
          PATH: dirname(nodeExecutable),
          LEGACY_AGENT_HOST_PROFILE_PATH: profile,
          LEGACY_AGENT_HOST_PROFILE_SHA256: '0'.repeat(64),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const exit = once(child, 'exit');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const [code] = await exit;
      assert.equal(code, 1);
      assert.equal(stdout, '');
      assert.equal(stderr.includes('TEST-private-marker'), false);
      assert.deepEqual(readdirSync(root), ['profile.json']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'captured CLI owns canonical Team effects, frames policy diagnostics, and recovers same receipts',
  { timeout: 15000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-host-')));
    const store = join(root, 'store');
    mkdirSync(store);
    const hostEntry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const owner = {
      ownerId: 'TEST-backend',
      revision: 'TEST-revision',
      storageRoot: store,
      profileId: 'TEST-profile',
      protocolVersion: 1 as const,
      buildId: 'TEST-product-host',
      nodeSha256: sha(readFileSync(nodeExecutable)),
      hostEntrySha256: sha(readFileSync(hostEntry)),
    };
    const scope = {
      projectId: 'TEST-project',
      workspaceId: 'TEST-workspace',
      teamId: 'TEST-team-id',
      runId: 'TEST-run',
      memberId: 'human',
      generation: '1',
    };
    const profile: TeamHostProfile = {
      schemaVersion: 1,
      owner,
      principalId: 'captured-human',
      teams: [
        {
          scope,
          binding: { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-team' },
          members: [{ memberId: 'alice-id', name: 'alice', role: 'member' }],
          grants: [
            {
              principalId: 'captured-human',
              memberName: 'user',
              permissions: ['read', 'task.write', 'message.write', 'admin'],
            },
          ],
        },
      ],
    };
    const profilePath = join(root, 'profile.json');
    const bytes = JSON.stringify(profile);
    writeFileSync(profilePath, bytes, { mode: 0o600 });
    const binding = { schemaVersion: 1, handleId: 'TEST-handle', owner, scope };
    let counter = 0;
    const start = () => {
      const child = spawn(nodeExecutable, [hostEntry], {
        cwd: root,
        env: {
          HOME: root,
          PATH: dirname(nodeExecutable),
          LEGACY_AGENT_HOST_PROFILE_PATH: profilePath,
          LEGACY_AGENT_HOST_PROFILE_SHA256: sha(bytes),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exit = once(child, 'exit');
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const iterator = lines[Symbol.asyncIterator]();
      let diagnostics = '';
      child.stderr.on('data', (chunk: Buffer) => {
        diagnostics += chunk.toString();
      });
      return {
        child,
        exit,
        diagnostics: () => diagnostics,
        async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
          const id = ++counter;
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
          const line = await iterator.next();
          assert.equal(line.done, false, 'host must answer through NDJSON');
          const frame = JSON.parse(line.value!) as { id: number; result: Record<string, unknown> };
          assert.equal(frame.id, id, 'legacy console output must never become a frame');
          return frame.result;
        },
        async close() {
          child.stdin.end();
          const [code, signal] = await exit;
          assert.equal(code, 0);
          assert.equal(signal, null);
          lines.close();
        },
      };
    };
    let current: ReturnType<typeof start> | undefined;
    try {
      current = start();
      const handshake = await current.rpc('host.handshake', { protocolVersion: 1 });
      assert.equal(handshake.buildId, owner.buildId);
      assert.ok((handshake.capabilities as string[]).includes('team.task'));
      assert.ok(!(handshake.capabilities as string[]).includes('runtime.session'));
      assert.deepEqual(
        await current.rpc('team.launch.read', {
          commandId: 'TEST-offline-launch-read',
          binding,
          payload: {},
        }),
        { ok: true, value: null },
        'product-only Host has no invented runtime presence'
      );
      assert.deepEqual(
        await current.rpc('team.launch.start', {
          commandId: 'TEST-offline-launch-start',
          binding,
          payload: { launchId: scope.runId, rosterRevision: 'TEST-revision' },
        }),
        { ok: false, code: 'invalid', outcome: 'rejected', reason: 'runtime-unconfigured' }
      );
      const create = {
        commandId: 'TEST-create',
        binding,
        payload: { operation: 'task.create', payload: { subject: 'Host-owned task' } },
      };
      const beforeProduct = await current.rpc('team.snapshot', {
        commandId: 'TEST-before-create',
        binding,
        payload: {},
      });
      const beforePosition = (
        beforeProduct.value as { feed: { cursor: string; streamId: string; sequence: number } }
      ).feed;
      const first = await current.rpc('team.execute', create);
      assert.equal(first.ok, true);
      const feedAfterCreate = await current.rpc('team.changes.read', {
        commandId: 'TEST-after-create',
        binding,
        payload: { cursor: beforePosition.cursor },
      });
      const sourceEvents = (
        feedAfterCreate.value as { events: { sequence: number; eventId: string }[] }
      ).events;
      assert.deepEqual(
        sourceEvents.map((event) => event.sequence),
        [beforePosition.sequence + 1]
      );
      assert.equal(
        sourceEvents[0]!.eventId,
        beforePosition.streamId + ':' + (beforePosition.sequence + 1)
      );
      assert.deepEqual(await current.rpc('team.execute', create), first);
      assert.deepEqual(
        await current.rpc('team.changes.read', {
          commandId: 'TEST-same-replay',
          binding,
          payload: { cursor: beforePosition.cursor },
        }),
        feedAfterCreate,
        'completed command replay neither repeats product effects nor fabricates a new source event'
      );
      const conflict = await current.rpc('team.execute', {
        ...create,
        payload: { operation: 'task.create', payload: { subject: 'Different intent' } },
      });
      assert.deepEqual(conflict, { ok: false, code: 'conflict', outcome: 'rejected' });
      const forged = await current.rpc('team.execute', {
        ...create,
        commandId: 'TEST-forged',
        binding: { ...binding, owner: { ...owner, storageRoot: root } },
      });
      assert.deepEqual(forged, { ok: false, code: 'forbidden', outcome: 'rejected' });
      const receipt = first.value as { phase: string; effects: { taskId: string } };
      assert.equal(receipt.phase, 'completed');
      const removed = await current.rpc('team.execute', {
        commandId: 'TEST-delete',
        binding,
        payload: {
          operation: 'task.lifecycle',
          payload: { taskId: receipt.effects.taskId, action: 'delete' },
        },
      });
      assert.equal(removed.ok, true);
      assert.equal((removed.value as { phase: string }).phase, 'completed');
      await current.close();
      assert.ok(current.diagnostics().length <= 8192);
      current = start();
      await current.rpc('host.handshake', { protocolVersion: 1 });
      assert.deepEqual(
        await current.rpc('team.execute', create),
        first,
        'restart returns old receipt without recreating Task'
      );
      const listed = await current.rpc('team.tasks.list', {
        commandId: 'TEST-list',
        binding,
        payload: null,
      });
      assert.deepEqual(listed, { ok: true, value: [] });
      const trash = await current.rpc('team.tasks.list', {
        commandId: 'TEST-list-deleted',
        binding,
        payload: { deleted: true },
      });
      assert.equal(trash.ok, true);
      const deleted = trash.value as {
        kind: string;
        teamName: string;
        tasks: { id: string; status: string; deletedAt: string }[];
      };
      assert.equal(deleted.kind, 'deleted-tasks');
      assert.equal(deleted.teamName, 'test-team');
      assert.equal(deleted.tasks.length, 1);
      assert.equal(deleted.tasks[0]!.id, receipt.effects.taskId);
      assert.equal(deleted.tasks[0]!.status, 'deleted');
      assert.ok(deleted.tasks[0]!.deletedAt);
      const snapshot = await current.rpc('team.snapshot', {
        commandId: 'TEST-snapshot',
        binding,
        payload: {},
      });
      assert.equal(snapshot.ok, true);
      const product = snapshot.value as {
        teamName: string;
        members: { name: string }[];
        tasks: unknown[];
        revision: string;
      };
      const restartedFeed = await current.rpc('team.changes.read', {
        commandId: 'TEST-old-cursor-after-restart',
        binding,
        payload: { cursor: beforePosition.cursor },
      });
      assert.equal((restartedFeed.value as { gap: { reason: string } }).gap.reason, 'cursor');
      assert.notEqual(
        (restartedFeed.value as { streamId: string }).streamId,
        beforePosition.streamId
      );
      assert.deepEqual((snapshot.value as { feed: unknown }).feed, {
        cursor: (restartedFeed.value as { cursor: string }).cursor,
        streamId: (restartedFeed.value as { streamId: string }).streamId,
        sequence: (restartedFeed.value as { sequence: number }).sequence,
      });
      assert.equal(product.teamName, 'test-team');
      assert.deepEqual(product.members, [{ name: 'alice', role: 'member' }]);
      assert.deepEqual(product.tasks, []);
      assert.match(product.revision, /^[a-f0-9]{64}$/);
      const changes = await current.rpc('team.changes.read', {
        commandId: 'TEST-product-changes',
        binding,
        payload: {},
      });
      const cursor = (changes.value as { cursor: string }).cursor;
      assert.deepEqual((changes.value as { gap: unknown }).gap, { reason: 'initial' });
      assert.deepEqual(
        await current.rpc('team.changes.read', {
          commandId: 'TEST-product-unchanged',
          binding,
          payload: { cursor },
        }),
        {
          ok: true,
          value: {
            cursor,
            streamId: (changes.value as { streamId: string }).streamId,
            sequence: (changes.value as { sequence: number }).sequence,
            events: [],
          },
        }
      );
      assert.deepEqual(
        await current.rpc('team.changes.read', {
          commandId: 'TEST-forged-feed',
          binding: { ...binding, scope: { ...scope, runId: 'TEST-wrong' } },
          payload: { cursor },
        }),
        { ok: false, code: 'forbidden', outcome: 'rejected' }
      );

      assert.deepEqual(
        await current.rpc('team.snapshot', {
          commandId: 'TEST-forged-snapshot',
          binding: { ...binding, scope: { ...scope, runId: 'TEST-wrong' } },
          payload: {},
        }),
        { ok: false, code: 'forbidden', outcome: 'rejected' }
      );

      // M03: existing real CLI boundary, without SDK/model or a Runtime profile.
      const record = (value: unknown): Record<string, unknown> => {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        return value as Record<string, unknown>;
      };
      const accepted = (reply: Record<string, unknown>): Record<string, unknown> => {
        assert.equal(reply.ok, true, JSON.stringify(reply));
        return record(reply.value);
      };
      assert.equal(profile.runtime, undefined);
      const blobTask = accepted(
        await current.rpc('team.execute', {
          commandId: 'TEST-cold-blob-task',
          binding,
          payload: {
            operation: 'task.create',
            payload: { subject: 'TEST persisted Task/comment blobs' },
          },
        })
      );
      const blobTaskId = String(record(blobTask.effects).taskId);
      const cases = [
        { id: 'TEST-task-blob', bytes: Buffer.from('TEST Task blob survives replacement Host\n') },
        {
          id: 'TEST-comment-blob',
          bytes: Buffer.from('TEST comment blob survives replacement Host\n'),
        },
      ];
      const refs: AttachmentReference[] = [];
      for (const item of cases) {
        const uploaded = accepted(
          await current.rpc('team.attachment.upload', {
            commandId: 'TEST-upload-' + item.id,
            binding,
            payload: {
              uploadId: 'TEST-upload-' + item.id,
              purpose: { kind: 'task', taskId: blobTaskId },
              attachment: {
                id: item.id,
                filename: item.id + '.txt',
                mimeType: 'text/plain',
                size: item.bytes.length,
              },
              digest: sha(item.bytes),
              offset: 0,
              base64: item.bytes.toString('base64'),
            },
          })
        );
        assert.equal(uploaded.nextOffset, null);
        const ref = record(uploaded.reference);
        assert.equal(ref.digest, sha(item.bytes));
        assert.equal(ref.byteLength, item.bytes.length);
        assert.ok(
          typeof ref.artifactId === 'string' &&
            typeof ref.mimeType === 'string' &&
            typeof ref.byteLength === 'number' &&
            typeof ref.digest === 'string'
        );
        refs.push({
          artifactId: ref.artifactId,
          mimeType: ref.mimeType,
          byteLength: ref.byteLength,
          digest: ref.digest,
        });
      }
      accepted(
        await current.rpc('team.execute', {
          commandId: 'TEST-publish-task-blob',
          binding,
          payload: {
            operation: 'task.attachment.add',
            payload: { taskId: blobTaskId, attachment: refs[0]! },
          },
        })
      );
      accepted(
        await current.rpc('team.execute', {
          commandId: 'TEST-publish-comment-blob',
          binding,
          payload: {
            operation: 'task.comment',
            payload: { taskId: blobTaskId, text: 'TEST original comment', attachments: [refs[1]!] },
          },
        })
      );
      const warmTask = accepted(
        await current.rpc('team.task.get', {
          commandId: 'TEST-warm-blob-task',
          binding,
          payload: { taskId: blobTaskId },
        })
      );
      assert.equal((warmTask.attachments as unknown[]).length, 1);
      const warmComments = warmTask.comments as Record<string, unknown>[];
      assert.equal(warmComments.length, 1);
      assert.equal((warmComments[0]!.attachments as unknown[]).length, 1);
      const originalBlobHost = current.child;
      await current.close(); // Held original ChildProcess observes exit0 before replacement.
      current = start();
      assert.notEqual(
        current.child,
        originalBlobHost,
        'a new actual Host child, not an owner-object reopen'
      );
      const coldHandshake = await current.rpc('host.handshake', { protocolVersion: 1 });
      assert.equal(
        (coldHandshake.capabilities as string[]).includes('runtime.member-session'),
        false
      );
      assert.deepEqual(
        await current.rpc('team.launch.read', {
          commandId: 'TEST-cold-blob-no-runtime',
          binding,
          payload: {},
        }),
        { ok: true, value: null }
      );
      const coldTask = accepted(
        await current.rpc('team.task.get', {
          commandId: 'TEST-cold-blob-task-read',
          binding,
          payload: { taskId: blobTaskId },
        })
      );
      assert.deepEqual(
        coldTask,
        warmTask,
        'original Task/comment identities and attachment metadata survive actual Host replacement'
      );
      for (const item of cases) {
        const chunk = accepted(
          await current.rpc('team.task.attachment.read', {
            commandId: 'TEST-cold-read-' + item.id,
            binding,
            payload: { taskId: blobTaskId, attachmentId: item.id, offset: 0 },
          })
        );
        assert.equal(record(chunk.attachment).id, item.id);
        assert.equal(record(chunk.attachment).size, item.bytes.length);
        assert.equal(chunk.offset, 0);
        assert.equal(chunk.nextOffset, null);
        assert.equal(chunk.sha256, sha(item.bytes));
        assert.deepEqual(Buffer.from(String(chunk.base64), 'base64'), item.bytes);
      }
      assert.equal(
        readdirSync(store).includes('runtime-sessions'),
        false,
        'product-only profile creates no Runtime generation/input store'
      );

      await current.close();
      current = undefined;
    } finally {
      if (current && current.child.exitCode === null && current.child.signalCode === null) {
        current.child.kill('SIGKILL');
        await current.exit;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
);
