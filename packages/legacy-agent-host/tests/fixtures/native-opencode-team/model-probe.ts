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
