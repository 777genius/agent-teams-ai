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
      process.execPath,
      [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
      {
        cwd: root,
        env: {
          HOME: root,
          PATH: dirname(process.execPath),
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
      nodeSha256: sha(readFileSync(process.execPath)),
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
      const child = spawn(process.execPath, [hostEntry], {
        cwd: root,
        env: {
          HOME: root,
          PATH: dirname(process.execPath),
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
      const create = {
        commandId: 'TEST-create',
        binding,
        payload: { operation: 'task.create', payload: { subject: 'Host-owned task' } },
      };
      const first = await current.rpc('team.execute', create);
      assert.equal(first.ok, true);
      assert.deepEqual(await current.rpc('team.execute', create), first);
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
