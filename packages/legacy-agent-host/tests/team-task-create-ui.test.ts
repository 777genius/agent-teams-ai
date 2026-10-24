import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { CommandReceipt, TeamCommand } from '../dist/team/contracts.js';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

test(
  'ordinary Task create choices and clear assignee cross the actual captured NDJSON Host exactly once',
  { timeout: 15000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-task-ui-')));
    const store = join(root, 'store');
    mkdirSync(store);
    const hostEntry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const owner = {
      ownerId: 'TEST-task-backend',
      revision: 'TEST-revision',
      storageRoot: store,
      profileId: 'TEST-task-profile',
      protocolVersion: 1 as const,
      buildId: 'TEST-task-ui-host',
      nodeSha256: sha(readFileSync(process.execPath)),
      hostEntrySha256: sha(readFileSync(hostEntry)),
    };
    const scope = {
      projectId: 'TEST-project',
      workspaceId: 'TEST-workspace',
      teamId: 'TEST-team',
      runId: 'TEST-product-run',
      memberId: 'human',
      generation: '1',
    };
    const profile: TeamHostProfile = {
      schemaVersion: 1,
      owner,
      principalId: 'TEST-human',
      teams: [
        {
          scope,
          binding: { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-team' },
          members: [
            { memberId: 'lead-id', name: 'lead', role: 'lead' },
            { memberId: 'alice-id', name: 'alice', role: 'member' },
          ],
          grants: [
            {
              principalId: 'TEST-human',
              memberName: 'user',
              permissions: ['read', 'task.write', 'message.write', 'admin'],
            },
          ],
        },
      ],
    };
    const bytes = JSON.stringify(profile);
    const profilePath = join(root, 'profile.json');
    writeFileSync(profilePath, bytes, { mode: 0o600 });
    const binding = { schemaVersion: 1, handleId: 'TEST-handle', owner, scope };
    let counter = 0;
    const start = () => {
      const child = spawn(process.execPath, [hostEntry], {
        cwd: root,
        env: {
          PATH: dirname(process.execPath),
          LEGACY_AGENT_HOST_PROFILE_PATH: profilePath,
          LEGACY_AGENT_HOST_PROFILE_SHA256: sha(bytes),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exit = once(child, 'exit');
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const iterator = lines[Symbol.asyncIterator]();
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      return {
        child,
        exit,
        async rpc(method: string, params: unknown) {
          const id = ++counter;
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
          const line = await iterator.next();
          assert.equal(line.done, false, stderr);
          const frame = JSON.parse(line.value!) as {
            id: number;
            result: { ok: boolean; value?: unknown; code?: string };
          };
          assert.equal(frame.id, id);
          return frame.result;
        },
        async close() {
          child.stdin.end();
          const [code, signal] = await exit;
          lines.close();
          assert.equal(code, 0, stderr);
          assert.equal(signal, null);
        },
      };
    };
    let host: ReturnType<typeof start> | undefined;
    const task = (id: string) =>
      JSON.parse(readFileSync(join(store, 'tasks', 'test-team', `${id}.json`), 'utf8')) as {
        id: string;
        owner?: string;
        status: string;
        related?: string[];
        prompt?: string;
        promptTaskRefs?: unknown[];
      };
    const inbox = (name: string) => {
      try {
        return JSON.parse(
          readFileSync(join(store, 'teams', 'test-team', 'inboxes', `${name}.json`), 'utf8')
        ) as { messageId: string; text: string }[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    };
    const execute = async (command: TeamCommand) => {
      const { commandId, ...payload } = command;
      const response = await host!.rpc('team.execute', { binding, commandId, payload });
      assert.equal(response.ok, true, JSON.stringify(response));
      const receipt = response.value as CommandReceipt;
      assert.equal(receipt.phase, 'completed');
      return receipt;
    };
    try {
      host = start();
      await host.rpc('host.handshake', { protocolVersion: 1 });
      const base = await execute({
        commandId: 'TEST-base',
        operation: 'task.create',
        payload: { subject: 'TEST dependency' },
      });
      const ref = { taskId: base.effects.taskId, displayId: '1', teamName: 'test-team' };
      const create: TeamCommand = {
        commandId: 'TEST-create-ui',
        operation: 'task.create',
        payload: {
          subject: 'TEST assigned immediate create',
          owner: 'alice',
          related: [base.effects.taskId],
          prompt: 'TEST instructions with a separate task reference',
          promptTaskRefs: [ref],
          startImmediately: true,
        },
      };
      const first = await execute(create);
      assert.equal(task(first.effects.taskId).status, 'in_progress');
      assert.equal(task(first.effects.taskId).prompt, create.payload.prompt);
      assert.deepEqual(task(first.effects.taskId).promptTaskRefs, [ref]);
      assert.deepEqual(task(base.effects.taskId).related, [first.effects.taskId]);
      const notice = inbox('alice').filter(
        (message) => message.messageId === first.effects.messageId
      );
      assert.equal(notice.length, 1);
      assert.ok(notice[0]!.text.includes('TEST instructions'));
      assert.deepEqual(await execute(create), first);
      const clear: TeamCommand = {
        commandId: 'TEST-clear-owner',
        operation: 'task.assign',
        payload: { taskId: first.effects.taskId, owner: null },
      };
      const cleared = await execute(clear);
      assert.equal(task(first.effects.taskId).owner, undefined);
      const lead = await execute({
        commandId: 'TEST-lead-start',
        operation: 'task.create',
        payload: { subject: 'TEST lead task', owner: 'lead', startImmediately: true },
      });
      assert.equal(task(lead.effects.taskId).status, 'in_progress');
      assert.equal(
        inbox('lead').filter((message) => message.messageId === lead.effects.messageId).length,
        1
      );
      const blocked = await execute({
        commandId: 'TEST-blocked-start',
        operation: 'task.create',
        payload: {
          subject: 'TEST blocked task',
          owner: 'alice',
          blockedBy: [base.effects.taskId],
          startImmediately: true,
        },
      });
      assert.equal(task(blocked.effects.taskId).status, 'pending');
      assert.equal(
        inbox('alice').some((message) => message.messageId === blocked.effects.messageId),
        false
      );
      const unowned = await execute({
        commandId: 'TEST-unowned-start',
        operation: 'task.create',
        payload: { subject: 'TEST unowned task', startImmediately: true },
      });
      assert.equal(task(unowned.effects.taskId).status, 'pending');
      const beforeRestart = sha(
        JSON.stringify({
          a: inbox('alice'),
          l: inbox('lead'),
          task: task(first.effects.taskId),
          base: task(base.effects.taskId),
        })
      );
      await host.close();
      host = start();
      await host.rpc('host.handshake', { protocolVersion: 1 });
      assert.deepEqual(await execute(create), first);
      assert.deepEqual(await execute(clear), cleared);
      assert.equal(
        sha(
          JSON.stringify({
            a: inbox('alice'),
            l: inbox('lead'),
            task: task(first.effects.taskId),
            base: task(base.effects.taskId),
          })
        ),
        beforeRestart
      );
      const conflicting = await host.rpc('team.execute', {
        binding,
        commandId: create.commandId,
        payload: {
          operation: 'task.create',
          payload: { ...create.payload, prompt: 'TEST changed intent' },
        },
      });
      assert.equal(conflicting.ok, false);
      assert.equal(conflicting.code, 'conflict');
      await host.close();
      host = undefined;
    } finally {
      if (host && host.child.exitCode === null && host.child.signalCode === null) {
        host.child.kill('SIGKILL');
        await host.exit;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
);
