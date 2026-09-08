import { describe, expect, it } from 'vitest';

import {
  assertTranscriptModel,
  assertTranscriptSession,
  hasMessage,
  hasTaskCompletion,
  relayMetadata,
  successfulTools,
} from './openCodeMixedTeamEvidence';
// These run offline even when the paid scenario is disabled.
describe('mixed team tool evidence acceptance', () => {
  const use = { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'echo proof' } };
  const result = {
    type: 'tool_result',
    toolUseId: 'call-1',
    status: 'completed',
    contentText: 'proof',
    isError: false,
  };
  function transcript(role: string, contentBlocks: unknown[]) {
    return { data: { messages: [{ role, contentBlocks }] } };
  }
  it('accepts only a successful completed assistant call/result pair', () => {
    expect(successfulTools(transcript('assistant', [use, result]))).toEqual([
      { name: 'bash', input: { command: 'echo proof' }, output: 'proof' },
    ]);
  });
  it('rejects injected user text, mismatched results, running calls and tool errors', () => {
    expect(successfulTools(transcript('user', [use, result]))).toEqual([]);
    expect(
      successfulTools(
        transcript('assistant', [{ type: 'text', text: JSON.stringify([use, result]) }])
      )
    ).toEqual([]);
    expect(
      successfulTools(transcript('assistant', [use, { ...result, toolUseId: 'other' }]))
    ).toEqual([]);
    expect(
      successfulTools(transcript('assistant', [use, { ...result, status: 'running' }]))
    ).toEqual([]);
    expect(successfulTools(transcript('assistant', [use, { ...result, isError: true }]))).toEqual(
      []
    );
  });
  it('rejects actual assistant inference on a different model', () => {
    const evidence = {
      data: {
        messages: [{ role: 'assistant', providerId: 'selected', modelId: 'fallback' }],
      },
    };
    expect(() => assertTranscriptModel(evidence, 'selected/requested')).toThrow();
    expect(() => assertTranscriptModel(evidence, 'selected/fallback')).not.toThrow();
  });
});

it('whitelists relay metadata and only rejects confirmed terminal failures', () => {
  const output = relayMetadata({
    diagnostics: ['secret'],
    lastDelivery: { reason: 'secret', ledgerStatus: 'failed_terminal', accepted: false },
  });
  expect(output.terminalFailure).toBe(true);
  expect(JSON.stringify(output)).not.toContain('secret');
  expect(
    relayMetadata({ lastDelivery: { ledgerStatus: 'failed_terminal', acceptanceUnknown: true } })
      .terminalFailure
  ).toBe(false);
  expect(relayMetadata({ lastDelivery: { ledgerStatus: 'secret' } }).ledgerStatus).toBeNull();
});


it('rejects unattributed assistant rows and transcripts from another session', () => {
  const transcript = { data: { sessionId: 'session-1', messages: [
    { role: 'assistant', providerId: 'selected', modelId: 'requested' },
  ] } };
  expect(() => assertTranscriptSession(transcript, 'session-2')).toThrow();
  expect(() => assertTranscriptModel({ data: { messages: [
    ...transcript.data.messages, { role: 'assistant', contentBlocks: [] },
  ] } }, 'selected/requested')).toThrow();
});

it('requires task and message identity in argument fields, never substrings or notes', () => {
  const completion = { name: 'agent-teams_task_complete', output: '',
    input: { teamName: 'test-team', taskId: 'task-10', actor: 'alice', note: 'task-1' } };
  expect(hasTaskCompletion([completion], 'test-team', 'task-1', 'alice')).toBe(false);
  const message = { name: 'agent-teams_message_send', output: '',
    input: { teamName: 'test-team', from: 'bob', to: 'user', text: 'ACK:nonce' } };
  expect(hasMessage([message], 'test-team', 'bob', 'alice', 'ACK:nonce')).toBe(false);
});
