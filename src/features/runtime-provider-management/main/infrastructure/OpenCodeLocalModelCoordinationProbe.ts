import { randomUUID } from 'crypto';

import type { RuntimeLocalProviderListEntryDto } from '../../contracts';

const COORDINATION_PROBE_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const PROBE_TEAM_NAME = 'agent-teams-local-probe';
const PROBE_MEMBER_NAME = 'probe-member';
const PROBE_RECIPIENT = 'probe-lead';
const TASK_BRIEFING_TOOL_NAME = 'agent_teams_task_briefing';
const MESSAGE_SEND_TOOL_NAME = 'agent_teams_message_send';

export interface OpenCodeLocalModelCoordinationProbeResult {
  readonly status: 'passed' | 'failed' | 'unavailable';
  readonly message: string;
}

interface OpenCodeLocalModelCoordinationProbeDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly createNonce?: () => string;
}

interface ToolCall {
  readonly id: string | null;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
}

interface ProbeResponse {
  readonly root: Record<string, unknown>;
  readonly assistant: Record<string, unknown>;
  readonly toolCalls: ToolCall[];
}

export async function probeOpenCodeLocalModelCoordination(
  input: {
    readonly provider: RuntimeLocalProviderListEntryDto;
    readonly modelId: string;
  },
  dependencies: OpenCodeLocalModelCoordinationProbeDependencies = {}
): Promise<OpenCodeLocalModelCoordinationProbeResult> {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const nonce =
    dependencies.createNonce?.() ?? `local-probe-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COORDINATION_PROBE_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const first = await requestProbeCompletion({
      fetchImpl,
      controller,
      provider: input.provider,
      modelId: input.modelId,
      messages: [
        {
          role: 'system',
          content:
            'You are an Agent Teams teammate compatibility test. Follow the coordination protocol exactly. Use tools instead of writing fake tool calls or plain-text replies.',
        },
        {
          role: 'user',
          content:
            `Call ${TASK_BRIEFING_TOOL_NAME} with teamName=${PROBE_TEAM_NAME} and ` +
            `memberName=${PROBE_MEMBER_NAME}. Do not reply in text.`,
        },
      ],
      tools: buildCoordinationProbeTools(),
    });
    if (!first.ok) {
      return unavailableResult(input, first.message);
    }

    const firstCall = findToolCall(first.value.toolCalls, 'task_briefing');
    if (
      !firstCall ||
      firstCall.arguments.teamName !== PROBE_TEAM_NAME ||
      firstCall.arguments.memberName !== PROBE_MEMBER_NAME ||
      findToolCall(first.value.toolCalls, 'message_send')
    ) {
      return failedResult(
        input,
        `${input.provider.preset.displayName} returned a response, but ${input.modelId} did not ` +
          'complete the required task_briefing tool step.'
      );
    }

    const second = await requestProbeCompletion({
      fetchImpl,
      controller,
      provider: input.provider,
      modelId: input.modelId,
      messages: [
        {
          role: 'system',
          content:
            'You are an Agent Teams teammate compatibility test. Follow the coordination protocol exactly. Use tools instead of writing fake tool calls or plain-text replies.',
        },
        {
          role: 'user',
          content:
            `Call ${TASK_BRIEFING_TOOL_NAME} with teamName=${PROBE_TEAM_NAME} and ` +
            `memberName=${PROBE_MEMBER_NAME}. Do not reply in text.`,
        },
        buildAssistantToolCallMessage(first.value),
        buildToolResultMessage(firstCall, nonce),
      ],
      tools: buildCoordinationProbeTools(),
    });
    if (!second.ok) {
      return unavailableResult(input, second.message);
    }

    const messageCall = findToolCall(second.value.toolCalls, 'message_send');
    if (
      !messageCall ||
      messageCall.arguments.teamName !== PROBE_TEAM_NAME ||
      messageCall.arguments.to !== PROBE_RECIPIENT ||
      messageCall.arguments.from !== PROBE_MEMBER_NAME ||
      messageCall.arguments.text !== nonce ||
      typeof messageCall.arguments.summary !== 'string' ||
      messageCall.arguments.summary.trim().length === 0
    ) {
      return failedResult(
        input,
        `${input.provider.preset.displayName} returned a response, but ${input.modelId} wrote ` +
          'plain text or an invalid call instead of the required Agent Teams message_send tool.'
      );
    }

    return {
      status: 'passed',
      message:
        `${input.modelId} completed the Agent Teams task_briefing -> message_send ` +
        'coordination probe with valid tool arguments.',
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'The Agent Teams coordination probe timed out.'
        : error instanceof Error
          ? error.message
          : String(error);
    return unavailableResult(input, message);
  } finally {
    clearTimeout(timeout);
  }
}

function buildCoordinationProbeTools(): Record<string, unknown>[] {
  return [
    {
      type: 'function',
      function: {
        name: TASK_BRIEFING_TOOL_NAME,
        description: 'Get actionable Agent Teams tasks for this teammate.',
        parameters: {
          type: 'object',
          properties: {
            teamName: { type: 'string' },
            memberName: { type: 'string' },
          },
          required: ['teamName', 'memberName'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: MESSAGE_SEND_TOOL_NAME,
        description: 'Send a visible Agent Teams message to another teammate.',
        parameters: {
          type: 'object',
          properties: {
            teamName: { type: 'string' },
            to: { type: 'string' },
            from: { type: 'string' },
            text: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['teamName', 'to', 'from', 'text', 'summary'],
        },
      },
    },
  ];
}

async function requestProbeCompletion(input: {
  fetchImpl: typeof fetch;
  controller: AbortController;
  provider: RuntimeLocalProviderListEntryDto;
  modelId: string;
  messages: Record<string, unknown>[];
  tools: Record<string, unknown>[];
}): Promise<
  | { readonly ok: true; readonly value: ProbeResponse }
  | { readonly ok: false; readonly message: string }
> {
  const url = buildOpenAiChatCompletionsUrl(input.provider.baseUrl);
  const body = {
    model: input.modelId,
    messages: input.messages,
    tools: input.tools,
    stream: false,
    temperature: 0,
    max_tokens: 1_024,
  };
  const response = await input.fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: input.controller.signal,
  });
  const raw = await readResponseTextWithLimit(response);
  if (!response.ok) {
    return {
      ok: false,
      message: `HTTP ${response.status}${raw ? `: ${summarizeServerError(raw)}` : ''}`,
    };
  }
  if (!raw) {
    return { ok: false, message: 'The local server returned an empty response.' };
  }

  const parsed = parseProbeResponse(raw);
  return parsed
    ? { ok: true, value: parsed }
    : { ok: false, message: 'The local server returned an invalid tool-call response.' };
}

function parseProbeResponse(raw: string): ProbeResponse | null {
  let root: Record<string, unknown> | null = null;
  try {
    root = asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!root) return null;

  const assistant = asRecord(
    asRecord(Array.isArray(root.choices) ? root.choices[0] : null)?.message
  );
  if (!assistant) return null;
  const rawToolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
  const toolCalls = rawToolCalls
    .map(parseToolCall)
    .filter((value): value is ToolCall => value !== null);
  return { root, assistant, toolCalls };
}

function parseToolCall(value: unknown): ToolCall | null {
  const raw = asRecord(value);
  const fn = asRecord(raw?.function);
  if (!raw || !fn || typeof fn.name !== 'string') return null;
  const args = parseToolArguments(fn.arguments);
  if (!args) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : null,
    name: fn.name,
    arguments: args,
    raw,
  };
}

function parseToolArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function findToolCall(toolCalls: readonly ToolCall[], expectedName: string): ToolCall | null {
  return toolCalls.find((toolCall) => normalizeToolName(toolCall.name) === expectedName) ?? null;
}

function normalizeToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^mcp__agent[-_]teams__/, '')
    .replace(/^agent[-_]teams[-_:]?/, '')
    .replace(/-/g, '_');
}

function buildAssistantToolCallMessage(response: ProbeResponse): Record<string, unknown> {
  return {
    role: 'assistant',
    content: response.assistant.content ?? null,
    tool_calls: response.toolCalls.map((call, index) => ({
      ...call.raw,
      id: call.id ?? `agent-teams-probe-call-${index + 1}`,
    })),
  };
}

function buildToolResultMessage(call: ToolCall, nonce: string): Record<string, unknown> {
  const content =
    `Direct message from ${PROBE_RECIPIENT}: send the exact text ${nonce} to ` +
    `${PROBE_RECIPIENT} using ${MESSAGE_SEND_TOOL_NAME}. Use teamName=${PROBE_TEAM_NAME}, ` +
    `from=${PROBE_MEMBER_NAME}, and summary=Compatibility probe.`;
  return {
    role: 'tool',
    tool_call_id: call.id ?? 'agent-teams-probe-call-1',
    content,
  };
}

function buildOpenAiChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath.endsWith('/chat/completions')
    ? normalizedPath
    : `${normalizedPath}/chat/completions`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function readResponseTextWithLimit(response: Response): Promise<string | null> {
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) return null;
  const raw = await response.text();
  return Buffer.byteLength(raw, 'utf8') <= MAX_RESPONSE_BYTES ? raw : null;
}

function summarizeServerError(raw: string): string {
  try {
    const parsed = asRecord(JSON.parse(raw));
    const message = parsed?.error ?? parsed?.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim().slice(0, 300);
    }
  } catch {
    // Fall through to a bounded plain-text preview.
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function unavailableResult(
  input: {
    readonly provider: RuntimeLocalProviderListEntryDto;
    readonly modelId: string;
  },
  reason: string
): OpenCodeLocalModelCoordinationProbeResult {
  return {
    status: 'unavailable',
    message:
      `Could not verify Agent Teams tool coordination for ${input.modelId} through ` +
      `${input.provider.preset.displayName}. ${reason}`,
  };
}

function failedResult(
  input: {
    readonly provider: RuntimeLocalProviderListEntryDto;
    readonly modelId: string;
  },
  reason: string
): OpenCodeLocalModelCoordinationProbeResult {
  return {
    status: 'failed',
    message:
      `${reason} This model is not reliable enough for Agent Teams task execution and ` +
      'teammate messaging.',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
