import assert from 'node:assert/strict';
type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
export const CROSS_BEGIN = 'NATIVE_CROSS_BEGIN',
  CROSS_REQUEST = 'NATIVE_CROSS_REQUEST',
  CROSS_REPLY = 'NATIVE_CROSS_REPLY',
  CROSS_DONE = 'NATIVE_CROSS_DONE';
export const CROSS_FORWARD_ID = 'TEST-native-cross-forward',
  CROSS_REPLY_ID = 'TEST-native-cross-reply';
export const CROSS_TARGET = 'test-native-cross-target';
export interface NativeCrossTeamScenario {
  actor: 'source' | 'target';
  contextMarker: string;
}
/** Compact canonical MCP JSON only; SDK may append a reminder on later lines. */
function toolValue(content: unknown): unknown {
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content
            .map(row)
            .filter((block) => block.type === 'text')
            .map((block) => String(block.text))
        : [];
  const text = texts.find((text) => /^[{[]/.test(text.trimStart()));
  assert.ok(text && text.length <= 256 * 1024);
  const value: unknown = JSON.parse(text.trimStart().split('\n')[0]!);
  return value && typeof value === 'object' && !Array.isArray(value) && 'result' in value
    ? value.result
    : value;
}
/** Inference responses only. Actual native SDK must execute the authenticated tools. */
export function nativeCrossTeamScript(options: NativeCrossTeamScenario) {
  const requests: {
    actor: string;
    turn: string;
    step: number;
    model: unknown;
    toolResultError: boolean;
    tool?: string;
  }[] = [];
  const counters = new Map<string, number>();
  return {
    requests,
    respond(body: Row, tools: string[]): Row | undefined {
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(row);
      let turn = '';
      for (const message of messages.toReversed()) {
        if (message.role !== 'user') continue;
        const text =
          typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .map(row)
                  .filter((block) => block.type === 'text')
                  .map((block) => String(block.text))
                  .join('\n')
              : '';
        const found = new RegExp(`${CROSS_BEGIN}|${CROSS_REQUEST}|${CROSS_REPLY}`).exec(text);
        if (found) {
          turn = found[0];
          break;
        }
      }
      if (!turn) return undefined;
      assert.ok(
        JSON.stringify(body.system).includes(options.contextMarker),
        'native request preserves captured actor context'
      );
      assert.equal(body.model, 'claude-opus-4-6');
      assert.equal(row(body.output_config).effort, 'medium');
      assert.equal(options.actor, turn === CROSS_REQUEST ? 'target' : 'source');
      const step = counters.get(turn) ?? 0,
        ack = turn === CROSS_REPLY;
      assert.ok(
        step <= (ack ? 1 : 2) && requests.length < (options.actor === 'source' ? 5 : 3),
        'bounded original native roundtrip'
      );
      const results = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.map(row).filter((block) => block.type === 'tool_result')
          : []
      );
      const last = results.at(-1);
      if (step > 0) {
        assert.ok(last);
        assert.notEqual(last.is_error, true);
        assert.equal(last.tool_use_id, `native_cross_${turn}_${step - 1}`);
      }
      let name: string | undefined,
        input: Row = {};
      if (ack) {
        if (step === 0) {
          name = 'message_send';
          input = { commandId: 'TEST-native-cross-human-ack', to: 'user', text: CROSS_DONE };
        } else assert.equal(row(toolValue(last!.content)).phase, 'completed');
      } else if (step === 0) name = 'cross_team_list_targets';
      else if (step === 1) {
        const value = toolValue(last!.content);
        assert.ok(Array.isArray(value));
        const expectedTeam = options.actor === 'source' ? CROSS_TARGET : 'test-native-team';
        const targets = value.map(row).filter((target) => target.teamName === expectedTeam);
        assert.equal(targets.length, 1);
        const target = targets[0]!;
        assert.equal(target.recipientName, options.actor === 'source' ? 'dana' : 'alice');
        assert.ok(
          typeof target.resourceRef === 'string' && target.resourceRef !== expectedTeam,
          'actual opaque captured recipient resource'
        );
        name = 'cross_team_send';
        input = {
          commandId: options.actor === 'source' ? CROSS_FORWARD_ID : CROSS_REPLY_ID,
          toTeam: target.resourceRef,
          text: options.actor === 'source' ? CROSS_REQUEST : CROSS_REPLY,
        };
        // Reply deliberately omits conversation metadata: Host must infer original active delivery.
      } else {
        const receipt = row(toolValue(last!.content));
        assert.equal(receipt.phase, 'completed');
        assert.equal(
          receipt.commandId,
          options.actor === 'source' ? CROSS_FORWARD_ID : CROSS_REPLY_ID
        );
        assert.ok(typeof receipt.conversationId === 'string' && receipt.conversationId.length > 0);
      }
      counters.set(turn, step + 1);
      requests.push({
        actor: options.actor,
        turn,
        step,
        model: body.model,
        toolResultError: last?.is_error === true,
        ...(name ? { tool: name } : {}),
      });
      if (!name)
        return {
          type: 'text',
          text: `TEST cross-Team ${options.actor} ${ack ? 'acknowledged' : 'sent'}`,
        };
      const fullName = 'mcp__team__' + name;
      assert.ok(tools.includes(fullName), 'native cross-Team tool must be advertised');
      return { type: 'tool_use', id: `native_cross_${turn}_${step}`, name: fullName, input };
    },
  };
}
