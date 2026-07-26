import { randomUUID } from 'crypto';

import { readResponseTextWithLimit } from './boundedResponseBody';

import type { RuntimeLocalProviderListEntryDto } from '../../contracts';

const COORDINATION_PROBE_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const PROBE_TEAM_NAME = 'agent-teams-local-probe';
const PROBE_MEMBER_NAME = 'probe-member';
const PROBE_RECIPIENT = 'probe-lead';
const TASK_BRIEFING_TOOL_NAME = 'agent-teams_task_briefing';
const MESSAGE_SEND_TOOL_NAME = 'agent-teams_message_send';

export interface OpenCodeLocalModelCoordinationProbeResult {
  readonly status: 'passed' | 'failed' | 'unavailable';
  readonly message: string;
}

interface OpenCodeLocalModelCoordinationProbeDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly createNonce?: () => string;
  readonly timeoutMs?: number;
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

interface StreamingToolCall {
  id: string | null;
  type: string;
  name: string;
  arguments: string;
}

interface StreamingToolCallAccumulator {
  readonly callsBySequence: Map<number, StreamingToolCall>;
  readonly sequenceById: Map<string, number>;
  readonly sequenceByIndex: Map<number, number>;
  readonly ambiguousIndexes: Set<number>;
  nextSequence: number;
}

export async function probeOpenCodeLocalModelCoordination(
  input: {
    readonly provider: RuntimeLocalProviderListEntryDto;
    readonly modelId: string;
    readonly signal?: AbortSignal;
  },
  dependencies: OpenCodeLocalModelCoordinationProbeDependencies = {}
): Promise<OpenCodeLocalModelCoordinationProbeResult> {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const nonce =
    dependencies.createNonce?.() ?? `local-probe-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const timeoutController = input.signal ? null : new AbortController();
  const timeout = timeoutController
    ? setTimeout(
        () => timeoutController.abort(),
        dependencies.timeoutMs ?? COORDINATION_PROBE_TIMEOUT_MS
      )
    : null;
  timeout?.unref?.();
  const signal = input.signal ?? timeoutController!.signal;

  try {
    const first = await requestProbeCompletion({
      fetchImpl,
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
      signal,
    });
    if (!first.ok) {
      return first.failureKind === 'request_rejected'
        ? failedResult(input, first.message)
        : unavailableResult(input, first.message);
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
      signal,
    });
    if (!second.ok) {
      return second.failureKind === 'request_rejected'
        ? failedResult(input, second.message)
        : unavailableResult(input, second.message);
    }

    const messageCall = findToolCall(second.value.toolCalls, 'message_send');
    if (
      !messageCall ||
      messageCall.arguments.teamName !== PROBE_TEAM_NAME ||
      messageCall.arguments.to !== PROBE_RECIPIENT ||
      messageCall.arguments.from !== PROBE_MEMBER_NAME ||
      messageCall.arguments.text !== nonce
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
    if (timeout) {
      clearTimeout(timeout);
    }
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
            claudeDir: { type: 'string' },
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
            claudeDir: { type: 'string' },
            summary: { type: 'string' },
            source: { type: 'string' },
            relayOfMessageId: { type: 'string' },
            leadSessionId: { type: 'string' },
            attachments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  filename: { type: 'string' },
                  mimeType: { type: 'string' },
                  size: { type: 'number', minimum: 0 },
                  filePath: { type: 'string' },
                },
                required: ['id', 'filename', 'mimeType', 'size'],
              },
            },
            taskRefs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  taskId: { type: 'string' },
                  displayId: { type: 'string' },
                  teamName: { type: 'string' },
                },
                required: ['taskId', 'displayId', 'teamName'],
              },
            },
          },
          required: ['teamName', 'to', 'from', 'text'],
        },
      },
    },
  ];
}

async function requestProbeCompletion(input: {
  fetchImpl: typeof fetch;
  provider: RuntimeLocalProviderListEntryDto;
  modelId: string;
  messages: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  signal: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly value: ProbeResponse }
  | {
      readonly ok: false;
      readonly failureKind: 'request_rejected' | 'unavailable';
      readonly message: string;
    }
> {
  const url = buildOpenAiChatCompletionsUrl(input.provider.baseUrl);
  const useOllamaStreaming = input.provider.preset.id === 'ollama';
  const body = {
    model: input.modelId,
    messages: input.messages,
    tools: input.tools,
    stream: useOllamaStreaming,
    temperature: 0,
    max_tokens: 1_024,
    ...(useOllamaStreaming ? { reasoning_effort: 'none' } : {}),
  };
  const response = await input.fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: useOllamaStreaming ? 'text/event-stream, application/json' : 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: input.signal,
  });
  const raw = await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES);
  if (!response.ok) {
    return {
      ok: false,
      failureKind:
        response.status === 400 || response.status === 422 ? 'request_rejected' : 'unavailable',
      message: `HTTP ${response.status}${raw ? `: ${summarizeServerError(raw)}` : ''}`,
    };
  }
  if (!raw) {
    return {
      ok: false,
      failureKind: 'unavailable',
      message: 'The local server returned an empty response.',
    };
  }

  const parsed = parseProbeResponse(raw);
  return parsed
    ? { ok: true, value: parsed }
    : {
        ok: false,
        failureKind: 'unavailable',
        message: 'The local server returned an invalid tool-call response.',
      };
}

function parseProbeResponse(raw: string): ProbeResponse | null {
  const nonStreaming = parseNonStreamingProbeResponse(raw);
  if (nonStreaming) {
    return nonStreaming;
  }
  return parseStreamingProbeResponse(raw);
}

function parseNonStreamingProbeResponse(raw: string): ProbeResponse | null {
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

function parseStreamingProbeResponse(raw: string): ProbeResponse | null {
  const chunks = parseServerSentEventData(raw);
  if (chunks.length === 0) return null;

  let root: Record<string, unknown> | null = null;
  let content = '';
  let reasoning = '';
  let reasoningContent = '';
  const toolCallAccumulator: StreamingToolCallAccumulator = {
    callsBySequence: new Map(),
    sequenceById: new Map(),
    sequenceByIndex: new Map(),
    ambiguousIndexes: new Set(),
    nextSequence: 0,
  };

  for (const chunk of chunks) {
    root = chunk;
    const choice = asRecord(Array.isArray(chunk.choices) ? chunk.choices[0] : null);
    const delta = asRecord(choice?.delta) ?? asRecord(choice?.message);
    if (!delta) continue;

    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
    if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;

    const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    rawToolCalls.forEach((value) => {
      const rawToolCall = asRecord(value);
      if (!rawToolCall) return;
      const sequence = resolveStreamingToolCallSequence(
        toolCallAccumulator,
        rawToolCall,
        rawToolCalls.length === 1
      );
      const fn = asRecord(rawToolCall.function);
      const previous = toolCallAccumulator.callsBySequence.get(sequence) ?? {
        id: null,
        type: 'function',
        name: '',
        arguments: '',
      };
      if (typeof rawToolCall.id === 'string' && rawToolCall.id.trim()) {
        previous.id = rawToolCall.id;
      }
      if (typeof rawToolCall.type === 'string' && rawToolCall.type.trim()) {
        previous.type = rawToolCall.type;
      }
      if (typeof fn?.name === 'string') {
        previous.name = mergeStreamedField(previous.name, fn.name);
      }
      if (typeof fn?.arguments === 'string') {
        previous.arguments += fn.arguments;
      }
      toolCallAccumulator.callsBySequence.set(sequence, previous);
    });
  }

  if (!root) return null;
  const rawToolCalls = Array.from(toolCallAccumulator.callsBySequence.entries())
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({
      id: call.id,
      type: call.type,
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    }));
  const assistant: Record<string, unknown> = {
    role: 'assistant',
    content: content || null,
    tool_calls: rawToolCalls,
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };
  const toolCalls = rawToolCalls
    .map(parseToolCall)
    .filter((value): value is ToolCall => value !== null);
  return { root, assistant, toolCalls };
}

function resolveStreamingToolCallSequence(
  accumulator: StreamingToolCallAccumulator,
  rawToolCall: Record<string, unknown>,
  allowSingleCallContinuation: boolean
): number {
  const id =
    typeof rawToolCall.id === 'string' && rawToolCall.id.trim() ? rawToolCall.id.trim() : null;
  const index =
    typeof rawToolCall.index === 'number' && Number.isSafeInteger(rawToolCall.index)
      ? rawToolCall.index
      : null;

  if (id) {
    const knownIdSequence = accumulator.sequenceById.get(id);
    if (knownIdSequence !== undefined) {
      registerStreamingToolCallIndex(accumulator, index, knownIdSequence);
      return knownIdSequence;
    }

    if (index !== null && !accumulator.ambiguousIndexes.has(index)) {
      const knownIndexSequence = accumulator.sequenceByIndex.get(index);
      const indexedCall =
        knownIndexSequence === undefined
          ? undefined
          : accumulator.callsBySequence.get(knownIndexSequence);
      if (knownIndexSequence !== undefined && (!indexedCall?.id || indexedCall.id === id)) {
        accumulator.sequenceById.set(id, knownIndexSequence);
        return knownIndexSequence;
      }
      if (knownIndexSequence !== undefined) {
        accumulator.sequenceByIndex.delete(index);
        accumulator.ambiguousIndexes.add(index);
      }
    }

    const sequence = accumulator.nextSequence++;
    accumulator.sequenceById.set(id, sequence);
    registerStreamingToolCallIndex(accumulator, index, sequence);
    return sequence;
  }

  if (index !== null && !accumulator.ambiguousIndexes.has(index)) {
    const knownIndexSequence = accumulator.sequenceByIndex.get(index);
    if (knownIndexSequence !== undefined) return knownIndexSequence;
  }

  if (index === null && allowSingleCallContinuation && accumulator.callsBySequence.size === 1) {
    for (const sequence of accumulator.callsBySequence.keys()) return sequence;
  }

  const sequence = accumulator.nextSequence++;
  registerStreamingToolCallIndex(accumulator, index, sequence);
  return sequence;
}

function registerStreamingToolCallIndex(
  accumulator: StreamingToolCallAccumulator,
  index: number | null,
  sequence: number
): void {
  if (index === null || accumulator.ambiguousIndexes.has(index)) return;
  const knownSequence = accumulator.sequenceByIndex.get(index);
  if (knownSequence === undefined || knownSequence === sequence) {
    accumulator.sequenceByIndex.set(index, sequence);
    return;
  }
  accumulator.sequenceByIndex.delete(index);
  accumulator.ambiguousIndexes.add(index);
}

function parseServerSentEventData(raw: string): Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = asRecord(JSON.parse(data));
      if (parsed) chunks.push(parsed);
    } catch {
      continue;
    }
  }
  return chunks;
}

function mergeStreamedField(existing: string, fragment: string): string {
  if (!existing || !fragment) return existing || fragment;
  if (fragment === existing || existing.endsWith(fragment)) return existing;
  if (fragment.startsWith(existing)) return fragment;
  if (existing.startsWith(fragment)) return existing;
  return existing + fragment;
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
    ...(typeof response.assistant.reasoning === 'string'
      ? { reasoning: response.assistant.reasoning }
      : {}),
    ...(typeof response.assistant.reasoning_content === 'string'
      ? { reasoning_content: response.assistant.reasoning_content }
      : {}),
    tool_calls: response.toolCalls.map((call, index) => ({
      ...call.raw,
      id: call.id ?? `agent-teams-probe-call-${index + 1}`,
      type: 'function',
      function: {
        ...(asRecord(call.raw.function) ?? {}),
        name: call.name,
        // Some compatible servers return arguments as an object even though the
        // OpenAI request schema requires a JSON string. Always replay the parsed
        // arguments canonically so a permissive response cannot break turn two.
        arguments: JSON.stringify(call.arguments),
      },
    })),
  };
}

function buildToolResultMessage(call: ToolCall, nonce: string): Record<string, unknown> {
  const content =
    `Direct message from ${PROBE_RECIPIENT}: send the exact text ${nonce} to ` +
    `${PROBE_RECIPIENT} using ${MESSAGE_SEND_TOOL_NAME}. Use teamName=${PROBE_TEAM_NAME}, ` +
    `from=${PROBE_MEMBER_NAME}. summary is optional.`;
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
