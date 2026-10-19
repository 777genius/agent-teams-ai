import assert from 'node:assert/strict';
import { types } from 'node:util';

/** Finite observations from the existing public V2 canonical DTO, never turn authority. */
export function projectV2NativeTranscript(value: unknown, expected: {
  sessionId: string; selectedModel: string; runtimePromptMessageId?: string | null;
}) {
  const field = (input: unknown, key: string): unknown => {
    assert(input && typeof input === 'object' && !types.isProxy(input) && !Array.isArray(input), 'TEST V2 transcript invalid');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  const array = (input: unknown, limit: number): unknown[] => {
    assert(input && typeof input === 'object' && !types.isProxy(input) && Array.isArray(input) && input.length <= limit,
      'TEST V2 transcript invalid');
    // Array index accessors are foreign input too.
    return Array.from({ length: input.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      assert(descriptor && Object.hasOwn(descriptor, 'value'), 'TEST V2 transcript invalid');
      return descriptor.value as unknown;
    });
  };
  assert(/^ses_[A-Za-z0-9]+$/.test(expected.sessionId));
  assert(field(value, 'sessionId') === expected.sessionId, 'TEST V2 transcript session mismatch');
  const durableState = ['unknown', 'running', 'retrying', 'idle', 'error'].find(item => item === field(value, 'durableState'));
  assert(durableState, 'TEST V2 transcript state invalid');
  const messages = array(field(value, 'messages'), 1600);
  const ids = messages.map(message => field(message, 'id'));
  assert(ids.every(id => typeof id === 'string' && /^msg_[A-Za-z0-9]+$/.test(id)) &&
    new Set(ids).size === ids.length, 'TEST V2 transcript messages invalid');
  const roles = messages.map(message => field(message, 'role'));
  assert(roles.every(role => typeof role === 'string' && ['user', 'assistant', 'system', 'unknown'].includes(role)), 'TEST V2 transcript role invalid');
  const assistants = messages.filter((_, index) => roles[index] === 'assistant');
  const modelSeparator = expected.selectedModel.indexOf('/');
  assert(modelSeparator > 0 && modelSeparator < expected.selectedModel.length - 1);
  const provider = expected.selectedModel.slice(0, modelSeparator), model = expected.selectedModel.slice(modelSeparator + 1);
  const modelMatch = (message: unknown) => field(message, 'providerId') === provider && field(message, 'modelId') === model;
  const tools: unknown[] = [];
  for (const message of messages) {
    const next = array(field(message, 'toolCalls'), Math.min(4096, 16_384 - tools.length));
    tools.push(...next);
  }
  const toolNames = tools.map(tool => {
    const name = field(tool, 'toolName');
    const normalized = typeof name === 'string' ? name.toLowerCase().replace(/^proxy_/, '')
      .replace(/^(?:mcp__agent[-_]teams__|agent[-_]teams_)/, '') : '';
    return ['execute', 'bash', 'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'task_get', 'task_list',
      'task_add_comment', 'task_complete', 'message_send', 'member_briefing', 'runtime_bootstrap_checkin']
      .find(item => item === normalized) ?? 'other';
  });
  const failure = (message: unknown) => {
    const name = field(message, 'errorName'), raw = field(message, 'errorMessage');
    let parsed: unknown;
    if (typeof raw === 'string' && raw.length <= 32_768) {
      try { parsed = JSON.parse(raw); } catch { /* Plain text is not retained. */ }
    }
    const safeField = (input: unknown, key: string): unknown => {
      try { return field(input, key); } catch { return undefined; }
    };
    const rows = [parsed, safeField(parsed, 'error'), safeField(parsed, 'data')];
    const names = ['APIError', 'APICallError', 'AI_APICallError', 'ProviderAuthError', 'MessageAbortedError',
      'ContextOverflowError', 'StructuredOutputError', 'UnknownError', 'NoOutputGeneratedError',
      'NoObjectGeneratedError', 'InvalidResponseDataError', 'TypeValidationError', 'InvalidPromptError',
      'UnsupportedFunctionalityError', 'ModelNotFoundError'];
    const codes = ['insufficient_credits', 'insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key',
      'context_length_exceeded', 'max_tokens_exceeded', 'model_not_found', 'invalid_request_error',
      'invalid_request', 'authentication_error', 'permission_denied', 'server_error', 'overloaded_error', 'billing_error'];
    return {
      name: names.find(item => item === name || rows.some(row => safeField(row, 'name') === item)) ?? null,
      providerCode: codes.find(item => rows.some(row => safeField(row, 'code') === item)) ?? null,
      httpStatus: rows.flatMap(row => [safeField(row, 'status'), safeField(row, 'statusCode')])
        .find(status => Number.isSafeInteger(status) && Number(status) >= 100 && Number(status) <= 599) as number | undefined ?? null,
    };
  };
  const errors = assistants.filter(message => field(message, 'hasError') === true);
  const inputId = expected.runtimePromptMessageId;
  assert(inputId === undefined || inputId === null || /^msg_[A-Za-z0-9]+$/.test(inputId));
  return {
    source: 'existing_public_v2_runtime_transcript_before_stop' as const,
    sessionMatches: true,
    originalInputPresent: inputId ? messages.some((_, index) => roles[index] === 'user' && ids[index] === inputId) : null,
    durableState,
    messageCount: messages.length,
    userCount: roles.filter(role => role === 'user').length,
    assistantCount: assistants.length,
    completedAssistantCount: assistants.filter(message => {
      const completed = field(message, 'completedAt');
      return typeof completed === 'number' && Number.isFinite(completed) && completed >= 0 && completed <= 8_640_000_000_000_000;
    }).length,
    matchingModelAssistantCount: assistants.filter(modelMatch).length,
    differentOrMissingModelAssistantCount: assistants.filter(message => !modelMatch(message)).length,
    errorAssistantCount: errors.length,
    assistantFailures: errors.slice(-8).map(failure),
    toolCount: tools.length,
    toolErrorCount: tools.filter(tool => field(tool, 'isError') === true).length,
    toolCategories: [...new Set(toolNames)],
    finishReasons: [...new Set(assistants.map(message => {
      const finish = field(message, 'finishReason');
      return ['stop', 'tool-calls', 'length', 'error', 'content-filter', 'unknown'].find(item => item === finish) ?? 'other';
    }))],
  };
}
