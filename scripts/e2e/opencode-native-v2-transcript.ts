import assert from 'node:assert/strict';
import { types } from 'node:util';

/** Finite observations from the existing public V2 canonical DTO, never turn authority. */
export function projectV2NativeTranscript(value: unknown, expected: {
  sessionId: string; selectedModel: string; runtimePromptMessageId?: string | null;
  command?: { program: string; marker: string };
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
  const toolRows: { tool: unknown; message: unknown; messageIndex: number }[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    const next = array(field(message, 'toolCalls'), Math.min(4096, 16_384 - tools.length));
    tools.push(...next);
    for (const tool of next) toolRows.push({ tool, message, messageIndex });
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
  const commandObservation = expected.command ? (() => {
    const { program, marker } = expected.command;
    assert(typeof program === 'string' && program.length > 0 && program.length <= 32_768 &&
      typeof marker === 'string' && marker.length > 0 && marker.length <= 4096, 'TEST command expectation invalid');
    const originalInputIndex = inputId ? messages.findIndex((_, index) => ids[index] === inputId && roles[index] === 'user') : -1;
    const nextInputIndex = originalInputIndex < 0 ? -1 : messages.findIndex((_, index) => index > originalInputIndex && roles[index] === 'user');
    const relationCounts = { before_original: 0, original_window: 0, after_next_input: 0, unknown: 0 };
    const candidates: { row: (typeof toolRows)[number]; tool: 'bash' | 'shell' | 'exec' | 'execute' | 'other'; relation: keyof typeof relationCounts }[] = [];
    let total = 0;
    for (const row of toolRows) {
      const knownTool = (['bash', 'shell', 'exec', 'execute'] as const).find(name => name === field(row.tool, 'toolName'));
      const rawInput = field(row.tool, 'input');
      const hasCommand = rawInput && typeof rawInput === 'object' && typeof field(rawInput, 'command') === 'string';
      if (!knownTool && !hasCommand) continue;
      const tool = knownTool ?? 'other';
      const relation = originalInputIndex < 0 ? 'unknown' : row.messageIndex < originalInputIndex ? 'before_original' :
        nextInputIndex >= 0 && row.messageIndex >= nextInputIndex ? 'after_next_input' : 'original_window';
      relationCounts[relation]++; total++;
      candidates.push({ row, tool, relation });
      if (candidates.length > 8) candidates.shift();
    }
    const tuples = candidates.map(({ row, tool, relation }) => {
      const sourceValue = field(row.tool, 'source');
      const callId = field(row.tool, 'callId');
      const nativeCallIdPresent = typeof callId === 'string' && callId.length > 0 && callId.length <= 4096;
      const source = sourceValue && typeof sourceValue === 'object' &&
        field(sourceValue, 'kind') === 'opencode-v2-code-mode-metadata' ? 'code-mode-metadata' as const :
        sourceValue == null && nativeCallIdPresent ? 'native' as const : 'unknown' as const;
      const status = ['pending', 'running', 'completed', 'errored'].find(item => item === field(row.tool, 'status')) ?? 'unknown';
      const error = field(row.tool, 'isError');
      const inputValue = field(row.tool, 'input');
      const command = inputValue == null ? undefined : field(inputValue, 'command');
      const workdir = inputValue == null ? undefined : field(inputValue, 'workdir');
      // This input-only copy mirrors nativeCommandMatch. Its CDP closure must
      // remain self-contained; no canonical output is made into a tool result.
      const input = typeof command === 'string' && command.length > 32_768 ||
        typeof workdir === 'string' && workdir.length > 32_768 ? null : (() => {
        const shell = ['bash', 'shell', 'exec'].includes(tool);
        const programMatches = typeof command === 'string' && command.includes(program);
        const nodeMatches = typeof command === 'string' && /\bnode(?:\.exe)?\b/i.test(command);
        const slash = (value: string) => value.replace(/\\/g, '/');
        const normalizedProgram = slash(program);
        const normalizedCommand = typeof command === 'string' ? slash(command) : '';
        const windowsAbsolute = /^[A-Za-z]:\//.test(normalizedProgram);
        const directory = normalizedProgram.slice(0, normalizedProgram.lastIndexOf('/'));
        const basename = normalizedProgram.slice(normalizedProgram.lastIndexOf('/') + 1);
        const invocation = typeof command === 'string'
          ? /^\s*node(?:\.exe)?\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"';&|<>`$]+))\s*$/i.exec(command) : null;
        const argument = invocation ? slash(invocation[1] ?? invocation[2] ?? invocation[3]) : null;
        const relativeProgramArgument = argument !== null && [basename, './' + basename].includes(argument);
        const normalizedWorkdir = typeof workdir === 'string' ? slash(workdir).replace(/\/$/, '') : null;
        const workdirProjectMatches = normalizedWorkdir !== null && windowsAbsolute && /^[A-Za-z]:\//.test(normalizedWorkdir)
          ? normalizedWorkdir.toLowerCase() === directory.toLowerCase() : null;
        return { shell, programMatches, nodeMatches, commandShape: {
          slashNormalizedAbsolutePresent: windowsAbsolute && normalizedCommand.includes(normalizedProgram),
          caseNormalizedAbsolutePresent: windowsAbsolute && normalizedCommand.toLowerCase().includes(normalizedProgram.toLowerCase()),
          relativeProgramArgument, workdirProjectMatches,
          relativeProgramAtProject: relativeProgramArgument && workdirProjectMatches === true,
        } };
      })();
      let outputPresent: boolean | null = null, markerLinePresent: boolean | null = null;
      if (source === 'native') {
        const outputText = field(row.tool, 'outputText');
        const output = field(row.tool, 'output');
        outputPresent = outputText != null || output != null;
        if (typeof outputText === 'string') markerLinePresent = outputText.length <= 1_048_576 ? outputText.split(/\r?\n/).includes(marker) : null;
        else if (output == null) markerLinePresent = false;
        else if (Array.isArray(output) && !types.isProxy(output)) {
          const blocks = array(output, 4096);
          let inspected = 0;
          markerLinePresent = false;
          for (const block of blocks) {
            if (field(block, 'type') !== 'text') continue;
            const text = field(block, 'text');
            if (typeof text !== 'string') continue;
            inspected += text.length;
            if (inspected > 1_048_576) { markerLinePresent = null; break; }
            if (text.split(/\r?\n/).includes(marker)) markerLinePresent = true;
          }
        }
      }
      return { tool, relation, source, modelMatches: modelMatch(row.message), nativeCallIdPresent,
        status, isError: typeof error === 'boolean' ? error : null, input, outputPresent, markerLinePresent };
    });
    return { originalInputIndex: originalInputIndex < 0 ? null : originalInputIndex,
      nextInputIndex: nextInputIndex < 0 ? null : nextInputIndex, total, exhaustive: total <= 8, relationCounts, tuples };
  })() : undefined;
  return {
    source: 'existing_public_v2_runtime_transcript_before_stop' as const,
    ...(commandObservation ? { commandObservation } : {}),
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
