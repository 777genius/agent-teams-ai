import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  COMMAND_ARGS,
  COMPACT_AUTHORIZATION,
  PROJECT_COMMAND_BODY,
  REVIEW_ARGS,
} from '../native-claude-compaction/model.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
export type NativeCommandUiPhase = 'idle' | 'compact' | 'project-command' | 'review';
export interface NativeCommandUiScenario {
  phase(): NativeCommandUiPhase;
}
export const NATIVE_COMMAND_UI_REPLY = 'TEST_P03_UI_PROJECT_COMMAND_NATIVE_REPLY';
export const NATIVE_COMMAND_UI_REPLY_ID = 'TEST-p03-ui-project-native-reply';
export const NATIVE_REVIEW_UI_REPLY = 'TEST_P03_UI_BUILTIN_REVIEW_NATIVE_REPLY';
export const NATIVE_REVIEW_UI_REPLY_ID = 'TEST-p03-ui-review-native-reply';

/** Existing Launch keeps its own oracle. Only the five subsequent native command requests are scripted. */
export function nativeCommandUiScript(
  options: NativeCommandUiScenario,
  readReceipt: (value: unknown) => Row
) {
  const requests: {
    phase: Exclude<NativeCommandUiPhase, 'idle'>;
    bodySha256: string;
    requestedModel: string;
  }[] = [];
  let compact = 0,
    project = 0,
    review = 0;
  return {
    requests,
    respond(body: Row, tools: string[]): Row | undefined {
      const phase = options.phase();
      if (phase === 'idle') return;
      assert.ok(
        requests.length < 5,
        'one compact summary and two native command/tool-result pairs'
      );
      const serialized = JSON.stringify(body);
      assert.ok(Buffer.byteLength(serialized) <= 2_000_000);
      assert.equal(
        body.model,
        'claude-opus-4-6',
        'native commands retain the model selected by the real Launch dialog'
      );
      let block: Row;
      if (phase === 'compact') {
        assert.equal(compact++, 0, 'one original native compact request');
        assert.ok(
          serialized.includes(COMPACT_AUTHORIZATION),
          'native summary receives exact Composer args'
        );
        assert.ok(
          serialized.includes('DONE_NATIVE_TEAM_ONE'),
          'native summary receives the actual prior Launch history'
        );
        block = {
          type: 'text',
          text: 'TEST_P03_UI_NATIVE_SUMMARY: The original Launch completed its task and visible reply. Preserve the captured Team instructions for the next explicit command.',
        };
      } else {
        assert.equal(compact, 1);
        const count = phase === 'review' ? review++ : project++;
        assert.ok(count < 2, 'no duplicate native command request');
        if (phase === 'review') {
          assert.equal(project, 2);
          assert.ok(
            serialized.includes('You are an expert code reviewer.'),
            'native builtin review expands its prompt'
          );
          assert.ok(serialized.includes(`PR number: ${REVIEW_ARGS}`));
        } else assert.ok(serialized.includes(PROJECT_COMMAND_BODY));
        assert.ok(
          serialized.includes(phase === 'review' ? REVIEW_ARGS : COMMAND_ARGS),
          'actual native command expands its original Composer arguments'
        );
        assert.ok(JSON.stringify(body.system).includes('TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1'));
        assert.ok(
          tools.includes('mcp__team__message_send'),
          'the native command retains its captured Team tool'
        );
        const reply = phase === 'review' ? NATIVE_REVIEW_UI_REPLY : NATIVE_COMMAND_UI_REPLY;
        const replyId = phase === 'review' ? NATIVE_REVIEW_UI_REPLY_ID : NATIVE_COMMAND_UI_REPLY_ID;
        const toolId =
          phase === 'review' ? 'TEST-p03-ui-review-native-tool' : 'TEST-p03-ui-project-native-tool';
        if (count === 0)
          block = {
            type: 'tool_use',
            id: toolId,
            name: 'mcp__team__message_send',
            input: {
              commandId: replyId,
              to: 'user',
              text: reply,
            },
          };
        else {
          const latest = (Array.isArray(body.messages) ? body.messages : [])
            .map(record)
            .findLast((row) => row.role === 'user');
          const result = (Array.isArray(latest?.content) ? latest.content : [])
            .map(record)
            .find((row) => row.type === 'tool_result');
          assert.ok(result);
          assert.equal(result.tool_use_id, toolId);
          assert.notEqual(result.is_error, true);
          const receipt = readReceipt(result.content);
          assert.equal(receipt.commandId, replyId);
          assert.equal(receipt.phase, 'completed');
          assert.equal(record(record(receipt.result).message).text, reply);
          block = { type: 'text', text: `TEST_P03_UI_${phase}_DONE` };
        }
      }
      requests.push({
        phase,
        bodySha256: createHash('sha256').update(serialized).digest('hex'),
        requestedModel: String(body.model),
      });
      return block;
    },
  };
}
