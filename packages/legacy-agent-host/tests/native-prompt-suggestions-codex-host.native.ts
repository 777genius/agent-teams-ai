import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import {
  createCodexSuggestionProfile,
  readCodexSuggestionInputs,
} from './fixtures/native-codex-team/suggestion-config.ts';
import { startCodexSuggestionModel } from './fixtures/native-codex-team/suggestion-model.ts';
import { assertSafeRuntimeProjection, fileHash, startHost, tick } from './fixtures/native-host.ts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const rows = (value: unknown) => (Array.isArray(value) ? value : []).map(record);
const sources = [
  {
    marker: 'TEST_CODEX_HOST_LEAD_ONE',
    owner: 'lead',
    suggestion: 'Review the completed lead work.',
  },
  {
    marker: 'TEST_CODEX_HOST_PEER_ONE',
    owner: 'peer',
    suggestion: 'Review the completed peer work.',
  },
  {
    marker: 'TEST_CODEX_HOST_LEAD_CANCEL',
    owner: 'lead',
    suggestion: 'Must never appear.',
    hold: 'turn' as const,
  },
  {
    marker: 'TEST_CODEX_HOST_PEER_LATE',
    owner: 'peer',
    suggestion: 'Must never arrive after Stop.',
    hold: 'suggestion' as const,
  },
];

/** Original native persisted history is independent of the Host notice under test. */
async function readOriginalNativeTurns(home: string) {
  const files: string[] = [];
  let visited = 0;
  const walk = async (directory: string) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      assert.ok(++visited <= 256, 'bounded fresh native session history');
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && item.name.endsWith('.jsonl')) files.push(path);
    }
  };
  await walk(join(home, 'sessions'));
  assert.equal(files.length, 1, 'sampling never creates another retained source session');
  assert.ok((await stat(files[0]!)).size <= 8 * 1024 * 1024);
  const history = (await readFile(files[0]!, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => record(JSON.parse(line)));
  const metadata = history
    .filter((row) => row.type === 'session_meta')
    .map((row) => record(row.payload));
  assert.equal(metadata.length, 1);
  const nativeSession = metadata[0]!.id;
  assert.ok(typeof nativeSession === 'string' && nativeSession.length > 0);
  const events = history
    .filter((row) => row.type === 'event_msg')
    .map((row) => record(row.payload));
  const started = events.filter((row) => row.type === 'task_started').map((row) => row.turn_id);
  const completed = events.filter((row) => row.type === 'task_complete').map((row) => row.turn_id);
  assert.ok(started.every((id) => typeof id === 'string' && id.length > 0));
  return {
    nativeSession,
    started,
    completed,
    sourceMessages: events
      .filter((row) => row.type === 'user_message')
      .map((row) => String(row.message)),
  };
}

test(
  'real Codex 0.169 lead and peer suggestions retain original captured Host authority',
  {
    timeout: 240_000,
  },
  async (t) => {
    assert.equal(
      process.env.NATIVE_SUGGESTIONS_CODEX_HOST_GO,
      '1',
      'explicit finite native TEST gate'
    );
    assert.equal(process.version, 'v24.21.0');
    const repo = resolve(import.meta.dirname, '../../..');
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    assert.equal(await realpath(process.execPath), node);
    const entry = await realpath(join(repo, 'packages/legacy-agent-host/dist/cli.js'));
    const provider = join(
      repo,
      'vendor/provider-migration/native-prompt-suggestions-18a1c276/agent-teams-provider-implementations-0.0.0.tgz'
    );
    const providerSha256 = await fileHash(provider);
    assert.equal(
      providerSha256,
      '26f8fc7083dbc470dd9d3a656e24873b73c78af3da3ffeea802a09a98f253e3c'
    );
    const pins = await readCodexSuggestionInputs();
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'TEST-native-codex-suggestions-host-'))
    );
    for (const directory of ['home', 'tmp', 'store'])
      await mkdir(join(root, directory), { mode: 0o700 });
    const model = await startCodexSuggestionModel({ sources });
    const notices: Record<string, unknown>[] = [];
    let host: ReturnType<typeof startHost> | undefined;
    let receipt: Record<string, unknown> = {
      passed: false,
      nativeVersion: '0.169.0',
      providerSha256,
    };
    const namespace = randomUUID();
    const owner = {
      ownerId: `TEST-owner-${namespace}`,
      revision: 'TEST-revision',
      storageRoot: join(root, 'store'),
      profileId: `TEST-profile-${namespace}`,
      protocolVersion: 1 as const,
      buildId: 'TEST-native-codex-suggestions',
      nodeSha256: await fileHash(node),
      hostEntrySha256: await fileHash(entry),
    };
    const scope = {
      projectId: `TEST-project-${namespace}`,
      workspaceId: `TEST-workspace-${namespace}`,
      teamId: `TEST-team-${namespace}`,
      runId: `TEST-run-${namespace}`,
      memberId: 'human',
      generation: '1',
    };
    const teamBinding = {
      backendId: owner.ownerId,
      teamId: scope.teamId,
      teamName: 'test-codex-suggestions',
    };
    const members = [
      { name: 'lead', memberId: 'lead-id', role: 'lead' as const },
      { name: 'peer', memberId: 'peer-id', role: 'member' as const },
    ];
    const delivery = (memberId: string) => ({
      ...teamBinding,
      runId: scope.runId,
      memberId,
      generation: '1',
    });
    const envelope = (payload: unknown) => ({
      commandId: `TEST-${randomUUID()}`,
      binding: { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope },
      payload,
    });
    try {
      const profiles = await Promise.all(
        members.map((member) =>
          createCodexSuggestionProfile({
            root: join(root, member.name),
            node,
            modelUrl: model.url,
            executable: pins.executable,
            teamId: scope.teamId,
            memberId: member.memberId,
            principalId: `${member.name}-session`,
            sessionId: `TEST-session-${member.name}-${namespace}`,
          })
        )
      );
      const version = execFileSync(pins.executable.path, ['--version'], {
        cwd: profiles[0]!.cwd,
        env: profiles[0]!.environment,
        encoding: 'utf8',
        timeout: 10_000,
      }).trim();
      assert.equal(version, 'codex-cli 0.169.0');
      const profile: TeamHostProfile = {
        schemaVersion: 1,
        owner,
        principalId: 'human',
        promptSuggestions: { enabled: true },
        teams: [
          {
            scope,
            binding: teamBinding,
            members: members.map((member) => ({ ...member, delivery: delivery(member.memberId) })),
            grants: [
              {
                principalId: 'human',
                memberName: 'user',
                permissions: ['read', 'message.write', 'task.write', 'admin'],
              },
              ...members.map((member) => ({
                principalId: `${member.name}-session`,
                memberName: member.name,
                permissions: ['read', 'message.write', 'task.write'] as (
                  | 'read'
                  | 'message.write'
                  | 'task.write'
                )[],
              })),
            ],
          },
        ],
        runtime: { members: profiles },
      };
      const profilePath = join(root, 'profile.json'),
        serialized = JSON.stringify(profile);
      await writeFile(profilePath, serialized, { mode: 0o600, flag: 'wx' });
      host = startHost({
        node,
        entry,
        root,
        profile: profilePath,
        profileHash: digest(serialized),
        onNotification: (method, value) => {
          if (method === 'runtime.prompt-suggestion.updated') notices.push(record(value));
        },
      });
      const handshake = await host.rpc('host.handshake', { protocolVersion: 1 });
      assert.ok((handshake.capabilities as string[]).includes('runtime.member-session'));
      const read = async (memberId: string, extra: Record<string, unknown> = {}) => {
        const reply = await host!.rpc('runtime.read', envelope({ memberId, ...extra }));
        assert.equal(reply.ok, true);
        assertSafeRuntimeProjection(reply.value);
        return record(reply.value);
      };
      const wait = async (predicate: () => boolean | Promise<boolean>, label: string) => {
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          assert.deepEqual(model.failures, []);
          if (await predicate()) return;
          await tick();
        }
        assert.fail(
          `Original native Codex did not settle: ${label}; requests=${JSON.stringify(model.requests)}`
        );
      };
      const send = async (name: string, marker: string) => {
        const messageId = `TEST-message-${randomUUID()}`;
        const result = await host!.rpc(
          'team.execute',
          envelope({
            operation: 'message.send',
            payload: {
              to: name,
              text: marker,
              messageId,
              summary: 'TEST original human DM',
              actionMode: 'do',
            },
          })
        );
        assert.equal(result.ok, true);
        assert.equal(record(result.value).phase, 'completed');
        const inputId = record(record(result.value).effects).deliveryId;
        assert.ok(typeof inputId === 'string' && inputId.length > 0);
        return { messageId, inputId };
      };
      for (const member of members) {
        const opened = await host.rpc('runtime.open', envelope({ memberId: member.memberId }));
        assert.equal(opened.ok, true);
        assert.equal(
          record(opened.value).nativeReady,
          true,
          'actual selected Codex and original Team MCP are ready'
        );
        assert.equal(rows((await read(member.memberId)).inputs).length, 0);
      }
      const accepted: {
        memberId: string;
        messageId: string;
        inputId: string;
        operationRef: string;
        nativeTurnRef: string;
      }[] = [];
      for (const [index, member] of members.entries()) {
        const source = sources[index]!;
        const original = await send(member.name, source.marker);
        await wait(async () => {
          const input = rows((await read(member.memberId)).inputs).find(
            (row) => row.inputId === original.inputId
          );
          return (
            input?.phase === 'terminal' &&
            input.terminal === 'succeeded' &&
            notices.some((notice) => notice.messageId === original.messageId)
          );
        }, `original ${member.role} source and notice`);
        const matches = notices.filter((notice) => notice.messageId === original.messageId);
        assert.equal(matches.length, 1);
        const event = matches[0]!;
        assert.deepEqual(
          [
            event.provider,
            event.teamId,
            event.runId,
            event.memberId,
            event.memberName,
            event.generation,
            event.messageId,
            event.inputId,
            event.text,
          ],
          [
            'codex',
            scope.teamId,
            scope.runId,
            member.memberId,
            member.name,
            '1',
            original.messageId,
            original.inputId,
            source.suggestion,
          ]
        );
        assert.ok(typeof event.operationRef === 'string' && event.operationRef.length > 0);
        assert.ok(typeof event.completedTurnRef === 'string' && event.completedTurnRef.length > 0);
        assert.notEqual(
          event.completedTurnRef,
          event.operationRef,
          'a native turn is never synthesized from a Host operation'
        );
        const proof = { inputId: original.inputId, operationRef: event.operationRef };
        const verified = await read(member.memberId, {
          expectedGeneration: '1',
          nativePromptProof: proof,
        });
        assert.equal(verified.nativePromptCurrent, true);
        assert.equal(JSON.stringify(verified).includes(event.operationRef), false);
        assert.equal(
          (
            await read(member.memberId, {
              nativePromptProof: { ...proof, operationRef: 'TEST-foreign-operation' },
            })
          ).nativePromptCurrent,
          false
        );
        const other = members.find((candidate) => candidate !== member)!;
        assert.equal(
          (await read(other.memberId, { nativePromptProof: proof })).nativePromptCurrent,
          false,
          'same-team peer cannot prove another member original operation'
        );
        accepted.push({
          memberId: member.memberId,
          ...original,
          operationRef: event.operationRef,
          nativeTurnRef: event.completedTurnRef,
        });
        assert.equal(
          model.requests.filter((request) => request.marker === source.marker).length,
          2,
          'one authored turn plus exactly one native auxiliary model request'
        );
      }
      const cancelled = await send('lead', sources[2]!.marker);
      await wait(() => model.held(sources[2]!.marker), 'original lead turn held before its result');
      const interrupted = await host.rpc(
        'runtime.interrupt',
        envelope({ memberId: 'lead-id', inputId: cancelled.inputId, expectedGeneration: '1' })
      );
      assert.equal(interrupted.ok, true);
      await wait(
        async () =>
          rows((await read('lead-id')).inputs).some(
            (input) =>
              input.inputId === cancelled.inputId &&
              input.phase === 'terminal' &&
              input.terminal === 'cancelled'
          ),
        'original cancelled terminal'
      );
      model.release(sources[2]!.marker);
      const late = await send('peer', sources[3]!.marker);
      await wait(
        () => model.held(sources[3]!.marker),
        'real auxiliary native sample held before its response'
      );
      assert.equal(
        notices.some((notice) => notice.messageId === late.messageId),
        false
      );
      for (const member of members) {
        const stopped = await host.rpc(
          'runtime.stop',
          envelope({ memberId: member.memberId, expectedGeneration: '1' })
        );
        assert.equal(stopped.ok, true);
        assert.equal(record(stopped.value).custody, 'released');
        assert.equal(record(stopped.value).phase, 'closed');
        assert.equal(
          (
            await read(member.memberId, {
              nativePromptProof: {
                inputId: accepted.find((input) => input.memberId === member.memberId)!.inputId,
                operationRef: accepted.find((input) => input.memberId === member.memberId)!
                  .operationRef,
              },
            })
          ).nativePromptCurrent,
          false,
          'a stopped native source cannot authorize stale insertion'
        );
      }
      model.release(sources[3]!.marker);
      await host.close();
      host = undefined;
      assert.equal(
        notices.length,
        2,
        'cancelled original turn and closed auxiliary request never publish late offers'
      );
      assert.equal(model.requests.filter((request) => request.kind === 'turn').length, 4);
      assert.equal(model.requests.filter((request) => request.kind === 'suggestion').length, 3);
      assert.equal(
        model.requests.filter((request) => request.marker === sources[2]!.marker).length,
        1
      );
      assert.deepEqual(model.failures, []);
      const nativeProofs = [];
      for (const member of members) {
        const persisted = new FileRuntimeStore(owner.storageRoot).fenced(
          delivery(member.memberId),
          (tx) => tx.get()
        );
        assert.ok(persisted);
        assert.equal(
          persisted.sessionRef,
          profiles.find((profile) => profile.memberId === member.memberId)!.sessionId
        );
        assert.equal(
          persisted.inputs.length,
          2,
          'sampling did not admit another Runtime source input'
        );
        const qualified = accepted.find((input) => input.memberId === member.memberId)!;
        assert.equal(
          persisted.inputs.find((input) => input.intent.inputId === qualified.inputId)
            ?.operationRef,
          qualified.operationRef
        );
        const history = await readOriginalNativeTurns(join(root, member.name, 'codex-home'));
        assert.equal(
          history.started.length,
          2,
          'native source history has exactly two actual human turns'
        );
        assert.ok(
          history.completed.includes(qualified.nativeTurnRef),
          'Host notice names the original native completed turn'
        );
        assert.equal(
          history.sourceMessages.length,
          2,
          'auxiliary sampling never persists another native user message'
        );
        for (const source of sources) {
          assert.equal(
            history.sourceMessages.filter((message) => message.includes(source.marker)).length,
            source.owner === member.name ? 1 : 0,
            'native source history preserves exactly this member original human messages'
          );
        }
        nativeProofs.push({ role: member.role, ...qualified, ...history });
      }
      assert.notEqual(nativeProofs[0]!.nativeSession, nativeProofs[1]!.nativeSession);
      await pins.verify();
      receipt = {
        passed: true,
        nativeVersion: version,
        providerSha256,
        manifestSha256: pins.manifestSha256,
        originalHostNotifications: notices.length,
        originalHumanInputs: 4,
        auxiliaryModelRequests: 3,
        accepted: nativeProofs,
        cancelledInput: cancelled.inputId,
        stoppedSampleInput: late.inputId,
        nativeCustody: 'released',
        nativeCustodyProof: 'original-Host-stop-receipts-and-exit',
        vendorAuth: false,
        localhostModelCalls: model.requests.length,
      };
    } catch (error) {
      receipt = {
        ...receipt,
        passed: false,
        failure:
          error instanceof Error ? error.message.slice(0, 2000) : 'Original native Host failed',
        requests: model.requests,
        modelFailures: model.failures,
        notices,
        ...(host ? { host: host.facts() } : {}),
      };
      throw error;
    } finally {
      let cleanupError: unknown;
      try {
        await host?.close();
      } catch (error) {
        cleanupError = error;
      }
      await model.close();
      if (cleanupError) receipt = { ...receipt, passed: false, nativeCustody: 'unverified' };
      const destination = process.env.NATIVE_SUGGESTIONS_CODEX_HOST_RECEIPT;
      if (destination)
        await writeFile(destination, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      t.diagnostic(JSON.stringify(receipt));
      await rm(root, { recursive: true, force: true });
      if (cleanupError) throw cleanupError;
    }
  }
);
