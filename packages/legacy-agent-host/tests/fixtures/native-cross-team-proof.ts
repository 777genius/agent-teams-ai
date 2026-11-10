import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  CROSS_BEGIN,
  CROSS_REQUEST,
  CROSS_REPLY,
  CROSS_DONE,
  CROSS_FORWARD_ID,
  CROSS_REPLY_ID,
  CROSS_TARGET,
} from './native-cross-team-script.ts';
import { tick, type startHost } from './native-host.ts';
import { digest } from '../../dist/team/identity.js';
import type { TeamHostProfile } from '../../dist/composition/TeamHost.js';
import type { startNativeTeamModel } from './native-claude-team/model.ts';
type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const json = async (path: string): Promise<Row> => row(JSON.parse(await readFile(path, 'utf8')));
const sourceTeam = 'test-native-team',
  targetId = 'TEST-cross-target-team',
  targetMemberId = 'dana-id';
const crossSources = [
  'packages/legacy-agent-host/tests/native-mixed-host.native.ts',
  ...[
    'native-cross-team-proof.ts',
    'native-cross-team-script.ts',
    'native-host.ts',
    'native-peers.ts',
    'native-claude-team/model.ts',
    'native-codex-team/model.ts',
    'native-opencode-team/model.ts',
    'native-mixed-groups.ts',
  ].map((path) => 'packages/legacy-agent-host/tests/fixtures/' + path),
];
/** Capture finite actual TEST source bytes before any model/Host/native allocation. */
export async function captureNativeCrossTeamSources(snapshotRoot?: string) {
  const repo = resolve(import.meta.dirname, '../../../..');
  return Promise.all(
    crossSources.map(async (path) => {
      const bytes = await readFile(join(repo, path));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (snapshotRoot) {
        const target = join(snapshotRoot, 'cross-source-before', path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
      }
      return { path, sha256 };
    })
  );
}
/** Trusted TEST profile delta only. Existing Host composition still owns all state/runtime dispatch. */
export async function addNativeCrossTeamTarget(
  profile: TeamHostProfile,
  root: string,
  modelUrl: string
) {
  assert.equal(profile.teams.length, 1);
  assert.equal(profile.teams[0]!.members.length, 3);
  const source = profile.teams[0]!,
    alice = source.members.find((member) => member.memberId === 'alice-id');
  assert.ok(alice);
  alice.role = 'lead'; // A real authoritative reply recipient; no synthetic name fallback.
  const recipe = profile.runtime?.members.find((member) => member.memberId === 'alice-id');
  assert.ok(recipe && recipe.provider === 'claude');
  for (const directory of ['home', 'tmp', 'config', 'data', 'cache', 'workspace'])
    await mkdir(join(root, 'dana', directory), { recursive: true, mode: 0o700 });
  const scope = { ...source.scope, teamId: targetId, runId: 'TEST-cross-target-run' };
  const binding = { ...source.binding, teamId: targetId, teamName: CROSS_TARGET };
  profile.teams.push({
    scope,
    binding,
    members: [
      {
        memberId: targetMemberId,
        name: 'dana',
        role: 'lead',
        delivery: { ...binding, runId: scope.runId, memberId: targetMemberId, generation: '1' },
      },
    ],
    grants: [
      {
        principalId: profile.principalId,
        memberName: 'user',
        permissions: ['read', 'message.write', 'task.write', 'admin'],
      },
      {
        principalId: 'dana-session',
        memberName: 'dana',
        permissions: ['read', 'message.write', 'task.write'],
      },
    ],
  });
  profile.runtime!.members.push({
    ...recipe,
    teamId: targetId,
    memberId: targetMemberId,
    principalId: 'dana-session',
    sessionId: 'TEST-cross-target-session',
    accountBinding: 'TEST-LOCALHOST-DANA-ONLY',
    generation: 1,
    configRevision: 'TEST-cross-target-config',
    cwd: join(root, 'dana/workspace'),
    environment: {
      ...recipe.environment,
      HOME: join(root, 'dana/home'),
      TMPDIR: join(root, 'dana/tmp'),
      CLAUDE_CONFIG_DIR: join(root, 'dana/config'),
      XDG_CONFIG_HOME: join(root, 'dana/config'),
      XDG_DATA_HOME: join(root, 'dana/data'),
      XDG_CACHE_HOME: join(root, 'dana/cache'),
      ANTHROPIC_BASE_URL: modelUrl,
    },
    nativeOptions: {
      ...recipe.nativeOptions,
      projectInstructions: {
        append: 'TEST_NATIVE_CROSS_TARGET_CONTEXT. You are dana in an isolated TEST workspace.',
      },
    },
  });
}
/** Runs after the existing three-provider baseline; this adds one native cross-Team roundtrip only. */
export async function runNativeCrossTeamProof(options: {
  host: ReturnType<typeof startHost>;
  profile: TeamHostProfile;
  root: string;
  sourcePinsBefore: Awaited<ReturnType<typeof captureNativeCrossTeamSources>>;
  sourceModel: Awaited<ReturnType<typeof startNativeTeamModel>>;
  targetModel: Awaited<ReturnType<typeof startNativeTeamModel>>;
}) {
  assert.deepEqual(
    await captureNativeCrossTeamSources(),
    options.sourcePinsBefore,
    'original preboot TEST source freeze before cross-Team effects'
  );
  const { host, profile, root } = options,
    source = profile.teams.find((team) => team.binding.teamName === sourceTeam)!,
    target = profile.teams.find((team) => team.binding.teamId === targetId)!;
  const envelope = (team: typeof source, commandId: string, payload: unknown) => ({
    commandId,
    binding: {
      schemaVersion: 1,
      handleId: 'TEST-headless-' + team.binding.teamId,
      owner: profile.owner,
      scope: team.scope,
    },
    payload,
  });
  const rpc = async (team: typeof source, method: string, commandId: string, payload: unknown) => {
    const result = await host.rpc(method, envelope(team, commandId, payload));
    assert.equal(result.ok, true, JSON.stringify(result));
    return row(result.value);
  };
  const readRuntime = (team: typeof source, memberId: string) =>
    rpc(team, 'runtime.read', 'TEST-cross-read-' + memberId, { memberId });
  const inputs = (value: Row) => {
    assert.ok(Array.isArray(value.inputs));
    return value.inputs.map(row);
  };
  const before = await readRuntime(source, 'alice-id'),
    initial = await rpc(target, 'team.launch.read', 'TEST-cross-target-read', {});
  await rpc(target, 'team.launch.start', 'TEST-cross-target-launch', {
    launchId: initial.launchId,
    rosterRevision: initial.rosterRevision,
    configuration: {
      members: [
        {
          memberId: targetMemberId,
          model: 'claude-opus-4-6',
          effort: 'medium',
          fastMode: false,
          permissions: 'bypass',
          context: 'model-default',
        },
      ],
    },
  });
  const deadline = Date.now() + 75_000;
  let targetReady: Row = {};
  do {
    targetReady = await rpc(target, 'team.launch.read', 'TEST-cross-target-ready', {});
    if (targetReady.status === 'ready') break;
    assert.ok(!['failed', 'unknown'].includes(String(targetReady.status)));
    await tick();
  } while (Date.now() < deadline);
  assert.equal(targetReady.status, 'ready');
  assert.equal(targetReady.ready, 1);
  const targetBefore = await readRuntime(target, targetMemberId);
  assert.deepEqual(inputs(targetBefore), []);
  const submit = envelope(source, 'TEST-cross-human-start', {
    operation: 'message.send',
    payload: { to: 'alice', text: CROSS_BEGIN },
  });
  const submitted = await host.rpc('team.execute', submit);
  assert.equal(submitted.ok, true);
  const human = row(submitted.value);
  assert.equal(human.phase, 'completed');
  const startInputId = row(human.effects).deliveryId;
  const rows = async (team: string, file: string): Promise<Row[]> => {
    const value: unknown = JSON.parse(
      await readFile(join(root, 'store/teams', team, file), 'utf8')
    );
    assert.ok(Array.isArray(value));
    return value.map(row);
  };
  let sourceRuntime: Row = {},
    targetRuntime: Row = {},
    humanReplies: Row[] = [];
  do {
    for (const model of [options.sourceModel, options.targetModel])
      assert.deepEqual(model.failures, []);
    sourceRuntime = await readRuntime(source, 'alice-id');
    targetRuntime = await readRuntime(target, targetMemberId);
    humanReplies = await rows(sourceTeam, 'inboxes/user.json');
    if (
      humanReplies.some((message) => message.text === CROSS_DONE) &&
      inputs(sourceRuntime).length === inputs(before).length + 2 &&
      inputs(targetRuntime).length === 1 &&
      [...inputs(sourceRuntime), ...inputs(targetRuntime)].every(
        (input) => input.phase === 'terminal' && input.terminal === 'succeeded'
      )
    )
      break;
    await tick();
  } while (Date.now() < deadline);
  assert.equal(inputs(sourceRuntime).length, inputs(before).length + 2);
  assert.equal(inputs(targetRuntime).length, 1);
  assert.ok(
    [...inputs(sourceRuntime), ...inputs(targetRuntime)].every(
      (input) => input.phase === 'terminal' && input.terminal === 'succeeded'
    )
  );
  assert.equal(
    humanReplies.filter((message) => message.text === CROSS_DONE && message.from === 'alice')
      .length,
    1
  );
  const command = (team: string, id: string) =>
    json(join(root, 'store/teams', team, '.host-owner/commands', digest(id) + '.json'));
  const forward = await command(sourceTeam, CROSS_FORWARD_ID),
    reply = await command(CROSS_TARGET, CROSS_REPLY_ID);
  const selectedFiles: string[] = [];
  for (const [receipt, from, to, actor, recipient, text] of [
    [forward, source, target, 'alice', 'dana', CROSS_REQUEST],
    [reply, target, source, 'dana', 'alice', CROSS_REPLY],
  ] as const) {
    assert.equal(receipt.family, 'cross-team');
    assert.equal(receipt.phase, 'completed');
    const intent = row(receipt.intent),
      pair = row(intent.pair),
      request = row(intent.request),
      result = row(receipt.result);
    assert.equal(pair.ownerId, profile.owner.ownerId);
    assert.equal(row(pair.source).teamId, from.binding.teamId);
    assert.equal(row(pair.target).teamId, to.binding.teamId);
    assert.equal(row(pair.source).actor, actor);
    assert.equal(row(row(pair.target).recipient).name, recipient);
    const sender = from.members.find((member) => member.name === actor)!.delivery!,
      receiver = to.members.find((member) => member.name === recipient)!.delivery!;
    assert.deepEqual(row(pair.source).sender, {
      memberId: sender.memberId,
      runId: sender.runId,
      generation: sender.generation,
    });
    assert.deepEqual(row(pair.target).recipient, {
      memberId: receiver.memberId,
      name: recipient,
      runId: receiver.runId,
      generation: receiver.generation,
    });
    assert.equal(request.text, text);
    assert.equal(result.phase, 'completed');
    assert.equal(result.messageId, receipt.commandId);
    assert.equal(row(pair.source).handleId, undefined);
    assert.equal(row(pair.target).handleId, undefined, 'native port never adopts Desktop handles');
    const inbound = await command(to.binding.teamName, String(intent.targetCommandId));
    assert.equal(inbound.phase, 'completed');
    assert.equal(row(inbound.effects).messageId, receipt.commandId);
    const deliveryId = String(row(inbound.effects).deliveryId),
      admitted = await json(
        join(root, 'store/teams', to.binding.teamName, '.host-owner/outbox', deliveryId + '.json')
      );
    assert.equal(admitted.phase, 'admitted');
    assert.equal(row(admitted.binding).memberId, row(row(pair.target).recipient).memberId);
    const selectedRuntime = to === source ? sourceRuntime : targetRuntime;
    assert.equal(inputs(selectedRuntime).filter((input) => input.inputId === deliveryId).length, 1);
    const sent = await rows(from.binding.teamName, 'sent-cross-team.json');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.messageId, receipt.commandId);
    assert.equal(sent[0]!.fromMember, actor);
    assert.equal(sent[0]!.toMember, recipient);
    const copies = await rows(from.binding.teamName, 'sentMessages.json');
    assert.equal(
      copies.filter(
        (message) => message.messageId === receipt.commandId && message.source === 'cross_team_sent'
      ).length,
      1
    );
    selectedFiles.push(
      join(root, 'store/teams', from.binding.teamName, 'sent-cross-team.json'),
      join(root, 'store/teams', from.binding.teamName, 'sentMessages.json')
    );
    const inbox = await rows(to.binding.teamName, 'inboxes/' + recipient + '.json');
    assert.equal(
      inbox.filter(
        (message) => message.messageId === receipt.commandId && message.source === 'cross_team'
      ).length,
      1
    );
    for (const [team, id] of [
      [from.binding.teamName, receipt.commandId],
      [to.binding.teamName, intent.targetCommandId],
    ])
      selectedFiles.push(
        join(
          root,
          'store/teams',
          String(team),
          '.host-owner/commands',
          digest(String(id)) + '.json'
        )
      );
    selectedFiles.push(
      join(root, 'store/teams', to.binding.teamName, '.host-owner/outbox', deliveryId + '.json')
    );
    const census = (
      await readdir(join(root, 'store/teams', from.binding.teamName, '.host-owner/commands'))
    ).filter((name) => name.endsWith('.json'));
    const cross = (
      await Promise.all(
        census.map((name) =>
          json(join(root, 'store/teams', from.binding.teamName, '.host-owner/commands', name))
        )
      )
    ).filter((value) => value.family === 'cross-team');
    assert.equal(cross.length, 1, 'exact original native cross-Team command per side');
  }
  assert.equal(
    row(row(forward.intent).request).conversationId,
    row(row(reply.intent).request).conversationId
  );
  assert.equal(
    row(row(reply.intent).request).replyToConversationId,
    row(row(forward.intent).request).conversationId,
    'active native delivery inferred original conversation'
  );
  assert.ok(inputs(sourceRuntime).some((input) => input.inputId === startInputId));
  const sourceRequests = options.sourceModel.crossTeamRequests,
    targetRequests = options.targetModel.crossTeamRequests;
  assert.equal(sourceRequests.length, 5);
  assert.equal(targetRequests.length, 3);
  const stoppedTarget = await rpc(target, 'runtime.stop', 'TEST-cross-stop-target', {
    memberId: targetMemberId,
    expectedGeneration: targetRuntime.generation,
  });
  assert.equal(stoppedTarget.custody, 'released');
  const frozen = await Promise.all(
    selectedFiles.map(async (path) => ({ path, bytes: await readFile(path, 'utf8') }))
  );
  const sourcePins = options.sourcePinsBefore;
  const evidence = {
    status: 'PASS',
    sourcePins,
    scope:
      'Existing mixed3 + second host-owned Team1; one Claude-to-Claude native cross-Team roundtrip, same inferred conversation, exact admission/recipients; no UI/auth/full F06 claim',
    human,
    sourceRuntime,
    targetRuntime,
    targetReady,
    forward,
    reply,
    stoppedTarget,
    sourceRequests,
    targetRequests,
    noNativeReplay: true,
  };
  return {
    evidence,
    sourceRuntime,
    async verifyAfterRestart(recovered: ReturnType<typeof startHost>) {
      assert.deepEqual(
        await captureNativeCrossTeamSources(),
        sourcePins,
        'original source remains frozen through cold verification'
      );
      for (const [team, id, expected] of [
        [source, 'alice-id', sourceRuntime],
        [target, targetMemberId, targetRuntime],
      ] as const) {
        const value = await recovered.rpc(
          'runtime.read',
          envelope(team, 'TEST-cross-cold-' + id, { memberId: id })
        );
        assert.equal(value.ok, true);
        assert.equal(row(value.value).attached, false);
        assert.deepEqual(row(value.value).inputs, expected.inputs);
      }
      for (const file of frozen) assert.equal(await readFile(file.path, 'utf8'), file.bytes);
      assert.equal(sourceRequests.length, 5);
      assert.equal(targetRequests.length, 3);
    },
  };
}
