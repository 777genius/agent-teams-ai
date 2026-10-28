import assert from 'node:assert/strict';

/** Diagnostic only: exact original input's native terminal, never send authority. */
export function projectV2TerminalFailure(value: unknown, expected: { sessionId: string; nativeInputId: string }) {
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
    assert(event.aggregateID === expected.sessionId && data.sessionID === expected.sessionId &&
      Number.isSafeInteger(event.seq) && Number(event.seq) > seq && (seq < 0 || event.seq === seq + 1) && !ids.has(event.id));
    seq = Number(event.seq); ids.add(event.id);
  }
  assert(log.watermark === (events.at(-1)?.seq ?? null));
  const deliveries = events.filter(e => e.type === 'session.inbox.delivered' && row(e.data).inboxID === expected.nativeInputId);
  assert(deliveries.length === 1);
  assert(page.data.map(row).filter(m => m.id === expected.nativeInputId && m.type === 'user').length === 1);
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
  const names = ['APIError', 'APICallError', 'ProviderAuthError', 'ContextOverflowError', 'UnknownError',
    'NoOutputGeneratedError', 'InvalidResponseDataError', 'InvalidPromptError', 'ModelNotFoundError', 'RequestBudgetExceededError'];
  const codes = ['insufficient_credits', 'insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key',
    'context_length_exceeded', 'max_tokens_exceeded', 'invalid_request_error', 'model_not_found', 'server_error',
    'request_budget_exceeded', 'max_steps_exceeded', 'output_length_exceeded'];
  const status = [error.statusCode, error.status, nested.statusCode, nested.status].find(v => Number.isInteger(v) && Number(v) >= 100 && Number(v) <= 599);
  const finish = interval.filter(e => e.type === 'session.step.ended').at(-1);
  return { source: 'exact_original_owned_native_event' as const, terminalType: String(terminal.type),
    errorType: names.find(v => v === error.type || v === error.name) ?? null,
    errorCode: codes.find(v => v === error.code || v === nested.code) ?? null,
    httpStatus: typeof status === 'number' ? status : null,
    lastStepFinish: ['stop', 'tool-calls', 'length', 'error', 'content-filter'].find(v => v === (finish && row(finish.data).finish)) ?? null };
}

/** Existing authenticated owner validates run/process/challenge and exact native member. */
export function v2TerminalFailureReaderCode(): string {
  return `import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';
const input=JSON.parse(process.argv.at(-1));
const {discoverOpenCodeV2Run,requestOpenCodeV2Run}=await import(pathToFileURL(path.join(input.sdkRoot,'src/services/opencode/bridge/OpenCodeV2RunControl.ts')).href);
const {resolveClaudeMultimodelPaths}=await import(pathToFileURL(path.join(input.sdkRoot,'src/services/opencode/OpenCodeManagedPaths.ts')).href);
assert.equal(resolveClaudeMultimodelPaths().data,input.dataRoot);
const owner=await discoverOpenCodeV2Run(input.dataRoot,input.teamId,input.runId);assert(owner);
const result=await requestOpenCodeV2Run(owner,{operation:'transcript',memberId:input.memberId,originalSessionId:input.sessionId},8000);
assert.equal(result.kind,'transcript');const {projectV2TerminalFailure:project}=await import(pathToFileURL(input.projectorPath).href);
console.log(JSON.stringify(project(result,{sessionId:input.sessionId,nativeInputId:input.nativeInputId})));`;
}
