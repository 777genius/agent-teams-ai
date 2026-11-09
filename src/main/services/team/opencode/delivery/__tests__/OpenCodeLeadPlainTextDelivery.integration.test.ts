import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamInboxReader } from '../../../TeamInboxReader';
import { TeamInboxWriter } from '../../../TeamInboxWriter';
import { buildPlainTextVisibleReplyMessageId, buildPlainTextVisibleReplySummary } from '../OpenCodeGroupVisibleReply';
import {
  createOpenCodePromptDeliveryLedgerStore,
  isOpenCodePromptDeliveryWatchdogTerminal,
} from '../OpenCodePromptDeliveryLedger';
import {
  getOpenCodeDeliveryPendingReason,
  isOpenCodeDeliveryResponseReadCommitAllowed,
  isOpenCodeDeliveryRetryablePendingResponse,
} from '../OpenCodePromptDeliveryReadCommitPolicy';
import { openCodeTaskRefsIncludeAll } from '../OpenCodeRuntimeDeliveryProofMatching';
import { readOpenCodeExactAssistantText } from '../OpenCodeVisibleReplyProofComposition';
import { OpenCodeVisibleReplyProofService } from '../OpenCodeVisibleReplyProofService';

import type { OpenCodeRuntimeTranscriptResponse } from '../../../../runtime/ClaudeMultimodelBridgeService';
import type { OpenCodePromptDeliveryLedgerRecord } from '../OpenCodePromptDeliveryLedger';
import type { OpenCodeVisibleReplyProof } from '../OpenCodePromptDeliveryWatchdog';
import type { OpenCodeVisibleReplyProofServiceDependencies } from '../OpenCodeVisibleReplyProofService';
import type * as PathDecoder from '@main/utils/pathDecoder';

const ISO = '2026-11-09T10:00:00.000Z';
const root = vi.hoisted(() => ({ teamsBase: '' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof PathDecoder>()),
  getTeamsBasePath: () => root.teamsBase,
}));

function transcriptMessage(id: string, text: string) {
  return {
    uuid: id, parentUuid: null, type: 'assistant' as const, timestamp: ISO,
    role: 'assistant', content: [{ type: 'text' as const, text }],
    isMeta: false, sessionId: 'ses-current', toolCalls: [], toolResults: [],
  };
}

describe('OpenCode lead plain-text reply persisted E2E', () => {
  let tempRoot: string;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-lead-plain-'));
    root.teamsBase = tempRoot;
  });
  afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  async function fixture(input: {
    recipient?: string;
    lead?: string | null;
    peers?: string[];
    text?: string | null;
    observedToolCallNames?: string[];
    confirmedFailedSend?: boolean;
  } = {}) {
    const ledger = createOpenCodePromptDeliveryLedgerStore({
      filePath: path.join(tempRoot, 'ledger.json'),
    });
    const pending = await ledger.ensurePending({
      teamName: 'team', memberName: 'worker', laneId: 'primary',
      runId: 'run-1', inboxMessageId: 'msg-lead', inboxTimestamp: ISO,
      source: 'watcher', replyRecipient: input.recipient ?? 'team-lead',
      actionMode: 'ask', taskRefs: [], payloadHash: 'stable-hash', now: ISO,
    });
    const observed = await ledger.applyDeliveryResult({
      id: pending.id, accepted: true, sessionId: 'ses-current',
      runtimePromptMessageId: 'msg-prompt',
      responseObservation: {
        state: 'responded_plain_text', deliveredUserMessageId: 'msg-prompt',
        assistantMessageId: 'msg-assistant', toolCallNames: input.observedToolCallNames ?? [],
        visibleMessageToolCallId: null, visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: 'Only a short clipped preview.',
        reason: 'assistant_replied_with_plain_text',
      },
      now: ISO,
    });
    const reader = new TeamInboxReader();
    const writer = new TeamInboxWriter();
    const readExactAssistantText = vi.fn(async (request: { requireFailedMessageSendProof?: boolean }) =>
      request.requireFailedMessageSendProof && !input.confirmedFailedSend
        ? null : input.text === undefined ? 'Full response.' : input.text);
    const deps = {
      inboxReader: reader,
      inboxWriter: writer,
      getConfiguredLeadName: vi.fn(async () => input.lead === undefined ? 'captain' : input.lead),
      isConfiguredPeerRecipient: vi.fn(async (_team, recipient) =>
        input.peers?.some(name => name.toLowerCase() === recipient.trim().toLowerCase()) ?? false),
      readExactAssistantText,
      emitRuntimeDeliveryReplyAdvisoryRefresh: vi.fn(),
      warn: vi.fn(),
      getErrorMessage: (e: unknown) => String(e),
      nowIso: () => ISO,
    } satisfies OpenCodeVisibleReplyProofServiceDependencies;
    const service = new OpenCodeVisibleReplyProofService(deps);
    const materialize = (record: OpenCodePromptDeliveryLedgerRecord = observed) =>
      service.materializePlainTextReplyIfNeeded({
        ledger, ledgerRecord: record, teamName: 'team', memberName: 'worker',
      });
    const readAllowed = async (record: OpenCodePromptDeliveryLedgerRecord, proof: OpenCodeVisibleReplyProof | null) =>
      isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: 'team', memberName: 'worker', configuredLeadName: input.lead === undefined ? 'captain' : input.lead,
        knownPeerRecipient: input.peers?.some(name => name.toLowerCase() === observed.replyRecipient.trim().toLowerCase()) ?? false,
        ledgerRecord: record, responseState: record.responseState,
        actionMode: record.actionMode ?? undefined, taskRefs: record.taskRefs,
        visibleReply: proof, taskRefsIncludeAll: openCodeTaskRefsIncludeAll,
        hasAcceptedMemberWorkSyncReport: async () => false,
      });
    const messages = async (name: string) => reader.getMessagesFor('team', name);
    return { ledger, observed, pending, service, deps, materialize, readAllowed, messages, readExactAssistantText };
  }

  it.each(['team-lead', 'teamlead', 'team-leader', 'team_lead', 'captain', 'orchestrator'])('persists the exact long reply in the configured lead inbox (%s)', async (recipient) => {
    const text = 'Result:\n' + 'x'.repeat(20_000) + '\nLast line.';
    const f = await fixture({ recipient, text });
    expect(await f.readAllowed(f.observed, null)).toBe(false);
    const resolved = await f.materialize();
    expect(resolved.visibleReply?.message.text).toBe(text);
    expect((await f.messages('captain')).map(m => m.text)).toEqual([text]);
    expect(await f.messages('user')).toEqual([]);
    expect(f.readExactAssistantText).toHaveBeenCalledWith({
      teamName: 'team', memberName: 'worker', laneId: 'primary',
      runId: 'run-1', sessionId: 'ses-current', assistantMessageId: 'msg-assistant',
    });
    expect(await f.readAllowed(resolved.ledgerRecord, resolved.visibleReply)).toBe(true);
    const committed = await f.ledger.markInboxReadCommitted({
      id: resolved.ledgerRecord.id, committedAt: ISO,
    });
    expect(isOpenCodePromptDeliveryWatchdogTerminal(committed)).toBe(true);
  });

  it('recovers an already written lead reply without duplicating it after a ledger crash', async () => {
    const f = await fixture();
    const first = await f.materialize();
    expect(first.visibleReply).not.toBeNull();
    f.readExactAssistantText.mockClear();
    const again = await f.materialize(f.observed);
    expect(again.visibleReply?.message.messageId).toBe(first.visibleReply?.message.messageId);
    expect((await f.messages('captain'))).toHaveLength(1);
    expect(f.readExactAssistantText).not.toHaveBeenCalled();
  });

  it('does not commit a lead receipt when writer deduplicates a non-exact reply', async () => {
    const f = await fixture({ text: 'Full response.' });
    const messageId = buildPlainTextVisibleReplyMessageId(f.observed);
    await f.deps.inboxWriter.sendMessage('team', {
      member: 'captain', from: 'worker', to: 'captain',
      text: '  Full response.  ', messageId, timestamp: ISO,
      summary: buildPlainTextVisibleReplySummary('Full response.'),
      relayOfMessageId: ' msg-lead ', source: 'runtime_delivery',
    });
    const result = await f.materialize();
    expect(result.visibleReply).toBeNull();
    expect(result.ledgerRecord.visibleReplyMessageId).toBeNull();
    expect(await f.readAllowed(result.ledgerRecord, null)).toBe(false);
    expect((await f.messages('captain')).map(message => message.text)).toEqual(['  Full response.  ']);
  });

  it('does not accept a user inbox receipt for a lead-directed reply', async () => {
    const f = await fixture();
    const id = buildPlainTextVisibleReplyMessageId(f.observed);
    await f.deps.inboxWriter.sendMessage('team', {
      member: 'user', from: 'worker', to: 'user', messageId: id,
      text: 'Wrong destination', relayOfMessageId: 'msg-lead', source: 'runtime_delivery',
    });
    const resolved = await f.materialize();
    expect(resolved.visibleReply?.inboxName).toBe('captain');
    expect((await f.messages('captain'))).toHaveLength(1);
    expect((await f.messages('user'))).toHaveLength(1);
    expect(await f.readAllowed(resolved.ledgerRecord, resolved.visibleReply)).toBe(true);
  });

  it('repairs a recovered user-inbox receipt before closing a lead reply', async () => {
    const f = await fixture({ text: 'Exact answer for the lead.' });
    const messageId = buildPlainTextVisibleReplyMessageId(f.observed);
    await f.deps.inboxWriter.sendMessage('team', {
      member: 'user', from: 'worker', to: 'user', messageId,
      text: 'A misplaced older message', relayOfMessageId: 'msg-lead', source: 'runtime_delivery',
    });
    const misleadingRecord = await f.ledger.applyDestinationProof({
      id: f.observed.id, visibleReplyInbox: 'user', visibleReplyMessageId: messageId,
      visibleReplyCorrelation: 'relayOfMessageId', semanticallySufficient: true, observedAt: ISO,
    });
    const mistaken = {
      inboxName: 'user',
      message: {
        from: 'worker', to: 'user', text: 'A misplaced older message', timestamp: ISO,
        read: false, messageId, relayOfMessageId: 'msg-lead', source: 'runtime_delivery' as const,
      },
    };
    expect(await f.readAllowed(misleadingRecord, mistaken)).toBe(false);
    const corrected = await f.service.materializePlainTextReplyIfNeeded({
      ledger: f.ledger, ledgerRecord: misleadingRecord, teamName: 'team',
      memberName: 'worker', visibleReply: mistaken,
    });
    expect(corrected.visibleReply?.inboxName).toBe('captain');
    expect((await f.messages('captain')).map(msg => msg.text)).toEqual(['Exact answer for the lead.']);
    expect(await f.readAllowed(corrected.ledgerRecord, corrected.visibleReply)).toBe(true);
  });

  it('ignores the legacy user fallback before it can corrupt a plain-text lead ledger', async () => {
    const f = await fixture({ text: 'Correct lead-only reply.' });
    const messageId = buildPlainTextVisibleReplyMessageId(f.observed);
    await f.deps.inboxWriter.sendMessage('team', {
      member: 'user', from: 'worker', to: 'user', messageId,
      text: 'Wrong user receipt', relayOfMessageId: 'msg-lead', source: 'runtime_delivery',
    });
    const legacy = {
      ...f.observed,
      visibleReplyCorrelation: 'relayOfMessageId' as const,
      visibleReplyMessageId: messageId,
    };
    const recovered = await f.service.applyDestinationProof({
      ledger: f.ledger, ledgerRecord: legacy, teamName: 'team',
      replyRecipient: 'team-lead', memberName: 'worker',
    });
    expect(recovered.visibleReply).toBeNull();
    expect(recovered.ledgerRecord.visibleReplyInbox).toBeNull();
    const corrected = await f.service.materializePlainTextReplyIfNeeded({
      ledger: f.ledger, ledgerRecord: recovered.ledgerRecord,
      teamName: 'team', memberName: 'worker',
    });
    expect(corrected.visibleReply?.inboxName).toBe('captain');
    expect((await f.messages('captain')).map(msg => msg.text)).toEqual(['Correct lead-only reply.']);
    expect(await f.readAllowed(corrected.ledgerRecord, corrected.visibleReply)).toBe(true);
  });

  it('preserves an already correlated tool delivery to the right lead inbox', async () => {
    const f = await fixture();
    const first = await f.materialize();
    expect(first.visibleReply).not.toBeNull();
    f.readExactAssistantText.mockClear();
    const repeated = await f.service.materializePlainTextReplyIfNeeded({
      ledger: f.ledger, ledgerRecord: first.ledgerRecord,
      teamName: 'team', memberName: 'worker', visibleReply: first.visibleReply,
    });
    expect(repeated.visibleReply?.message.messageId).toBe(first.visibleReply?.message.messageId);
    expect(f.readExactAssistantText).not.toHaveBeenCalled();
    expect(await f.messages('captain')).toHaveLength(1);
  });

  it.each([null, 'Already handled: msg-lead', 'ok'])(
    'keeps delivery retryable instead of silently marking a non-answer read (%s)',
    async (text) => {
      const f = await fixture({ text });
      const result = await f.materialize();
      expect(result.visibleReply).toBeNull();
      expect(await f.readAllowed(result.ledgerRecord, null)).toBe(false);
      expect(isOpenCodeDeliveryRetryablePendingResponse({
        ledgerRecord: result.ledgerRecord, readAllowed: false,
      })).toBe(true);
      expect(await f.messages('captain')).toEqual([]);
    }
  );

  it('keeps custom-lead delivery in proof-observation mode at the attempt limit', async () => {
    const f = await fixture({ recipient: 'captain', text: null });
    const capped = { ...f.observed, attempts: f.observed.maxAttempts };
    expect(await f.readAllowed(capped, null)).toBe(false);
    expect(getOpenCodeDeliveryPendingReason({
      ledgerRecord: capped, responseState: 'responded_plain_text',
      actionMode: capped.actionMode, taskRefs: capped.taskRefs,
      visibleReply: null, taskRefsIncludeAll: openCodeTaskRefsIncludeAll,
    })).toBe('plain_text_visible_reply_not_materialized_yet');
  });

  it('does not mark a custom lead reply read when the lead roster lookup is unavailable', async () => {
    const f = await fixture({ recipient: 'captain', lead: null });
    expect(await f.readAllowed(f.observed, null)).toBe(false);
    const attempted = await f.materialize();
    expect(attempted.visibleReply).toBeNull();
    expect(await f.readAllowed(attempted.ledgerRecord, null)).toBe(false);
    expect((await f.messages('user'))).toEqual([]);
  });

  it('does not misroute a real peer named team_lead to the configured captain', async () => {
    const f = await fixture({ recipient: 'team_lead', peers: ['team_lead'] });
    expect(await f.readAllowed(f.observed, null)).toBe(true);
    const result = await f.materialize();
    expect(result.visibleReply).toBeNull();
    expect(result.ledgerRecord.visibleReplyMessageId).toBeNull();
    expect(await f.messages('captain')).toEqual([]);
    expect(await f.messages('team_lead')).toEqual([]);
  });

  it('keeps optional peer reports silent', async () => {
    const peer = await fixture({ recipient: 'another-member' });
    const response = await peer.materialize();
    expect(response.visibleReply).toBeNull();
    expect(await peer.readAllowed(response.ledgerRecord, null)).toBe(true);
  });

  it('does not double-send an observed message_send tool reply', async () => {
    const withTool = await fixture({ observedToolCallNames: ['agent-teams_message_send'] });
    const result = await withTool.materialize();
    expect(result.visibleReply).toBeNull();
    expect(await withTool.readAllowed(result.ledgerRecord, null)).toBe(false);
  });

  it('persists the full lead reply only after a correlated message_send failure', async () => {
    const f = await fixture({
      observedToolCallNames: ['agent-teams_message_send'], confirmedFailedSend: true,
    });
    const result = await f.materialize();
    expect(f.readExactAssistantText).toHaveBeenCalledWith(expect.objectContaining({
      requireFailedMessageSendProof: true,
      runtimePromptMessageId: 'msg-prompt',
      assistantMessageId: 'msg-assistant',
    }));
    expect(result.visibleReply?.message.text).toBe('Full response.');
    expect((await f.messages('captain'))).toHaveLength(1);
    expect(await f.readAllowed(result.ledgerRecord, result.visibleReply)).toBe(true);
  });

  it('preserves cancellation and never writes a reply for a stopped team', async () => {
    const f = await fixture();
    await f.ledger.cancelNonTerminalRecords({
      ownedRunIds: ['run-1'], now: ISO, reason: 'force_stop_requested:test',
    });
    const result = await f.materialize();
    expect(result.visibleReply).toBeNull();
    expect(await f.messages('captain')).toEqual([]);
  });

  it('reads a real captured OpenCode projection by canonical message identity', () => {
    const fixturePath = path.join(process.cwd(), 'test/fixtures/team/opencode/relay-works-10-jack-projection-transcript.json');
    const captured = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as OpenCodeRuntimeTranscriptResponse;
    const messages = captured.transcript?.logProjection?.messages ?? [];
    const final = messages.filter(message =>
      message.type === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some(block => block.type === 'text')
    ).at(-1);
    expect(final).toBeDefined();
    if (!final) throw new Error('Missing captured assistant');
    const full = Array.isArray(final.content)
      ? final.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      : '';
    expect(readOpenCodeExactAssistantText(captured.transcript, final.sessionId, final.uuid)).toBe(full);
    const toolCall = messages.find(message => message.type === 'assistant' &&
      message.toolCalls.some(call => call.name.includes('message_send')));
    expect(toolCall).toBeDefined();
    if (toolCall) {
      expect(readOpenCodeExactAssistantText(captured.transcript, toolCall.sessionId, toolCall.uuid)).toBeNull();
    }
  });

  it('requires matching failed tool results from this prompt before reading a fallback', () => {
    const prompt = { ...transcriptMessage('prompt-id', 'prompt'), type: 'user' as const, role: 'user' };
    const send = {
      ...transcriptMessage('send-id', ''),
      toolCalls: [{ id: 'call-id', name: 'agent-teams_message_send', input: {}, isTask: false }],
    };
    const result = {
      ...transcriptMessage('send-id::tool_results', ''),
      type: 'user' as const, role: 'user', isMeta: true,
      sourceToolAssistantUUID: 'send-id',
      toolResults: [{ toolUseId: 'call-id', content: 'tool not connected', isError: true }],
    };
    const answer = transcriptMessage('answer-id', 'Complete fallback after failed tool.');
    const projection = (messages: unknown[]) => ({
      sessionId: 'ses-current', logProjection: { messages },
    }) as OpenCodeRuntimeTranscriptResponse['transcript'];
    const options = { requireFailedMessageSendProof: true, runtimePromptMessageId: 'prompt-id' };
    const transcript = projection([prompt, send, result, answer]);
    expect(readOpenCodeExactAssistantText(transcript, 'ses-current', 'answer-id', options))
      .toBe('Complete fallback after failed tool.');
    expect(readOpenCodeExactAssistantText(transcript, 'ses-current', 'answer-id', {
      ...options, runtimePromptMessageId: 'other-prompt',
    })).toBeNull();
    expect(readOpenCodeExactAssistantText(projection([prompt, send, answer]),
      'ses-current', 'answer-id', options)).toBeNull();
    expect(readOpenCodeExactAssistantText(projection([
      prompt, send, result,
      { ...prompt, uuid: 'later-user-prompt' }, answer,
    ]), 'ses-current', 'answer-id', options)).toBeNull();
    expect(readOpenCodeExactAssistantText(projection([prompt, send, {
      ...result, toolResults: [{ ...result.toolResults[0], isError: false }],
    }, answer]), 'ses-current', 'answer-id', options)).toBeNull();
    expect(readOpenCodeExactAssistantText(projection([
      prompt, send, result, answer,
      { ...send, uuid: 'later-send', toolCalls: [{
        ...send.toolCalls[0], id: 'later-call-id',
      }] },
      {
        ...result, uuid: 'later-send::tool_results', sourceToolAssistantUUID: 'later-send',
        toolResults: [{ toolUseId: 'later-call-id', content: 'delivered', isError: false }],
      },
    ]), 'ses-current', 'answer-id', options)).toBeNull();
    expect(readOpenCodeExactAssistantText(projection([prompt, send, {
      ...result, sourceToolAssistantUUID: 'different-assistant',
    }, answer]), 'ses-current', 'answer-id', options)).toBeNull();
    const sameTurnAnswer = {
      ...send, content: [{ type: 'text' as const, text: 'Answer next to failed send.' }],
    };
    expect(readOpenCodeExactAssistantText(projection([prompt, sameTurnAnswer, result]),
      'ses-current', 'send-id', options)).toBe('Answer next to failed send.');
    expect(readOpenCodeExactAssistantText(projection([prompt, sameTurnAnswer, result]),
      'ses-current', 'send-id')).toBeNull();
  });

  it('does not confuse a stale ledger message_send with a send in the current turn', () => {
    const oldPrompt = { ...transcriptMessage('old-prompt', ''), type: 'user' as const, role: 'user' };
    const oldSend = {
      ...transcriptMessage('old-send', ''),
      toolCalls: [{ id: 'old-call', name: 'agent-teams_message_send', input: {}, isTask: false }],
    };
    const prompt = { ...oldPrompt, uuid: 'current-prompt' };
    const answer = transcriptMessage('current-answer', 'Actual text-only result.');
    const transcript = {
      sessionId: 'ses-current',
      logProjection: { messages: [oldPrompt, oldSend, prompt, answer] },
    } as unknown as OpenCodeRuntimeTranscriptResponse['transcript'];
    expect(readOpenCodeExactAssistantText(transcript, 'ses-current', 'current-answer', {
      requireFailedMessageSendProof: true, runtimePromptMessageId: 'current-prompt',
    })).toBe('Actual text-only result.');
    expect(readOpenCodeExactAssistantText(transcript, 'ses-current', 'current-answer', {
      requireFailedMessageSendProof: true, runtimePromptMessageId: 'old-prompt',
    })).toBeNull();
  });

  it('preserves real newline separators between distinct assistant text blocks', () => {
    const fullAssistant = {
      ...transcriptMessage('msg-multiblock', 'unused'),
      content: [
        { type: 'text' as const, text: 'First paragraph.' },
        { type: 'text' as const, text: 'Second paragraph.' },
      ],
    };
    const transcript = {
      sessionId: 'ses-current',
      logProjection: { messages: [fullAssistant] },
    } as unknown as OpenCodeRuntimeTranscriptResponse['transcript'];
    expect(readOpenCodeExactAssistantText(transcript, 'ses-current', 'msg-multiblock'))
      .toBe('First paragraph.\nSecond paragraph.');
  });

  it('matches the exact canonical assistant ID/session and never falls back to latest text', () => {
    const messages = [
      transcriptMessage('msg-older', 'Old reply'),
      transcriptMessage('msg-target', 'Exact complete reply'),
      transcriptMessage('msg-later', 'Wrong newer reply'),
    ];
    const transcript = {
      sessionId: 'ses-current',
      latestAssistantText: 'Wrong newer reply',
      logProjection: { messages },
    } as unknown as OpenCodeRuntimeTranscriptResponse['transcript'];
    expect(readOpenCodeExactAssistantText(transcript, 'ses-current', 'msg-target')).toBe('Exact complete reply');
    expect(readOpenCodeExactAssistantText(transcript, 'ses-other', 'msg-target')).toBeNull();
    expect(readOpenCodeExactAssistantText(transcript, 'ses-current', 'msg-absent')).toBeNull();
    expect(readOpenCodeExactAssistantText({
      ...transcript!,
      logProjection: { ...transcript!.logProjection!, messages: [messages[1], messages[1]] },
    }, 'ses-current', 'msg-target')).toBeNull();
    expect(readOpenCodeExactAssistantText({
      ...transcript!,
      logProjection: { ...transcript!.logProjection!, messages: [
        { ...messages[1], toolCalls: [{ name: 'mcp__agent-teams__message_send' }] },
      ] },
    } as unknown as OpenCodeRuntimeTranscriptResponse['transcript'], 'ses-current', 'msg-target')).toBeNull();
  });
});
