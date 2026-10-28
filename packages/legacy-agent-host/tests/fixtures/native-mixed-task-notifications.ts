import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../../dist/team/identity.js';

export type MixedNoticeRow = Record<string, unknown>;
export type MixedNoticeActor = 'team-lead' | 'bob' | 'carol';
export const mixedNoticeRow = (value: unknown): MixedNoticeRow => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as MixedNoticeRow;
};
export const mixedNoticeRows = (value: unknown): MixedNoticeRow[] => {
  assert.ok(Array.isArray(value));
  return value.map(mixedNoticeRow);
};
const read = (path: string) => mixedNoticeRow(JSON.parse(readFileSync(path, 'utf8')));
export const mixedBinding = (value: unknown) => {
  const row = mixedNoticeRow(value);
  return Object.fromEntries(
    ['backendId', 'teamId', 'runId', 'memberId', 'generation'].map((key) => {
      assert.equal(typeof row[key], 'string');
      return [key, row[key]];
    })
  );
};
export function mixedNativeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(mixedNoticeRow)
    .filter((row) => row.type === 'text' || row.type === 'input_text')
    .map((row) => {
      assert.equal(typeof row.text, 'string');
      return row.text;
    })
    .join('\n');
}
export function mixedSemanticText(content: unknown): boolean {
  // Tool-result-only user carriers and native reminder-only carriers are not new inputs.
  return (
    mixedNativeText(content)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim().length > 0
  );
}
export interface MixedTaskNotice {
  actor: MixedNoticeActor;
  commandId: string;
  messageId: string;
  content: string;
  binding: MixedNoticeRow;
  receipt: MixedNoticeRow;
  notification: MixedNoticeRow;
  outbox?: MixedNoticeRow;
}
/** Read only original immutable Task plans; no command, delivery or Runtime action is invoked. */
export function readMixedTaskNotices(
  root: string,
  actor: MixedNoticeActor,
  binding?: MixedNoticeRow
): MixedTaskNotice[] {
  const directory = join(root, 'hoststore/teams/test-created-native-mixed/.host-owner');
  const state = read(join(directory, 'state.json'));
  const members = mixedNoticeRows(state.members).filter((member) => member.name === actor);
  assert.equal(members.length, 1);
  const target = binding ?? mixedBinding(members[0]!.delivery);
  const commandNames = readdirSync(join(directory, 'commands')).filter((name) =>
    /^[a-f0-9]{64}\.json$/.test(name)
  );
  assert.ok(commandNames.length <= 128);
  const outboxNames = readdirSync(join(directory, 'outbox')).filter((name) =>
    /^[a-f0-9-]{36}\.json$/.test(name)
  );
  assert.ok(outboxNames.length <= 128);
  const outboxes = outboxNames.map((name) => read(join(directory, 'outbox', name)));
  const result: MixedTaskNotice[] = [];
  for (const name of commandNames) {
    const receipt = read(join(directory, 'commands', name));
    if (receipt.taskPlanVersion !== 1 || receipt.phase !== 'completed') continue;
    const plan = read(join(directory, 'task-plans', digest(receipt.commandId) + '.json'));
    assert.equal(plan.commandId, receipt.commandId);
    assert.equal(plan.fingerprint, receipt.fingerprint);
    for (const notification of mixedNoticeRows(plan.notifications)) {
      if (notification.member !== actor) continue;
      const recipients = mixedNoticeRows(receipt.taskRecipients).filter(
        (row) => row.name === actor
      );
      assert.equal(recipients.length, 1);
      const delivery = mixedBinding(recipients[0]!.delivery);
      if (digest(delivery) !== digest(target)) continue;
      assert.equal(receipt.phase, 'completed');
      assert.equal(digest(receipt.binding), digest(state.binding));
      const command = mixedNoticeRow(receipt.command);
      assert.ok(
        command.operation === 'task.assign' ||
          (command.operation === 'task.lifecycle' &&
            mixedNoticeRow(command.payload).action === 'complete')
      );
      assert.equal(typeof notification.messageId, 'string');
      assert.equal(typeof notification.content, 'string');
      const matched = outboxes.filter(
        (outbox) =>
          outbox.commandId === receipt.commandId &&
          outbox.messageId === notification.messageId &&
          digest(mixedBinding(outbox.binding)) === digest(target)
      );
      assert.ok(matched.length <= 1, 'one original notification outbox');
      if (matched[0]) assert.equal(matched[0].content, notification.content);
      result.push({
        actor,
        commandId: String(receipt.commandId),
        messageId: String(notification.messageId),
        content: String(notification.content),
        binding: delivery,
        receipt,
        notification,
        ...(matched[0] ? { outbox: matched[0] } : {}),
      });
    }
  }
  return result;
}
export function readMixedNoticeSessions(root: string): MixedNoticeRow[] {
  const directory = join(root, 'hoststore/runtime-sessions');
  const namespaces = readdirSync(directory).filter((name) => /^[a-f0-9]{64}$/.test(name));
  assert.ok(namespaces.length <= 16);
  return namespaces.flatMap((namespace) => {
    const files = readdirSync(join(directory, namespace)).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name)
    );
    assert.ok(files.length <= 256);
    return files.map((name) => read(join(directory, namespace, name)));
  });
}
export interface ObservedMixedTaskNotice extends MixedTaskNotice {
  inputId: string;
  input: MixedNoticeRow;
}
export type MixedTaskNoticeReader = (text: string) => ObservedMixedTaskNotice | undefined;
function currentNoticeTextMatches(text: string, expected: string): boolean {
  if (text === expected) return true;
  const start = text.indexOf(expected);
  if (start < 0 || text.indexOf(expected, start + 1) !== -1) return false;
  // SDK decoration may surround, but never replace or alter, the original input bytes.
  const reminders =
    /^(?:\s*<system-reminder>(?:(?!<\/?system-reminder>)[\s\S])*<\/system-reminder>\s*)+$/;
  return [text.slice(0, start), text.slice(start + expected.length)].every(
    (fragment) => fragment === '' || reminders.test(fragment)
  );
}
/** Only the CURRENT original input can qualify; old business/group history never supplies a notice. */
export function createMixedTaskNoticeReader(
  root: () => string,
  actor: MixedNoticeActor
): MixedTaskNoticeReader {
  const seen = new Set<string>();
  return (text) => {
    const notices = readMixedTaskNotices(root(), actor);
    const sessions = readMixedNoticeSessions(root());
    const matches: ObservedMixedTaskNotice[] = [];
    for (const notice of notices) {
      if (!notice.outbox) continue;
      const selected = sessions.filter(
        (session) => digest(mixedBinding(session.binding)) === digest(notice.binding)
      );
      assert.equal(selected.length, 1);
      for (const input of mixedNoticeRows(selected[0]!.inputs)) {
        const intent = mixedNoticeRow(input.intent);
        if (intent.inputId !== notice.outbox.inputId) continue;
        const preparation =
          input.preparation === undefined ? {} : mixedNoticeRow(input.preparation);
        const preparedContent = String(preparation.prefix ?? '') + String(intent.content);
        if (!currentNoticeTextMatches(text, preparedContent)) continue;
        assert.ok(['pending', 'admitted'].includes(String(notice.outbox.phase)));
        assert.ok(
          ['claimed', 'consumed'].includes(String(input.phase)),
          'one current dispatched notification input'
        );
        assert.equal(intent.content, notice.content);
        assert.equal(intent.deliveryId, notice.outbox.deliveryId);
        assert.equal(intent.inputId, notice.outbox.inputId);
        assert.equal(intent.messageId, notice.messageId);
        assert.deepEqual(intent.binding, notice.binding);
        if (notice.outbox.phase === 'admitted' || notice.outbox.runtimeReceipt !== undefined) {
          const receipt = mixedNoticeRow(notice.outbox.runtimeReceipt);
          assert.deepEqual(receipt.binding, notice.binding);
          assert.equal(receipt.fingerprint, input.fingerprint);
          assert.equal(receipt.operationRef, input.operationRef);
        }
        matches.push({ ...notice, inputId: String(intent.inputId), input });
      }
    }
    assert.ok(matches.length <= 1, 'one exact receipt-bound current notification');
    const selected = matches[0];
    if (!selected) return;
    assert.ok(!seen.has(selected.inputId), 'notification inference is not replayed');
    seen.add(selected.inputId);
    return selected;
  };
}
