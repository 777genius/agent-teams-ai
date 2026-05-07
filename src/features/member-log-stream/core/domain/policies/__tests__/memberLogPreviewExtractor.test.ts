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

  it('extracts readable inbound task and comment messages without agent-only blocks', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'assigned',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: `New task assigned to you: #01d7462a *Calculator - final build and test command*

<info_for_agent>
Hidden tool protocol that must not be rendered.
</info_for_agent>

Description:
Run final validation.`,
        }),
        message({
          uuid: 'comment',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: `**Comment on task #1dcfefd2** _Calculator - logic smoke checklist_

> Logic smoke check passed.

<info_for_agent>
Reply to this comment using MCP tool task_add_comment.
</info_for_agent>`,
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'text',
      title: 'Comment received',
      preview: '#1dcfefd2: Logic smoke check passed.',
    });
    expect(result.items[1]).toMatchObject({
      kind: 'text',
      title: 'Task assigned',
      preview: '#01d7462a Calculator - final build and test command',
    });
    expect(JSON.stringify(result.items)).not.toContain('info_for_agent');
    expect(JSON.stringify(result.items)).not.toContain('task_add_comment');
  });

  it('skips meta tool-result user messages for inbound text extraction', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'meta',
          type: 'user',
          role: 'user',
          isMeta: true,
          timestamp: '2026-04-01T10:00:00.000Z',
          content: 'Internal runtime metadata',
        }),
      ],
    });

    expect(result.items).toEqual([]);
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
      title: 'Bash error',
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
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result.items)).not.toContain('deliveredToInbox');
  });

  it('keeps known tool names on structured error payloads', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
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
              name: 'agent-teams_message_send',
              input: {
                to: 'team-lead',
                summary: '#abc done',
              },
            },
          ],
        }),
        message({
          uuid: 'send-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-send',
              content: {
                success: false,
                message: 'Delivery failed',
              },
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Send message error',
      preview: 'Delivery failed',
      tone: 'error',
    });
    expect(result.items[1]).toMatchObject({
      kind: 'tool_use',
      title: 'Send message',
      preview: 'to team-lead: #abc done',
    });
  });

  it('formats orphan comment result payloads without guessing add vs read semantics', () => {
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
      title: 'Comment',
      preview: 'Comment by tom on #task-799: Done with UI review',
    });
    expect(JSON.stringify(result.items)).not.toContain('"comment"');
  });

  it('uses tool context to name comment add results precisely', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'comment-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-comment',
              name: 'mcp__agent-teams__task_add_comment',
              input: {
                taskId: 'task-799',
                text: 'Done with UI review',
              },
            },
          ],
        }),
        message({
          uuid: 'comment-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-comment',
              content: JSON.stringify({
                taskId: 'task-799',
                comment: {
                  id: 'comment-1',
                  author: 'tom',
                  text: 'Done with UI review',
                },
              }),
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Comment added',
      preview: 'Comment by tom on #task-799: Done with UI review',
    });
    expect(result.items).toHaveLength(1);
  });

  it('distinguishes read-comment results from add-comment results', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'comment-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-comment',
              name: 'mcp__agent-teams__task_get_comment',
              input: {
                taskId: 'task-799',
                commentId: '47697aeb',
              },
            },
          ],
        }),
        message({
          uuid: 'comment-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-comment',
              content: JSON.stringify({
                agent_teams_task_get_comment_response: {
                  taskId: 'task-799',
                  comment: {
                    id: '47697aeb-3734-4d5c-ae3e-42fafcbdea0b',
                    author: 'tom',
                    text: 'Готово по UI',
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
      title: 'Comment loaded',
      preview: 'Comment by tom on #task-799: Готово по UI',
    });
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result.items)).not.toContain('Comment added');
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
    expect(result.items).toHaveLength(1);
  });

  it('keeps board tool input visible when the paired successful result is empty', () => {
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
              content: '',
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Complete task result',
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
                    subject: 'Fix preview alignment',
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

  it('formats common board and cross-team tool previews compactly', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'cross-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-cross',
              name: 'agent-teams_cross_team_send',
              input: {
                toTeam: 'design-team',
                summary: 'Need UI review',
                text: 'Please review compact logs',
              },
            },
            {
              type: 'tool_use',
              id: 'tool-link',
              name: 'agent-teams_task_link',
              input: {
                taskId: 'abc12345',
                targetId: 'def67890',
                relationship: 'blocked-by',
              },
            },
          ],
        }),
        message({
          uuid: 'cross-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-cross',
              content: 'ok',
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Cross-team message',
      preview: 'to design-team: Need UI review',
    });
    expect(result.items[1]).toMatchObject({
      kind: 'tool_use',
      title: 'Link tasks',
      preview: '#abc12345 blocked-by #def67890',
    });
    expect(result.items).toHaveLength(2);
  });

  it('uses concrete names for generic runtime tool results', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'bash-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-bash',
              name: 'bash',
              input: {
                command: 'pnpm test',
              },
            },
          ],
        }),
        message({
          uuid: 'bash-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-bash',
              content: 'Tests passed',
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Bash result',
      preview: 'Tests passed',
    });
    expect(result.items[1]).toMatchObject({
      kind: 'tool_use',
      title: 'Bash',
      preview: 'pnpm test',
    });
  });

  it('does not label arbitrary message fields as sent messages', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'generic-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-generic',
              content: {
                message: 'generic tool status',
              },
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Tool result',
      preview: 'generic tool status',
    });
  });

  it('formats unknown JSON string results without leaking raw JSON syntax', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'generic-json',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-generic',
              content: JSON.stringify({
                payload: {
                  nested: true,
                },
                status: 'stored',
                count: 2,
              }),
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Tool result',
      preview: 'stored',
    });
    expect(result.items[0]?.preview).not.toContain('{');
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
