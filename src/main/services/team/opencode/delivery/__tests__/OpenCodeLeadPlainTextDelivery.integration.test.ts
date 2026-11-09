import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamInboxReader } from '../../../TeamInboxReader';
import { TeamInboxWriter } from '../../../TeamInboxWriter';
import { buildPlainTextVisibleReplyMessageId } from '../OpenCodeGroupVisibleReply';
import {
  createOpenCodePromptDeliveryLedgerStore,
  isOpenCodePromptDeliveryWatchdogTerminal,
} from '../OpenCodePromptDeliveryLedger';
import {
  isOpenCodeDeliveryResponseReadCommitAllowed,
  isOpenCodeDeliveryRetryablePendingResponse,
} from '../OpenCodePromptDeliveryReadCommitPolicy';
import { openCodeTaskRefsIncludeAll } from '../OpenCodeRuntimeDeliveryProofMatching';
import { OpenCodeVisibleReplyProofService } from '../OpenCodeVisibleReplyProofService';
import { readOpenCodeExactAssistantText } from '../OpenCodeVisibleReplyProofComposition';

import type { OpenCodePromptDeliveryLedgerRecord } from '../OpenCodePromptDeliveryLedger';
import type { OpenCodeVisibleReplyProofServiceDependencies } from '../OpenCodeVisibleReplyProofService';
import type { OpenCodeVisibleReplyProof } from '../OpenCodePromptDeliveryWatchdog';
import type { OpenCodeRuntimeTranscriptResponse } from '../../../../runtime/ClaudeMultimodelBridgeService';
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
    text?: string | null;
    observedToolCallNames?: string[];
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
    const readExactAssistantText = vi.fn(async () => input.text === undefined ? 'Full response.' : input.text);
    const deps = {
      inboxReader: reader,
      inboxWriter: writer,
      getConfiguredLeadName: vi.fn(async () => input.lead === undefined ? 'captain' : input.lead),
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
        ledgerRecord: record, responseState: record.responseState,
        actionMode: record.actionMode ?? undefined, taskRefs: record.taskRefs,
        visibleReply: proof, taskRefsIncludeAll: openCodeTaskRefsIncludeAll,
        hasAcceptedMemberWorkSyncReport: async () => false,
      });
    const messages = async (name: string) => reader.getMessagesFor('team', name);
    return { ledger, observed, pending, service, deps, materialize, readAllowed, messages, readExactAssistantText };
  }

  it.each(['team-lead', 'captain'])('persists the exact long reply in the configured lead inbox (%s)', async (recipient) => {
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
    } as OpenCodeRuntimeTranscriptResponse['transcript'], 'ses-current', 'msg-target')).toBeNull();
  });
});
