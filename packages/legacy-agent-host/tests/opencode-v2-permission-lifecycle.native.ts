/** TEST-only actual Host policy and lifecycle effects, with its original Runtime/Team owners. */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { record } from './fixtures/native-claude-team/model.ts';
import { fileHash, startHost, tick } from './fixtures/native-host.ts';
import {
  outsideSecret,
  startPermissionModel,
  turnText,
} from './fixtures/native-opencode-v2-permissions.ts';
import { assertNativeV1Build, buildNativeV1Host } from './opencode-v1-version-source.ts';
import type { PermissionTurn } from './fixtures/native-opencode-v2-permissions.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

async function endpoint(): Promise<string> {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done()))
  );
  return 'http://127.0.0.1:' + address.port;
}
const value = (result: Record<string, unknown>) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return record(result.value);
};
async function directChildren(parent: number): Promise<number[]> {
  const children: number[] = [];
  for (const name of (await readdir('/proc')).filter((item) => /^\d+$/.test(item))) {
    const stat = await readFile('/proc/' + name + '/stat', 'utf8').catch(() => undefined);
    if (!stat) continue;
    const fields = stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/);
    if (Number(fields[1]) === parent && fields[0] !== 'Z') children.push(Number(name));
  }
  return children;
}
const absent = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

test(
  'native V2 external deny/ask, once/reject/stale/revoke and active Stop preserve sibling and cold receipts',
  {
    timeout: 600_000,
    skip: process.env.OPENCODE_V2_PERMISSION_LIFECYCLE_GO !== '1',
  },
  async () => {
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    assert.equal(process.version, 'v24.21.0');
    const repo = resolve(import.meta.dirname, '../../..');
    const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
    const build = await buildNativeV1Host(repo, sourceHead);
    const node = await realpath(process.execPath);
    const entry = join(repo, 'packages/legacy-agent-host/dist/cli.js');
    const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
    const engine = await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
    const manifest = process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256!;
    const receiptPath = process.env.OPENCODE_V2_PERMISSION_LIFECYCLE_RECEIPT!;
    assert.ok(receiptPath?.startsWith('/'));
    assert.equal(await fileHash(join(engine, 'opencode-v2-engine-manifest.json')), manifest);
    const digests = {
      node: await fileHash(node),
      bun: await fileHash(bun),
      manifest,
      source: build.hostSourceDigest,
      dist: build.hostDistDigest,
      provider: build.providerDigest,
    };
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-v2-policy-')));
    const steps: string[] = [];
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
    const nativePids = new Map<string, number>();
    const nativeEffectPids = new Set<number>();
    const commands = new Map<
      PermissionTurn,
      { request: unknown; receipt: Record<string, unknown>; inputId: string }
    >();
    let host: ReturnType<typeof startHost> | undefined;
    let model: Awaited<ReturnType<typeof startPermissionModel>> | undefined;
    let originalFailure: unknown,
      passed = false,
      cleanup = false;
    const cleanupErrors: unknown[] = [];
    try {
      for (const name of [
        'home',
        'tmp',
        'config',
        'data',
        'cache',
        'store',
        'outside',
        'deny',
        'ask',
        'sibling',
      ])
        await mkdir(join(root, name), { mode: 0o700 });
      const outsideFile = join(root, 'outside/external.txt');
      await writeFile(outsideFile, outsideSecret + '\n', { mode: 0o600 });
      model = await startPermissionModel({ outsideFile });
      const owner = {
        ownerId: 'TEST-policy-owner',
        revision: 'TEST-owner-v1',
        profileId: 'TEST-profile',
        storageRoot: join(root, 'store'),
        protocolVersion: 1 as const,
        buildId: 'TEST-native-policy',
        nodeSha256: digests.node,
        hostEntrySha256: await fileHash(entry),
      };
      const scope = {
        projectId: 'TEST-project',
        workspaceId: 'TEST-workspace',
        teamId: 'TEST-team',
        runId: 'TEST-run',
        memberId: 'human',
        generation: '1',
      };
      const teamBinding = {
        backendId: owner.ownerId,
        teamId: scope.teamId,
        teamName: 'test-native-policy',
      };
      const members: NonNullable<TeamHostProfile['runtime']>['members'] = [];
      for (const name of ['deny', 'ask', 'sibling'])
        members.push({
          provider: 'opencode',
          nativeGeneration: 'v2',
          protocolRevision: '2.1.4',
          teamId: scope.teamId,
          memberId: name,
          principalId: name + '-session',
          sessionId: 'TEST-native-' + name,
          generation: 1,
          configRevision: 'TEST-config',
          cwd: join(root, name),
          model: 'TEST-model',
          endpoint: await endpoint(),
          accountBinding: 'TEST-account',
          executable: { path: bun, sha256: digests.bun },
          environment: {
            HOME: join(root, 'home'),
            TMPDIR: join(root, 'tmp'),
            XDG_CONFIG_HOME: join(root, 'config'),
            XDG_DATA_HOME: join(root, 'data'),
            XDG_CACHE_HOME: join(root, 'cache'),
            PATH: dirname(node) + ':/usr/bin:/bin',
            NO_COLOR: '1',
          },
          embedded: {
            version: '2.1.4',
            platform: 'linux',
            arch: 'x64',
            directory: engine,
            manifestSha256: manifest,
            externalDirectory: name === 'ask' ? 'ask' : 'deny',
            providerConfiguration: {
              package: 'aisdk:@ai-sdk/openai-compatible',
              settings: { baseURL: model.url + '/v1', apiKey: 'TEST-LOCALHOST-ONLY' },
              models: {
                'TEST-model': {
                  name: 'TEST-model',
                  limit: { context: 200000, output: 1000 },
                  capabilities: { tools: true, input: ['text'], output: ['text'] },
                },
              },
            },
          },
          nativeOptions: {
            providerId: 'TEST-local',
            agent: 'TEST-member',
            toolApprovalMode: 'auto',
            instructions: 'TEST permission and lifecycle qualification for ' + name,
          },
          limits: {
            queuedInputs: 1,
            inputBytes: 8192,
            outputBytes: 500000,
            outputEvents: 1000,
            pendingInteractions: 4,
            timeoutMs: 120000,
          },
        });
      const profile: TeamHostProfile = {
        schemaVersion: 1,
        owner,
        principalId: 'human',
        teams: [
          {
            scope,
            binding: teamBinding,
            members: members.map((member) => ({
              memberId: member.memberId,
              name: member.memberId,
              role: 'member' as const,
              delivery: {
                ...teamBinding,
                runId: scope.runId,
                memberId: member.memberId,
                generation: '1',
              },
            })),
            grants: [
              {
                principalId: 'human',
                memberName: 'user',
                permissions: ['read', 'admin', 'message.write', 'task.write'],
              },
              ...members.map((member) => ({
                principalId: member.principalId,
                memberName: member.memberId,
                permissions: ['read', 'message.write', 'task.write'] as (
                  | 'read'
                  | 'message.write'
                  | 'task.write'
                )[],
              })),
            ],
          },
        ],
        runtime: { members },
      };
      const path = join(root, 'profile.json');
      await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
      const profileHash = await fileHash(path);
      const start = () => startHost({ node, entry, root, profile: path, profileHash });
      const binding = { schemaVersion: 1, handleId: 'TEST-policy-handle', owner, scope };
      let counter = 0;
      const envelope = (payload: unknown, commandId = 'TEST-control-' + ++counter) => ({
        commandId,
        binding,
        payload,
      });
      const control = async (operation: string, payload: unknown) =>
        host!.rpc('runtime.' + operation, envelope(payload));
      const state = async (memberId: string) => value(await control('read', { memberId }));
      const wait = async (check: () => Promise<boolean>, label: string, timeout = 90000) => {
        const deadline = Date.now() + timeout;
        do {
          assert.deepEqual(model!.failures, []);
          if (await check()) return;
          await tick();
        } while (Date.now() < deadline);
        throw Error('TEST native policy wait failed: ' + label);
      };
      const send = async (memberId: string, turn: PermissionTurn) => {
        const request = envelope(
          { operation: 'message.send', payload: { to: memberId, text: turnText(turn) } },
          'TEST-original-' + turn
        );
        const receipt = await host!.rpc('team.execute', request);
        const accepted = value(receipt);
        assert.equal(accepted.phase, 'completed');
        const inputId = record(accepted.effects).deliveryId;
        assert.equal(typeof inputId, 'string');
        commands.set(turn, { request, receipt, inputId: inputId as string });
        return inputId as string;
      };
      const inputState = async (memberId: string) =>
        (await state(memberId)).inputs as Record<string, unknown>[];
      const terminal = async (memberId: string, inputId: string) => {
        let result: Record<string, unknown> | undefined;
        await wait(async () => {
          result = (await inputState(memberId)).find((row) => row.inputId === inputId);
          return result?.phase === 'terminal';
        }, memberId + ' terminal');
        return result!;
      };
      const permission = async (inputId: string) => {
        let found: Record<string, unknown> | undefined;
        await wait(async () => {
          const pending = ((await state('ask')).interactions as unknown[])
            .map(record)
            .filter((row) => row.inputId === inputId && row.phase === 'pending');
          assert.ok(pending.length <= 1);
          found = pending[0];
          return found !== undefined;
        }, 'external-directory permission');
        assert.equal(found!.kind, 'permission');
        assert.equal(typeof found!.interactionRef, 'string');
        return found!;
      };
      const answer = (
        inputId: string,
        interactionRef: unknown,
        decision: string,
        expectedGeneration = '1'
      ) =>
        control('interaction', {
          memberId: 'ask',
          expectedGeneration,
          inputId,
          interactionRef,
          reply: { kind: 'permission', decision },
        });

      host = start();
      await host.rpc('host.handshake', { protocolVersion: 1 });
      for (const memberId of ['deny', 'ask', 'sibling']) {
        const opened = value(await control('open', { memberId }));
        assert.equal(opened.nativeReady, true, JSON.stringify(opened));
        const children = await directChildren(host.facts().pid!);
        const fresh = children.filter((pid) => ![...nativePids.values()].includes(pid));
        assert.equal(fresh.length, 1, 'one captured original Bun child per member');
        nativePids.set(memberId, fresh[0]!);
        assert.equal(await fileHash('/proc/' + fresh[0] + '/exe'), digests.bun);
      }
      steps.push('three_original_native_members_attest_empty_saved_grants_and_builtin_plugins');

      const deniedInput = await send('deny', 'DENY');
      const denied = await terminal('deny', deniedInput);
      assert.notEqual(denied.terminal, 'unknown');
      assert.equal(model.counts.get('DENY'), 2);
      assert.equal(
        model.requests.find((row) => row.turn === 'DENY' && row.step === 1)?.externalContent,
        false
      );
      assert.equal(((await state('deny')).interactions as unknown[]).length, 0);
      const deniedActivity = value(await control('activity.snapshot', { memberId: 'deny' }));
      assert.ok(
        (record(deniedActivity.latest).tools as unknown[])
          .map(record)
          .some(
            (row) => record(row.data).kind === 'tool-result' && record(row.data).isError === true
          )
      );
      steps.push('external_directory_deny_prevents_native_read_and_content_disclosure');

      const onceInput = await send('ask', 'ONCE');
      const once = await permission(onceInput);
      assert.equal(model.counts.get('ONCE'), 1);
      assert.equal((await answer(onceInput, once.interactionRef, 'always')).ok, false);
      assert.equal((await answer(onceInput, once.interactionRef, 'allow', '999')).ok, false);
      value(await answer(onceInput, once.interactionRef, 'allow'));
      assert.equal((await terminal('ask', onceInput)).terminal, 'succeeded');
      assert.equal(
        model.requests.find((row) => row.turn === 'ONCE' && row.step === 1)?.externalContent,
        true
      );
      steps.push('external_directory_ask_once_discloses_only_after_original_grant');

      const rejectedInput = await send('ask', 'REJECT');
      const rejected = await permission(rejectedInput);
      assert.notEqual(rejected.interactionRef, once.interactionRef);
      assert.equal((await answer(onceInput, once.interactionRef, 'allow')).ok, false);
      assert.equal((await permission(rejectedInput)).interactionRef, rejected.interactionRef);
      value(await answer(rejectedInput, rejected.interactionRef, 'deny'));
      assert.equal((await terminal('ask', rejectedInput)).terminal, 'cancelled');
      assert.equal(model.counts.get('REJECT'), 1);
      steps.push('once_is_not_always_second_prompt_reject_and_stale_reply_have_no_effect');

      const revokedInput = await send('ask', 'REVOKE');
      const revoked = await permission(revokedInput);
      // Adversarial removal of this disposable TEST member's authority under the
      // original Team store's fence; no second Team/Runtime owner is created.
      const { TeamOwnerStore } = await import('../dist/adapters/team/TeamOwnerStore.js');
      const authorityStore = new TeamOwnerStore(join(root, 'store'), 'test-native-policy');
      authorityStore.fenced(() => {
        const authority = authorityStore.read<{
          grants: { principalId: string; revoked?: boolean; revision?: number }[];
        }>('state.json')!;
        const grant = authority.grants.find((row) => row.principalId === 'ask-session')!;
        assert.ok(grant);
        grant.revoked = true;
        grant.revision = (grant.revision ?? 1) + 1;
        authorityStore.write('state.json', authority);
      });
      const revokedReply = await answer(revokedInput, revoked.interactionRef, 'allow');
      // A successful RPC envelope may carry the held result of an attempted
      // control. It is not a native permission ACK: Runtime records UNKNOWN.
      if (revokedReply.ok) {
        const replyState = value(revokedReply);
        assert.equal(replyState.nativeReady, false);
        assert.equal(
          (replyState.interactions as Record<string, unknown>[]).find(
            (row) => row.interactionRef === revoked.interactionRef
          )?.phase,
          'unknown'
        );
      }
      assert.equal((await state('ask')).nativeReady, false);
      const revokedStop = value(
        await control('stop', { memberId: 'ask', expectedGeneration: '1' })
      );
      assert.equal(revokedStop.custody, 'released');
      await wait(async () => absent(-nativePids.get('ask')!), 'revoked original child gone', 15000);
      assert.equal(model.counts.get('REVOKE'), 1);
      steps.push('revoked_member_cannot_grant_pending_native_permission_or_replay_it');

      const activeInput = await send('deny', 'ACTIVE');
      const activeDirectory = join(root, 'deny');
      await wait(
        async () =>
          (await readFile(join(activeDirectory, 'active-started.txt'), 'utf8').catch(() => '')) ===
          'START\n',
        'real native foreground command starts'
      );
      const shellPid = Number((await readFile(join(activeDirectory, 'active.pid'), 'utf8')).trim());
      assert.ok(Number.isSafeInteger(shellPid) && shellPid > 0 && !absent(shellPid));
      nativeEffectPids.add(shellPid);
      const stopped = value(await control('stop', { memberId: 'deny', expectedGeneration: '1' }));
      assert.equal(stopped.phase, 'closed');
      assert.equal(stopped.custody, 'released');
      await wait(
        async () => absent(-nativePids.get('deny')!) && absent(shellPid),
        'native shell and original process group stopped',
        15000
      );
      assert.equal(
        await readFile(join(activeDirectory, 'active-late.txt'), 'utf8').catch(() => undefined),
        undefined
      );
      assert.equal(model.counts.get('ACTIVE'), 1);
      const activeOutcome = (await inputState('deny')).find((row) => row.inputId === activeInput);
      assert.equal(activeOutcome?.phase, 'unknown');
      assert.equal(activeOutcome?.terminal, undefined, 'physical Stop invents no terminal ACK');
      assert.equal(await fileHash('/proc/' + nativePids.get('sibling') + '/exe'), digests.bun);
      const siblingInput = await send('sibling', 'SIBLING');
      assert.equal((await terminal('sibling', siblingInput)).terminal, 'succeeded');
      assert.equal(model.counts.get('SIBLING'), 1);
      const checkpoint = value(
        await control('checkpoint', { memberId: 'sibling', checkpointId: 'TEST-sibling-cold' })
      );
      assert.equal(checkpoint.status, 'published');
      assert.equal(value(await control('stop', { memberId: 'sibling' })).custody, 'released');
      steps.push('active_Stop_terminates_native_foreground_effect_preserves_unknown_and_sibling');

      for (const pid of nativePids.values()) assert.equal(absent(-pid), true);
      const databases = (await readdir(join(root, 'data'))).filter((name) =>
        name.startsWith('agent-teams-v2-')
      );
      assert.equal(databases.length, 3);
      for (const name of databases) {
        const database = new DatabaseSync(join(root, 'data', name, 'opencode.sqlite'), {
          readOnly: true,
        });
        try {
          assert.equal(
            record(database.prepare('SELECT COUNT(*) AS count FROM permission').get()).count,
            0
          );
        } finally {
          database.close();
        }
      }
      steps.push('pinned_native_database_has_zero_saved_always_permissions_after_once_reject');
      await host.close();
      hosts.push(host.facts());
      host = undefined;
      await assertNativeV1Build(repo, sourceHead, build);
      const callsBeforeCold = model.requests.length;
      host = start();
      await host.rpc('host.handshake', { protocolVersion: 1 });
      for (const { request, receipt } of commands.values()) {
        assert.deepEqual(await host.rpc('team.lookup', request), receipt);
        assert.deepEqual(await host.rpc('team.execute', request), receipt);
      }
      const cold = await state('deny');
      assert.equal(cold.attached, false);
      const coldActive = (cold.inputs as unknown[])
        .map(record)
        .find((row) => row.inputId === activeInput);
      assert.equal(coldActive?.phase, 'unknown');
      assert.equal(
        coldActive?.terminal,
        undefined,
        'cold readback retains the absence of a terminal ACK'
      );
      const restored = value(
        await control('restore', {
          memberId: 'sibling',
          reference: checkpoint.reference,
          expectedGeneration: '1',
        })
      );
      assert.equal(restored.nativeReady, true);
      const restoredChildren = await directChildren(host.facts().pid!);
      assert.equal(restoredChildren.length, 1, 'cold restore owns only the selected sibling child');
      nativePids.set('sibling-restored', restoredChildren[0]!);
      assert.equal(await fileHash('/proc/' + restoredChildren[0] + '/exe'), digests.bun);
      await new Promise<void>((done) => setTimeout(done, 300));
      assert.equal(model.requests.length, callsBeforeCold);
      assert.deepEqual(model.failures, []);
      assert.equal(
        await readFile(join(activeDirectory, 'active-late.txt'), 'utf8').catch(() => undefined),
        undefined
      );
      assert.equal(
        value(
          await control('stop', { memberId: 'sibling', expectedGeneration: restored.generation })
        ).custody,
        'released'
      );
      await host.close();
      hosts.push(host.facts());
      host = undefined;
      assert.ok(
        hosts.every((row) => row.exitCode === 0 && row.signalCode === null && row.stdoutValid)
      );
      await assertNativeV1Build(repo, sourceHead, build);
      steps.push(
        'cold_Host_preserves_original_unknown_receipts_and_restores_only_idle_sibling_without_replay'
      );
      passed = true;
    } catch (error) {
      originalFailure = error;
    } finally {
      if (host)
        try {
          await host.close();
          hosts.push(host.facts());
          host = undefined;
        } catch (error) {
          cleanupErrors.push(error);
        }
      try {
        await model?.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const pid of nativePids.values())
        if (!absent(-pid)) cleanupErrors.push(Error('TEST original native group remains'));
      for (const pid of nativeEffectPids)
        if (!absent(pid))
          cleanupErrors.push(Error('TEST observed native foreground effect remains'));
      cleanup = cleanupErrors.length === 0;
      if (cleanup)
        try {
          await rm(root, { recursive: true, force: true });
        } catch (error) {
          cleanup = false;
          cleanupErrors.push(error);
        }
      try {
        await writeFile(
          receiptPath,
          JSON.stringify(
            {
              kind: 'TEST_NATIVE_V2_PERMISSION_LIFECYCLE',
              sourceHead,
              platform: 'linux-x64',
              version: '2.1.4',
              status: passed && cleanup && originalFailure === undefined ? 'PASS' : 'INCOMPLETE',
              digests,
              cleanup,
              steps,
              modelRequests: model?.requests ?? [],
              modelFailures: model?.failures ?? [],
              originalNativeProcessCount: nativePids.size,
              hosts: hosts.map(({ exitCode, signalCode, stdoutValid }) => ({
                exitCode,
                signalCode,
                stdoutValid,
              })),
              vendorAuthQualified: false,
              desktopQualified: false,
              releaseQualified: false,
            },
            null,
            2
          ) + '\n',
          { mode: 0o600 }
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (originalFailure !== undefined && cleanupErrors.length)
      throw new AggregateError(
        [originalFailure, ...cleanupErrors],
        'TEST native policy and cleanup failed'
      );
    if (originalFailure !== undefined) throw originalFailure;
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, 'TEST native policy cleanup failed');
  }
);
