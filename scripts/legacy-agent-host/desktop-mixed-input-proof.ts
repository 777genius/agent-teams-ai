import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import {
  mixedBinding,
  mixedNoticeRow as row,
  mixedNoticeRows as rows,
  readMixedTaskNotices,
} from '../../packages/legacy-agent-host/tests/fixtures/native-mixed-task-notifications.ts';
import type {
  MixedNoticeActor,
  MixedNoticeRow as Row,
} from '../../packages/legacy-agent-host/tests/fixtures/native-mixed-task-notifications.ts';
import type { DesktopMixedModels } from './desktop-mixed-native-fixture.ts';

export type MixedBusinessTurns = Record<MixedNoticeActor, readonly string[]>;
export const initialMixedBusinessTurns: MixedBusinessTurns = {
  'team-lead': ['NATIVE_TEAM_ONE'],
  bob: ['CODEX_TEAM_ONE'],
  carol: ['OPENCODE_TEAM_ONE'],
};
export const continuedMixedBusinessTurns: MixedBusinessTurns = {
  'team-lead': ['NATIVE_TEAM_ONE', 'NATIVE_TEAM_TWO'],
  bob: ['CODEX_TEAM_TWO'],
  carol: ['OPENCODE_TEAM_ONE', 'OPENCODE_TEAM_TWO'],
};
const read = (path: string) => row(JSON.parse(readFileSync(path, 'utf8')));
/** Exact business + original canonical Task/group inputs; no count inferred from raw model totals. */
export function mixedInputAccounting(
  root: string,
  sessions: Row[],
  models: DesktopMixedModels,
  turns: MixedBusinessTurns,
  currentBindings?: readonly Row[]
) {
  const directory = join(root, 'hoststore/teams/test-created-native-mixed/.host-owner');
  const state = read(join(directory, 'state.json'));
  const commands = readdirSync(join(directory, 'commands'))
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => read(join(directory, 'commands', name)));
  const outboxes = readdirSync(join(directory, 'outbox'))
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => read(join(directory, 'outbox', name)));
  assert.ok(commands.length <= 128 && outboxes.length <= 128);
  const proof: Row[] = [];
  let ready = sessions.length === 3;
  for (const [actor, provider] of [
    ['team-lead', 'claude'],
    ['bob', 'codex'],
    ['carol', 'opencode'],
  ] as const) {
    const members = rows(state.members).filter((member) => member.name === actor);
    assert.equal(members.length, 1);
    const original = mixedBinding(members[0]!.delivery);
    const qualified = currentBindings?.filter((value) => value.memberId === original.memberId);
    if (qualified) assert.equal(qualified.length, 1);
    const binding = qualified ? mixedBinding(qualified[0]) : original;
    for (const key of ['backendId', 'teamId', 'runId', 'memberId'])
      assert.equal(binding[key], original[key]);
    const selected = sessions.filter((session) => digest(session.binding) === digest(binding));
    if (selected.length !== 1) {
      ready = false;
      continue;
    }
    const session = selected[0]!,
      inputs = rows(session.inputs);
    const targetOutboxes = outboxes.filter(
      (outbox) => digest(mixedBinding(outbox.binding)) === digest(binding)
    );
    const expected = new Set<string>();
    const business: Row[] = [];
    for (const turn of turns[actor]) {
      const matching = inputs.filter((input) => {
        const content = row(input.intent).content;
        return content === turn || (typeof content === 'string' && content.endsWith('\n\n' + turn));
      });
      if (matching.length !== 1) {
        ready = false;
        continue;
      }
      business.push(matching[0]!);
      expected.add(String(row(matching[0]!.intent).inputId));
    }
    const notifications = readMixedTaskNotices(root, actor, binding);
    const noticeIds: string[] = [];
    for (const notice of notifications) {
      if (!notice.outbox) {
        ready = false;
        continue;
      }
      const id = String(notice.outbox.inputId);
      expected.add(id);
      noticeIds.push(id);
    }
    const groupInputs: Row[] = [];
    for (const source of commands.filter(
      (command) => command.family === 'group-chat' && row(command.request).operation === 'send'
    )) {
      if (source.phase !== 'completed') {
        ready = false;
        continue;
      }
      for (const delivery of rows(source.deliveries)) {
        const recipient = row(delivery.recipient);
        if (digest(mixedBinding(recipient.binding)) !== digest(binding)) continue;
        const matched = targetOutboxes.filter(
          (outbox) =>
            outbox.commandId === recipient.commandId &&
            outbox.messageId === recipient.physicalMessageId
        );
        if (matched.length !== 1) {
          ready = false;
          continue;
        }
        expected.add(String(matched[0]!.inputId));
        groupInputs.push(matched[0]!);
      }
    }
    const ids = inputs.map((input) => String(row(input.intent).inputId));
    const admittedIds = targetOutboxes.map((outbox) => String(outbox.inputId));
    if (
      new Set(ids).size !== ids.length ||
      expected.size !== ids.length ||
      ids.some((id) => !expected.has(id)) ||
      admittedIds.length !== expected.size ||
      admittedIds.some((id) => !expected.has(id))
    )
      ready = false;
    for (const input of inputs) {
      const intent = row(input.intent),
        matched = targetOutboxes.filter((outbox) => outbox.inputId === intent.inputId);
      if (matched.length !== 1) {
        ready = false;
        continue;
      }
      const outbox = matched[0]!;
      if (outbox.phase !== 'admitted' || outbox.runtimeReceipt === undefined) {
        ready = false;
        continue;
      }
      const receipt = row(outbox.runtimeReceipt);
      assert.equal(intent.content, outbox.content);
      assert.equal(intent.messageId, outbox.messageId);
      assert.equal(intent.deliveryId, outbox.deliveryId);
      assert.equal(intent.inputId, outbox.deliveryId);
      assert.deepEqual(intent.binding, binding);
      assert.deepEqual(receipt.binding, binding);
      assert.equal(receipt.fingerprint, input.fingerprint);
      assert.equal(receipt.operationRef, input.operationRef);
      if (
        outbox.phase !== 'admitted' ||
        input.phase !== 'terminal' ||
        input.terminal !== 'succeeded'
      )
        ready = false;
    }
    const notificationObservations = models[provider].notificationObservations;
    assert.ok(notificationObservations, 'explicit mixed notification oracle is configured');
    const observed = notificationObservations.filter(
      (observation) => digest(observation.notice.binding) === digest(binding)
    );
    if (
      observed.length !== noticeIds.length ||
      new Set(observed.map((value) => value.notice.inputId)).size !== observed.length ||
      observed.some((value) => !noticeIds.includes(value.notice.inputId))
    )
      ready = false;
    assert.ok(
      observed.every((value) => value.contextEffective),
      'notice retains captured native context'
    );
    proof.push({
      actor,
      binding,
      business,
      notifications,
      groupInputs,
      session,
      notificationObservations: observed,
    });
  }
  return { ready, proof };
}
export function assertMixedInputAccounting(
  root: string,
  sessions: Row[],
  models: DesktopMixedModels,
  turns: MixedBusinessTurns,
  currentBindings?: readonly Row[]
) {
  const result = mixedInputAccounting(root, sessions, models, turns, currentBindings);
  assert.equal(
    result.ready,
    true,
    'exact original business, canonical notification and group receipt/input census'
  );
  return result.proof;
}
