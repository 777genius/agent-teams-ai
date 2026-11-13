/** TEST actual ordinary Claude Host -> original Main broker, under the existing outer Job. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CapturedHostClient } from '../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import { captureMainWindowsCustody } from '../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody';
import type { SelectedHostProfile } from '../../src/features/agent-backend/main/infrastructure/selectedHostProfile';
import { verifyBrokerArchitecture } from '../../scripts/build/buildOwnedProcessBroker';
import {
  startNativeTeamModel,
  CONTEXT_MARKER,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { JsonValue } from '../../packages/legacy-agent-host/dist/contracts.js';
import type { HostCustodyOwner } from '@agent-teams/legacy-agent-host/owned-process';
import { capturedQueryableWitness, timeout } from './nativeGateContext';
import { createNativeGateEvents } from './nativeGateEvents';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
interface Selection {
  schemaVersion: number;
  testOnly: boolean;
  platform: string;
  version: string;
  integrity: string;
  executable: { path: string; sha256: string };
  bash: { path: string; sha256: string };
}
type Case = 'graceful' | 'crash';

function prepareProfile(originalSandbox: string, broker: string, selected: Selection, url: string) {
  const root = realpathSync.native(originalSandbox);
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot && /^[a-z]:\\/i.test(systemRoot));
  for (const name of ['home', 'tmp', 'config', 'workspace', 'appdata', 'localdata', 'storage'])
    mkdirSync(join(root, name));
  const environment = {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localdata'),
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: join(systemRoot, 'System32/cmd.exe'),
    PATH: [
      dirname(selected.bash.path),
      dirname(process.execPath),
      join(systemRoot, 'System32'),
    ].join(delimiter),
    CLAUDE_CODE_GIT_BASH_PATH: selected.bash.path,
    OWNED_PROCESS_VENDOR_TEST_GO: '1',
    ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY',
    ANTHROPIC_BASE_URL: url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_TELEMETRY: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  const nonce = randomUUID(),
    profileId = 'TEST-main-retained-' + nonce;
  const binding = {
    backendId: 'TEST-owner-' + nonce,
    teamId: 'TEST-team',
    teamName: 'test-main-retained',
  };
  const hostEntry = join(root, 'TEST-original-host.mjs'),
    crash = join(root, 'TEST-crash-original-host');
  const cli = realpathSync(
    fileURLToPath(new URL('../../packages/legacy-agent-host/dist/cli.js', import.meta.url))
  );
  // No provider fake: this small wrapper imports the original public CLI, and only supplies a TEST crash barrier.
  writeFileSync(
    hostEntry,
    "import { existsSync } from 'node:fs';\n" +
      'setInterval(() => { if (existsSync(' +
      JSON.stringify(crash) +
      ')) process.exit(91); }, 25);\n' +
      'await import(' +
      JSON.stringify(pathToFileURL(cli).href) +
      ');\n',
    { flag: 'wx' }
  );
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    owner: {
      ownerId: binding.backendId,
      revision: 'TEST-1',
      storageRoot: join(root, 'storage'),
      profileId,
      protocolVersion: 1,
      buildId: 'TEST-main-retained-1',
      nodeSha256: hash(process.execPath),
      hostEntrySha256: hash(hostEntry),
    },
    principalId: 'human',
    processCustody: { kind: 'main-windows-v1' },
    teams: [
      {
        binding,
        scope: {
          projectId: 'TEST-project',
          workspaceId: 'TEST-workspace',
          teamId: binding.teamId,
          runId: 'TEST-run',
          memberId: 'human',
          generation: '1',
        },
        members: [
          {
            memberId: 'alice-id',
            name: 'alice',
            role: 'member',
            delivery: { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' },
          },
        ],
        grants: [
          {
            principalId: 'human',
            memberName: 'user',
            permissions: ['read', 'task.write', 'message.write', 'admin'],
          },
          {
            principalId: 'alice-session',
            memberName: 'alice',
            permissions: ['read', 'task.write', 'message.write'],
          },
        ],
      },
    ],
    runtime: {
      members: [
        {
          provider: 'claude',
          teamId: binding.teamId,
          memberId: 'alice-id',
          principalId: 'alice-session',
          sessionId: 'TEST-session-' + nonce,
          generation: 1,
          configRevision: 'TEST-native-1',
          cwd: join(root, 'workspace'),
          model: 'claude-sonnet-4-6',
          accountBinding: 'TEST-localhost-only',
          environment,
          executable: selected.executable,
          windowsBroker: { path: broker, sha256: hash(broker), arch: process.arch, protocol: 1 },
          nativeTools: ['Bash'],
          autoAllowedTools: ['Bash'],
          nativeOptions: {
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            settingSources: [],
            projectInstructions: { append: CONTEXT_MARKER },
          },
          limits: {
            queuedInputs: 2,
            inputBytes: 65536,
            outputEvents: 1000,
            outputBytes: 2_000_000,
            pendingInteractions: 2,
            timeoutMs: 45000,
          },
        },
      ],
    },
  };
  const source = join(root, 'TEST-captured-profile.json');
  writeFileSync(source, JSON.stringify(profile), { flag: 'wx' });
  const host: SelectedHostProfile = {
    profileId,
    nodeExecutable: realpathSync.native(process.execPath),
    nodeVersion: process.version,
    nodeSha256: profile.owner.nodeSha256,
    hostEntry: realpathSync.native(hostEntry),
    hostEntrySha256: profile.owner.hostEntrySha256,
    expectedBuildId: profile.owner.buildId,
    cwd: root,
    env: {
      ...environment,
      LEGACY_AGENT_HOST_PROFILE_PATH: source,
      LEGACY_AGENT_HOST_PROFILE_SHA256: hash(source),
    },
    startupTimeoutMs: 10000,
    requestTimeoutMs: 45000,
    writeTimeoutMs: 5000,
    shutdownTimeoutMs: 1000,
  };
  return { profile, host, source, crash, cli };
}

export async function runNativeRetainedHostGate(
  broker: string,
  fixture: string,
  selectionPath: string,
  selectionSha256: string,
  receiptPath: string,
  mode: Case,
  sandbox: string
): Promise<void> {
  assert.equal(process.env.OWNED_PROCESS_VENDOR_TEST_GO, '1');
  assert.equal(process.platform, 'win32');
  assert.equal(process.version, 'v24.21.0');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  assert.match(process.env.EXPECTED_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.ok(
    resolve(sandbox).startsWith(resolve(tmpdir()) + sep) &&
      /^opg[0-9a-f]+\.tmp$/i.test(basename(sandbox))
  );
  assert.ok(isAbsolute(receiptPath) && !existsSync(receiptPath));
  assert.match(selectionSha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(selectionPath), selectionSha256);
  const selected = JSON.parse(readFileSync(selectionPath, 'utf8')) as Selection;
  assert.equal(selected.schemaVersion, 1);
  assert.equal(selected.testOnly, true);
  assert.equal(selected.platform, 'win32-' + process.arch);
  assert.equal(selected.version, '0.3.305');
  assert.equal(realpathSync(selected.executable.path), selected.executable.path);
  assert.equal(realpathSync(selected.bash.path), selected.bash.path);
  assert.equal(
    basename(broker),
    'owned-process-broker.exe',
    'Staged product broker, no TEST debug activation'
  );
  for (const path of [broker, fixture, selected.executable.path])
    verifyBrokerArchitecture(readFileSync(path), process.arch);
  const digests = {
    broker: hash(broker),
    fixture: hash(fixture),
    node: hash(process.execPath),
    claude: selected.executable.sha256,
    bash: selected.bash.sha256,
    selection: selectionSha256,
  };
  const verify = () => {
    assert.equal(hash(broker), digests.broker);
    assert.equal(hash(fixture), digests.fixture);
    assert.equal(hash(selected.executable.path), digests.claude);
    assert.equal(hash(selected.bash.path), digests.bash);
    assert.equal(hash(selectionPath), digests.selection);
    assert.equal(hash(process.execPath), digests.node);
  };
  verify();
  const model = await startNativeTeamModel({ requireVisibleReply: true });
  let captured: ReturnType<typeof prepareProfile>;
  let physical: NonNullable<ReturnType<typeof captureMainWindowsCustody>>;
  try {
    captured = prepareProfile(sandbox, broker, selected, model.url);
    const original = captureMainWindowsCustody(captured.host);
    assert.ok(original); physical = original;
  } catch (error) { await model.close(); throw error; }
  const events = createNativeGateEvents(),
    children = new Set<ChildProcess>();
  const exits = new Map<ChildProcess, Promise<void>>();
  const track = (child: ChildProcess) => {
    children.add(child);
    const done = new Promise<void>((resolveExit, reject) => {
      child.once('exit', () => resolveExit());
      child.once('error', reject);
    });
    void done.catch(() => undefined);
    exits.set(child, done);
  };
  const counts = { allocate: 0, prepare: 0, resume: 0, stop: 0, release: 0 };
  const originalHandleChecks: {
    afterInput: 'alive' | 'absent' | null; afterHostLoss: 'alive' | 'absent' | null;
    afterCleanup: 'alive' | 'absent' | null;
  } = { afterInput: null, afterHostLoss: null, afterCleanup: null };
  let witness: Awaited<ReturnType<typeof capturedQueryableWitness>> | undefined,
    hostExited: Promise<void> | undefined;
  const observedOwner: HostCustodyOwner = {
    mainEpoch: physical.mainEpoch,
    attach(context) {
      assert.equal(hostExited, undefined, 'One actual original Host; no hidden successor');
      hostExited = context.hostExited;
      const port = physical.attach(context);
      return {
        ...port,
        async handle(call) {
          const value = await port.handle(call);
          if (call.operation in counts) counts[call.operation as keyof typeof counts]++;
          if (value.operation === 'prepare') {
            assert.equal(witness, undefined, 'One actual ordinary native allocation');
            // Independent witness retains the original HANDLE while the original root is still suspended.
            witness = await capturedQueryableWitness(
              fixture, value.root.pid, value.root.birth, track, events
            );
          }
          return value;
        },
      };
    },
  };
  const client = new CapturedHostClient(captured.host, observedOwner);
  const envelope = (commandId: string, payload: JsonValue): JsonValue => ({
    commandId,
    binding: { owner: captured.profile.owner, scope: captured.profile.teams[0]!.scope },
    payload,
  });
  const rpc = async (method: string, commandId: string, payload: JsonValue) => {
    const result = row(
      await client.request(method, envelope(commandId, payload), {
        control: method === 'runtime.read',
      })
    );
    assert.equal(result.ok, true, 'Actual original Host route succeeded');
    return row(result.value);
  };
  let phase = 'starting',
    passed = false,
    cleanup = false,
    nativeTurn = false,
    retainedAfterCrash = false;
  let originalFailure: unknown;
  const cleanupErrors: unknown[] = [];
  const sentinel = spawn(fixture, ['vendor-sentinel'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  track(sentinel);
  try {
    await timeout(
      events.wait(
        new Promise<void>((done) =>
          sentinel.stdout!.once(
            'data',
            events.guard(() => done())
          )
        )
      )
    );
    await client.start();
    phase = 'native-open';
    await rpc('runtime.open', 'TEST-original-open', { memberId: 'alice-id' });
    assert.equal(
      (await rpc('runtime.read', 'TEST-ready-read', { memberId: 'alice-id' })).nativeReady,
      true
    );
    assert.ok(witness);
    assert.equal(witness.process.exitCode, null);
    assert.deepEqual(counts, { allocate: 1, prepare: 1, resume: 1, stop: 0, release: 0 });
    phase = 'native-turn';
    const input = await rpc('team.execute', 'human-native-two', {
      operation: 'message.send',
      payload: {
        to: 'alice',
        text: 'NATIVE_TEAM_TWO',
        messageId: 'human-native-two',
        actionMode: 'do',
      },
    });
    const inputId = row(input.effects).deliveryId;
    assert.equal(typeof inputId, 'string');
    const deadline = performance.now() + 35000;
    while (!nativeTurn) {
      assert.deepEqual(model.failures, []);
      const state = await rpc('runtime.read', 'TEST-original-terminal-read', {
        memberId: 'alice-id',
      });
      assert.ok(Array.isArray(state.inputs));
      const original = state.inputs.map(row).find((item) => item.inputId === inputId);
      if (original?.phase === 'terminal') {
        assert.equal(original.terminal, 'succeeded');
        nativeTurn = true;
      } else {
        assert.ok(performance.now() < deadline, 'Original native turn deadline');
        await delay(25);
      }
    }
    assert.equal(readFileSync(join(sandbox, 'workspace/native-effect.txt'), 'utf8'), 'TWO\n');
    assert.deepEqual(
      model.observations.map((item) => [item.turn, item.step]),
      [
        ['NATIVE_TEAM_TWO', 0],
        ['NATIVE_TEAM_TWO', 1],
        ['NATIVE_TEAM_TWO', 2],
      ]
    );
    assert.ok(
      model.observations.every((item) => item.contextEffective && item.visibleReplyContract)
    );
    assert.equal(model.probes.length, 0);
    assert.deepEqual(model.failures, []);
    originalHandleChecks.afterInput = await witness.observe();
    assert.equal(originalHandleChecks.afterInput, 'alive');
    assert.equal(sentinel.exitCode, null);
    phase = mode;
    if (mode === 'graceful') {
      await client.shutdown();
      assert.ok(counts.stop >= 1 && counts.stop <= 4);
      assert.equal(counts.release, 1);
    } else {
      assert.ok(hostExited);
      writeFileSync(captured.crash, 'TEST original Host crash\n', { flag: 'wx' });
      await timeout(hostExited, 5000);
      await client.shutdown();
      assert.equal(counts.stop, 0);
      assert.equal(counts.release, 0);
      originalHandleChecks.afterHostLoss = await witness.observe();
      assert.equal(originalHandleChecks.afterHostLoss, 'alive',
        'Fresh zero-time observation of the same original HANDLE after original Host exit');
      retainedAfterCrash = true;
      // Source refusal cannot take away cleanup through the original physical owner.
      writeFileSync(captured.source, JSON.stringify({ TEST_CHANGED_SOURCE: true }));
    }
    phase = 'main-cleanup';
    assert.equal(await physical.close(), true);
    originalHandleChecks.afterCleanup = await witness.observe();
    assert.equal(originalHandleChecks.afterCleanup, 'absent');
    assert.equal(await witness.wait(), 0);
    assert.equal(sentinel.exitCode, null, 'Original unrelated process survives Main cleanup');
    verify();
    passed = true;
  } catch (error) {
    originalFailure = error;
  } finally {
    try {
      await client.shutdown();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      assert.equal(await physical.close(), true);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (witness) assert.equal(await witness.wait(), 0);
    } catch (error) {
      cleanupErrors.push(error);
    }
    // Only TEST ChildProcess objects opened here; the existing native controller independently proves Job zero.
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill();
    try {
      await timeout(Promise.all(exits.values()), 10000);
      await model.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    cleanup = cleanupErrors.length === 0;
    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          kind: 'TEST_WINDOWS_MAIN_RETAINED_CLAUDE',
          sourceHead: process.env.EXPECTED_SOURCE_SHA,
          mode,
          platform: 'win32-' + process.arch,
          nodeVersion: process.version,
          status: passed && cleanup && originalFailure === undefined ? 'PASS' : 'INCOMPLETE',
          phase,
          digests: { ...digests, cli: hash(captured.cli) },
          nativePackageVersion: selected.version,
          ordinaryHostConsumer: true,
          nativeTurn,
          retainedAfterCrash,
          originalHandleChecks,
          counts,
          cleanup,
          modelRequests: model.observations.length,
          modelFailures: model.failures.length,
          registryQualified: false,
          hostRebindQualified: false,
          sdkColdConversationQualified: false,
          desktopQualified: false,
          releaseQualified: false,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx' }
    );
  }
  if (originalFailure !== undefined || cleanupErrors.length)
    throw new AggregateError(
      [...(originalFailure === undefined ? [] : [originalFailure]), ...cleanupErrors],
      'Actual Main-retained native Host gate failed; original evidence retained'
    );
  assert.ok(passed && cleanup);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [broker, fixture, selection, sha256, receipt, mode, flag, sandbox] = process.argv.slice(2);
  assert.ok(broker && fixture && selection && sha256 && receipt && sandbox);
  assert.ok(mode === 'graceful' || mode === 'crash');
  assert.equal(flag, '--controller-sandbox');
  await runNativeRetainedHostGate(
    realpathSync(broker),
    realpathSync(fixture),
    realpathSync(selection),
    sha256,
    resolve(receipt),
    mode,
    realpathSync(sandbox)
  );
}
