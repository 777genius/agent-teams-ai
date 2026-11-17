import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
export type NativeExtensionUiPhase = 'idle' | 'user-skill' | 'project-skill' | 'plugin';
export type NativeExtensionInvocation = Readonly<{
  name: string;
  args: string;
  fragment: string;
  sourceSha256: string;
  absentFragment?: string;
}>;
export interface NativeExtensionUiScenario {
  phase(): NativeExtensionUiPhase;
  invocation(phase: Exclude<NativeExtensionUiPhase, 'idle'>): NativeExtensionInvocation;
}
export const EXTENSION_USER_SKILL = 'test-native-user-extension';
export const EXTENSION_PROJECT_SKILL = 'test-native-project-extension';
export const EXTENSION_USER_BODY = 'TEST_R10_NATIVE_USER_SKILL_BODY';
export const EXTENSION_PROJECT_BODY_A = 'TEST_R10_NATIVE_PROJECT_SKILL_BODY_A';
export const EXTENSION_PROJECT_BODY_B = 'TEST_R10_NATIVE_PROJECT_SKILL_BODY_B';
export const extensionReply = (phase: Exclude<NativeExtensionUiPhase, 'idle'>) =>
  'TEST_R10_NATIVE_' + phase.toUpperCase().replaceAll('-', '_') + '_REPLY';
export const extensionReplyId = (phase: Exclude<NativeExtensionUiPhase, 'idle'>) =>
  'TEST-r10-native-' + phase + '-reply';
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Six finite responses after the ordinary Launch; the native SDK expands every selected skill. */
export function nativeExtensionUiScript(
  options: NativeExtensionUiScenario,
  readReceipt: (value: unknown) => Row
) {
  const requests: { phase: Exclude<NativeExtensionUiPhase, 'idle'>; step: number;
    bodySha256: string; sourceSha256: string; nativeBodyObserved: true; requestedModel: string }[] = [];
  const phases = ['user-skill', 'project-skill', 'plugin'] as const;
  return {
    requests,
    respond(body: Row, tools: string[]): Row | undefined {
      const phase = options.phase();
      if (phase === 'idle') return;
      assert.ok(requests.length < 6, 'exactly one native tool/result pair per explicit UI command');
      assert.equal(phase, phases[Math.floor(requests.length / 2)], 'original command order');
      const step = requests.length % 2;
      const selected = options.invocation(phase);
      assert.ok(selected.fragment.length >= 20 && selected.fragment.length <= 1024);
      assert.match(selected.sourceSha256, /^[a-f0-9]{64}$/);
      assert.equal(body.model, 'claude-opus-4-6');
      const serialized = JSON.stringify(body);
      assert.ok(Buffer.byteLength(serialized) <= 2_000_000);
      assert.ok(JSON.stringify(body.system).includes('TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1'));
      assert.ok(tools.includes('mcp__team__message_send'));
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const latest = messages.findLast(row => row.role === 'user');
      assert.ok(latest);
      const blocks = typeof latest.content === 'string' ? [{ type: 'text', text: latest.content }]
        : (Array.isArray(latest.content) ? latest.content : []).map(record);
      const text = normalized(blocks.filter(block => block.type === 'text')
        .map(block => String(block.text)).join('\n'));
      const toolId = 'TEST-r10-native-' + phase + '-tool';
      let block: Row;
      if (step === 0) {
        assert.ok(text.includes(normalized(selected.fragment)),
          'latest native command body contains the installed source, not only slash name or args');
        assert.ok(text.includes(selected.args), 'native expansion retains exact Composer arguments');
        if (selected.absentFragment) assert.equal(text.includes(selected.absentFragment), false,
          'edited skill consumes B, never the previous A body');
        block = { type: 'tool_use', id: toolId, name: 'mcp__team__message_send',
          input: { commandId: extensionReplyId(phase), to: 'user', text: extensionReply(phase) } };
      } else {
        const result = blocks.find(value => value.type === 'tool_result');
        assert.ok(result);
        assert.equal(result.tool_use_id, toolId);
        assert.notEqual(result.is_error, true);
        const receipt = readReceipt(result.content);
        assert.equal(receipt.commandId, extensionReplyId(phase));
        assert.equal(receipt.phase, 'completed');
        assert.equal(record(record(receipt.result).message).text, extensionReply(phase));
        block = { type: 'text', text: 'TEST_R10_NATIVE_' + phase + '_DONE' };
      }
      requests.push({ phase, step, bodySha256: createHash('sha256').update(serialized).digest('hex'),
        sourceSha256: selected.sourceSha256, nativeBodyObserved: true, requestedModel: String(body.model) });
      return block;
    },
  };
}
