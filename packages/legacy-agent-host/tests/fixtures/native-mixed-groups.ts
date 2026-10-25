import assert from 'node:assert/strict';

export const MIXED_GROUP_INPUT = 'TEST_MIXED_GROUP_UI_REQUEST_V1';
export const MIXED_GROUP_REPLY = 'TEST_MIXED_GROUP_NATIVE_REPLY_V1';
export const MIXED_GROUP_REPLY_ID = '20000000-0000-4000-8000-000000000002';
export type MixedGroupActor = 'team-lead' | 'bob' | 'carol';
type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const text = (value: unknown): string => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(row).filter(item => ['text', 'input_text'].includes(String(item.type)))
      .map(item => String(item.text)).join('\n') : '';
export interface MixedGroupTurn {
  turn: string;
  actor: MixedGroupActor;
  context: Row;
}
/** One finite group turn per provider; transport adapters still execute every real MCP call. */
export function readMixedGroupTurn(content: unknown, actor: MixedGroupActor): MixedGroupTurn | undefined {
  const input = text(content), expected = actor === 'bob' ? MIXED_GROUP_INPUT : MIXED_GROUP_REPLY;
  if (!input.includes('Group context: ') || !input.includes(expected)) return;
  const matches = [...input.matchAll(/Group context: (\{[^\n]+\})/g)];
  assert.equal(matches.length, 1);
  const context = row(JSON.parse(matches[0]![1]!));
  assert.equal(context.to, actor);
  assert.equal(context.from, actor === 'bob' ? 'user' : 'bob');
  assert.equal(context.source, actor === 'bob' ? 'user_sent' : 'runtime_delivery');
  assert.equal(context.text, expected);
  assert.equal(context.groupChatProtocolVersion, 1);
  assert.match(String(context.messageId), /^[a-f0-9-]{36}:g:[a-f0-9]{24}$/);
  assert.notEqual(context.messageId, context.groupMessageId);
  assert.match(String(context.groupRunKey), /^host-group-v1:[a-f0-9]{64}$/);
  assert.equal(row(context.groupRecipientRunKeys)[actor], context.groupRunKey);
  return { turn: 'TEST_MIXED_GROUP_' + actor + '_' + String(context.messageId).replaceAll(':', '_'), actor, context };
}
export function mixedGroupActions(group: MixedGroupTurn) {
  const { actor, context } = group;
  const ack = { name: 'group_chat_react', input: {
    commandId: 'TEST-mixed-group-ack-' + actor,
    groupChatId: context.groupChatId,
    relayOfMessageId: context.messageId,
  } };
  return actor === 'bob' ? [
    { name: 'group_chat_list', input: {} }, ack,
    { name: 'group_chat_send', input: {
      commandId: 'TEST-mixed-group-reply', messageId: MIXED_GROUP_REPLY_ID,
      groupChatId: context.groupChatId, text: MIXED_GROUP_REPLY,
      relayOfMessageId: context.messageId,
    } },
  ] : [ack];
}
/** Read native tool output via its existing provider-specific decoder, never manufacture an ACK. */
export function assertMixedGroupReceipt(group: MixedGroupTurn, step: number, receipt: Row) {
  if (group.actor === 'bob' && step === 1) {
    assert.ok(JSON.stringify(receipt).includes(String(group.context.groupChatId)));
    return;
  }
  assert.equal(receipt.kind, 'group-chat-command');
  assert.equal(receipt.phase, 'completed');
  assert.equal(receipt.operation, group.actor === 'bob' && step === 3 ? 'send' : 'reaction.ack');
}
