import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const COMPACT_SEED = 'TEST_NATIVE_M10_SEED_V1';
export const COMPACT_AUTHORIZATION = 'TEST_NATIVE_M10_MANUAL_COMPACT_AUTHORIZATION_V1';
export const COMPACT_COMMAND = `/compact ${COMPACT_AUTHORIZATION}`;
export const COMPACT_VERIFY = 'TEST_NATIVE_M10_VERIFY_CURRENT_CONTEXT_V1';
export const COMPACT_FOLLOWUP = 'TEST_NATIVE_M10_FOLLOWUP_NO_SECOND_REMINDER_V1';
export type CompactionPhase = 'seed' | 'compact' | 'verify' | 'followup';
export interface CompactionScenario {
  phase(): CompactionPhase;
  taskId(): string;
  preparedInput(): { prefix: string; originalContent: string };
}
export interface CompactionRequest {
  phase: CompactionPhase;
  requestedModel: string;
  bodySha256: string;
  latestUserSha256: string;
  toolCount: number;
  preparedPrefixSha256?: string;
  preparedPayloadSha256?: string;
}
const userText = (message: Row) =>
  typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .map(record)
          .filter((block) => block.type === 'text')
          .map((block) => String(block.text))
          .join('\n')
      : '';

/** Only Anthropic response text is scripted. Real SDK/native `/compact` must emit the boundary. */
export function contextCompactionScript(options: CompactionScenario) {
  const requests: CompactionRequest[] = [];
  const phases = new Set<CompactionPhase>();
  return {
    requests,
    respond(body: Row, tools: string[]): Row {
      assert.ok(requests.length < 4, 'one bounded seed/summary/verify/followup inference each');
      const phase = options.phase();
      assert.equal(
        phases.has(phase),
        false,
        'no duplicate native model spend for an original phase'
      );
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const latest = messages.findLast((message) => message.role === 'user');
      assert.ok(
        latest,
        'actual native request includes a user input or native summary instruction'
      );
      const text = userText(latest),
        serialized = JSON.stringify(body);
      assert.ok(Buffer.byteLength(serialized) <= 2_000_000);
      let prefix: string | undefined, payload: string | undefined;
      if (phase === 'seed') {
        assert.ok(text.includes(COMPACT_SEED), 'seed is an explicit original Team input');
        assert.ok(JSON.stringify(body.system).includes('TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1'));
      } else if (phase === 'compact') {
        assert.ok(
          serialized.includes(COMPACT_AUTHORIZATION),
          'native summary retains only the deliberately authorized custom compact instruction'
        );
        assert.ok(
          serialized.includes(`ACK_${COMPACT_SEED}`),
          'native summary consumes the genuine prior assistant response'
        );
      } else if (phase === 'verify') {
        assert.ok(text.includes(COMPACT_VERIFY));
        const prepared = options.preparedInput();
        prefix = prepared.prefix;
        payload = prefix + prepared.originalContent;
        assert.ok(
          prefix.includes('Internal standing context restored after provider context compaction.')
        );
        assert.ok(
          prefix.includes('"name":"bob"'),
          'current canonical roster, changed after actual compact'
        );
        assert.ok(
          prefix.includes(options.taskId()),
          'current canonical Task, created after actual compact'
        );
        assert.ok(prefix.includes('TEST_M10_CURRENT_TASK_AFTER_COMPACT'));
        assert.ok(
          text.includes(payload),
          'the exact durable original native payload reaches actual native inference'
        );
        assert.equal(
          text.split(prefix).length,
          2,
          'one reminder prefix in this actual original input'
        );
        assert.ok(
          text.includes('TURN ACTION MODE: ASK'),
          'ordinary original per-turn action mode survives'
        );
      } else {
        assert.ok(text.includes(COMPACT_FOLLOWUP));
        assert.equal(
          text.includes('Internal standing context restored after provider context compaction.'),
          false,
          'represented epoch is not injected again'
        );
      }
      assert.equal(typeof body.model, 'string');
      assert.ok(String(body.model).length <= 256);
      requests.push({
        phase,
        requestedModel: String(body.model),
        bodySha256: sha(serialized),
        latestUserSha256: sha(text),
        toolCount: tools.length,
        ...(prefix === undefined || payload === undefined
          ? {}
          : { preparedPrefixSha256: sha(prefix), preparedPayloadSha256: sha(payload) }),
      });
      phases.add(phase);
      return {
        type: 'text',
        text:
          phase === 'compact'
            ? 'TEST_M10_ACTUAL_NATIVE_COMPACTION_SUMMARY_V1: The prior TEST seed turn completed. Await the next original user input and current standing Team context.'
            : `ACK_${phase === 'seed' ? COMPACT_SEED : phase === 'verify' ? COMPACT_VERIFY : COMPACT_FOLLOWUP}`,
      };
    },
  };
}
