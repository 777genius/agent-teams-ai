import type { RuntimeActivitySnapshot } from '../runtime/activityContracts.js';
import type { RuntimeSessionRecord } from '../runtime/contracts.js';
import type { ScheduledRunCapture } from './scheduledRunCapture.js';
import type { ScheduledRunSnapshot } from './scheduledRunContracts.js';
import type { RuntimeActivityEvent } from '../runtime/activityContracts.js';

/** Reuses retained Runtime observations and the existing schedule log reader's public JSON shape. */
export function projectScheduledRun(capture: ScheduledRunCapture, record: RuntimeSessionRecord | undefined,
  activity: RuntimeActivitySnapshot, inFlight: boolean): ScheduledRunSnapshot {
  const terminal = record?.inputs.find(input => input.intent.inputId === capture.input.runId),
    released = record?.phase === 'closed' && record.custody === 'released';
  const phase: ScheduledRunSnapshot['phase'] = released
    ? terminal?.phase === 'terminal' ? 'completed' : 'interrupted'
    : inFlight ? 'running' : 'held';
  if (!released) return { runId: capture.input.runId, phase, cleanup: 'unresolved' };
  const children = new Map<string, RuntimeActivityEvent & { agentId: string }>();
  for (const event of activity.latest.subagents) {
    const { fact, childId, phase } = event.data;
    if (phase !== 'fact' || typeof childId !== 'string' || !fact || typeof fact !== 'object' ||
      Array.isArray(fact) || !['text', 'tool', 'tool-result'].includes(String(fact.kind))) continue;
    const key = JSON.stringify([childId, fact.kind, fact.messageRef, fact.block, fact.toolRef]);
    children.set(key, { ...event, data: { ...fact, kind: String(fact.kind) }, agentId: childId });
  }
  const events: (RuntimeActivityEvent & { agentId?: string })[] = [...activity.latest.text,
    ...activity.events.filter(event => event.data.kind === 'tool' || event.data.kind === 'tool-result'),
    ...children.values()];
  events.sort((a, b) => a.sequence - b.sequence);
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const event of events) {
    const value = event.data;
    const block = value.kind === 'text' ? { type: 'text', text: value.text }
      : value.kind === 'tool' ? { type: 'tool_use', id: value.toolRef, name: value.name, input: value.input }
      : { type: 'tool_result', tool_use_id: value.toolRef, content: value.content, is_error: value.isError };
    const line = JSON.stringify({ type: value.kind === 'tool-result' ? 'user' : 'assistant',
      uuid: event.eventId, ...(event.agentId ? { agentId: event.agentId } : {}),
      message: { role: value.kind === 'tool-result' ? 'user' : 'assistant', content: [block] } });
    if (bytes + Buffer.byteLength(line) + 1 > 512 * 1024 - 1024) { truncated = true; break; }
    lines.push(line); bytes += Buffer.byteLength(line) + 1;
  }
  const text = activity.latest.text.flatMap(event => typeof event.data.text === 'string' ? [event.data.text] : []).join('\n');
  const lastTime = activity.events.at(-1)?.observedAt;
  const durationMs = lastTime ? Math.max(0, Date.parse(lastTime) - Date.parse(capture.capturedAt)) : 0;
  const usage = activity.latest.usage.find(event => event.operationRef === terminal?.operationRef)?.data;
  if (terminal?.phase === 'terminal') lines.push(JSON.stringify({ type: 'result',
    subtype: terminal.terminal === 'succeeded' ? 'success' : 'error_during_execution',
    is_error: terminal.terminal !== 'succeeded', duration_ms: durationMs,
    ...(usage?.cumulativeCostUsd === undefined ? {} : { total_cost_usd: usage.cumulativeCostUsd }),
    ...(usage ? { usage: {
      ...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
      ...(usage.outputTokens === undefined ? {} : { output_tokens: usage.outputTokens }),
    } } : {}) }));
  return { runId: capture.input.runId, phase, cleanup: 'confirmed', result: {
    exitCode: terminal?.phase === 'terminal' ? terminal.terminal === 'succeeded' ? 0 : 1 : null,
    stdout: lines.join('\n'),
    stderr: activity.gap || truncated ? 'Some retained runtime log entries are unavailable.' : '',
    summary: (text || (terminal?.phase === 'terminal' ? `Scheduled run ${terminal.terminal}` :
      'Scheduled run stopped without a confirmed model result')).slice(0, 500),
    durationMs,
  } };
}
