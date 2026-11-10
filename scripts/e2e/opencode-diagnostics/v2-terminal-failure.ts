import assert from 'node:assert/strict';

// Native 2.1.4 to-session-error and runner output-limit types, plus legacy
// class names. Both child projection and parent validation use this closed list.
const ERROR_TYPES = [
  'provider.rate-limit', 'provider.auth', 'provider.quota', 'provider.free-limit',
  'provider.content-filter', 'provider.transport', 'provider.internal', 'provider.invalid-output',
  'provider.invalid-request', 'provider.unsupported-operation', 'provider.no-route',
  'provider.unknown', 'provider.timeout', 'permission.rejected', 'tool.execution', 'unknown', 'output-limit',
  'APIError', 'APICallError', 'ProviderAuthError', 'ContextOverflowError', 'UnknownError',
  'NoOutputGeneratedError', 'InvalidResponseDataError', 'InvalidPromptError', 'ModelNotFoundError', 'RequestBudgetExceededError',
] as const;
const ERROR_CODES = ['insufficient_credits', 'insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key',
  'context_length_exceeded', 'max_tokens_exceeded', 'invalid_request_error', 'model_not_found', 'server_error',
  'request_budget_exceeded', 'max_steps_exceeded', 'output_length_exceeded'] as const;

export const projectV2TerminalErrorType = (value: unknown) => ERROR_TYPES.find(type => type === value) ?? null;
export const projectV2TerminalErrorCode = (value: unknown) => ERROR_CODES.find(code => code === value) ?? null;

function ownedCut(value: unknown, sessionId: string) {
  const row = (v: unknown): Record<string, unknown> => {
    assert(v && typeof v === 'object' && !Array.isArray(v));
    return v as Record<string, unknown>;
  };
  const input = row(value), log = row(input.log), page = row(input.messages);
  assert(log.synced === true && Array.isArray(log.events) && log.events.length <= 4096);
  assert(Array.isArray(page.data) && page.data.length <= 1600 && page.previous === null && page.next === null);
  const events = log.events.map(row), ids = new Set(); let seq = -1;
  for (const event of events) {
    const data = row(event.data);
    assert(event.aggregateID === sessionId && data.sessionID === sessionId &&
      Number.isSafeInteger(event.seq) && Number(event.seq) > seq && (seq < 0 || event.seq === seq + 1) && !ids.has(event.id));
    seq = Number(event.seq); ids.add(event.id);
  }
  assert(log.watermark === (events.at(-1)?.seq ?? null));
  const messages = page.data.map(row);
  assert(messages.every(message => typeof message.id === 'string') && new Set(messages.map(message => message.id)).size === messages.length);
  return { row, log, page, messages, events };
}

/** Diagnostic only: exact original input's native terminal, never send authority. */
export function projectV2TerminalFailure(value: unknown, expected: { sessionId: string; nativeInputId: string }) {
  const { row, messages, events } = ownedCut(value, expected.sessionId);
  const deliveries = events.filter(e => e.type === 'session.inbox.delivered' && row(e.data).inboxID === expected.nativeInputId);
  assert(deliveries.length === 1);
  assert(messages.filter(m => m.id === expected.nativeInputId && m.type === 'user').length === 1);
  const start = events.indexOf(deliveries[0]!);
  const terminals = ['session.execution.failed', 'session.execution.succeeded', 'session.execution.interrupted'];
  const end = events.findIndex((e, i) => i > start && terminals.includes(String(e.type)));
  assert(end >= 0);
  let boundary = -1;
  for (let i = 0; i < start; i++) if (terminals.includes(String(events[i]!.type))) boundary = i;
  const interval = events.slice(boundary + 1, end + 1);
  assert(interval.filter(e => e.type === 'session.inbox.delivered').length === 1);
  assert(interval.filter(e => e.type === 'session.execution.started').length === 1);
  assert(!interval.some(e => e.type === 'session.step.started' && Number(e.seq) < Number(deliveries[0]!.seq)));
  const terminal = events[end]!, data = row(terminal.data);
  const error = data.error && typeof data.error === 'object' ? row(data.error) : {};
  const nested = error.data && typeof error.data === 'object' ? row(error.data) : {};
  const status = [error.statusCode, error.status, nested.statusCode, nested.status].find(v => Number.isInteger(v) && Number(v) >= 100 && Number(v) <= 599);
  const finish = interval.filter(e => e.type === 'session.step.ended').at(-1);
  return { source: 'exact_original_owned_native_event' as const, terminalType: String(terminal.type),
    errorType: projectV2TerminalErrorType(error.type) ?? projectV2TerminalErrorType(error.name),
    errorCode: projectV2TerminalErrorCode(error.code) ?? projectV2TerminalErrorCode(nested.code),
    httpStatus: typeof status === 'number' ? status : null,
    lastStepFinish: ['stop', 'tool-calls', 'length', 'error', 'content-filter'].find(v => v === (finish && row(finish.data).finish)) ?? null };
}

const TERMINALS = ['session.execution.failed', 'session.execution.succeeded', 'session.execution.interrupted'] as const;
const FINISHES = ['stop', 'tool-calls', 'length', 'error', 'content-filter'] as const;
const PROJECTION_REASONS = [
  'incomplete_native_cut', 'unqualified_projection_pin', 'unbounded_or_duplicate_cut',
  'foreign_or_incomplete_log', 'incomplete_log_watermark', 'original_inbox_cancelled',
  'ambiguous_input_disposition', 'input_not_delivered', 'missing_original_delivery',
  'original_input_projection_mismatch', 'ambiguous_delivered_input_lineage', 'execution_interval_lineage_missing',
  'ambiguous_assistant_lineage', 'assistant_snapshot_lineage_mismatch', 'missing_step_terminal',
  'ambiguous_step_terminal', 'incomplete_assistant_snapshot', 'step_terminal_snapshot_mismatch',
  'invalid_assistant_content', 'text_snapshot_mismatch', 'invalid_tool_snapshot', 'tool_call_lineage_mismatch',
  'unsettled_tool_at_execution_terminal', 'tool_failure_snapshot_mismatch', 'tool_success_snapshot_mismatch',
  'invalid_tool_input', 'tool_event_missing_snapshot', 'foreign_assistant_event', 'no_execution_terminal',
  'missing_execution_terminal', 'no_assistant_terminal_lineage', 'terminal_snapshot_mismatch', ...TERMINALS,
] as const;
const unavailable = () => ({ observation: 'unavailable' as const });
type TurnProjector = (input: {
  pin: string; sessionID: string; nativeInputID: string; beforeCursor: number; originalText: string;
  messages: unknown; log: unknown;
}) => { state: unknown; reason: unknown };

/** One authenticated cut; candidate projection never claims the occupied slot. */
export function projectV2OwnedSessionDiagnostic(value: unknown,
  expected: { sessionId: string; nativeInputId: string | null }, pin: string, projectTurn: TurnProjector) {
  const { row, log, page, messages, events } = ownedCut(value, expected.sessionId);
  const requestedInput = expected.nativeInputId === null ? 'unknown' as const :
    messages.some(message => message.id === expected.nativeInputId && message.type === 'user') ? 'present' as const : 'absent' as const;
  let terminalEvent: unknown = unavailable(), candidateProjection: unknown = unavailable();
  if (requestedInput === 'present') {
    try { terminalEvent = projectV2TerminalFailure(value, { sessionId: expected.sessionId, nativeInputId: expected.nativeInputId! }); }
    catch { /* A partial or ambiguous original never gains attribution. */ }
  }
  const end = events.findLastIndex(event => TERMINALS.some(type => type === event.type));
  if (end >= 0) {
    let boundary = -1;
    for (let i = 0; i < end; i++) if (TERMINALS.some(type => type === events[i]!.type)) boundary = i;
    const interval = events.slice(boundary + 1, end + 1);
    const deliveries = interval.filter(event => event.type === 'session.inbox.delivered');
    // Reuse the exact-input lineage checks before exposing a fallback terminal fact.
    if (deliveries.length === 1) {
      const id = row(deliveries[0]!.data).inboxID;
      const user = messages.find(message => message.id === id && message.type === 'user');
      if (typeof id === 'string' && user) {
        try {
          const terminal = projectV2TerminalFailure(value, { sessionId: expected.sessionId, nativeInputId: id });
          if (requestedInput !== 'present') terminalEvent = { ...terminal,
            source: 'owned_session_last_terminal', attribution: 'no_requested_input_attribution' };
        } catch { /* Ambiguous terminal attribution remains unavailable. */ }
      }
    }
  }
  // Candidate selection is independent of terminal attribution: a missing
  // execution start/terminal is precisely a useful pure-projector observation.
  const materializedDeliveries = events.filter(event => event.type === 'session.inbox.delivered' &&
    messages.some(message => message.type === 'user' && message.id === row(event.data).inboxID));
  const delivered = materializedDeliveries.at(-1);
  if (delivered) {
    try {
      const id = row(delivered.data).inboxID;
      assert(typeof id === 'string' && materializedDeliveries.filter(event => row(event.data).inboxID === id).length === 1);
      const user = messages.find(message => message.id === id && message.type === 'user')!;
      const enqueued = events.filter(event => event.type === 'session.inbox.enqueued' && row(event.data).inboxID === id);
      const data = row(user.data);
      assert(enqueued.length === 1 && Number(enqueued[0]!.seq) < Number(delivered.seq) &&
        data.id === id && data.type === 'user' && typeof data.text === 'string' && data.text.length <= 256 * 1024);
      const projected = projectTurn({ pin, sessionID: expected.sessionId, nativeInputID: id,
        beforeCursor: Number(enqueued[0]!.seq) - 1, originalText: data.text, messages: page, log });
      const terminal = events.find(event => Number(event.seq) > Number(delivered.seq) && TERMINALS.some(type => type === event.type));
      candidateProjection = { source: 'last_materialized_user_not_actual_occupied_slot',
        attribution: 'no_requested_input_attribution', boundary: 'native_enqueue_seq_minus_one',
        state: projected.state, reason: projected.reason, enqueuePresent: true, deliveryPresent: true,
        terminalPresent: !!terminal, idlePresent: !!terminal && messages.some(message => message.id === String(terminal.id).replace(/^evt_/, 'msg_') && message.type === 'idle') };
    } catch { /* Missing or duplicate original boundary remains unavailable. */ }
  }
  return reprojectV2OwnedSessionDiagnostic({ requestedInput, terminalEvent, candidateProjection });
}

/** Parent and child share the same closed output schema; arbitrary fields are discarded. */
export function reprojectV2OwnedSessionDiagnostic(value: unknown) {
  assert(value && typeof value === 'object');
  const fact = value as Record<string, unknown>;
  const requestedInput = ['present', 'absent', 'unknown'].find(item => item === fact.requestedInput);
  assert(requestedInput);
  const terminal = fact.terminalEvent as Record<string, unknown> | undefined;
  const projection = fact.candidateProjection as Record<string, unknown> | undefined;
  let terminalEvent: ReturnType<typeof projectV2TerminalFailure> | {
    source: 'owned_session_last_terminal'; attribution: 'no_requested_input_attribution'; terminalType: string;
    errorType: ReturnType<typeof projectV2TerminalErrorType>; errorCode: ReturnType<typeof projectV2TerminalErrorCode>;
    httpStatus: number | null; lastStepFinish: string | null;
  } | ReturnType<typeof unavailable> = unavailable();
  if (terminal && TERMINALS.some(type => type === terminal.terminalType) &&
      (terminal.source === 'exact_original_owned_native_event' && requestedInput === 'present' ||
       terminal.source === 'owned_session_last_terminal' && requestedInput !== 'present' && terminal.attribution === 'no_requested_input_attribution')) {
    const fields = { terminalType: String(terminal.terminalType), errorType: projectV2TerminalErrorType(terminal.errorType),
      errorCode: projectV2TerminalErrorCode(terminal.errorCode),
      httpStatus: Number.isInteger(terminal.httpStatus) && Number(terminal.httpStatus) >= 100 && Number(terminal.httpStatus) <= 599 ? Number(terminal.httpStatus) : null,
      lastStepFinish: FINISHES.find(item => item === terminal.lastStepFinish) ?? null };
    terminalEvent = terminal.source === 'owned_session_last_terminal' ? { ...fields, source: 'owned_session_last_terminal', attribution: 'no_requested_input_attribution' } :
      { ...fields, source: 'exact_original_owned_native_event' };
  }
  const state = ['unknown', 'pending', 'succeeded', 'failed', 'cancelled'].find(item => item === projection?.state);
  const reason = PROJECTION_REASONS.find(item => item === projection?.reason);
  const candidateProjection = projection?.source === 'last_materialized_user_not_actual_occupied_slot' &&
    projection.attribution === 'no_requested_input_attribution' && projection.boundary === 'native_enqueue_seq_minus_one' && state && reason &&
    ['enqueuePresent', 'deliveryPresent', 'terminalPresent', 'idlePresent'].every(key => typeof projection[key] === 'boolean') ? {
      source: 'last_materialized_user_not_actual_occupied_slot' as const, attribution: 'no_requested_input_attribution' as const,
      boundary: 'native_enqueue_seq_minus_one' as const, state, reason, enqueuePresent: projection.enqueuePresent as boolean,
      deliveryPresent: projection.deliveryPresent as boolean, terminalPresent: projection.terminalPresent as boolean, idlePresent: projection.idlePresent as boolean,
    } : unavailable();
  return { requestedInput, terminalEvent, candidateProjection };
}

/** Existing authenticated owner validates run/process/challenge and exact native member. */
export function v2TerminalFailureReaderCode(): string {
  return `import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';
const input=JSON.parse(process.argv.at(-1));
const {discoverOpenCodeV2Run,requestOpenCodeV2Run}=await import(pathToFileURL(path.join(input.sdkRoot,'src/services/opencode/bridge/OpenCodeV2RunControl.ts')).href);
const {resolveClaudeMultimodelPaths}=await import(pathToFileURL(path.join(input.sdkRoot,'src/services/opencode/OpenCodeManagedPaths.ts')).href);
const {resolveOpenCodeV2EngineVersion}=await import(pathToFileURL(path.join(input.sdkRoot,'src/services/opencode/compatibility/OpenCodeV2Registry.ts')).href);
const {projectOpenCodeV2Turn}=await import(pathToFileURL(path.join(input.sdkRoot,'src/services/opencode/execution/OpenCodeV2TurnProjection.ts')).href);
assert.equal(resolveClaudeMultimodelPaths().data,input.dataRoot);
assert.equal(process.platform,'win32');const pin=resolveOpenCodeV2EngineVersion(input.nativeVersion,'win32-'+process.arch);assert(pin);
const owner=await discoverOpenCodeV2Run(input.dataRoot,input.teamId,input.runId);assert(owner);
const result=await requestOpenCodeV2Run(owner,{operation:'transcript',memberId:input.memberId,originalSessionId:input.sessionId},8000);
assert.equal(result.kind,'transcript');const {projectV2OwnedSessionDiagnostic:project}=await import(pathToFileURL(input.projectorPath).href);
console.log(JSON.stringify(project(result,{sessionId:input.sessionId,nativeInputId:input.nativeInputId},pin,projectOpenCodeV2Turn)));`;
}
