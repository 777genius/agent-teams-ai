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
export const PROJECT_COMMAND_BODY = 'TEST_NATIVE_P03_PROJECT_COMMAND_BODY_V1';
export const USER_COMMAND_BODY = 'TEST_NATIVE_P03_USER_COMMAND_BODY_V1';
export const COMMAND_ARGS = 'TEST_NATIVE_P03_EXACT_ARGUMENTS';
export const REVIEW_ARGS = 'TEST_NATIVE_P03_EXACT_REVIEW_ARGUMENTS';
export type CompactionPhase =
  | 'seed'
  | 'compact'
  | 'verify'
  | 'followup'
  | 'project-command'
  | 'user-command'
  | 'review';
export interface CompactionScenario {
  phase(): CompactionPhase;
  taskId(): string;
  preparedInput(): { prefix: string; originalContent: string };
  reviewRead?: { path: string; content: string };
}
export interface CompactionRequest {
  phase: CompactionPhase;
  requestedModel: string;
  bodySha256: string;
  latestUserSha256: string;
  toolCount: number;
  preparedPrefixSha256?: string;
  preparedPayloadSha256?: string;
  commandExecution?: 'legacy-inline-review-v1';
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

/** Explicit old inline compatibility recipe, not successful execution of the newer native fork. */
export function assertLegacyInlineReviewExpansion(body: Row): void {
  const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
  assert.ok(
    messages.some((message) => {
      if (message.role !== 'user') return false;
      const text = userText(message);
      return text.includes('You are an expert code reviewer. Follow these steps:') &&
        text.includes('3. Run `gh pr diff <number>` to get the diff') &&
        text.includes(`\n      PR number: ${REVIEW_ARGS}\n`);
    }),
    'legacy inline review expands its exact arguments in original user context'
  );
}

/** Preserve the strict system predicate; expose only closed facts when it fails. */
export function assertCapturedCommandSystem(
  body: Row,
  phase: 'project-command' | 'user-command' | 'review'
): void {
  const marker = 'TEST_CAPTURED_ALICE_ROLE_CONTEXT_V1';
  const system = JSON.stringify(body.system);
  if (system?.includes(marker)) return;
  const markerBlocks = {
    user: { text: 0, tool_use: 0, tool_result: 0, other: 0 },
    assistant: { text: 0, tool_use: 0, tool_result: 0, other: 0 },
    system: { text: 0, tool_use: 0, tool_result: 0, other: 0 },
    other: { text: 0, tool_use: 0, tool_result: 0, other: 0 },
  };
  for (const messageValue of Array.isArray(body.messages) ? body.messages : []) {
    const message = record(messageValue);
    const role =
      message.role === 'user' || message.role === 'assistant' || message.role === 'system'
        ? message.role
        : 'other';
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    for (const blockValue of blocks) {
      if (!JSON.stringify(blockValue)?.includes(marker)) continue;
      const block = record(blockValue);
      const type =
        typeof blockValue === 'string'
          ? 'text'
          : block.type === 'text' || block.type === 'tool_use' || block.type === 'tool_result'
            ? block.type
            : 'other';
      markerBlocks[role][type] += 1;
    }
  }
  const facts = JSON.stringify({
    phase,
    bodySha256: sha(JSON.stringify(body)),
    systemSha256: sha(system ?? ''),
    systemShape:
      body.system === undefined
        ? 'absent'
        : typeof body.system === 'string'
          ? 'string'
          : Array.isArray(body.system)
            ? 'blocks'
            : 'other',
    markerBlocks,
  });
  assert.ok(Buffer.byteLength(facts) <= 2_048, 'bounded captured system diagnostic');
  assert.fail('named native command keeps captured team system configuration; ' + facts);
}

/** Only Anthropic response text is scripted. Real SDK/native `/compact` must emit the boundary. */
export function contextCompactionScript(
  options: CompactionScenario,
  readReceipt?: (content: unknown) => Row
) {
  const requests: CompactionRequest[] = [];
  const phases = new Map<CompactionPhase, number>();
  return {
    requests,
    respond(body: Row, tools: string[]): Row {
      assert.ok(
        requests.length < 11,
        'four context turns, three exact command/tool-result pairs and one review Read result'
      );
      const phase = options.phase();
      const count = phases.get(phase) ?? 0;
      const command = phase === 'project-command' || phase === 'user-command' || phase === 'review';
      assert.ok(
        count < (phase === 'review' ? 3 : command ? 2 : 1),
        'bounded phase: no duplicate native model spend for an original phase'
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
      } else if (phase === 'followup') {
        assert.ok(text.includes(COMPACT_FOLLOWUP));
        assert.equal(
          text.includes('Internal standing context restored after provider context compaction.'),
          false,
          'represented epoch is not injected again'
        );
      } else {
        if (phase === 'review') assertLegacyInlineReviewExpansion(body);
        else
          assert.ok(
            serialized.includes(
              phase === 'project-command' ? PROJECT_COMMAND_BODY : USER_COMMAND_BODY
            )
          );
        assert.ok(
          serialized.includes(phase === 'review' ? REVIEW_ARGS : COMMAND_ARGS),
          'actual native command expands its original arguments'
        );
        assertCapturedCommandSystem(body, phase);
        assert.ok(
          tools.includes('mcp__team__message_send'),
          'command retains the captured Team tool'
        );
        if (phase === 'review') {
          assert.ok(options.reviewRead && tools.includes('Read'), 'one captured TEST Read is available');
          if (count === 1) {
            const result = (Array.isArray(latest.content) ? latest.content : []).map(record)
              .find((block) => block.type === 'tool_result');
            assert.ok(result);
            assert.equal(result.tool_use_id, 'TEST-p03-review-read');
            assert.notEqual(result.is_error, true);
            assert.ok(JSON.stringify(result.content).includes(options.reviewRead.content.trim()),
              'actual original Read returns the immutable TEST file marker');
          }
        }
        if (count === (phase === 'review' ? 2 : 1)) {
          const result = (Array.isArray(latest.content) ? latest.content : [])
            .map(record)
            .find((block) => block.type === 'tool_result');
          assert.ok(result);
          assert.equal(result.tool_use_id, `TEST-p03-${phase}-tool`);
          assert.notEqual(result.is_error, true);
          assert.ok(
            readReceipt,
            'actual native skill journey supplies its existing MCP receipt parser'
          );
          const receipt = readReceipt(result.content);
          assert.equal(receipt.commandId, `TEST-p03-${phase}-reply`);
          assert.equal(receipt.phase, 'completed');
          assert.equal(
            record(record(receipt.result).message).text,
            `TEST_P03_${phase}_VISIBLE_REPLY`
          );
        }
      }
      assert.equal(typeof body.model, 'string');
      assert.ok(String(body.model).length <= 256);
      requests.push({
        phase,
        requestedModel: String(body.model),
        bodySha256: sha(serialized),
        latestUserSha256: sha(text),
        toolCount: tools.length,
        ...(phase === 'review' ? { commandExecution: 'legacy-inline-review-v1' as const } : {}),
        ...(prefix === undefined || payload === undefined
          ? {}
          : { preparedPrefixSha256: sha(prefix), preparedPayloadSha256: sha(payload) }),
      });
      phases.set(phase, count + 1);
      if (phase === 'review' && count === 0) {
        assert.ok(options.reviewRead);
        return { type: 'tool_use', id: 'TEST-p03-review-read', name: 'Read',
          input: { file_path: options.reviewRead.path } };
      }
      if (command && count === (phase === 'review' ? 1 : 0))
        return {
          type: 'tool_use',
          id: `TEST-p03-${phase}-tool`,
          name: 'mcp__team__message_send',
          input: {
            commandId: `TEST-p03-${phase}-reply`,
            to: 'user',
            text: `TEST_P03_${phase}_VISIBLE_REPLY`,
          },
        };
      return {
        type: 'text',
        text:
          phase === 'compact'
            ? 'TEST_M10_ACTUAL_NATIVE_COMPACTION_SUMMARY_V1: The prior TEST seed turn completed. Await the next original user input and current standing Team context.'
            : `ACK_${phase === 'seed' ? COMPACT_SEED : phase === 'verify' ? COMPACT_VERIFY : phase === 'followup' ? COMPACT_FOLLOWUP : phase}`,
      };
    },
  };
}
