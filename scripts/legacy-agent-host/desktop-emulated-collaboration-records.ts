import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeDigest, normalizeBinding } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { launchReadinessSchema } from '../../packages/legacy-agent-host/dist/team-launch/launchReadiness.js';
import { storedModelProbeSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { liveRuntimeCaptureSchema } from '../../packages/legacy-agent-host/dist/composition/liveRuntimeCaptureSchema.js';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { command } from './desktop-backend-observations.ts';
import { json, record, rows } from './desktop-resume-records.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { readDesktopEmulatedCollaborationEffects, verifyDesktopEmulatedCollaborationFixture } from './desktop-emulated-collaboration-fixture.ts';
import type { DesktopEmulatedCollaborationFixture } from './desktop-emulated-collaboration-fixture.ts';

export type Row = Record<string, unknown>;
export const array = (value: unknown): Row[] => { assert.ok(Array.isArray(value) && value.length <= 1024); return value.map(record); };
export const one = (values: Row[], accepts: (value: Row) => boolean): Row => {
  const selected = values.filter(accepts); assert.equal(selected.length, 1); return selected[0]!;
};
const bindingOf = (value: unknown) => {
  const row = record(value), text = (key: string) => { const value = row[key]; assert.equal(typeof value, 'string'); return value as string; };
  return normalizeBinding({ backendId: text('backendId'), teamId: text('teamId'), runId: text('runId'),
    memberId: text('memberId'), generation: text('generation') });
};
export function runtimeOrigin(session: Row) {
  return { binding: session.binding, config: session.config, sessionRef: session.sessionRef, openFingerprint: session.openFingerprint };
}
export function createCollaborationRecords(fixture: DesktopEmulatedCollaborationFixture) {
  const team = join(fixture.root, 'hoststore/teams/test-desktop-backend'), directory = join(team, '.host-owner');
  const list = async (path: string) => {
    const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024);
    return array(JSON.parse(await readFile(path, 'utf8')));
  };
  const owner = () => json(join(directory, 'state.json'));
  const commands = () => rows(join(directory, 'commands'));
  const sessions = async (launchId: unknown) => (await readDesktopNativeStopSessions(fixture.root)).filter(row => record(row.binding).runId === launchId);
  const launch = (launchId: unknown) => json(join(directory, 'launches', runtimeDigest(launchId) + '.json'));
  const inbox = (member: string) => { assert.ok(['alice', 'bob', 'carol', 'user'].includes(member)); return list(join(team, 'inboxes', member + '.json')); };
  return { owner, commands, sessions, launch, inbox,
    groups: async () => array((await json(join(team, 'group-chats.json'))).groups),
    reactions: async () => array((await json(join(team, 'group-chat-reactions.json'))).entries),
    async delivery(receipt: Row, selected: Row[]) {
      assert.equal(receipt.phase, 'completed'); const inputId = record(receipt.effects).deliveryId;
      assert.equal(typeof inputId, 'string'); const outbox = await json(join(directory, 'outbox', inputId + '.json'));
      assert.equal(outbox.phase, 'admitted'); assert.equal(outbox.commandId, receipt.commandId);
      const binding = record(outbox.binding), session = one(selected, row => runtimeDigest(row.binding) === runtimeDigest(bindingOf(binding)));
      const input = one(array(session.inputs), row => record(row.intent).inputId === inputId);
      assert.equal(input.phase, 'terminal'); assert.equal(input.terminal, 'succeeded');
      assert.equal(record(input.intent).messageId, outbox.messageId);
      assert.deepEqual(record(input.intent).binding, bindingOf(binding));
      const member = one(array((await owner()).members), row => row.memberId === binding.memberId);
      const physical = one(await inbox(String(member.name)), row => row.messageId === outbox.messageId);
      assert.equal(physical.to, member.name); return { receipt, outbox, session: runtimeOrigin(session), input, physical };
    },
    async membership(commandId: unknown, kind: 'add' | 'restore', launchId: unknown) {
      const state = await owner(), receipt = one(array(state.rosterCommands), row => row.commandId === commandId);
      const decision = record(receipt.liveMembership), memberId = record(decision.delta).targetId;
      assert.equal(decision.phase, 'completed'); assert.equal(record(decision.delta).kind, kind); assert.equal(decision.launchId, launchId);
      const original = await launch(launchId), retained = one(array(original.liveMembership), row => record(row.intent).commandId === commandId);
      assert.equal(retained.phase, 'selected'); assert.equal(record(retained.intent).originalFingerprint, receipt.fingerprint);
      assert.equal(record(retained.intent).requestDigest, decision.requestDigest);
      assert.equal(decision.sourceCaptureDigest, runtimeDigest(record(original.definition).capture));
      const captured = liveRuntimeCaptureSchema.parse(retained.capture), view = record(decision.capture), selection = record(decision.selection);
      assert.equal(view.captureDigest, runtimeDigest(retained.capture)); assert.equal(retained.captureDigest, view.captureDigest);
      assert.equal(captured.member.memberId, memberId); assert.equal(captured.member.name, 'carol');
      assert.equal(selection.configurationDigest, captured.configurationDigest);
      const binding = bindingOf(selection.delivery), selected = record(retained.selected);
      assert.deepEqual(selected.binding, binding); assert.equal(selected.configurationDigest, captured.configurationDigest);
      const member = one(array(state.members), row => row.memberId === memberId); assert.deepEqual(member.delivery, selection.delivery);
      const grant = one(array(state.grants), row => row.principalId === selection.principalId && row.revoked !== true);
      assert.equal(grant.memberName, 'carol');
      const session = one(await sessions(launchId), row => runtimeDigest(row.binding) === runtimeDigest(binding));
      assert.equal(session.phase, 'allocated'); assert.equal(session.custody, 'owned'); assert.equal(session.nativeReady, true);
      assert.equal(record(session.config).configRevision, selected.configRevision);
      assert.equal(record(session.config).generation, captured.runtimeGeneration); assert.deepEqual(session.inputs, []);
      const preparationId = 'live-model-' + runtimeDigest({ commandId, capture: view.captureDigest });
      const readiness = launchReadinessSchema.parse(original.readiness), references = readiness.groups.filter(row => row.commandId === preparationId);
      assert.equal(references.length, 1); const reference = references[0]!;
      const consumers = readiness.consumers.filter(row => row.groupCommandId === preparationId); assert.equal(consumers.length, 1);
      assert.equal(consumers[0]!.disposition, 'consumed'); assert.deepEqual(consumers[0]!.binding, binding);
      assert.equal(consumers[0]!.configurationDigest, captured.configurationDigest);
      const { digest, ...body } = await json(join(fixture.root, 'hoststore/management-commands', managementDigest(preparationId) + '.json'));
      assert.equal(digest, managementDigest(body)); const probe = storedModelProbeSchema.parse(body);
      assert.equal(probe.phase, 'completed'); assert.equal(probe.ok, true); assert.equal(probe.resourceHeld, false);
      const provider = probe.localModelReadinessOrigin?.workspaces.find(row => row.path === captured.sourceCwd)
        ?.project.providers.find(row => row.providerId === 'test-provider');
      assert.equal(provider?.hasConfiguredApiKey, true, 'Main captured the original TEST credential-backed route');
      assert.equal(probe.readiness?.evidence.ordinary, 'confirmed'); assert.equal(probe.readiness?.evidence.decision, 'allow');
      for (const key of ['profileId', 'configRevision', 'fingerprint', 'selectionDigest', 'resourceId', 'expiresAt'] as const)
        assert.equal(reference[key], probe[key]);
      assert.equal(reference.purpose, probe.purpose); assert.equal(consumers[0]!.cutoff, reference.expiresAt);
      return { receipt, member, selection, binding, session, captured, readiness: { reference, consumer: consumers[0], probe } };
    },
    async group(groupId: unknown, launchId: unknown) {
      const selected = await sessions(launchId), all = await commands(), reactions = array((await json(join(team, 'group-chat-reactions.json'))).entries);
      const group = one(array((await json(join(team, 'group-chats.json'))).groups), row => row.id === groupId);
      const logical = (await inbox('user')).filter(row => row.groupChatId === groupId && row.messageId === row.groupMessageId);
      assert.equal(logical.length, 2);
      const human = one(logical, row => row.text === 'TEST_UI_COLLAB_GROUP'), reply = one(logical, row => row.text === 'TEST_UI_COLLAB_GROUP_REPLY');
      assert.equal(human.from, 'user'); assert.deepEqual(human.groupRecipientNames, ['bob']); assert.equal(reply.from, 'bob');
      assert.deepEqual([...(reply.groupRecipientNames as string[])].sort(), ['alice', 'carol']);
      const sends = all.filter(row => row.family === 'group-chat' && record(row.request).operation === 'send' && record(row.request).groupChatId === groupId);
      assert.equal(sends.length, 2); const deliveries = [];
      for (const send of sends) {
        assert.equal(send.phase, 'completed'); const canonical = one(logical, row => row.messageId === record(send.request).messageId);
        for (const delivered of array(send.deliveries)) {
          const recipient = record(delivered.recipient), binding = record(recipient.binding);
          const physical = one(await inbox(String(recipient.name)), row => row.messageId === recipient.physicalMessageId);
          assert.equal(physical.groupMessageId, canonical.messageId);
          const direct = one(all, row => row.commandId === recipient.commandId), proof = await this.delivery(direct, selected);
          assert.deepEqual(proof.physical, physical); assert.deepEqual(proof.outbox.binding, binding);
          const session = one(selected, row => record(row.binding).memberId === binding.memberId && record(row.binding).generation === binding.generation);
          const key = 'host-group-v1:' + runtimeDigest({ binding, config: session.config, sessionRef: session.sessionRef });
          assert.equal(physical.groupRunKey, key); assert.equal(record(canonical.groupRecipientRunKeys)[String(recipient.name)], key);
          const reaction = one(reactions, row => row.messageId === canonical.messageId), ack = one(array(reaction.actors), row => row.name === recipient.name);
          assert.equal(ack.inboxMessageId, physical.messageId); assert.equal(ack.groupRunKey, key);
          deliveries.push({ ...proof, ack });
        }
      }
      assert.equal(deliveries.length, 3); return { group, logical, reactions, sends, deliveries };
    },
  };
}

/** Original births only. Metadata children remain separately identified by their journal role. */
export async function observeCollaborationPeers(fixture: DesktopEmulatedCollaborationFixture, expected: readonly string[]) {
  await verifyDesktopEmulatedCollaborationFixture(fixture);
  const effects = await readDesktopEmulatedCollaborationEffects(fixture), table = processFacts();
  const result = new Map<string, ReturnType<typeof processFacts>[number]>();
  for (const provider of expected) {
    const selection = fixture.emulatedRuntime.collaboration.selections.find(row => row.provider === provider); assert.ok(selection);
    const connected = effects.filter(row => row.provider === provider && row.role === 'runtime' && ['connected', 'mcp-connected'].includes(String(row.event)));
    const live = table.filter(row => connected.some(event => event.pid === row.pid)); assert.equal(live.length, 1);
    const birth = live[0]!; assert.equal(birth.groupId, birth.pid);
    assert.ok(command(birth.pid).startsWith(`${fixture.node} ${selection.executable.path} `));
    assert.equal(command(birth.parentPid), `${fixture.node} ${fixture.hostEntry}`);
    assert.ok(effects.some(row => row.event === 'launch' && row.pid === birth.pid && row.parentPid === birth.parentPid));
    result.set(provider, { ...birth });
  }
  assert.equal(new Set([...result.values()].map(row => row.parentPid)).size, expected.length ? 1 : 0);
  for (const selection of fixture.emulatedRuntime.collaboration.selections) if (!expected.includes(selection.provider)) {
    const pids = effects.filter(row => row.provider === selection.provider && row.role === 'runtime' && ['connected', 'mcp-connected'].includes(String(row.event))).map(row => Number(row.pid));
    assert.ok(table.every(row => !pids.includes(row.pid)), 'unselected Runtime has no live peer');
  }
  return result;
}
