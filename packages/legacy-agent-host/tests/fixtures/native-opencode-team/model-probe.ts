import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Exact 2.1.4 no-tool preflight shape observed with the native one-step agent. */
export const OPENCODE_V2_PROBE_STEP_LIMIT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** TEST inference only. Native runtime admission, configuration and model proof remain real. */
export function isOpenCodeModelProbe(
  body: Record<string, unknown>,
  generation: 'v1' | 'v2' = 'v1'
): boolean {
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) return false;
  if (!Array.isArray(body.messages) || !body.messages.every(object)) return false;
  let messages = body.messages;
  if (generation === 'v2') {
    const last = messages.at(-1);
    if (!last || last.role !== 'assistant' || last.content !== OPENCODE_V2_PROBE_STEP_LIMIT ||
        Object.keys(last).sort().join(',') !== 'content,role') return false;
    messages = messages.slice(0, -1);
  }
  if (!messages.every(message => message.role === 'system' || message.role === 'user')) return false;
  const users = messages.filter(message => message.role === 'user');
  if (users.length !== 1) return false;
  const content = users[0]!.content;
  const text = typeof content === 'string' ? content :
    Array.isArray(content) && content.every(part => object(part) && part.type === 'text' && typeof part.text === 'string')
      ? content.map(part => String(part.text)).join('\n') : undefined;
  return text === 'Reply only OK. Do not use tools, access files or run commands.';
}

export interface ConfiguredOpenCodeLaunchPreparation {
  arm(scope: {
    commandId: 'TEST-explicit-sandbox-setup-launch';
    launchId: string;
    rosterRevision: string;
    memberId: string;
    model: string;
  }): () => void;
  readonly consumed: number;
}

type ConfiguredLaunchOptions = {
  configuredLaunchPreparation?: true;
  nativeGeneration?: 'v2';
  memberName?: 'alice' | 'carol';
} & Partial<Record<
  'allowModelProbes' | 'settingsProbe' | 'liveMembershipPhase' | 'coordinationProof' |
  'localReadinessProof' | 'sharedSessionProbe' | 'mixedGroups' | 'mixedTaskNotifications' |
  'peerMessaging' | 'captureFileUpdate' | 'retainedProcess' | 'selectedModel' |
  'selectedOutputTokens' | 'selectedBusinessOutputTokens' | 'selectedConfiguration',
  unknown
>>;

/** One original configured Launch may consume its required no-tools preparation. */
export function createConfiguredOpenCodeLaunchPreparation(
  options: ConfiguredLaunchOptions,
  counts: () => { probes: number; business: number }
) {
  if (options.configuredLaunchPreparation === undefined) return undefined;
  assert.equal(options.configuredLaunchPreparation, true);
  assert.equal(options.nativeGeneration, 'v2');
  assert.equal(options.memberName, 'alice');
  const incompatible = [
    'allowModelProbes', 'settingsProbe', 'liveMembershipPhase', 'coordinationProof',
    'localReadinessProof', 'sharedSessionProbe', 'mixedGroups', 'mixedTaskNotifications',
    'peerMessaging', 'captureFileUpdate', 'retainedProcess', 'selectedModel',
    'selectedOutputTokens', 'selectedBusinessOutputTokens', 'selectedConfiguration',
  ] as const;
  assert.ok(incompatible.every(key => options[key] === undefined || options[key] === false),
    'one explicit configured Launch oracle');
  let phase: 'idle' | 'armed' | 'consumed' | 'closed' = 'idle';
  let consumed = 0;
  const port: ConfiguredOpenCodeLaunchPreparation = {
    arm(scope) {
      assert.equal(phase, 'idle', 'the original configured Launch window arms only once');
      phase = 'closed';
      assert.equal(scope.commandId, 'TEST-explicit-sandbox-setup-launch');
      assert.ok(scope.launchId.length > 0 && scope.launchId.length <= 256 && !/[\0\r\n]/u.test(scope.launchId));
      assert.match(scope.rosterRevision, /^[a-f0-9]{64}$/u);
      assert.equal(scope.memberId, 'alice-id');
      assert.equal(scope.model, 'test-local/TEST-model');
      assert.deepEqual(counts(), { probes: 0, business: 0 });
      phase = 'armed';
      return () => { phase = 'closed'; };
    },
    get consumed() { return consumed; },
  };
  return {
    port,
    request(request: Pick<IncomingMessage, 'url' | 'headers'>, body: Record<string, unknown>): boolean {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer TEST-LOCALHOST-ONLY');
      assert.equal(body.model, 'TEST-model');
      if (isOpenCodeModelProbe(body, 'v2')) {
        assert.equal(phase, 'armed', 'only the original configured Launch may prepare its model');
        assert.deepEqual(counts(), { probes: 0, business: 0 });
        phase = 'consumed';
        consumed++;
        return true;
      }
      assert.equal(phase, 'closed', 'business input follows the original configured Launch preparation');
      assert.equal(consumed, 1);
      return false;
    },
  };
}

/** The original ordinary probe wire codec, shared with the configured Launch window. */
export function replyOpenCodeModelProbe(
  response: ServerResponse, body: Record<string, unknown>, probeCount: number
): void {
  const event = (delta: Record<string, unknown>, finish: string | null) => ({
    id: `TEST-opencode-probe-${probeCount}`,
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: typeof body.model === 'string' ? body.model : 'TEST-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify(event({ role: 'assistant', content: 'OK' }, null))}\n\n`
  );
  response.write(`data: ${JSON.stringify(event({}, 'stop'))}\n\n`);
  response.end('data: [DONE]\n\n');
}
