import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { FileRuntimeEventStorage } from '../dist/adapters/runtime/FileRuntimeEventStorage.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { deliveryFingerprint, normalizeBinding } from '../dist/runtime/identity.js';
import { preparedInputProof } from '../dist/runtime/inputPreparation.js';
import { effectId } from '../dist/team/identity.js';
import { fileHash, tick, treeHash, startHost } from './fixtures/native-host.ts';
import { processFacts } from './fixtures/native-input-capture.ts';
import {
  CONTEXT_MARKER,
  record,
  startNativeTeamModel,
} from './fixtures/native-claude-team/model.ts';
import {
  COMPACT_COMMAND,
  COMPACT_SEED,
  COMPACT_VERIFY,
  COMPACT_FOLLOWUP,
} from './fixtures/native-claude-compaction/model.ts';
import type { CompactionPhase } from './fixtures/native-claude-compaction/model.ts';
import type { ProcessFact } from './fixtures/native-input-capture.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { ClaudeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { RuntimeBinding } from '../dist/runtime/contracts.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { DeliveryIntent, TeamCommand } from '../dist/team/contracts.js';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const required = (name: string) => {
  const value = process.env[name];
  assert.ok(value, `${name} is selected by Root`);
  return value;
};
const sourcePaths = [
  'tests/native-claude-compaction.native.ts',
  'tests/fixtures/native-claude-compaction/model.ts',
  'tests/fixtures/native-claude-team/model.ts',
  'tests/fixtures/native-claude-subagent/model.ts',
  'tests/fixtures/native-peers.ts',
  'tests/fixtures/native-host.ts',
  'tests/fixtures/native-input-capture.ts',
];

/** TEST-only bounded inspection of actual native transcript rows, never a product reader. */
async function nativeBoundaries(config: string) {
  const files: { path: string; sha256: string }[] = [],
    boundaries: Record<string, unknown>[] = [];
  let entries = 0,
    bytes = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    assert.ok(depth < 8);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 128);
      if (entry.isSymbolicLink()) continue; // No-follow inspection: sidecar links never supply evidence.
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        assert.ok(files.length < 16);
        const data = await readFile(path);
        bytes += data.length;
        assert.ok(bytes <= 4 * 1024 * 1024);
        files.push({ path, sha256: sha(data) });
        for (const line of data.toString('utf8').split('\n').filter(Boolean)) {
          const row = record(JSON.parse(line) as unknown);
          if (row.type === 'system' && row.subtype === 'compact_boundary') boundaries.push(row);
        }
      }
    }
  }
  await walk(config, 0);
  return { files, boundaries };
}

test(
  'actual native compact -> supported current roster/Task recapture -> exactly one prepared original input, with cold proof recovery',
  { timeout: 300_000 },
  async (t) => {
    assert.equal(
      process.env.LEGACY_NATIVE_CLAUDE_COMPACTION_GO,
      '1',
      'Root GO required; no implicit native run'
    );
    const repo = resolve(import.meta.dirname, '../../..'),
      pkg = join(repo, 'packages/legacy-agent-host');
    const node = await realpath(required('LEGACY_NATIVE_COMPACTION_NODE'));
    assert.equal(await realpath(process.execPath), node);
    const entry = join(pkg, 'dist/cli.js'),
      artifactPath = resolve(repo, required('LEGACY_NATIVE_PROVIDER_ARTIFACT'));
    const providerEntry = await realpath(
      join(pkg, 'node_modules/@agent-teams/provider-implementations/dist/claude.js')
    );
    const sdk = createRequire(providerEntry).resolve('@anthropic-ai/claude-agent-sdk');
    assert.equal(
      record(JSON.parse(await readFile(join(dirname(sdk), 'package.json'), 'utf8'))).version,
      '0.3.305'
    );
    const native = {
      path: await realpath(
        createRequire(sdk).resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
      ),
      sha256: '',
    };
    native.sha256 = await fileHash(native.path);
    assert.equal(native.sha256, required('LEGACY_NATIVE_CLAUDE_SHA256'));
    const artifacts = {
      node: { path: node, sha256: await fileHash(node) },
      native,
      provider: {
        path: artifactPath,
        sha256: await fileHash(artifactPath),
        distSha256: await treeHash(dirname(providerEntry), '.js'),
      },
      sdk: { path: sdk, sha256: await fileHash(sdk) },
      host: {
        entry,
        entrySha256: await fileHash(entry),
        sourceSha256: await treeHash(join(pkg, 'src'), '.ts'),
        distSha256: await treeHash(join(pkg, 'dist'), '.js'),
      },
      fixtureSources: Object.fromEntries(
        await Promise.all(
          sourcePaths.map(async (path) => [path, await fileHash(join(pkg, path))] as const)
        )
      ),
    };
    assert.equal(artifacts.provider.sha256, required('LEGACY_NATIVE_PROVIDER_SHA256'));
    assert.equal(artifacts.provider.distSha256, required('LEGACY_NATIVE_PROVIDER_DIST_SHA256'));
    assert.equal(
      artifacts.sdk.sha256,
      'c8d3e6cf794501c9b2dad3199762e4594e7b890e8ce76f957e9d748e02680bb1'
    );
    assert.equal(artifacts.host.sourceSha256, required('LEGACY_NATIVE_HOST_SOURCE_SHA256'));
    assert.equal(artifacts.host.distSha256, required('LEGACY_NATIVE_HOST_DIST_SHA256'));
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-claude-compaction-'))),
      namespace = basename(root);
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const name of ['home', 'config', 'workspace', 'tmp', 'store'])
      await mkdir(join(root, name), { mode: 0o700 });
    const untouchedPath = join(root, 'workspace/TEST-unrelated.txt');
    await writeFile(untouchedPath, 'TEST unrelated native compact fixture bytes\n');
    const untouchedSha256 = await fileHash(untouchedPath);
    const owner = {
      ownerId: `TEST-owner-${namespace}`,
      revision: 'TEST-revision',
      storageRoot: join(root, 'store'),
      profileId: `TEST-profile-${namespace}`,
      protocolVersion: 1 as const,
      buildId: 'TEST-native-compaction',
      nodeSha256: artifacts.node.sha256,
      hostEntrySha256: artifacts.host.entrySha256,
    };
    const scope = {
      projectId: `TEST-project-${namespace}`,
      workspaceId: `TEST-workspace-${namespace}`,
      teamId: 'TEST-m10-team',
      runId: `TEST-run-${namespace}`,
      memberId: 'human',
      generation: '1',
    };
    const binding = { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-m10-team' };
    const initialBinding = {
      backendId: binding.backendId,
      teamId: binding.teamId,
      runId: scope.runId,
      memberId: 'lead-id',
      generation: '1',
    };
    let selectedBinding: RuntimeBinding = initialBinding,
      phase: CompactionPhase = 'seed',
      taskId = '';
    const inputId = (commandId: string) =>
      effectId('delivery', binding.backendId, binding.teamId, commandId);
    const store = new FileRuntimeStore(owner.storageRoot),
      events = new FileRuntimeEventStorage(owner.storageRoot);
    const teamStore = new TeamOwnerStore(owner.storageRoot, binding.teamName);
    const state = () => {
      const value = teamStore.read<OwnerState>('state.json');
      assert.ok(value);
      return value;
    };
    const runtime = (target = selectedBinding) =>
      store.fenced(target, (tx) => {
        const value = tx.get();
        assert.ok(value);
        return value;
      });
    const preparedOriginal = () => {
      const input = runtime().inputs.find(
        (row) => row.intent.inputId === inputId('TEST-m10-verify')
      );
      assert.ok(input?.preparation);
      return input;
    };
    const model = await startNativeTeamModel({
      contextCompaction: {
        phase: () => phase,
        taskId: () => taskId,
        preparedInput: () => {
          const input = preparedOriginal();
          assert.ok(input.preparation);
          return { prefix: input.preparation.prefix, originalContent: input.intent.content };
        },
      },
    });
    let modelClosed = false;
    const closeModel = async () => {
      if (!modelClosed) {
        await model.close();
        modelClosed = true;
      }
    };
    t.after(closeModel);
    const environment = {
      HOME: join(root, 'home'),
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      TMPDIR: join(root, 'tmp'),
      PATH: `${dirname(node)}:/usr/bin:/bin`,
      ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY',
      ANTHROPIC_BASE_URL: model.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_TELEMETRY: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    };
    const member: ClaudeMemberProfile = {
      teamId: scope.teamId,
      memberId: 'lead-id',
      principalId: 'lead-session',
      provider: 'claude',
      sessionId: `TEST-session-${namespace}`,
      generation: 1,
      configRevision: 'TEST-config-1',
      cwd: join(root, 'workspace'),
      model: 'claude-sonnet-4-6',
      accountBinding: 'TEST-dummy-account',
      executable: native,
      environment,
      nativeTools: [],
      autoAllowedTools: [],
      nativeOptions: {
        settingSources: [],
        context: 'model-default',
        projectInstructions: {
          append: `${CONTEXT_MARKER} TEST-only native compact qualification. No filesystem effects or tool calls requested.`,
        },
      },
      limits: {
        queuedInputs: 4,
        inputBytes: 128 * 1024,
        outputBytes: 2_000_000,
        outputEvents: 2000,
        pendingInteractions: 4,
        timeoutMs: 45_000,
      },
    };
    const profile: TeamHostProfile = {
      schemaVersion: 1,
      owner,
      principalId: 'human',
      teams: [
        {
          scope,
          binding,
          savedSettings: {
            cwd: member.cwd,
            providerId: 'anthropic',
            providerBackendId: 'cli-sdk',
            model: member.model,
            limitContext: true,
          },
          members: [
            {
              memberId: 'lead-id',
              name: 'lead',
              role: 'lead',
              delivery: { ...binding, ...initialBinding },
            },
          ],
          grants: [
            {
              principalId: 'human',
              memberName: 'user',
              permissions: ['read', 'message.write', 'task.write', 'admin'],
            },
            {
              principalId: 'lead-session',
              memberName: 'lead',
              permissions: ['read', 'message.write', 'task.write'],
            },
          ],
        },
      ],
      runtime: {
        members: [member],
        providerTemplates: [
          {
            ...structuredClone(member),
            memberId: 'TEST-template',
            principalId: 'TEST-template',
            sessionId: 'TEST-template',
          },
        ],
      },
    };
    const profilePath = join(root, 'profile.json'),
      profileBytes = JSON.stringify(profile);
    await writeFile(profilePath, profileBytes, { mode: 0o600 });
    let host: ReturnType<typeof startHost> | undefined,
      passed = false,
      originalFailure: unknown,
      finalFailure: unknown;
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [],
      children: ProcessFact[] = [],
      receipts: { command: TeamCommand; receipt: Record<string, unknown> }[] = [];
    const proofs: Record<string, unknown> = {},
      envelope = (commandId: string, payload: unknown) => ({
        commandId,
        binding: { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope },
        payload,
      });
    const rpc = async (method: string, commandId: string, payload: unknown) => {
      const result = await host!.rpc(method, envelope(commandId, payload));
      assert.equal(result.ok, true, JSON.stringify(result));
      return result;
    };
    const start = async () => {
      let diagnosticBytes = 0;
      host = startHost({
        node,
        entry,
        root,
        profile: profilePath,
        profileHash: sha(profileBytes),
        onDiagnostic(chunk) {
          const selected = chunk.subarray(0, Math.max(0, 64 * 1024 - diagnosticBytes));
          diagnosticBytes += selected.length;
          if (selected.length)
            appendFileSync(join(root, 'host-stderr.log'), selected, { mode: 0o600 });
        },
      });
      await host.rpc('host.handshake', { protocolVersion: 1 });
    };
    const close = async () => {
      assert.ok(host);
      await host.close();
      hosts.push(host.facts());
      host = undefined;
    };
    const childCensus: { hostPid: number; children: ProcessFact[] }[] = [];
    const captureChildren = (expected: number) => {
      assert.ok(host?.child.pid);
      const direct = processFacts().filter((row) => row.parentPid === host!.child.pid);
      assert.ok(direct.length <= 8);
      childCensus.push({ hostPid: host.child.pid, children: direct });
      const found = direct.filter((row) => row.command === native.path);
      assert.equal(found.length, expected);
      for (const child of found) {
        assert.equal(child.groupId, child.pid);
        children.push(child);
      }
    };
    const assertAbsent = () => {
      const table = processFacts();
      return children.map((child) => {
        const present = table.filter(
          (row) => row.pid === child.pid || row.groupId === child.groupId
        );
        assert.deepEqual(present, [], 'only originally captured native PID/groups must be absent');
        return { child, absent: true };
      });
    };
    const ready = async (memberId: string) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        assert.deepEqual(model.failures, []);
        const result = await rpc('runtime.read', 'TEST-m10-ready', { memberId });
        if (record(result.value).nativeReady === true) return;
        await tick();
      }
      throw new Error('Actual native member did not reach captured MCP readiness');
    };
    const terminal = async (originalId: string, memberId = 'lead-id') => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        assert.deepEqual(model.failures, []);
        const result = await rpc('runtime.read', 'TEST-m10-observe', { memberId });
        const found = (record(result.value).inputs as unknown[])
          .map(record)
          .find((row) => row.inputId === originalId);
        if (found?.phase === 'terminal') {
          assert.equal(found.terminal, 'succeeded');
          return;
        }
        await tick();
      }
      throw new Error('Original native compact/context input did not reach durable terminal');
    };
    const send = async (commandId: string, text: string, rich = false) => {
      const command: TeamCommand = {
        commandId,
        operation: 'message.send',
        payload: { to: 'lead', text, ...(rich ? { actionMode: 'ask' as const } : {}) },
      };
      const result = await rpc('team.execute', commandId, {
        operation: command.operation,
        payload: command.payload,
      });
      assert.equal(record(result.value).phase, 'completed');
      assert.equal(record(record(result.value).effects).deliveryId, inputId(commandId));
      receipts.push({ command, receipt: result });
      await terminal(inputId(commandId));
      return inputId(commandId);
    };
    try {
      await start();
      const launch = record((await rpc('team.launch.read', 'TEST-m10-launch-read', {})).value);
      await rpc('team.launch.start', 'TEST-m10-launch-start', {
        launchId: launch.launchId,
        rosterRevision: launch.rosterRevision,
      });
      await ready('lead-id');
      captureChildren(1);
      await send('TEST-m10-seed', COMPACT_SEED);
      phase = 'compact';
      await send('TEST-m10-compact', COMPACT_COMMAND);
      const originalRuntime = runtime(initialBinding),
        epoch = state().contextEpochs?.[0];
      assert.ok(epoch);
      assert.equal(state().contextEpochs?.length, 1);
      assert.equal(epoch.represented, undefined);
      assert.equal(epoch.candidate, undefined);
      const compactRows =
        events
          .readActivity(initialBinding)
          ?.events.filter((row) => row.data.kind === 'compaction') ?? [];
      assert.equal(compactRows.length, 1);
      assert.equal(compactRows[0]!.data.reason, 'manual');
      assert.equal(compactRows[0]!.data.sourceRef, epoch.sourceRef);
      assert.equal(epoch.sessionRef, originalRuntime.sessionRef);
      if (epoch.inputId !== undefined) {
        const compactInput = originalRuntime.inputs.find(
          (row) => row.intent.inputId === inputId('TEST-m10-compact')
        );
        assert.ok(compactInput);
        assert.equal(epoch.inputId, compactInput.intent.inputId);
        assert.equal(epoch.operationRef, compactInput.operationRef);
      }

      assert.match(epoch.sourceRef, /^[a-f0-9]{64}$/);
      assert.deepEqual(
        originalRuntime.inputs.map((row) => row.intent.inputId),
        [inputId('TEST-m10-seed'), inputId('TEST-m10-compact')]
      );
      assert.equal(originalRuntime.inputs[1]!.intent.content, COMPACT_COMMAND);
      assert.ok(
        originalRuntime.inputs.every((row) => row.fingerprint === deliveryFingerprint(row.intent))
      );
      assert.ok(
        originalRuntime.inputs.every((row) => row.preparation === undefined),
        'no hidden reminder before the original actual compact boundary'
      );
      proofs.actualCompaction = {
        epoch,
        events: compactRows,
        originalInputs: originalRuntime.inputs,
      };
      const stopped = await rpc('runtime.stop', 'TEST-m10-stop-before-roster', {
        memberId: 'lead-id',
      });
      assert.equal(record(stopped.value).custody, 'released');
      await close();
      proofs.firstPhysicalCleanup = assertAbsent();
      const transcript = await nativeBoundaries(join(root, 'config'));
      assert.equal(
        transcript.boundaries.length,
        1,
        'actual native transcript has one physical compact boundary'
      );
      const nativeBoundary = transcript.boundaries[0]!,
        nativeSession = nativeBoundary.session_id ?? nativeBoundary.sessionId;
      assert.equal(typeof nativeSession, 'string');
      assert.equal(typeof nativeBoundary.uuid, 'string');
      assert.equal(
        sha(JSON.stringify([nativeSession, nativeBoundary.uuid])),
        epoch.sourceRef,
        'actual native session/UUID independently match D stable sourceRef'
      );
      assert.equal(
        record(nativeBoundary.compact_metadata ?? nativeBoundary.compactMetadata).trigger,
        'manual'
      );
      proofs.nativeTranscript = transcript;
      await start();
      assert.equal(state().contextEpochs?.[0]?.epochId, epoch.epochId);
      assert.equal(state().contextEpochs?.[0]?.represented, undefined);
      const before = record((await rpc('team.roster.read', 'TEST-m10-roster-before', {})).value);
      const rosterCommandId = 'TEST-m10-current-roster';
      const roster = await rpc('team.roster.replace', rosterCommandId, {
        expectedRevision: before.revision,
        members: [{ name: 'bob', role: 'TEST_M10_FRESH_MEMBER_ROLE', providerId: 'anthropic' }],
      });
      const currentRoster = record(
        (await rpc('team.roster.read', 'TEST-m10-roster-current', {})).value
      );
      assert.notEqual(currentRoster.revision, before.revision);
      const task = await rpc('team.execute', 'TEST-m10-current-task', {
        operation: 'task.create',
        payload: { subject: 'TEST_M10_CURRENT_TASK_AFTER_COMPACT' },
      });
      assert.equal(record(task.value).phase, 'completed');
      taskId = String(record(record(task.value).effects).taskId);
      assert.match(taskId, /^[a-f0-9-]{36}$/);
      const currentTask = record(
        (await rpc('team.task.get', 'TEST-m10-current-task-read', { taskId })).value
      );
      assert.equal(currentTask.id, taskId);
      assert.equal(currentTask.subject, 'TEST_M10_CURRENT_TASK_AFTER_COMPACT');
      const capture = record(
          (await rpc('team.launch.capture', 'TEST-m10-current-capture', { rosterCommandId })).value
        ),
        nextLaunch = record(capture.launch);
      const freshMember = state().members.find((row) => row.memberId === 'lead-id');
      assert.ok(freshMember?.delivery);
      selectedBinding = normalizeBinding(freshMember.delivery);
      assert.notDeepEqual(selectedBinding, initialBinding);
      await rpc('team.launch.start', 'TEST-m10-current-start', {
        launchId: nextLaunch.launchId,
        rosterRevision: nextLaunch.rosterRevision,
      });
      const currentMembers = state().members;
      for (const member of currentMembers) await ready(member.memberId);
      captureChildren(2);
      assert.equal(runtime().inputs.length, 0, 'fresh launch has no synthetic prompt input');
      phase = 'verify';
      await send('TEST-m10-verify', COMPACT_VERIFY, true);
      const original = preparedOriginal(),
        preparation = original.preparation;
      assert.ok(preparation);
      assert.deepEqual(original.intent.binding, selectedBinding);
      assert.equal(
        preparation.bindingFingerprint,
        sha(JSON.stringify(normalizeBinding(selectedBinding)))
      );
      assert.equal(original.fingerprint, deliveryFingerprint(original.intent));
      assert.equal(preparation.intentFingerprint, original.fingerprint);
      assert.equal(preparation.inputId, original.intent.inputId);
      assert.equal(preparation.operationRef, original.operationRef);
      assert.equal(
        preparation.nativePayloadHash,
        sha(preparation.prefix + original.intent.content)
      );
      assert.equal(preparation.prefixHash, sha(preparation.prefix));
      const observedVerify = model.compactionRequests.find((row) => row.phase === 'verify');
      assert.ok(observedVerify);
      assert.equal(observedVerify.preparedPayloadSha256, preparation.nativePayloadHash);
      assert.deepEqual(preparation.epochIds, [epoch.epochId]);
      assert.ok(preparation.prefix.includes('"name":"bob"'));
      assert.ok(preparation.prefix.includes(taskId));
      assert.deepEqual(state().contextEpochs?.[0]?.represented, preparedInputProof(preparation));
      const leadActivity = record(
        (await rpc('team.lead.activity.read', 'TEST-m10-lead-activity', {})).value
      );
      assert.equal(leadActivity.kind, 'team-lead-activity');
      assert.equal(leadActivity.state, 'idle');
      assert.equal(record(leadActivity.launch).launchId, nextLaunch.launchId);
      const leadContext = record(
        (await rpc('team.lead.context.read', 'TEST-m10-lead-context', {})).value
      );
      assert.equal(leadContext.kind, 'team-lead-context');
      assert.equal(record(leadContext.launch).launchId, nextLaunch.launchId);
      if (leadContext.usage !== null) {
        const usage = record(leadContext.usage);
        for (const key of [
          'promptInputTokens',
          'contextUsedTokens',
          'contextWindowTokens',
          'contextUsedPercent',
        ])
          assert.equal(usage[key], null);
        assert.equal(usage.promptInputSource, 'unavailable');
      }
      proofs.leadViews = { activity: leadActivity, context: leadContext };
      const outbox = teamStore
        .list<DeliveryIntent>('outbox')
        .find((row) => row.inputId === original.intent.inputId);
      assert.ok(outbox);
      assert.equal(outbox.content, original.intent.content);
      phase = 'followup';
      await send('TEST-m10-followup', COMPACT_FOLLOWUP, true);
      const after = runtime();
      assert.deepEqual(
        after.inputs.map((row) => row.intent.inputId),
        [inputId('TEST-m10-verify'), inputId('TEST-m10-followup')]
      );
      assert.equal(after.inputs[1]!.preparation, undefined);
      for (const member of currentMembers.filter((row) => row.memberId !== 'lead-id')) {
        assert.ok(member.delivery);
        assert.equal(runtime(normalizeBinding(member.delivery)).inputs.length, 0);
      }
      proofs.currentContext = {
        roster,
        currentRoster,
        task,
        currentTask,
        capture,
        binding: selectedBinding,
        original,
        outbox,
        represented: state().contextEpochs?.[0]?.represented,
      };
      for (const member of currentMembers) {
        const result = await rpc('runtime.stop', 'TEST-m10-stop-current', {
          memberId: member.memberId,
        });
        assert.equal(record(result.value).custody, 'released');
      }
      await close();
      proofs.finalPhysicalCleanup = assertAbsent();
      const preparationBeforeCold = structuredClone(preparation),
        requestsBeforeCold = model.compactionRequests.length;
      await start();
      for (const original of receipts) {
        assert.deepEqual(
          await rpc('team.lookup', original.command.commandId, {}),
          original.receipt
        );
        assert.deepEqual(
          await rpc('team.execute', original.command.commandId, {
            operation: original.command.operation,
            payload: original.command.payload,
          }),
          original.receipt
        );
      }
      assert.deepEqual(runtime().inputs[0]!.preparation, preparationBeforeCold);
      assert.deepEqual(
        state().contextEpochs?.[0]?.represented,
        preparedInputProof(preparationBeforeCold)
      );
      assert.equal(model.compactionRequests.length, requestsBeforeCold);
      assert.equal(requestsBeforeCold, 4);
      assert.equal(
        processFacts().filter(
          (row) => row.parentPid === host!.child.pid && row.command === native.path
        ).length,
        0,
        'cold original lookup does not allocate native'
      );
      await close();
      proofs.coldRecovery = {
        exactOriginalPreparation: true,
        exactOriginalReceipts: receipts.length,
        noNativeAllocation: true,
        modelRequestsUnchanged: true,
      };
      assert.deepEqual(
        model.compactionRequests.map((row) => row.phase),
        ['seed', 'compact', 'verify', 'followup']
      );
      assert.deepEqual(model.failures, []);
      assert.equal(await fileHash(untouchedPath), untouchedSha256);
      passed = true;
    } catch (error) {
      originalFailure = error;
      throw error;
    } finally {
      let cleanupConfirmed = host === undefined,
        cleanupFailure: unknown;
      try {
        if (host) {
          await close();
          cleanupConfirmed = true;
        }
      } catch (error) {
        cleanupFailure = error;
      }
      try {
        await closeModel();
      } catch (error) {
        cleanupFailure ??= error;
      }
      const receipt: Record<string, unknown> = {
        status:
          passed && cleanupConfirmed && cleanupFailure === undefined ? 'SCOPED_PASS' : 'INCOMPLETE',
        root,
        artifacts,
        proofs,
        hosts,
        cleanupConfirmed,
        children,
        childCensus,
        modelRequests: model.compactionRequests,
        modelTokenCountRequests: model.compactionTokenRequests,
        modelFailures: model.failures,
        excluded: [
          'same-generation hot roster edit',
          'Desktop UI',
          'automatic compaction',
          'full context occupancy metrics',
          'real authentication',
          'M13 file evidence',
          'whole Stage1',
        ],
      };
      const failure = (error: unknown) =>
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error);
      if (originalFailure !== undefined) receipt.originalFailure = failure(originalFailure);
      if (cleanupFailure !== undefined) receipt.cleanupFailure = failure(cleanupFailure);
      try {
        receipt.physicalNativeCleanup = {
          qualified: children.length === 3,
          observations: assertAbsent(),
        };
        const final = {
          node: await fileHash(node),
          native: await fileHash(native.path),
          provider: await fileHash(artifactPath),
          providerDist: await treeHash(dirname(providerEntry), '.js'),
          sdk: await fileHash(sdk),
          hostSource: await treeHash(join(pkg, 'src'), '.ts'),
          hostDist: await treeHash(join(pkg, 'dist'), '.js'),
          hostEntry: await fileHash(entry),
          fixtureSources: Object.fromEntries(
            await Promise.all(
              sourcePaths.map(async (path) => [path, await fileHash(join(pkg, path))] as const)
            )
          ),
        };
        receipt.finalPins = final;
        assert.equal(final.node, artifacts.node.sha256);
        assert.equal(final.native, artifacts.native.sha256);
        assert.equal(final.provider, artifacts.provider.sha256);
        assert.equal(final.providerDist, artifacts.provider.distSha256);
        assert.equal(final.sdk, artifacts.sdk.sha256);
        assert.equal(final.hostSource, artifacts.host.sourceSha256);
        assert.equal(final.hostDist, artifacts.host.distSha256);
        assert.equal(final.hostEntry, artifacts.host.entrySha256);
        assert.deepEqual(final.fixtureSources, artifacts.fixtureSources);
        assert.equal(await fileHash(untouchedPath), untouchedSha256);
        receipt.sourcePinsUnchanged = true;
        receipt.unrelatedWorkspacePreserved = true;
      } catch (error) {
        receipt.status = 'INCOMPLETE';
        receipt.finalVerificationFailure = failure(error);
        cleanupFailure ??= error;
      }
      await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), {
        mode: 0o600,
      });
      if (originalFailure === undefined) finalFailure = cleanupFailure;
    }
    if (finalFailure !== undefined) throw finalFailure;
  }
);
