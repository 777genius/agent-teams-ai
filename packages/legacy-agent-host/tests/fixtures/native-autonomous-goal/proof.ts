import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { evidenceProjectDir } from '../../../dist/evidence/evidenceProjectDir.js';
import { captureInitialRuntimeModelAdmission } from '../../../dist/composition/initialRuntimeModelAdmission.js';
import {
  deliveryFingerprint,
  normalizeBinding,
  runtimeDigest,
} from '../../../dist/runtime/identity.js';
import { teamCommandPath } from '../../../dist/team/commandEntries.js';
import { fileHash, startHost, tick, treeHash } from '../native-host.ts';
import { captureCodexNativeInputs } from '../codex-native-closure.ts';
import { startNativeTeamModel } from '../native-claude-team/model.ts';
import { startCodexModel } from '../native-codex-team/model.ts';
import { startOpenCodeModel } from '../native-opencode-team/model.ts';
import {
  goalRow,
  nativeGoalArtifact,
  nativeGoalBytes,
  nativeGoalObjective,
  nativeGoalScript,
} from './model.ts';
import type { NativeGoalActor, NativeGoalProvider } from './model.ts';
import type { InitialRuntimeModelAction } from '../../../dist/composition/initialRuntimeModelAdmission.js';
import type { TeamHostProfile } from '../../../dist/composition/TeamHost.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../../../dist/runtime/contracts.js';
import type { CommandReceipt, DeliveryIntent } from '../../../dist/team/contracts.js';
import type { GoalRecord, GoalStatus } from '../../../dist/team/goalContracts.js';

const actors = ['alice', 'bob', 'carol'] as const;
const ATTEMPT_LIMIT = 24;
const providers = { alice: 'claude', bob: 'codex', carol: 'opencode' } as const;
type Row = Record<string, unknown>;
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const active = (phase: string) => phase === 'claimed' || phase === 'consumed';
const started = (phase: string) => active(phase) || phase === 'terminal';
const read = <T>(path: string): T => {
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};
const ok = <T>(reply: Row, label: string): T => {
  assert.equal(reply.ok, true, label + ': ' + String(reply.code ?? 'unknown'));
  return reply.value as T;
};

export interface NativeGoalSource {
  root: string;
  node: string;
  entry: string;
  profile: TeamHostProfile;
  initialLaunch: InitialRuntimeModelAction;
  modelUrls: { claude: string; codex: string; opencode: string };
  providerArchive: string;
  artifacts: {
    source: string;
    dist: string;
    entry: string;
    providerSha256: string;
    executables: Record<NativeGoalProvider, { path: string; sha256: string }>;
  };
  codexNativeInputs: Awaited<ReturnType<typeof captureCodexNativeInputs>>;
}
interface GoalCaseEvidence extends Row {
  status: 'INCOMPLETE' | 'PASS';
  leadProvider: NativeGoalProvider;
  actionMode: 'do' | 'delegate';
  root: string;
  cleanupConfirmed: boolean;
}
export interface NativeGoalMatrixEvidence extends Row {
  status: 'INCOMPLETE' | 'PASS';
  platform: string;
  arch: string;
  scriptedInference: true;
  genuineModelInference: false;
  overnightQualification: false;
  rows: GoalCaseEvidence[];
}

async function runCase(
  source: NativeGoalSource,
  lead: NativeGoalActor,
  mode: 'do' | 'delegate',
  evidence: GoalCaseEvidence,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const root = evidence.root;
  const workspace = join(root, 'workspace');
  for (const directory of [
    'home',
    'tmp',
    'store',
    'workspace',
    ...actors.flatMap((actor) => [
      actor,
      actor + '/home',
      actor + '/tmp',
      actor + '/config',
      actor + '/data',
      actor + '/cache',
      actor + '/workspace',
    ]),
    'carol/config/opencode',
  ])
    await mkdir(join(root, directory), { mode: 0o700 });
  execFileSync(
    '/usr/bin/git',
    ['-c', 'core.fsmonitor=false', '-c', 'init.templateDir=', 'init', '-q', workspace],
    {
      env: {
        HOME: join(root, 'home'),
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      timeout: 10_000,
    }
  );
  const suffix = providers[lead] + '-' + mode;
  const teamName = 'test-native-goal-' + suffix;
  const ownerId = source.profile.owner.ownerId + '-' + suffix;
  const teamId = 'TEST-goal-team-' + suffix;
  const runId = 'TEST-goal-run-' + suffix;
  const ownerRoot = join(root, 'store/teams', teamName, '.host-owner');
  const bindingFor = (actor: NativeGoalActor): RuntimeBinding => ({
    backendId: ownerId,
    teamId,
    runId,
    memberId: actor + '-id',
    generation: '1',
  });
  const runtime = (actor: NativeGoalActor): RuntimeSessionRecord => {
    const binding = bindingFor(actor);
    const member = {
      backendId: binding.backendId,
      teamId: binding.teamId,
      memberId: binding.memberId,
    };
    const value = read<RuntimeSessionRecord>(
      join(root, 'store/runtime-sessions', runtimeDigest(member), runtimeDigest(binding) + '.json')
    );
    assert.deepEqual(normalizeBinding(value.binding), binding);
    for (const input of value.inputs)
      assert.equal(input.fingerprint, deliveryFingerprint(input.intent));
    return value;
  };
  const goal = (): GoalRecord => {
    const value = read<{ autonomousGoal?: GoalRecord }>(
      join(ownerRoot, 'state.json')
    ).autonomousGoal;
    assert.ok(value);
    assert.equal(value.rootMode, mode);
    assert.equal(value.rootPrincipalId, 'human');
    return value;
  };
  const command = (id: string) => read<CommandReceipt>(join(ownerRoot, teamCommandPath(id)));
  const workers = actors.filter((actor) => actor !== lead).slice(0, lead === 'alice' ? 2 : 1);
  const scripts = Object.fromEntries(
    actors.map((actor) => [
      actor,
      nativeGoalScript({
        actor,
        lead,
        mode,
        workers,
        workspace,
        current() {
          const current = goal();
          const record = runtime(actor);
          const inputs = record.inputs.filter((input) => active(input.phase));
          assert.equal(inputs.length, 1, 'one actual original native inference input');
          const input = inputs[0]!;
          assert.match(input.intent.deliveryId, /^[a-f0-9-]{36}$/u);
          const outbox = read<DeliveryIntent>(
            join(ownerRoot, 'outbox', input.intent.deliveryId + '.json')
          );
          assert.ok(outbox.phase === 'pending' || outbox.phase === 'admitted');
          assert.equal(deliveryFingerprint(outbox), input.fingerprint);
          assert.equal(outbox.deliveryId, input.intent.deliveryId);
          assert.equal(outbox.inputId, input.intent.inputId);
          assert.equal(outbox.messageId, input.intent.messageId);
          assert.equal(outbox.content, input.intent.content);
          assert.deepEqual(normalizeBinding(outbox.binding), bindingFor(actor));
          const producing = command(outbox.commandId);
          assert.equal(
            producing.goal?.goalId,
            current.goalId,
            'this exact original outbox belongs to the current goal, not ordinary or historical work'
          );
          assert.equal(producing.goal.revision, current.revision);
          const intake = command(current.rootCommandId);
          assert.equal(intake.goal?.goalId, current.goalId);
          return {
            inputId: input.intent.inputId,
            operationRef: input.operationRef,
            goalId: current.goalId,
            content: input.intent.content,
            rootInput: input.intent.inputId === intake.effects.deliveryId,
            stopped: current.disposition === 'stopped',
          };
        },
      }),
    ])
  ) as Record<NativeGoalActor, ReturnType<typeof nativeGoalScript>>;
  const models: {
    claude?: Awaited<ReturnType<typeof startNativeTeamModel>>;
    codex?: Awaited<ReturnType<typeof startCodexModel>>;
    opencode?: Awaited<ReturnType<typeof startOpenCodeModel>>;
  } = {};
  let host: ReturnType<typeof startHost> | undefined;
  let phase = 'model-setup';
  const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  const assertModels = () => {
    for (const model of Object.values(models)) assert.deepEqual(model.failures, []);
  };
  const wait = async (
    label: string,
    predicate: () => Promise<boolean> | boolean,
    budget = 60_000
  ) => {
    const deadline = Date.now() + budget;
    for (;;) {
      signal.throwIfAborted();
      assertModels();
      const complete = await predicate();
      signal.throwIfAborted();
      if (complete) return;
      assert.ok(Date.now() < deadline, label);
      await tick();
    }
  };
  try {
    signal.throwIfAborted();
    models.claude = await startNativeTeamModel({ autonomousGoal: scripts.alice });
    signal.throwIfAborted();
    models.codex = await startCodexModel({ autonomousGoal: scripts.bob });
    signal.throwIfAborted();
    models.opencode = await startOpenCodeModel({ autonomousGoal: scripts.carol });
    const substitutions = [
      [source.root, root],
      [source.modelUrls.claude, models.claude.url],
      [source.modelUrls.codex, models.codex.url],
      [source.modelUrls.opencode, models.opencode.url],
    ] as const;
    const replace = (text: string) =>
      substitutions.reduce((result, [before, after]) => result.split(before).join(after), text);
    const profile = JSON.parse(replace(JSON.stringify(source.profile))) as TeamHostProfile;
    assert.equal(profile.teams.length, 1, 'goal proof never adopts the cross-Team fixture');
    const team = profile.teams[0]!;
    profile.owner.ownerId = ownerId;
    profile.owner.storageRoot = join(root, 'store');
    team.scope.teamId = teamId;
    team.scope.runId = runId;
    team.scope.projectId = 'TEST-goal-project-' + suffix;
    team.scope.workspaceId = 'TEST-goal-workspace-' + suffix;
    team.binding = { backendId: ownerId, teamId, teamName };
    for (const member of team.members) {
      const actor = actors.find((name) => member.memberId === name + '-id');
      assert.ok(actor);
      member.role = actor === lead ? 'lead' : 'member';
      member.delivery = { ...bindingFor(actor), teamName };
    }
    assert.ok(profile.runtime);
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = 'http://127.0.0.1:' + address.port;
    await new Promise<void>((done) => reservation.close(() => done()));
    for (const member of profile.runtime.members) {
      member.teamId = teamId;
      member.cwd = workspace;
      if (member.provider === 'opencode') member.endpoint = endpoint;
    }
    profile.promptSuggestions = { enabled: false };
    const originalConfig = await readFile(join(source.root, 'bob/config/config.toml'), 'utf8');
    assert.ok(originalConfig.includes(source.modelUrls.codex + '/v1'));
    assert.ok(originalConfig.includes('env_key = "TEST_CODEX_FIXTURE_KEY"'));
    await writeFile(join(root, 'bob/config/config.toml'), replace(originalConfig), { mode: 0o600 });
    const action: InitialRuntimeModelAction = {
      ...source.initialLaunch,
      teamId,
      commandId: 'TEST-goal-launch-' + suffix,
    };
    profile.runtime.initialModelAdmissions = [captureInitialRuntimeModelAdmission(profile, action)];
    const profileBytes = JSON.stringify(profile);
    const profilePath = join(root, 'profile.json');
    await writeFile(profilePath, profileBytes, { mode: 0o600 });
    evidence.profileSha256 = hash(profileBytes);
    const binding = {
      schemaVersion: 1,
      handleId: 'TEST-goal-handle-' + suffix,
      owner: profile.owner,
      scope: team.scope,
    };
    const envelope = (commandId: string, payload: unknown) => ({ binding, commandId, payload });
    const start = () => {
      signal.throwIfAborted();
      return startHost({
        node: source.node,
        entry: source.entry,
        root,
        profile: profilePath,
        profileHash: hash(profileBytes),
      });
    };
    const rpc = async <T>(method: string, payload: unknown, commandId: string): Promise<T> => {
      signal.throwIfAborted();
      const result = ok<T>(await host!.rpc(method, envelope(commandId, payload)), method);
      signal.throwIfAborted();
      return result;
    };
    const publicGoal = async () =>
      (await rpc<{ autonomousGoal?: GoalStatus }>('team.snapshot', {}, 'TEST-goal-snapshot'))
        .autonomousGoal;
    phase = 'native-launch';
    host = start();
    await host.rpc('host.handshake', { protocolVersion: 1 });
    const before = await rpc<Row>('team.launch.read', {}, 'TEST-goal-launch-read');
    await rpc(
      'team.launch.start',
      { launchId: before.launchId, rosterRevision: before.rosterRevision, ...action.payload },
      action.commandId
    );
    await wait('original three native members must become ready', async () => {
      const launch = await rpc<Row>('team.launch.read', {}, 'TEST-goal-launch-read');
      evidence.launch = launch;
      assert.ok(!['failed', 'unknown'].includes(String(launch.status)), JSON.stringify(launch));
      return launch.status === 'ready' && launch.ready === 3;
    });
    const available = await rpc<{ autonomousGoalAvailable?: boolean }>(
      'team.snapshot',
      {},
      'TEST-goal-ready'
    );
    assert.equal(available.autonomousGoalAvailable, true);
    const intake = async (stop: boolean) => {
      const id = 'TEST-goal-' + suffix + (stop ? '-stop' : '-happy');
      const payload = {
        operation: 'message.send',
        payload: {
          to: lead,
          text: nativeGoalObjective(stop),
          actionMode: mode,
          autonomousGoal: { durationHours: 1, maxAttempts: ATTEMPT_LIMIT },
        },
      };
      const receipt = await rpc<CommandReceipt>('team.execute', payload, id);
      assert.equal(receipt.phase, 'completed');
      assert.deepEqual(await rpc('team.lookup', payload, id), receipt);
      assert.deepEqual(await rpc('team.execute', payload, id), receipt);
      return { id, payload, receipt };
    };
    phase = 'happy-native-work';
    const happyIntake = await intake(false);
    await wait(
      'real native goal must accept and publish',
      async () => {
        const value = await publicGoal();
        if (!value) return false;
        evidence.happyCurrent = value;
        assert.notEqual(value.disposition, 'stopped');
        assert.ok(
          value.attemptsUsed < value.attemptLimit,
          'native goal cannot pass by exhausting its budget'
        );
        return value.disposition === 'accepted' && value.published === true;
      },
      90_000
    );
    const happy = await publicGoal();
    assert.ok(happy?.resultMessageId && happy.attemptsUsed > 0);
    const happyRecord = goal();
    assert.equal(Object.keys(happyRecord.debits).length, happy.attemptsUsed);
    assert.ok(
      !happyRecord.debits[String(happyIntake.receipt.effects.deliveryId)],
      'human intake is not an automatic debit'
    );
    const commands = readdirSync(join(ownerRoot, 'commands'))
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .map((name) => read<CommandReceipt>(join(ownerRoot, 'commands', name)));
    assert.ok(commands.length < 128, 'finite original goal command inventory');
    const continuations = commands.filter(
      (row) => row.goal?.goalId === happy.goalId && row.goal.continuation
    );
    assert.ok(continuations.length > 0);
    const neverSent = (phase: string) => ['cancelled', 'not-sent', 'rejected'].includes(phase);
    const succeeded = (input: RuntimeSessionRecord['inputs'][number]) =>
      input.phase === 'terminal' && input.terminal === 'succeeded';
    for (const [inputId, debit] of Object.entries(happyRecord.debits)) {
      const actor = actors.find((name) => debit.binding.memberId === name + '-id');
      assert.ok(actor);
      assert.deepEqual(normalizeBinding(debit.binding), bindingFor(actor));
      const original = runtime(actor).inputs.find((input) => input.intent.inputId === inputId);
      assert.ok(
        original && (succeeded(original) || neverSent(original.phase)),
        'each retained debit has a successful or explicitly never-sent original Runtime witness'
      );
      const outbox = read<DeliveryIntent>(join(ownerRoot, 'outbox', inputId + '.json'));
      assert.equal(outbox.commandId, debit.commandId);
      assert.equal(deliveryFingerprint(outbox), original.fingerprint);
      assert.equal(command(debit.commandId).goal?.goalId, happy.goalId);
    }
    const successfulContinuations: CommandReceipt[] = [];
    for (const continuation of continuations) {
      const original = continuation.goal!.continuation!;
      const actor = actors.find((name) => original.source.binding.memberId === name + '-id');
      const target = actors.find((name) => original.target.memberId === name + '-id');
      assert.ok(actor && target);
      assert.deepEqual(normalizeBinding(original.source.binding), bindingFor(actor));
      assert.deepEqual(normalizeBinding(original.target), bindingFor(target));
      assert.ok(
        runtime(actor).inputs.some(
          (input) =>
            input.intent.inputId === original.source.inputId &&
            input.operationRef === original.source.operationRef &&
            input.fingerprint === original.source.inputFingerprint
        ),
        'every continuation retains its exact actual native predecessor'
      );
      const inputId = String(continuation.effects.deliveryId);
      const input = runtime(target).inputs.find((input) => input.intent.inputId === inputId);
      assert.ok(
        input && (succeeded(input) || neverSent(input.phase)),
        'unknown or in-flight continuation cannot satisfy native qualification'
      );
      const outbox = read<DeliveryIntent>(join(ownerRoot, 'outbox', inputId + '.json'));
      assert.equal(outbox.commandId, continuation.commandId);
      assert.equal(deliveryFingerprint(outbox), input.fingerprint);
      if (succeeded(input)) {
        assert.equal(continuation.phase, 'completed');
        assert.ok(
          happyRecord.debits[inputId],
          'successful automatic input owns its original debit'
        );
        successfulContinuations.push(continuation);
      } else {
        assert.ok(
          !scripts[target].observations.some((row) => row.inputId === inputId),
          'an explicitly never-sent retirement is not successful native work'
        );
        // A never-sent retirement preserves any existing debit; it is not successful native work.
      }
    }
    const productive = mode === 'do' ? [lead] : workers;
    for (const actor of productive) {
      assert.ok(
        successfulContinuations.some((row) => row.deliveryBinding?.memberId === actor + '-id'),
        'each productive actor has a real charged continuation'
      );
      const record = runtime(actor);
      for (const final of [false, true]) {
        const path = join(workspace, nativeGoalArtifact(actor, false, final));
        assert.equal(await readFile(path, 'utf8'), nativeGoalBytes(actor, final));
      }
      const ledger = await new AgentChangeLedgerReader().readAgentChangesWithEvidence({
        teamName,
        memberName: actor,
        actorId: actor + '-id',
        projectDir: evidenceProjectDir(profile.owner.storageRoot, teamName),
        projectPath: workspace,
      });
      const finalPath = join(workspace, nativeGoalArtifact(actor, false, true));
      const effects = ledger.evidence.filter(
        (event) => event.filePath === finalPath && event.actorId === actor + '-id'
      );
      assert.ok(
        effects.some((event) => {
          const cause = goalRow(event.causalBinding);
          assert.deepEqual(normalizeBinding(cause.binding as RuntimeBinding), bindingFor(actor));
          return record.inputs.some(
            (input) =>
              input.intent.inputId === cause.inputId &&
              input.operationRef === cause.operationRef &&
              input.phase === 'terminal' &&
              input.terminal === 'succeeded'
          );
        }),
        'actual native artifact retains its original Runtime provenance'
      );
      const finalHash = await fileHash(finalPath);
      assert.ok(
        ledger.changes.files.some((file) =>
          file.snippets.some(
            (snippet) =>
              snippet.filePath === finalPath &&
              !snippet.isError &&
              snippet.ledger?.nativeCapture === 'qualified' &&
              snippet.ledger.afterHash === finalHash
          )
        ),
        'the actual final file has qualified native capture'
      );
    }
    const messages = async () =>
      (
        await rpc<{ messages: { messageId?: string; text: string }[] }>(
          'team.messages.page',
          {},
          'TEST-goal-messages'
        )
      ).messages;
    assert.equal(
      (await messages()).filter((row) => row.messageId === happy.resultMessageId).length,
      1
    );
    const inputWitnesses = (actor: NativeGoalActor) =>
      runtime(actor).inputs.map((input) => ({
        inputId: input.intent.inputId,
        operationRef: input.operationRef,
        phase: input.phase,
        terminal: input.terminal,
        fingerprint: input.fingerprint,
      }));
    evidence.happy = {
      status: 'PASS',
      goal: happy,
      originalIntake: happyIntake.receipt,
      debits: happyRecord.debits,
      runtime: Object.fromEntries(actors.map((actor) => [actor, inputWitnesses(actor)])),
      continuations: continuations.map((row) => ({
        commandId: row.commandId,
        inputId: row.effects.deliveryId,
        target: row.deliveryBinding,
        source: row.goal!.source,
      })),
    };

    phase = 'stop-original-inputs';
    const stopIntake = await intake(true);
    const stopActors = mode === 'do' ? [lead] : [lead, ...workers];
    await wait(
      'Stop must observe the original in-flight native response',
      () => stopActors.every((actor) => scripts[actor].heldInputIds().length === 1),
      45_000
    );
    const stoppedBefore = await publicGoal();
    assert.ok(stoppedBefore?.disposition === 'active');
    const startedBefore = new Map(
      actors.map((actor) => [
        actor,
        new Map(
          runtime(actor)
            .inputs.filter((input) => started(input.phase))
            .map((input) => [input.intent.inputId, input.operationRef])
        ),
      ])
    );
    const exactHeld = stopActors.map((actor) => {
      const inputId = scripts[actor].heldInputIds()[0]!;
      const input = runtime(actor).inputs.find((row) => row.intent.inputId === inputId);
      assert.ok(input && active(input.phase));
      return { actor, inputId, operationRef: input.operationRef, phase: input.phase };
    });
    const stopId = 'TEST-goal-stop-control-' + suffix;
    const stopCommand = {
      goalId: stoppedBefore.goalId,
      expectedRevision: stoppedBefore.revision,
      action: 'stop',
    };
    const stopped = await rpc<GoalStatus>('team.goal.control', stopCommand, stopId);
    assert.equal(stopped.disposition, 'stopped');
    assert.deepEqual(await rpc('team.goal.control', stopCommand, stopId), stopped);
    const inferenceCount = actors.map((actor) => scripts[actor].observations.length);
    for (const actor of stopActors) scripts[actor].releaseHeld();
    await wait('only original inputs may settle after Stop', async () => {
      const current = await publicGoal();
      assert.ok(current);
      assert.equal(current.disposition, 'stopped');
      assert.equal(current.attemptsUsed, stopped.attemptsUsed);
      assert.notEqual(current.published, true);
      for (const actor of actors)
        for (const input of runtime(actor).inputs) {
          if (started(input.phase))
            assert.equal(
              startedBefore.get(actor)!.get(input.intent.inputId),
              input.operationRef,
              'Stop forbids any new claim, including an input that was only admitted before Stop'
            );
        }
      assert.deepEqual(
        actors.map((actor) => scripts[actor].observations.length),
        inferenceCount
      );
      return exactHeld.every((original) =>
        runtime(original.actor).inputs.some(
          (input) =>
            input.intent.inputId === original.inputId &&
            input.operationRef === original.operationRef &&
            input.phase === 'terminal' &&
            input.terminal === 'succeeded'
        )
      );
    });
    assert.equal(
      (await messages()).filter((row) => row.messageId === happy.resultMessageId).length,
      1
    );
    const afterStopCommands = readdirSync(join(ownerRoot, 'commands'))
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .map((name) => read<CommandReceipt>(join(ownerRoot, 'commands', name)));
    assert.ok(
      !afterStopCommands.some(
        (row) => row.goal?.goalId === stopped.goalId && row.goal.kind === 'result'
      ),
      'Stop has no canonical final-result command, including one hidden by the stopped status'
    );
    evidence.stop = {
      status: 'PASS',
      goal: await publicGoal(),
      originalIntake: stopIntake.receipt,
      originalControl: stopped,
      originalInputs: exactHeld,
      nativeRequestsUnchanged: true,
      automaticAttemptsUnchanged: true,
      noFinalPublication: true,
    };

    phase = 'native-cleanup';
    for (const actor of actors) {
      const closed = await rpc<Row>(
        'runtime.stop',
        { memberId: actor + '-id', expectedGeneration: '1' },
        'TEST-goal-native-stop-' + actor
      );
      assert.equal(closed.custody, 'released');
    }
    await host.close();
    hosts.push(host.facts());
    host = undefined;
    evidence.cleanupConfirmed = true;
    phase = 'cold-read-and-replay';
    host = start();
    evidence.cleanupConfirmed = false;
    await host.rpc('host.handshake', { protocolVersion: 1 });
    assert.deepEqual(
      await rpc('team.execute', stopIntake.payload, stopIntake.id),
      stopIntake.receipt
    );
    assert.deepEqual(await rpc('team.goal.control', stopCommand, stopId), stopped);
    const cold = await publicGoal();
    assert.equal(cold?.disposition, 'stopped');
    assert.equal(cold.attemptsUsed, stopped.attemptsUsed);
    assert.equal(
      (await messages()).filter((row) => row.messageId === happy.resultMessageId).length,
      1
    );
    for (const actor of actors) {
      const view = await rpc<Row>(
        'runtime.read',
        { memberId: actor + '-id' },
        'TEST-goal-cold-' + actor
      );
      assert.equal(view.attached, false);
      assert.equal(runtime(actor).custody, 'released');
    }
    assert.deepEqual(
      actors.map((actor) => scripts[actor].observations.length),
      inferenceCount
    );
    assertModels();
    evidence.coldReadback = { status: 'PASS', noNativeReplay: true, goal: cold };
    await host.close();
    hosts.push(host.facts());
    host = undefined;
    evidence.cleanupConfirmed = true;
    evidence.status = 'PASS';
  } catch (error) {
    evidence.failurePhase = phase;
    evidence.reason =
      error instanceof Error ? error.message.slice(0, 2048) : 'Native goal proof failed';
    throw error;
  } finally {
    try {
      if (host) {
        await host.close();
        hosts.push(host.facts());
        evidence.cleanupConfirmed = true;
      }
    } finally {
      for (const actor of actors)
        if (scripts[actor].heldInputIds().length) scripts[actor].releaseHeld();
      const results = await Promise.allSettled(Object.values(models).map((model) => model.close()));
      if (results.some((result) => result.status === 'rejected')) {
        evidence.status = 'INCOMPLETE';
        evidence.cleanupConfirmed = false;
      }
      evidence.hosts = hosts.map((facts) => ({
        pid: facts.pid,
        exitCode: facts.exitCode,
        signalCode: facts.signalCode,
        stdoutValid: facts.stdoutValid,
        frameCount: facts.frames.length,
      }));
      evidence.modelObservations = actors.map((actor) => scripts[actor].observations);
      evidence.modelFailures = Object.values(models).map((model) => model.failures);
      await writeFile(join(root, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n', {
        mode: 0o600,
      });
    }
  }
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.cleanupConfirmed, true);
}

/** Called only by a separate opt-in native test after the unchanged baseline proof passes. */
export async function runNativeAutonomousGoalProof(
  source: NativeGoalSource,
  diagnostic: (text: string) => void,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  assert.equal(process.env.LEGACY_NATIVE_MIXED_GOALS_GO, '1');
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  assert.equal(await realpath(process.execPath), source.node);
  const matrixRoot = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-goal-matrix-')));
  const receiptPath = join(matrixRoot, 'receipt.json');
  diagnostic('TEST native goal receipt: ' + receiptPath);
  const evidence: NativeGoalMatrixEvidence = {
    status: 'INCOMPLETE',
    platform: process.platform,
    arch: process.arch,
    scriptedInference: true,
    genuineModelInference: false,
    overnightQualification: false,
    scope:
      'Actual pinned native CLI goal wiring with finite local inference, useful file effects and original Stop receipts',
    excluded: [
      'Desktop controls',
      'vendor authentication',
      'genuine model competence',
      'overnight reliability',
    ],
    rows: [],
  };
  const repo = resolve(import.meta.dirname, '../../../../..');
  const pkg = join(repo, 'packages/legacy-agent-host');
  const assertPins = async () => {
    assert.equal(await fileHash(source.node), source.profile.owner.nodeSha256);
    assert.equal(await fileHash(source.entry), source.artifacts.entry);
    assert.equal(await fileHash(source.providerArchive), source.artifacts.providerSha256);
    assert.equal(await treeHash(join(pkg, 'src'), '.ts'), source.artifacts.source);
    assert.equal(await treeHash(join(pkg, 'dist'), '.js'), source.artifacts.dist);
    for (const executable of Object.values(source.artifacts.executables))
      assert.equal(await fileHash(executable.path), executable.sha256);
    assert.deepEqual(
      await captureCodexNativeInputs(source.artifacts.executables.codex.path),
      source.codexNativeInputs
    );
  };
  try {
    await assertPins();
    evidence.artifacts = source.artifacts;
    evidence.baselineReceipt = join(source.root, 'receipt.json');
    evidence.helpers = Object.fromEntries(
      await Promise.all(
        [
          import.meta.filename,
          join(import.meta.dirname, 'model.ts'),
          join(import.meta.dirname, '../native-claude-team/model.ts'),
          join(import.meta.dirname, '../native-codex-team/model.ts'),
          join(import.meta.dirname, '../native-opencode-team/model.ts'),
        ].map(async (path) => [path.slice(repo.length + 1), await fileHash(path)])
      )
    );
    for (const lead of actors)
      for (const actionMode of ['do', 'delegate'] as const) {
        signal.throwIfAborted();
        const root = join(matrixRoot, providers[lead] + '-' + actionMode);
        await mkdir(root, { mode: 0o700 });
        const row: GoalCaseEvidence = {
          status: 'INCOMPLETE',
          leadProvider: providers[lead],
          actionMode,
          root,
          cleanupConfirmed: false,
        };
        evidence.rows.push(row);
        await runCase(source, lead, actionMode, row, signal);
      }
    await assertPins();
    assert.equal(evidence.rows.length, 6);
    signal.throwIfAborted();
    evidence.status = 'PASS';
  } finally {
    await writeFile(receiptPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  }
  return evidence;
}
