import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
export const GROUP_INPUT =
  'TEST_GROUP_UI_REQUEST: Create TEST-native-created-group with alice and bob, acknowledge this exact input and reply TEST_GROUP_NATIVE_REPLY to this group.';
export const GROUP_REPLY = 'TEST_GROUP_NATIVE_REPLY';
export const GROUP_REPLY_ID = '10000000-0000-4000-8000-000000000002';
export const GROUP_ALICE_CONTEXT = 'TEST_NATIVE_GROUP_ALICE_V1';
export const GROUP_BOB_CONTEXT = 'TEST_NATIVE_GROUP_BOB_V1';

/** Finite responses only. Actual SDK actors execute every authenticated MCP operation. */
export function nativeGroupChatScript(readReceipt: (content: unknown) => Row) {
  const requests: {
    memberName: string;
    step: number;
    groupChatId: string;
    physicalMessageId: string;
    logicalMessageId: string;
    groupRunKey: string;
    requestedModel: string;
    requestedEffort: string;
    toolNames: string[];
  }[] = [];
  const counters = new Map<string, number>();
  return {
    requests,
    respond(body: Row, tools: string[]): Row {
      assert.ok(requests.length < 7, 'two actors, exactly five Alice and two Bob requests maximum');
      const system = JSON.stringify(body.system);
      const memberName = system.includes(GROUP_ALICE_CONTEXT)
        ? 'alice'
        : system.includes(GROUP_BOB_CONTEXT)
          ? 'bob'
          : '';
      assert.ok(memberName, 'actual model request retains the captured actor context');
      assert.equal(body.model, 'claude-opus-4-6');
      assert.equal(row(body.output_config).effort, 'medium');
      const messages = Array.isArray(body.messages) ? body.messages.map(row) : [];
      const texts = messages
        .toReversed()
        .filter((message) => message.role === 'user')
        .flatMap((message) =>
          typeof message.content === 'string'
            ? [message.content]
            : Array.isArray(message.content)
              ? message.content
                  .map(row)
                  .filter((block) => block.type === 'text')
                  .map((block) => String(block.text))
              : []
        );
      const incoming = texts.find(
        (text) =>
          text.includes('Group context: ') &&
          text.includes(memberName === 'alice' ? 'TEST_GROUP_UI_REQUEST:' : GROUP_REPLY)
      );
      assert.ok(incoming, 'each native turn has one actual group physical inbound');
      const contexts = [...incoming.matchAll(/Group context: (\{[^\n]+\})/g)];
      assert.equal(contexts.length, 1);
      const context = row(JSON.parse(contexts[0]![1]!));
      assert.equal(context.to, memberName);
      assert.equal(context.from, memberName === 'alice' ? 'user' : 'alice');
      assert.equal(context.source, memberName === 'alice' ? 'user_sent' : 'runtime_delivery');
      assert.equal(context.groupChatProtocolVersion, 1);
      assert.equal(context.text, memberName === 'alice' ? GROUP_INPUT : GROUP_REPLY);
      const physicalMessageId = String(context.messageId),
        logicalMessageId = String(context.groupMessageId);
      assert.notEqual(physicalMessageId, logicalMessageId);
      assert.match(physicalMessageId, /^[a-f0-9-]{36}:g:[a-f0-9]{24}$/);
      assert.match(String(context.groupRunKey), /^host-group-v1:[a-f0-9]{64}$/);
      assert.equal(row(context.groupRecipientRunKeys)[memberName], context.groupRunKey);
      assert.ok(incoming.includes('Reply using group_chat_send'));
      const key = memberName + ':' + physicalMessageId;
      const step = counters.get(key) ?? 0;
      const blocks = messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content.map(row) : []
      );
      const results = blocks.filter((block) => block.type === 'tool_result');
      if (step > 0) {
        const last = results.at(-1);
        assert.ok(last);
        assert.notEqual(last.is_error, true, 'native MCP result must succeed before continuation');
        if (memberName === 'bob' || step >= 2) {
          const receipt = readReceipt(last.content);
          assert.equal(receipt.kind, 'group-chat-command');
          assert.equal(receipt.phase, 'completed');
          assert.equal(
            receipt.operation,
            memberName === 'bob' || step === 3
              ? 'reaction.ack'
              : step === 2
                ? 'create.agent'
                : 'send'
          );
        } else
          assert.ok(
            JSON.stringify(last.content).includes(String(context.groupChatId)),
            'actual native group list contains the UI-created group'
          );
      }
      requests.push({
        memberName,
        step,
        groupChatId: String(context.groupChatId),
        physicalMessageId,
        logicalMessageId,
        groupRunKey: String(context.groupRunKey),
        requestedModel: String(body.model),
        requestedEffort: String(row(body.output_config).effort),
        toolNames: tools,
      });
      const actions =
        memberName === 'alice'
          ? [
              { name: 'group_chat_list', input: {} },
              {
                name: 'group_chat_create',
                input: {
                  commandId: 'TEST-native-group-create',
                  sourceMessageId: logicalMessageId,
                  name: 'TEST-native-created-group',
                  selectedMemberNames: ['alice', 'bob'],
                  autoIncludeNewMembers: false,
                },
              },
              {
                name: 'group_chat_react',
                input: {
                  commandId: 'TEST-native-group-ack-alice',
                  groupChatId: context.groupChatId,
                  relayOfMessageId: physicalMessageId,
                },
              },
              {
                name: 'group_chat_send',
                input: {
                  commandId: 'TEST-native-group-reply',
                  messageId: GROUP_REPLY_ID,
                  groupChatId: context.groupChatId,
                  text: GROUP_REPLY,
                  relayOfMessageId: physicalMessageId,
                },
              },
            ]
          : [
              {
                name: 'group_chat_react',
                input: {
                  commandId: 'TEST-native-group-ack-bob',
                  groupChatId: context.groupChatId,
                  relayOfMessageId: physicalMessageId,
                },
              },
            ];
      const action = actions[step];
      counters.set(key, step + 1);
      if (!action) return { type: 'text', text: 'DONE_TEST_GROUP_' + memberName };
      for (const required of [
        'group_chat_list',
        'group_chat_create',
        'group_chat_send',
        'group_chat_react',
        'group_chat_lookup',
      ])
        assert.ok(
          tools.includes('mcp__team__' + required),
          'actual served group-compatible catalog'
        );
      const name = 'mcp__team__' + action.name;
      assert.ok(tools.includes(name), 'actual authenticated native group tool catalog');
      return {
        type: 'tool_use',
        id: 'native_group_' + memberName + '_' + step,
        name,
        input: action.input,
      };
    },
  };
}
