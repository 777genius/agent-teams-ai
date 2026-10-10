// Only the model boundary is synthetic. Never handles app/host/MCP control traffic.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';

export type Json = Record<string, unknown>;
export interface ModelReceipt {
  at: string;
  route: string;
  request: Json;
  decision: Decision;
}
interface Decision { text?: string; name?: string; input?: Json; id: string }
export interface Directive {
  kind: 'reply' | 'proactive' | 'private';
  teamName: string;
  actor?: string;
  groupChatId?: string;
  messageId?: string;
  token: string;
}
export const directive = (value: Directive) => `E2E_DIRECTIVE=${JSON.stringify(value)}\n`;
function stableUUID(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function toolNames(body: Json): string[] {
  return (Array.isArray(body.tools) ? body.tools : []).map((value: Json) =>
    String((value.function as Json | undefined)?.name ?? value.name));
}
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (value && typeof value === 'object') {
    const part = value as Json;
    // Tool results are intentionally excluded from directive selection.
    if (part.type === 'tool_result' || part.type === 'tool_use') return '';
    return String(part.text ?? '');
  }
  return '';
}
function userPromptText(value: unknown): string {
  // Tool continuations may carry skill reminders without a new physical turn.
  // Their context must not replace or inject a directive into the current frame.
  return textOf(value).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}
function requestedTool(names: string[], suffix: string) {
  const matches = names.filter(name => name === suffix || name.endsWith(`__${suffix}`) || name.endsWith(`_${suffix}`));
  assert.equal(matches.length, 1, `Expected one real requested ${suffix} tool; got ${matches}`);
  return matches[0]!;
}
export async function startGroupChatModelServer(receiptPath: string) {
  const receipts: ModelReceipt[] = [];
  const stages = new Map<string, { stage: number; last: Decision }>();
  const errors: string[] = [];
  let persist = Promise.resolve();
  function decide(body: Json): Decision {
    const messages = Array.isArray(body.messages) ? body.messages as Json[] : [];
    const latestUser = [...messages].reverse().find(message => message.role === 'user' && userPromptText(message.content).trim());
    const latest = userPromptText(latestUser?.content);
    // Native queries may merge earlier user text with the newly delivered
    // physical prompt. Only the last real group frame owns this model turn.
    const frameStart = latest.lastIndexOf('Process this queued GROUP CHAT message.');
    const active = frameStart < 0 ? latest : latest.slice(frameStart);
    const queued = [...active.matchAll(/<queued_mailbox_message>([\s\S]*?)<\/queued_mailbox_message>/g)].at(-1);
    const directiveText = queued?.[1] ?? active;
    const found = [...directiveText.matchAll(/E2E_DIRECTIVE=(\{[^\n]*\})/g)].at(-1);
    const id = `synthetic_${randomUUID().replaceAll('-', '')}`;
    // The real app's local-provider admission performs this model-only
    // coordination probe before launching the real OpenCode host. Follow its
    // requested tool schema and echoed nonce; this is not group delivery proof.
    if (messages.some(message=>message.role==='system' && textOf(message.content).includes('Agent Teams teammate compatibility test'))) {
      const result=[...messages].reverse().find(message=>message.role==='tool');
      if (result) {
        const args=/send the exact text (\S+) to (\S+) using .*?\. Use teamName=([^,]+), from=([^.\s]+)/.exec(String(result.content));
        assert(args,'Missing actual local probe nonce');
        return {id,name:requestedTool(toolNames(body),'message_send'),input:{teamName:args[3],from:args[4],to:args[2],text:args[1]}};
      }
      const args=/task_briefing with teamName=(\S+) and memberName=([^.\s]+)/.exec(latest);
      assert(args,'Missing actual local probe identities');
      return {id,name:requestedTool(toolNames(body),'task_briefing'),input:{teamName:args[1],memberName:args[2]}};
    }
    const summaryStart = latest.lastIndexOf('Your task is to create a detailed summary of');
    if (summaryStart >= 0 && summaryStart > frameStart
      && summaryStart > latest.lastIndexOf('</queued_mailbox_message>')) return { id, text: '<summary>Owned synthetic group chat E2E. No real project work. Continue only on the next explicit E2E directive. Use fresh group catalog and preserve physical inbound IDs for replies.</summary>' };
    if (!found) return { id, text: /Output only the single word PONG/.test(directiveText) ? 'PONG' :
      /E2E_REPLY:/.test(directiveText) ? '' : 'READY. No action requested.' };
    const d = JSON.parse(found[1]!) as Directive;
    if (d.kind === 'private') return { id, text: `E2E_PRIVATE_REPLY:${d.token}` };
    const names = toolNames(body);
    // Physical identity comes exclusively from the real runtime prompt.
    const templates = [...active.matchAll(/\{"teamName":"[^\n]*?"text":"<reply>"\}/g)];
    let context: Json | undefined;
    if (templates.length) context = JSON.parse(templates.at(-1)![0]) as Json;
    // Actual desktop OpenCode handoff uses an origin envelope without <reply>.
    if (!context) {
      const origins = [...active.matchAll(/\{"teamName":"[^\n]*?"relayOfMessageId":"[^"\n]+"\}/g)];
      if (origins.length) context = JSON.parse(origins.at(-1)![0]) as Json;
    }
    const group = /Group chat ([a-f0-9-]{36}): physical message ([^,\s]+), sender/.exec(active);
    const discovery = [...active.matchAll(/(?:group_chat_list[^\n]*?with |teamName=)(\{"teamName":"[^\n]*?","from":"[^\n]*?"\})/g)];
    const actor = d.actor ?? (context?.from as string | undefined) ??
      (discovery.length ? (JSON.parse(discovery.at(-1)![1]!) as Json).from as string : undefined) ??
      /team lead "([^"]+)"/.exec(active)?.[1];
    assert(actor, 'Cannot identify actual actor from runtime handoff');
    const groupChatId = d.kind === 'proactive' ? d.groupChatId : context?.groupChatId ?? group?.[1];
    const physical = d.kind === 'reply' ? context?.relayOfMessageId ?? group?.[2] : undefined;
    assert(groupChatId, 'Missing originating group in real prompt');
    if (d.kind === 'reply') assert(physical, 'Missing physical inbound in real prompt');
    const key = JSON.stringify([d.token, actor, groupChatId, physical]);
    const previous = stages.get(key);
    if (previous?.last.name) {
      const result = messages.find(message =>
        (message.role === 'tool' && message.tool_call_id === previous.last.id) ||
        (Array.isArray(message.content) && message.content.some((block: Json) => block.type === 'tool_result' && block.tool_use_id === previous.last.id)));
      // A repeated model request without the real MCP result repeats the same
      // model answer. It cannot advance the fixture's intended tool sequence.
      if (!result) return previous.last;
      // A failed real tool result cannot claim the human's update was posted.
      let resultPayload: Json | undefined;
      try { resultPayload = typeof result.content === 'string' ? JSON.parse(result.content) as Json : undefined; } catch { /* Non-JSON tool output has no structured error flag. */ }
      if (d.kind === 'proactive' && (result.is_error === true || resultPayload?.isError === true
        || (Array.isArray(result.content) && result.content.some((block: Json) =>
          block.type === 'tool_result' && block.tool_use_id === previous.last.id && block.is_error === true)))) return { id, text: '' };
    }
    const stage = previous?.stage ?? 0;
    const next = (decision: Decision) => { stages.set(key, { stage: stage + 1, last: decision }); return decision; };
    if (actor === 'worker' && d.kind === 'reply') {
      return { id, text: `E2E_REPLY:${d.token}:${actor}` };
    }
    if (stage === 0) return next({ id, name: requestedTool(names, 'group_chat_list'), input: { teamName: d.teamName, from: actor } });
    if (stage === 1 || (d.kind === 'proactive' && stage === 2)) {
      return next({ id, name: requestedTool(names, 'group_chat_send'), input: {
        teamName: d.teamName, from: actor, groupChatId,
        messageId: d.messageId ?? stableUUID(key),
        text: `E2E_REPLY:${d.token}:${actor}`,
        ...(physical ? { relayOfMessageId: physical } : {}),
      } });
    }
    // Finish only the ordinary human DM that requested this proactive post.
    // Group peer turns remain silent and never receive a private completion.
    if (d.kind === 'proactive' && frameStart < 0 && !context && !group
      && /^Process this queued mailbox message now\.\nSender: "user"\./.test(active)) return { id, text: 'Group update posted.' };
    return { id, text: '' };
  }
  function anthropic(response: ServerResponse, body: Json, decision: Decision) {
    const block = decision.name ? { type: 'tool_use', id: decision.id, name: decision.name, input: decision.input } : { type: 'text', text: decision.text };
    const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
      content: [block], stop_reason: decision.name ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 20 } };
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(message)); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type: string, data: Json) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: decision.name ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: decision.name ? { type: 'input_json_delta', partial_json: JSON.stringify(decision.input) } : { type: 'text_delta', text: decision.text } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
    event('message_stop', {}); response.end();
  }
  function openai(response: ServerResponse, body: Json, decision: Decision) {
    const call = { id: decision.id, type: 'function', function: { name: decision.name, arguments: JSON.stringify(decision.input) } };
    const base = { id: `chatcmpl_${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: body.model };
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0,
        message: { role: 'assistant', content: decision.text ?? null, ...(decision.name ? { tool_calls: [call] } : {}) },
        finish_reason: decision.name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: Json, finish: string | null) => response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', ...(decision.name ? { tool_calls: [{ index: 0, ...call }] } : { content: decision.text }) }, null);
    chunk({}, decision.name ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n');
  }
  const server = createServer(async (request, response) => {
    let failedRequest: Json | undefined;
    try {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'group-e2e', object: 'model' }] })); return;
      }
      if (request.url?.startsWith('/v1/messages/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"input_tokens":20}'); return;
      }
      if (request.method !== 'POST' || !/^\/v1\/(messages(?:\?.*)?|chat\/completions)$/.test(request.url ?? '')) {
        response.writeHead(404); response.end('Model endpoint only'); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length; assert(size < 16 * 1024 * 1024, 'Model request too large'); chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Json;
      failedRequest = JSON.parse(JSON.stringify(body).replaceAll('synthetic-owned-key', '[synthetic-key-redacted]')) as Json;
      const decision = decide(body);
      // No headers, keys or sessions are read. Payload belongs to this synthetic HOME only.
      const redacted = JSON.parse(JSON.stringify(body).replaceAll('synthetic-owned-key', '[synthetic-key-redacted]')) as Json;
      const receipt = { at: new Date().toISOString(), route: request.url!, request: redacted, decision };
      receipts.push(receipt);
      persist = persist.then(() => appendFile(receiptPath, JSON.stringify(receipt) + '\n'));
      await persist;
      if (request.url!.startsWith('/v1/messages')) anthropic(response, body, decision);
      else openai(response, body, decision);
    } catch (error) {
      if (failedRequest) {
        const failure = {at:new Date().toISOString(),route:request.url!,request:failedRequest,
          decision:{id:'fixture-error',text:String(error)}};
        receipts.push(failure);
        persist = persist.then(()=>appendFile(receiptPath,JSON.stringify(failure)+'\n'));
        await persist;
      }
      errors.push(String(error)); response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'api_error', message: String(error) } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address(); assert(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}`, receipts, errors,
    close: async () => { await persist; server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
