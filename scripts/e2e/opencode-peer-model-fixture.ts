import assert from 'node:assert/strict';

import type { Decision, Json } from './group-chat-model-server.ts';

type Peer = 'alice' | 'bob';
type Kind = 'challenge' | 'ack' | 'seed-report';
export interface PeerCandidate {
  from: Peer;
  to: Peer;
  seedMessageId?: string;
}
export interface PeerAction {
  kind: Kind;
  from: Peer;
  to: Peer | 'user';
  nonce: string;
  text: string;
  completedToolResult: true;
  callId: string;
  messageId: string;
}

function record(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  const part = record(value);
  if (!part || part.type === 'tool_result' || part.type === 'tool_use') return '';
  return typeof part.text === 'string' ? part.text : textOf(part.content);
}
function promptText(value: unknown): string {
  return textOf(value).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}
function parse(value: string): Json | undefined {
  try { return record(JSON.parse(value)); } catch { return undefined; }
}

// Undefined means no result yet; null means a result was present but did not
// prove the exact effect. Never advance on a mere tool-result block or error.
function toolResult(messages: Json[], id: string, input: Json): string | null | undefined {
  const results = messages.flatMap((message) => {
    if (message.role === 'tool' && message.tool_call_id === id) return [message];
    return Array.isArray(message.content)
      ? message.content.map(record).filter((part): part is Json =>
          part?.type === 'tool_result' && part.tool_use_id === id)
      : [];
  });
  if (!results.length) return undefined;
  const result = results[0]!;
  if (results.length !== 1 || result.is_error === true || result.isError === true) return null;
  const payload = parse(textOf(result.content));
  const saved = record(payload?.message);
  if (!payload || payload.isError === true || payload.deliveredToInbox !== true ||
      typeof payload.messageId !== 'string' || !payload.messageId.trim() ||
      saved?.messageId !== payload.messageId || saved.from !== input.from ||
      saved.to !== input.to || saved.text !== input.text ||
      (input.source !== undefined && saved.source !== input.source) ||
      (input.relayOfMessageId !== undefined && saved.relayOfMessageId !== input.relayOfMessageId)) return null;
  return payload.messageId;
}

/** Owns only the synthetic model decisions for the two TEST peer directions. */
export function createPeerModelFixture(options: {
  teamName: string;
  candidates: Map<string, PeerCandidate>;
  actions: Map<string, PeerAction>;
  seedReports: Map<string, PeerAction>;
}): (body: Json) => Decision | undefined {
  return (body) => {
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .map(record).filter((message): message is Json => message !== undefined);
    const userIndex = messages.findLastIndex((message) =>
      message.role === 'user' && promptText(message.content).trim() !== '');
    if (userIndex < 0) return undefined;
    const active = promptText(messages[userIndex]!.content);
    const inbound = [...active.matchAll(/<opencode_inbound_app_message>([\s\S]*?)<\/opencode_inbound_app_message>/g)].at(-1);
    if (!inbound) return undefined;
    const header = active.slice(active.lastIndexOf('<opencode_app_message_delivery>', inbound.index), inbound.index);
    const envelope = [...header.matchAll(/\{"teamName":"[^"\n]+","to":"[^"\n]+","from":"[^"\n]+","source":"runtime_delivery","relayOfMessageId":"[^"\n]+"\}/g)];
    const origin = envelope.length === 1 ? parse(envelope[0]![0]) : undefined;
    const command = inbound[1]!.trim();
    const seed = /^PEER_SEED:(alice|bob):(alice|bob):([0-9a-f-]{36})$/.exec(command);
    const peer = /^(CHALLENGE|ACK):([0-9a-f-]{36})$/.exec(command);
    const retry = /<opencode_delivery_retry>[\s\S]*?for inbound app messageId "([^"\n]+)"\./.exec(command);
    const nonce = seed?.[3] ?? peer?.[2] ?? (retry && [...options.candidates]
      .find(([, candidate]) => candidate.seedMessageId === retry[1])?.[0]);
    if (!nonce) return undefined;
    const candidate = options.candidates.get(nonce);
    const reject = (): Decision => ({ id: 'rejected_' + nonce, text: 'Unowned or unconfirmed peer directive' });
    const done = (): Decision => ({ id: 'done_' + nonce, text: '' });
    if (!candidate || candidate.from === candidate.to) return reject();
    const relay = origin?.relayOfMessageId;
    if (origin?.teamName !== options.teamName || typeof relay !== 'string' || !relay.trim()) return reject();
    const human = !!seed || !!retry;
    if (human) {
      if (origin.from !== candidate.from || origin.to !== 'user' ||
          (seed && (seed[1] !== candidate.from || seed[2] !== candidate.to)) ||
          (retry && retry[1] !== relay) ||
          (candidate.seedMessageId !== undefined && candidate.seedMessageId !== relay)) return reject();
      candidate.seedMessageId = relay;
    } else {
      const isAck = peer?.[1] === 'ACK';
      if (origin.from !== (isAck ? candidate.from : candidate.to) ||
          origin.to !== (isAck ? candidate.to : candidate.from)) return reject();
      const challenge = options.actions.get('challenge:' + nonce);
      if (!isAck && challenge && challenge.messageId !== relay) return reject();
      // Silent ACK read: native OpenCode must commit this real turn.
      if (isAck) return { id: 'silent_' + nonce.replaceAll('-', ''), text: '' };
    }
    const tool = (Array.isArray(body.tools) ? body.tools : []).map(record).map((row) =>
      record(row?.function)?.name ?? row?.name).find((name): name is string =>
        typeof name === 'string' && (name === 'message_send' || /(?:^|__|_)message_send$/.test(name)));
    assert(tool, 'Real OpenCode runtime did not expose message_send');
    const continuation = messages.slice(userIndex + 1);
    function send(kind: Kind, from: Peer, to: Peer | 'user', message: string, extra: Json = {}): Decision | undefined {
      const key = kind + ':' + nonce;
      const completed = kind === 'seed-report' ? options.seedReports : options.actions;
      if (completed.has(key)) return undefined;
      const id = 'call_' + nonce!.replaceAll('-', '') + '_' + kind;
      const input = { teamName: options.teamName, from, to, text: message, ...extra };
      const messageId = toolResult(continuation, id, input);
      if (messageId === null) return reject();
      if (messageId === undefined) return { id, name: tool, input };
      completed.set(key, { kind, from, to, nonce: nonce!, text: message, completedToolResult: true, callId: id, messageId });
      return undefined;
    }
    if (!human) return send('ack', candidate.to, candidate.from, 'ACK:' + nonce, {
      source: 'runtime_delivery', relayOfMessageId: relay,
    }) ?? done();
    // Watchdog retries may finish the original human report, but never issue
    // another peer challenge. The original tool result must already be known.
    if (retry && !options.actions.has('challenge:' + nonce)) return reject();
    const challenge = send('challenge', candidate.from, candidate.to, 'CHALLENGE:' + nonce);
    if (challenge) return challenge;
    return send('seed-report', candidate.from, 'user',
      'Sent the requested peer challenge CHALLENGE:' + nonce + ' to ' + candidate.to + '.', {
        summary: 'Peer challenge sent to ' + candidate.to,
        source: 'runtime_delivery', relayOfMessageId: relay,
      }) ?? done();
  };
}
