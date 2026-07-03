import { describe, expect, it, vi } from 'vitest';

import {
  appendProvisioningAssistantText,
  getCurrentLeadSessionId,
  getLiveLeadProcessMessages,
  joinLeadRelayCaptureText,
  pruneLiveLeadMessagesForCleanedRun,
  pushLiveLeadProcessMessage,
  pushLiveLeadTextMessage,
  resetLiveLeadTextBuffer,
  shiftProvisioningOutputIndexesAfterRemoval,
  type TeamProvisioningLeadTextRun,
} from '../TeamProvisioningLeadProcessMessages';

import type { InboxMessage, ToolCallMeta } from '@shared/types';

function createLeadTextRun(overrides: Partial<TeamProvisioningLeadTextRun> = {}) {
  return {
    teamName: 'alpha',
    runId: 'run-1',
    leadMsgSeq: 0,
    liveLeadTextBuffer: null,
    pendingToolCalls: [],
    lastLeadTextEmitMs: 0,
    ...overrides,
  };
}

describe('lead process message helpers', () => {
  it('joins lead relay capture text using block or stream mode', () => {
    expect(joinLeadRelayCaptureText({ textParts: ['one', 'two'], textJoinMode: 'block' })).toBe(
      'one\ntwo'
    );
    expect(joinLeadRelayCaptureText({ textParts: ['one', 'two'], textJoinMode: 'stream' })).toBe(
      'onetwo'
    );
  });

  it('appends stable assistant output and rewrites duplicate message ids in place', () => {
    const run = {
      provisioningOutputParts: [] as string[],
      provisioningOutputIndexByMessageId: new Map<string, number>(),
    };

    appendProvisioningAssistantText(run, { uuid: 'u1' }, 'first');
    appendProvisioningAssistantText(run, { uuid: 'u1' }, 'updated');
    appendProvisioningAssistantText(run, { uuid: 'u2' }, 'updated');

    expect(run.provisioningOutputParts).toEqual(['updated']);
    expect(run.provisioningOutputIndexByMessageId.get('lead-thought-u1')).toBe(0);
    expect(run.provisioningOutputIndexByMessageId.has('lead-thought-u2')).toBe(false);
  });

  it('shifts stable assistant output indexes after a removed part', () => {
    const run = {
      provisioningOutputParts: ['a', 'b', 'c'],
      provisioningOutputIndexByMessageId: new Map([
        ['a', 0],
        ['b', 1],
        ['c', 2],
      ]),
    };

    shiftProvisioningOutputIndexesAfterRemoval(run, 0);

    expect(run.provisioningOutputIndexByMessageId.get('a')).toBe(0);
    expect(run.provisioningOutputIndexByMessageId.get('b')).toBe(0);
    expect(run.provisioningOutputIndexByMessageId.get('c')).toBe(1);
  });

  it('caches live lead process messages with session enrichment and id replacement', () => {
    const liveLeadProcessMessages = new Map<string, InboxMessage[]>();
    const message = {
      from: 'lead',
      text: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      read: true,
      messageId: 'm1',
      source: 'lead_process' as const,
    };
    const ports = {
      liveLeadProcessMessages,
      getTrackedRunId: () => 'run-1',
      getRun: () => ({ detectedSessionId: 'session-1' }),
      cacheLimit: 1,
    };

    pushLiveLeadProcessMessage('alpha', message, ports);
    pushLiveLeadProcessMessage('alpha', { ...message, text: 'updated' }, ports);
    pushLiveLeadProcessMessage('alpha', { ...message, messageId: 'm2', text: 'second' }, ports);

    expect(liveLeadProcessMessages.get('alpha')).toEqual([
      expect.objectContaining({
        messageId: 'm2',
        text: 'second',
        leadSessionId: 'session-1',
      }),
    ]);
  });

  it('returns cloned live lead process messages enriched with the current session id', () => {
    const existingMessage: InboxMessage = {
      from: 'lead',
      text: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      read: true,
      messageId: 'm1',
      source: 'lead_process',
    };
    const messageWithSession: InboxMessage = {
      ...existingMessage,
      text: 'already session scoped',
      messageId: 'm2',
      leadSessionId: 'existing-session',
    };
    const liveLeadProcessMessages = new Map<string, InboxMessage[]>([
      ['alpha', [existingMessage, messageWithSession]],
    ]);
    const ports = {
      liveLeadProcessMessages,
      getTrackedRunId: () => 'run-1',
      getRun: () => ({ detectedSessionId: 'session-1' }),
    };

    expect(getCurrentLeadSessionId('alpha', ports)).toBe('session-1');

    const result = getLiveLeadProcessMessages('alpha', ports);

    expect(result).toEqual([
      expect.objectContaining({ messageId: 'm1', leadSessionId: 'session-1' }),
      expect.objectContaining({ messageId: 'm2', leadSessionId: 'existing-session' }),
    ]);
    expect(result[0]).not.toBe(existingMessage);
    expect(existingMessage.leadSessionId).toBeUndefined();
  });

  it('returns null current lead session id when no run is tracked', () => {
    expect(
      getCurrentLeadSessionId('alpha', {
        getTrackedRunId: () => null,
        getRun: () => ({ detectedSessionId: 'session-1' }),
      })
    ).toBeNull();
  });

  it('prunes live lead process messages for a cleaned run by run ids and session id', () => {
    const keepMessage: InboxMessage = {
      from: 'lead',
      text: 'keep',
      timestamp: '2026-01-01T00:00:00.000Z',
      read: true,
      messageId: 'lead-turn-other-run-1',
      source: 'lead_process',
    };
    const liveLeadProcessMessages = new Map<string, InboxMessage[]>([
      [
        'alpha',
        [
          { ...keepMessage },
          { ...keepMessage, messageId: ' lead-turn-run-1-1 ' },
          { ...keepMessage, messageId: 'lead-sendmsg-run-1-1' },
          { ...keepMessage, messageId: 'lead-process-run-1-1' },
          { ...keepMessage, messageId: 'compact-run-1-1' },
          { ...keepMessage, messageId: 'manual', leadSessionId: 'session-1' },
        ],
      ],
    ]);

    pruneLiveLeadMessagesForCleanedRun(
      { teamName: 'alpha', runId: 'run-1', detectedSessionId: 'session-1' },
      liveLeadProcessMessages
    );

    expect(liveLeadProcessMessages.get('alpha')).toEqual([keepMessage]);
  });

  it('deletes live lead process message cache when pruning removes every cleaned-run message', () => {
    const liveLeadProcessMessages = new Map<string, InboxMessage[]>([
      [
        'alpha',
        [
          {
            from: 'lead',
            text: 'remove',
            timestamp: '2026-01-01T00:00:00.000Z',
            read: true,
            messageId: 'lead-turn-run-1-1',
            source: 'lead_process',
          },
        ],
      ],
    ]);

    pruneLiveLeadMessagesForCleanedRun(
      { teamName: 'alpha', runId: 'run-1', detectedSessionId: null },
      liveLeadProcessMessages
    );

    expect(liveLeadProcessMessages.has('alpha')).toBe(false);
  });

  it('coalesces streamed lead text chunks and emits throttled refresh events', () => {
    const pushed: InboxMessage[] = [];
    const emitTeamChange = vi.fn();
    const run = createLeadTextRun({
      pendingToolCalls: [{ name: 'Read', preview: 'file.txt' } as ToolCallMeta],
    });
    const ports = {
      nowMs: () => 5_000,
      nowIso: () => '2026-01-01T00:00:00.000Z',
      getRunLeadName: () => 'lead',
      pushLiveLeadProcessMessage: (_teamName: string, message: InboxMessage) =>
        pushed.push(message),
      emitTeamChange,
      leadTextEmitThrottleMs: 2_000,
    };

    pushLiveLeadTextMessage(
      run,
      'hello ',
      undefined,
      undefined,
      { coalesceStreamChunk: true },
      ports
    );
    pushLiveLeadTextMessage(
      run,
      'world',
      undefined,
      undefined,
      { coalesceStreamChunk: true },
      ports
    );

    expect(pushed.map((message) => message.text)).toEqual(['hello', 'hello world']);
    expect(pushed[0].toolCalls).toHaveLength(1);
    expect(run.pendingToolCalls).toEqual([]);
    expect(emitTeamChange).toHaveBeenCalledTimes(1);

    resetLiveLeadTextBuffer(run);
    expect(run.liveLeadTextBuffer).toBeNull();
  });
});
