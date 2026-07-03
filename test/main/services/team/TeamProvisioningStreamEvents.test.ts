import {
  extractStreamContentBlocks,
  extractStreamUserText,
  getStableLeadThoughtMessageId,
  hasCapturedUserVisibleSendMessage,
  hasCapturedVisibleSendMessage,
  shouldAcceptDeterministicBootstrapEvent,
} from '@main/services/team/provisioning/TeamProvisioningStreamEvents';
import { describe, expect, it } from 'vitest';

describe('TeamProvisioningStreamEvents', () => {
  it('extracts user text from top-level and nested stream content', () => {
    expect(
      extractStreamUserText({
        type: 'user',
        content: [{ type: 'text', text: 'hello' }],
      })
    ).toBe('hello');

    expect(
      extractStreamUserText({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_result', content: 'ignored' },
            { type: 'text', text: 'second' },
          ],
        },
      })
    ).toBe('first\nsecond');
  });

  it('extracts assistant content blocks from supported stream envelopes', () => {
    const topLevel = [{ type: 'text', text: 'ready' }];
    expect(extractStreamContentBlocks({ type: 'assistant', content: topLevel })).toEqual(topLevel);

    const nested = [{ type: 'tool_use', name: 'SendMessage' }];
    expect(
      extractStreamContentBlocks({
        type: 'assistant',
        message: { content: nested },
      })
    ).toEqual(nested);
  });

  it('detects visible SendMessage tool calls and user-visible destinations', () => {
    const content = [
      {
        type: 'tool_use',
        name: 'SendMessage',
        input: { recipient: 'user', content: 'Launch complete' },
      },
    ];

    expect(hasCapturedVisibleSendMessage(content, 'atlas-hq')).toBe(true);
    expect(hasCapturedUserVisibleSendMessage(content, 'atlas-hq')).toBe(true);
  });

  it('builds stable lead thought ids from stream metadata', () => {
    expect(getStableLeadThoughtMessageId({ uuid: 'entry-1' })).toBe('lead-thought-entry-1');
    expect(getStableLeadThoughtMessageId({ message: { id: 'msg-1' } })).toBe(
      'lead-thought-msg-msg-1'
    );
  });

  it('filters deterministic bootstrap events by run, team, and monotonic sequence', () => {
    const base = {
      runId: 'run-1',
      teamName: 'atlas-hq',
      lastSeq: 4,
    };

    expect(
      shouldAcceptDeterministicBootstrapEvent({
        ...base,
        msg: { run_id: 'run-2', team_name: 'atlas-hq', seq: 5 },
      })
    ).toEqual({ accept: false, nextSeq: 4 });
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        ...base,
        msg: { run_id: 'run-1', team_name: 'other', seq: 5 },
      })
    ).toEqual({ accept: false, nextSeq: 4 });
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        ...base,
        msg: { run_id: 'run-1', team_name: 'atlas-hq', seq: 4 },
      })
    ).toEqual({ accept: false, nextSeq: 4 });
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        ...base,
        msg: { run_id: 'run-1', team_name: 'atlas-hq', seq: 5 },
      })
    ).toEqual({ accept: true, nextSeq: 5 });
  });
});
