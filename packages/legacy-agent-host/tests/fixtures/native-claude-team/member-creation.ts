import assert from 'node:assert/strict';
import type { NativeMemberCreationInput } from '../../../dist/team/nativeMemberCreationContracts.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
export const NATIVE_MEMBER = {
  name: 'test-native-peer',
  create: 'TEST_NATIVE_MEMBER_CREATE_DO_V1',
  work: 'TEST_NATIVE_CREATED_PEER_WORK_V1',
  next: 'TEST_NATIVE_CURRENT_ROSTER_NEXT_V1',
  followup: 'TEST_NATIVE_ROSTER_NO_REPEAT_V1',
  commandId: 'TEST-native-member-create-original',
  created: 'REPLY_NATIVE_MEMBER_CREATED',
  reply: 'REPLY_NATIVE_CREATED_PEER',
  contextReply: 'REPLY_NATIVE_CURRENT_ROSTER',
  followupReply: 'REPLY_NATIVE_ROSTER_NO_REPEAT',
} as const;
export interface NativeMemberCreationScenario {
  capture(): { input: NativeMemberCreationInput; model: string; effort: string };
  principalId(memberName: string): string;
}
/** Only responses are scripted; real native MCP must publish, allocate and deliver. */
export function nativeMemberCreationScript(
  options: NativeMemberCreationScenario,
  receipt: (value: unknown) => Row
) {
  const observations: Row[] = [];
  const counters = new Map<string, number>();
  let original: NativeMemberCreationInput | undefined;
  let created: Row | undefined;
  let expectedConfiguration: { model: string; effort: string } | undefined;
  const reminder = 'Internal standing context restored after provider context compaction.';
  return {
    observations,
    respond(body: Row, tools: string[]): Row | undefined {
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(row);
      const texts = messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .map(row)
                  .filter((block) => block.type === 'text')
                  .map((block) => String(block.text))
                  .join('\n')
              : ''
        );
      const tokens = [
        NATIVE_MEMBER.create,
        NATIVE_MEMBER.work,
        NATIVE_MEMBER.next,
        NATIVE_MEMBER.followup,
      ];
      const text = texts.findLast((value) => tokens.some((token) => value.includes(token)));
      if (!text) return undefined;
      assert.ok(Buffer.byteLength(text) <= 128 * 1024, 'bounded original native input observation');
      const token = tokens.find((value) => text.includes(value))!;
      const actor = token === NATIVE_MEMBER.work ? NATIVE_MEMBER.name : 'team-lead';
      const step = counters.get(token) ?? 0;
      const results = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.map(row).filter((block) => block.type === 'tool_result')
          : []
      );
      const last = results.at(-1);
      if (step > 0) {
        assert.equal(last?.tool_use_id, `native_member_${token}_${step - 1}`);
        assert.notEqual(last?.is_error, true, 'native operation must actually succeed');
        const completed = receipt(last?.content);
        assert.equal(completed.phase, 'completed');
        if (token === NATIVE_MEMBER.create && step <= 2) {
          assert.equal(completed.commandId, original!.commandId);
          assert.equal(completed.name, NATIVE_MEMBER.name);
          assert.equal(typeof completed.memberId, 'string');
          assert.match(String(completed.revision), /^[a-f0-9]{64}$/);
          if (step === 1) created = completed;
          else
            assert.deepEqual(
              completed,
              created,
              'lookup returns exact original creation without another effect'
            );
        } else assert.equal(completed.principalId, options.principalId(actor));
      }
      assert.ok(observations.length < 11, 'finite additive native request budget');
      assert.ok(JSON.stringify(body.system).includes('TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1'));
      if (step === 0 && token === NATIVE_MEMBER.create) {
        assert.ok(
          text.includes('TURN ACTION MODE: DO'),
          'original lead input explicitly selects Do'
        );
        const captured = structuredClone(options.capture());
        original = captured.input;
        expectedConfiguration = { model: captured.model, effort: captured.effort };
        assert.equal(original.commandId, NATIVE_MEMBER.commandId);
        assert.match(original.expectedRosterRevision, /^[a-f0-9]{64}$/);
        assert.equal(original.member.name, NATIVE_MEMBER.name);
      }
      if (step === 0 && token === NATIVE_MEMBER.next) {
        assert.equal(text.split(reminder).length, 2, 'one reminder in the next original input');
        assert.ok(
          text.includes(`"name":"${NATIVE_MEMBER.name}"`),
          'current canonical roster reaches native inference'
        );
      }
      if (step === 0 && token === NATIVE_MEMBER.followup)
        assert.equal(
          text.includes(reminder),
          false,
          'represented roster epoch is not injected again'
        );
      const actions: { name: string; input: Row }[] =
        token === NATIVE_MEMBER.create
          ? [
              { name: 'team_member_create', input: original! },
              { name: 'team_member_create_lookup', input: original! },
              {
                name: 'message_send',
                input: {
                  commandId: 'TEST-native-new-peer-work',
                  to: NATIVE_MEMBER.name,
                  text: NATIVE_MEMBER.work,
                },
              },
              {
                name: 'message_send',
                input: {
                  commandId: 'TEST-native-new-peer-created',
                  to: 'user',
                  text: NATIVE_MEMBER.created,
                },
              },
            ]
          : [
              {
                name: 'message_send',
                input: {
                  commandId: `TEST-native-member-reply-${token}`,
                  to: 'user',
                  text:
                    token === NATIVE_MEMBER.work
                      ? NATIVE_MEMBER.reply
                      : token === NATIVE_MEMBER.next
                        ? NATIVE_MEMBER.contextReply
                        : NATIVE_MEMBER.followupReply,
                },
              },
            ];
      assert.ok(step <= actions.length, 'no replay of a completed native turn');
      if (actor === NATIVE_MEMBER.name) {
        assert.equal(
          body.model,
          expectedConfiguration!.model,
          'selected new member model reaches actual native inference'
        );
        assert.equal(
          row(body.output_config).effort,
          expectedConfiguration!.effort,
          'selected inherited effort reaches actual native inference'
        );
        if (original!.member.role)
          assert.ok(JSON.stringify(body.system).includes(original!.member.role));
        if (original!.member.workflow)
          assert.ok(JSON.stringify(body.system).includes(original!.member.workflow));
      }
      observations.push({
        ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
        ...(typeof row(body.output_config).effort === 'string'
          ? { requestedEffort: row(body.output_config).effort }
          : {}),
        token,
        actor,
        step,
        tools,
        ...(step === 0 ? { originalText: text } : {}),
        ...(token === NATIVE_MEMBER.create && step === 2 ? { originalLookup: created } : {}),
      });
      counters.set(token, step + 1);
      const action = actions[step];
      if (!action) return { type: 'text', text: `DONE_${token}` };
      const name = `mcp__team__${action.name}`;
      assert.ok(tools.includes(name), 'actual native catalog contains the selected existing tool');
      return { type: 'tool_use', id: `native_member_${token}_${step}`, name, input: action.input };
    },
  };
}
