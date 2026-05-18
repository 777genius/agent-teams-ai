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
          content: [
            {
              type: 'text',
              text: 'latest answer <system-reminder>hidden reminder text</system-reminder>',
            },
          ],
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
    expect(JSON.stringify(result.items)).not.toContain('hidden reminder text');
  });

  it('removes agent-only blocks from generic assistant text previews', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'assistant-hidden-block',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'text',
              text: `Visible user-facing update.

<info_for_agent>
API Error: 500 hidden MCP protocol instructions.
</info_for_agent>`,
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'text',
      title: 'Assistant',
      preview: 'Visible user-facing update.',
      tone: 'neutral',
    });
    expect(JSON.stringify(result.items)).not.toContain('Hidden MCP protocol');
    expect(JSON.stringify(result.items)).not.toContain('API Error: 500');
  });

  it('marks assistant runtime error text as error tone without flagging normal text', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'api-error',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'text',
              text: `API Error: 429

{"type":"error","error":{"type":"api_error","message":"Codex API error: 429"}}`,
            },
          ],
        }),
        message({
          uuid: 'normal-error-word',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [{ type: 'text', text: 'Reviewed the error handling path and it is covered.' }],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'text',
      title: 'Assistant',
      preview: 'Reviewed the error handling path and it is covered.',
      tone: 'neutral',
    });
    expect(result.items[1]).toMatchObject({
      kind: 'text',
      title: 'API error',
      tone: 'error',
    });
    expect(result.items[1]?.preview).toContain('API Error: 429');
    expect(result.items[1]?.preview).toContain('Codex API error: 429');
    expect(result.items[1]?.preview).not.toContain('{"type"');
  });

  it('marks OpenCode system runtime errors as latest error previews', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      sourceId: 'ses-real-opencode',
      sourceLabel: 'OpenCode runtime',
      sessionId: 'ses-real-opencode',
      laneId: 'secondary:opencode:bob',
      messages: [
        message({
          uuid: 'assistant-before-error',
          timestamp: '2026-05-13T17:04:24.347Z',
          content: [
            {
              type: 'text',
              text: 'All done. Task #622701b8 completed and approved.',
            },
          ],
        }),
        message({
          uuid: 'opencode-system-error',
          type: 'system',
          role: 'system',
          timestamp: '2026-05-13T17:04:45.546Z',
          content: 'OpenCode runtime error - UnknownError: database or disk is full',
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'text',
      title: 'Runtime error',
      preview: 'OpenCode runtime error - UnknownError: database or disk is full',
      tone: 'error',
      sourceLabel: 'OpenCode runtime',
      sessionId: 'ses-real-opencode',
      laneId: 'secondary:opencode:bob',
    });
    expect(result.items[1]).toMatchObject({
      title: 'Assistant',
      tone: 'neutral',
    });
  });

  it('does not flag normal runtime-error discussion as a runtime failure', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'normal-runtime-error-discussion',
          timestamp: '2026-05-13T17:04:24.347Z',
          content: [
            { type: 'text', text: 'Fixed OpenCode runtime error handling for the preview.' },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'text',
      title: 'Assistant',
      preview: 'Fixed OpenCode runtime error handling for the preview.',
      tone: 'neutral',
    });
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
      preview: 'to team-lead - #abc done',
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

  it('accepts OpenCode canonical callId/toolName tool calls defensively', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'canonical-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: '',
          toolCalls: [
            {
              callId: 'fc-canonical',
              toolName: 'agent-teams_task_add_comment',
              input: {
                taskId: '1dcfefd2-e505-4b1f-af22-0227c0aa551a',
                text: 'Confirmed',
              },
            },
          ],
        }),
        message({
          uuid: 'canonical-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: '',
          toolResults: [
            {
              toolUseId: 'fc-canonical',
              content: JSON.stringify({
                taskId: '1dcfefd2-e505-4b1f-af22-0227c0aa551a',
                comment: {
                  id: 'comment-1',
                  author: 'jack',
                  text: 'Confirmed',
                },
              }),
              isError: false,
            },
          ],
        }),
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Comment added',
      preview: 'Comment by jack on #1dcfefd2: Confirmed',
    });
  });

  it('marks nested structured error tool results without requiring is_error', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'api-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-api',
              content: JSON.stringify({
                type: 'error',
                error: {
                  type: 'api_error',
                  message: 'Codex API error: 429',
                },
              }),
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Tool error',
      preview: 'Codex API error: 429',
      tone: 'error',
    });
    expect(result.items[0]?.preview).not.toContain('{"type"');
  });

  it('marks structured isError payloads as errors and prefers stderr details', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'stderr-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-stderr',
              content: {
                isError: true,
                stderr: 'Permission denied while writing app/index.tsx',
              },
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Tool error',
      preview: 'Permission denied while writing app/index.tsx',
      tone: 'error',
    });
  });

  it('marks plain failed tool-result text as an error when runtime flags are missing', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'read-task-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-task-get',
              name: 'agent-teams_task_get',
              input: {
                taskId: '211e430b-0901-4c9e-9296-2b6e2059a08f',
              },
            },
          ],
        }),
        message({
          uuid: 'read-task-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-task-get',
              content:
                "Tool 'task_get' execution failed: Task not found: 211e430b-0901-4c9e-9296-2b6e2059a08f",
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Read task error',
      preview: "Tool 'task_get' execution failed: Task not found: 211e430b",
      tone: 'error',
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

  it('does not repeat generic comment titles in compact previews', () => {
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
              content: JSON.stringify({
                comment: {
                  text: 'Focused checks passed.',
                },
              }),
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Comment',
      preview: 'Focused checks passed.',
    });
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

  it('formats direct task list arrays without leaking raw array fields', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 220,
      messages: [
        message({
          uuid: 'list-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-list',
              name: 'mcp__agent-teams__task_list',
              input: { teamName: 'demo' },
            },
          ],
        }),
        message({
          uuid: 'list-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-list',
              content: JSON.stringify([
                {
                  id: '4499fbe5-1fee-42a5-8584-851fbfc4adcd',
                  displayId: '4499fbe5',
                  subject: 'Fix contact form route',
                  status: 'todo',
                  owner: 'bob',
                },
                {
                  id: '0276a054-1111-4222-8333-444444444444',
                  displayId: '0276a054',
                  title: 'High-confidence bug triage',
                  status: 'in_progress',
                  owner: 'alice',
                },
                {
                  id: '8a9e766b-1111-4222-8333-444444444444',
                  displayId: '8a9e766b',
                  title: 'Follow-up split',
                  status: 'done',
                  owner: 'tom',
                },
                {
                  id: '898a6a3e-1111-4222-8333-444444444444',
                  displayId: '898a6a3e',
                  title: 'Regression research',
                  status: 'done',
                  owner: 'team-lead',
                },
              ]),
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Task list',
      preview:
        '4 tasks - #4499fbe5: Fix contact form route, status todo, owner bob; #0276a054: High-confidence bug triage, status in_progress, owner alice; #8a9e766b: Follow-up split, status done, owner tom; +1 more',
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.preview).not.toContain('displayId');
    expect(result.items[0]?.preview).not.toContain('[{');
  });

  it('formats primitive task list arrays as task refs instead of empty lists', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'primitive-list-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-primitive-list',
              name: 'mcp__agent-teams__task_list',
              input: { teamName: 'demo' },
            },
          ],
        }),
        message({
          uuid: 'primitive-list-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-primitive-list',
              content: JSON.stringify(['abc12345', 'def67890']),
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Task list',
      preview: '2 tasks - #abc12345; #def67890',
    });
  });

  it('formats sourceToolUseID result wrappers with text-block content arrays', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 220,
      messages: [
        message({
          uuid: 'list-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-list',
              name: 'mcp__agent-teams__task_list',
              input: { teamName: 'demo' },
            },
          ],
        }),
        message({
          uuid: 'source-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: '',
          sourceToolUseID: 'tool-list',
          toolUseResult: {
            toolUseId: 'tool-list',
            content: [
              {
                type: 'text',
                text: JSON.stringify([
                  {
                    id: '4499fbe5-1fee-42a5-8584-851fbfc4adcd',
                    displayId: '4499fbe5',
                    subject: 'Fix contact form route',
                    status: 'todo',
                    owner: 'bob',
                  },
                ]),
              },
            ],
            isError: false,
          },
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Task list',
      preview: '1 task - #4499fbe5: Fix contact form route, status todo, owner bob',
    });
    expect(result.items[0]?.preview).not.toContain('toolUseId');
    expect(result.items[0]?.preview).not.toContain('content');
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

  it('formats runtime housekeeping previews without leaking internal fields', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'briefing-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-briefing',
              name: 'agent-teams_member_briefing',
              input: {
                teamName: 'relay-works-10',
                memberName: 'jack',
                runtimeProvider: 'opencode',
              },
            },
          ],
        }),
        message({
          uuid: 'briefing-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-briefing',
              content:
                'Member briefing for jack on team "relay-works-10" (relay-works-10). Role: developer. CRITICAL: hidden long briefing details.',
            },
          ],
        }),
        message({
          uuid: 'checkin-call',
          timestamp: '2026-04-01T10:02:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-checkin',
              name: 'agent-teams_runtime_bootstrap_checkin',
              input: {
                teamName: 'relay-works-10',
                runId: 'run-1',
                memberName: 'jack',
                runtimeSessionId: 'ses-1',
              },
            },
          ],
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      kind: 'tool_use',
      title: 'Runtime check-in',
      preview: 'jack checked in',
    });
    expect(result.items[1]).toMatchObject({
      kind: 'tool_result',
      title: 'Member briefing',
      preview: 'Loaded briefing for jack',
    });
    expect(JSON.stringify(result.items)).not.toContain('runtimeSessionId');
    expect(JSON.stringify(result.items)).not.toContain('CRITICAL');

    const inputOnly = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'briefing-input-only',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-briefing-only',
              name: 'agent-teams_member_briefing',
              input: {
                teamName: 'relay-works-10',
                memberName: 'jack',
                runtimeProvider: 'opencode',
              },
            },
          ],
        }),
      ],
    });

    expect(inputOnly.items[0]).toMatchObject({
      kind: 'tool_use',
      title: 'Member briefing',
      preview: 'Loaded briefing for jack',
    });

    const failedBriefing = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'briefing-call-failed',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-briefing-failed',
              name: 'agent-teams_member_briefing',
              input: {
                teamName: 'relay-works-10',
                memberName: 'jack',
              },
            },
          ],
        }),
        message({
          uuid: 'briefing-result-failed',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-briefing-failed',
              content: "Tool 'member_briefing' execution failed: runtime session missing",
            },
          ],
        }),
      ],
    });

    expect(failedBriefing.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Member briefing error',
      preview: "Tool 'member_briefing' execution failed: runtime session missing",
      tone: 'error',
    });
  });

  it('formats runtime ops, work sync and process previews without internal ids', () => {
    const runtimeResult = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'heartbeat-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-heartbeat',
              name: 'agent-teams_runtime_heartbeat',
              input: {
                runId: 'run-1',
                teamName: 'relay-works-10',
                memberName: 'jack',
                runtimeSessionId: 'ses-1',
              },
            },
          ],
        }),
        message({
          uuid: 'runtime-event-call',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-runtime-event',
              name: 'agent-teams_runtime_task_event',
              input: {
                memberName: 'jack',
                taskId: 'abc12345-0000-0000-0000-000000000000',
                event: 'started',
              },
            },
          ],
        }),
      ],
    });

    expect(runtimeResult.items[0]).toMatchObject({
      kind: 'tool_use',
      title: 'Runtime task event',
      preview: 'jack started #abc12345',
    });
    expect(runtimeResult.items[1]).toMatchObject({
      kind: 'tool_use',
      title: 'Runtime heartbeat',
      preview: 'jack heartbeat',
    });
    expect(JSON.stringify(runtimeResult.items)).not.toContain('runtimeSessionId');

    const workSyncResult = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'work-sync-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-work-sync',
              name: 'agent-teams_member_work_sync_report',
              input: {
                memberName: 'jack',
                state: 'still_working',
                taskIds: ['abc12345-0000-0000-0000-000000000000'],
                reportToken: 'secret-token',
              },
            },
          ],
        }),
        message({
          uuid: 'work-sync-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-work-sync',
              content: 'ok',
            },
          ],
        }),
      ],
    });

    expect(workSyncResult.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Work sync report',
      preview: 'jack still_working #abc12345',
    });
    expect(JSON.stringify(workSyncResult.items)).not.toContain('reportToken');

    const processResult = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'process-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-process-list',
              name: 'agent-teams_process_list',
              input: { teamName: 'relay-works-10' },
            },
          ],
        }),
        message({
          uuid: 'process-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-process-list',
              content: JSON.stringify([
                { pid: 123, label: 'vite dev', status: 'running' },
                { pid: 456, command: 'pnpm test', status: 'exited' },
              ]),
            },
          ],
        }),
      ],
    });

    expect(processResult.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Process list',
      preview: '2 processes - vite dev running; pnpm test exited',
    });
    expect(processResult.items[0]?.preview).not.toContain('[{');

    const primitiveProcessResult = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'primitive-process-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-primitive-process-list',
              name: 'agent-teams_process_list',
              input: { teamName: 'relay-works-10' },
            },
          ],
        }),
        message({
          uuid: 'primitive-process-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-primitive-process-list',
              content: ['vite dev', 'pnpm test'],
            },
          ],
        }),
      ],
    });

    expect(primitiveProcessResult.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Process list',
      preview: '2 processes - vite dev; pnpm test',
    });

    const wrappedPrimitiveProcessResult = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'wrapped-primitive-process-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-wrapped-primitive-process-list',
              name: 'agent-teams_process_list',
              input: { teamName: 'relay-works-10' },
            },
          ],
        }),
        message({
          uuid: 'wrapped-primitive-process-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-wrapped-primitive-process-list',
              content: { processes: ['vite dev', 'pnpm test'] },
            },
          ],
        }),
      ],
    });

    expect(wrappedPrimitiveProcessResult.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Process list',
      preview: '2 processes - vite dev; pnpm test',
    });

    const taskUpdateResult = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'task-update-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-task-update',
              name: 'agent-teams_task_update',
              input: {
                taskId: 'abc12345-0000-0000-0000-000000000000',
                status: 'in_progress',
              },
            },
          ],
        }),
        message({
          uuid: 'task-update-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-task-update',
              content: {
                taskId: 'abc12345-0000-0000-0000-000000000000',
                status: 'in_progress',
              },
            },
          ],
        }),
      ],
    });

    expect(taskUpdateResult.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Task updated',
      preview: '#abc12345 -> in_progress',
    });

    const remainingOperationalTools = [
      {
        toolName: 'agent-teams_lead_briefing',
        input: { teamName: 'relay-works-10' },
        result: 'Lead briefing for team relay-works-10. CRITICAL: hidden rules',
        expectedTitle: 'Lead briefing',
        expectedPreview: 'Loaded lead briefing for relay-works-10',
      },
      {
        toolName: 'agent-teams_runtime_deliver_message',
        input: { to: 'bob', text: 'Follow-up ready', runtimeSessionId: 'ses-secret' },
        result: 'ok',
        expectedTitle: 'Runtime delivery',
        expectedPreview: 'Delivered to bob - Follow-up ready',
      },
      {
        toolName: 'agent-teams_cross_team_list_targets',
        input: { teamName: 'relay-works-10' },
        result: JSON.stringify(['qa-team', 'design-team']),
        expectedTitle: 'Cross-team targets',
        expectedPreview: '2 teams - qa-team; design-team',
      },
      {
        toolName: 'agent-teams_cross_team_get_outbox',
        input: { teamName: 'relay-works-10' },
        result: {
          messages: [{ toTeam: 'qa-team', summary: 'Need smoke-test help' }],
        },
        expectedTitle: 'Cross-team outbox',
        expectedPreview: '1 message - to qa-team: Need smoke-test help',
      },
      {
        toolName: 'agent-teams_process_register',
        input: { label: 'vite dev', command: 'pnpm dev' },
        result: { pid: 123, process: { label: 'vite dev', status: 'running' } },
        expectedTitle: 'Process registered',
        expectedPreview: 'Registered vite dev running',
      },
      {
        toolName: 'agent-teams_process_stop',
        input: { label: 'vite dev' },
        result: 'ok',
        expectedTitle: 'Process stopped',
        expectedPreview: 'Stopped vite dev',
      },
      {
        toolName: 'agent-teams_process_unregister',
        input: { pid: 123 },
        result: 'ok',
        expectedTitle: 'Process unregistered',
        expectedPreview: 'Unregistered 123',
      },
    ] as const;

    for (const [index, tool] of remainingOperationalTools.entries()) {
      const result = extractMemberLogPreviewItems({
        provider: 'opencode_runtime',
        maxItems: 3,
        textLimit: 160,
        messages: [
          message({
            uuid: `remaining-tool-call-${index}`,
            timestamp: '2026-04-01T10:00:00.000Z',
            content: [
              {
                type: 'tool_use',
                id: `tool-remaining-${index}`,
                name: tool.toolName,
                input: tool.input,
              },
            ],
          }),
          message({
            uuid: `remaining-tool-result-${index}`,
            type: 'user',
            role: 'user',
            timestamp: '2026-04-01T10:01:00.000Z',
            content: [
              {
                type: 'tool_result',
                tool_use_id: `tool-remaining-${index}`,
                content: tool.result,
              },
            ],
          }),
        ],
      });

      expect(result.items[0]).toMatchObject({
        kind: 'tool_result',
        title: tool.expectedTitle,
        preview: tool.expectedPreview,
      });
      expect(`${result.items[0]?.title ?? ''} ${result.items[0]?.preview ?? ''}`).not.toMatch(
        /CRITICAL|runtimeSessionId|agent_teams_|process_register|cross_team_/i
      );
    }
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
      preview: 'Tests passed - pnpm test',
    });
    expect(result.items).toHaveLength(1);
  });

  it('keeps successful file tool results compact with input context', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'read-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-read',
              name: 'Read',
              input: {
                file_path: 'src/app.ts',
              },
            },
          ],
        }),
        message({
          uuid: 'read-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-read',
              content: 'export function app() { return true; }',
            },
          ],
        }),
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Read result',
      preview: 'src/app.ts - export function app() { return true; }',
    });
  });

  it('keeps empty successful file tool results readable without duplicate input rows', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'edit-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-edit',
              name: 'Edit',
              input: {
                file_path: 'src/app.ts',
                old_string: 'a',
                new_string: 'b',
              },
            },
          ],
        }),
        message({
          uuid: 'edit-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-edit',
              content: '',
            },
          ],
        }),
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Edit result',
      preview: 'src/app.ts',
    });
  });

  it('cleans tagged file tool output and shortens absolute paths for compact rows', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'read-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-read',
              name: 'Read',
              input: {
                file_path: '/Users/belief/dev/projects/demo/app/page.tsx',
              },
            },
          ],
        }),
        message({
          uuid: 'read-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-read',
              content: `<path>/Users/belief/dev/projects/demo/app/page.tsx</path>
<type>file</type>
<content>
1: export default function Page() {
2:   return null;
3: }

(End of file - total 3 lines)
</content>`,
            },
          ],
        }),
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Read result',
      preview: 'demo/app/page.tsx - export default function Page() { return null; }',
    });
    expect(result.items[0]?.preview).not.toContain('/Users/belief');
    expect(result.items[0]?.preview).not.toContain('<path>');
    expect(result.items[0]?.preview).not.toContain('1:');
  });

  it('cleans tagged directory tool output without repeating absolute paths', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'opencode_runtime',
      maxItems: 3,
      textLimit: 160,
      messages: [
        message({
          uuid: 'read-call',
          timestamp: '2026-04-01T10:00:00.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-read',
              name: 'Read',
              input: {
                file_path: '/Users/belief/dev/projects/demo',
              },
            },
          ],
        }),
        message({
          uuid: 'read-result',
          type: 'user',
          role: 'user',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-read',
              content: `<path>/Users/belief/dev/projects/demo</path>
<type>directory</type>
<entries>
app/
package.json
README.md

(3 entries)
</entries>`,
            },
          ],
        }),
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Read result',
      preview: 'demo - directory app/ package.json README.md',
    });
    expect(result.items[0]?.preview).not.toContain('/Users/belief');
    expect(result.items[0]?.preview).not.toContain('(3 entries)');
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

  it('uses content block order before mirrored toolCalls for same-message readability', () => {
    const result = extractMemberLogPreviewItems({
      provider: 'claude_transcript',
      maxItems: 3,
      textLimit: 120,
      messages: [
        message({
          uuid: 'mirrored-tool-call',
          timestamp: '2026-04-01T10:01:00.000Z',
          content: [
            { type: 'text', text: 'I will inspect the files first.' },
            {
              type: 'tool_use',
              id: 'tool-read',
              name: 'Read',
              input: { file_path: 'src/app.ts' },
            },
          ],
          toolCalls: [
            {
              id: 'tool-read',
              name: 'Read',
              input: { file_path: 'src/app.ts' },
              isTask: false,
            },
          ],
        }),
      ],
    });

    expect(result.items.map((item) => item.title)).toEqual(['Assistant', 'Read']);
    expect(result.items[0]).toMatchObject({
      kind: 'text',
      preview: 'I will inspect the files first.',
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
