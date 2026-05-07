import { describe, expect, it } from 'vitest';

import { extractMemberLogPreviewItems } from '../memberLogPreviewExtractor';

import type { MemberLogPreviewParsedMessage } from '../memberLogPreviewExtractor';

function message(
  overrides: Partial<MemberLogPreviewParsedMessage> & {
    uuid: string;
    timestamp: string;
  }
): MemberLogPreviewParsedMessage {
  const { uuid, timestamp, ...rest } = overrides;
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    role: 'assistant',
    timestamp: new Date(timestamp),
    content: '',
    toolCalls: [],
    toolResults: [],
    ...rest,
  } as MemberLogPreviewParsedMessage;
}

describe('memberLogPreviewExtractor', () => {
  it('extracts bounded assistant text previews newest first', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 120,
      messages: [
        message({
          uuid: 'old',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [{ type: 'text', text: 'older answer' }],
        }),
        message({
          uuid: 'new',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [{ type: 'text', text: '<system-reminder>latest answer</system-reminder>' }],
        }),
      ],
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      kind: 'text',
      title: 'Assistant',
      preview: 'latest answer',
    });
    expect(result.items[1]?.preview).toBe('older answer');
  });

  it('extracts tool_use input and tool_result output without rendering huge payloads', () => {
    const hugeOutput = 'x'.repeat(10_000);
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      sourceId: 'session-1',
      sourceLabel: 'OpenCode runtime',
      laneId: 'secondary:opencode:alice',
      messages: [
        message({
          uuid: 'tool-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-1',
              name: 'Bash',
              input: { command: 'pnpm test -- --runInBand', ignored: hugeOutput },
            },
          ],
        }),
        message({
          uuid: 'tool-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-1',
              content: hugeOutput,
              is_error: true,
            },
          ],
          toolResults: [],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Tool error',
      tone: 'error',
      laneId: 'secondary:opencode:alice',
    });
    expect(result.items[0]?.preview?.length).toBeLessThanOrEqual(160);
    expect(result.items[1]).toMatchObject({
      kind: 'tool_use',
      title: 'Bash',
      preview: 'pnpm test -- --runInBand',
    });
    expect(result.truncated).toBe(true);
  });

  it('formats SendMessage and message_send payloads without raw JSON noise', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'send-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-send',
              name: 'mcp__agent-teams__message_send',
              input: {
                to: 'team-lead',
                from: 'tom',
                summary: '#abc done',
                text: 'Detailed body should stay secondary',
              },
            },
          ],
        }),
        message({
          uuid: 'send-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: '',
          toolResults: [
            {
              toolUseId: 'tool-send',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    deliveredToInbox: true,
                    message: {
                      from: 'tom',
                      to: 'team-lead',
                      text: 'Detailed body',
                      summary: '#abc done',
                    },
                  }),
                },
              ],
              isError: false,
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Message sent',
      preview: 'Message sent to team-lead - #abc done',
    });
    expect(result.items[1]).toMatchObject({
      kind: 'tool_use',
      title: 'Send message',
      preview: 'to team-lead: #abc done',
    });
    expect(JSON.stringify(result.items)).not.toContain('deliveredToInbox');
  });

  it('formats task comment result payloads without raw JSON noise', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'comment-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-comment',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    taskId: 'task-799',
                    comment: {
                      id: 'comment-1',
                      author: 'tom',
                      text: 'Done with UI review',
                    },
                  }),
                },
              ],
            },
          ],
        }),
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Comment added',
      preview: 'Comment by tom on #task-799: Done with UI review',
    });
    expect(JSON.stringify(result.items)).not.toContain('"comment"');
  });

  it('formats plain board tool results through the paired tool_use context', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'complete-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-complete',
              name: 'mcp__agent-teams__task_complete',
              input: { teamName: 'demo', taskId: 'abc12345', actor: 'tom' },
            },
          ],
        }),
        message({
          uuid: 'complete-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-complete',
              content: 'ok',
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Task completed',
      preview: 'Completed #abc12345',
      toolName: 'mcp__agent-teams__task_complete',
    });
    expect(result.items[1]).toMatchObject({
      kind: 'tool_use',
      title: 'Complete task',
      preview: '#abc12345',
    });
  });

  it('formats wrapped Agent Teams task responses', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'task-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-task-get',
              content: JSON.stringify({
                agent_teams_task_get_response: {
                  task: {
                    id: 'abc12345-0000-0000-0000-000000000000',
                    displayId: 'abc12345',
                    title: 'Fix preview alignment',
                    status: 'in_progress',
                    owner: 'tom',
                  },
                },
              }),
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Task loaded',
      preview: '#abc12345: Fix preview alignment, status in_progress, owner tom',
    });
    expect(JSON.stringify(result.items)).not.toContain('agent_teams_task_get_response');
  });

  it('keeps orphan tool results visible because graph preview is diagnostic', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 120,
      messages: [
        message({
          uuid: 'orphan',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: '',
          toolResults: [
            {
              toolUseId: 'missing-call',
              content: 'orphan result still matters',
              isError: false,
            },
          ],
        }),
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Tool result',
      preview: 'orphan result still matters',
      tone: 'success',
    });
  });

  it('caps preview items at three and reports overflow', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 120,
      messages: [1, 2, 3, 4].map((index) =>
        message({
          uuid: `m-${index}`,
          timestamp: `2026-04-01T10:0${index}:00.000Z`,
          content: [{ type: 'text', text: `message ${index}` }],
        })
      ),
    });

    expect(result.items.map((item) => item.preview)).toEqual([
      'message 4',
      'message 3',
      'message 2',
    ]);
    expect(result.overflowCount).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
