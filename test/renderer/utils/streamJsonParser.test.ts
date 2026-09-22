import { describe, expect, it } from 'vitest';

import { parseStreamJsonToGroups } from '@renderer/utils/streamJsonParser';

describe('parseStreamJsonToGroups', () => {
  it('renders Codex native JSONL lifecycle and assistant text instead of showing an empty viewer', () => {
    const groups = parseStreamJsonToGroups(
      [
        '[stdout]',
        '{"type":"thread.started","thread_id":"thread-1"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Lead response ready."}}',
        '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":7}}',
      ].join('\n')
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'output',
          content: 'Codex native thread started: thread-1.',
        }),
        expect.objectContaining({ type: 'output', content: 'Codex turn started.' }),
        expect.objectContaining({ type: 'output', content: 'Lead response ready.' }),
        expect.objectContaining({
          type: 'output',
          content: 'Codex turn completed (100 input, 25 cached, 7 output tokens).',
        }),
      ])
    );
  });

  it('deduplicates Codex native MCP tool started/completed events by item id', () => {
    const groups = parseStreamJsonToGroups(
      [
        '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"agent-teams","tool":"message_send","arguments":{"teamName":"signal-ops-11"},"status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"agent-teams","tool":"message_send","arguments":{"teamName":"signal-ops-11"},"result":{"content":[{"type":"text","text":"sent"}]},"status":"completed"}}',
      ].join('\n')
    );

    const tools = groups.flatMap((group) => group.items).filter((item) => item.type === 'tool');

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: 'tool',
      tool: {
        id: 'item_1',
        name: 'agent-teams_message_send',
        isOrphaned: false,
        result: {
          content: 'sent',
          isError: false,
        },
      },
    });
  });

  it('renders Codex native command execution and file change events from live JSONL logs', () => {
    const groups = parseStreamJsonToGroups(
      [
        '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"pwd","status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pwd","aggregated_output":"/repo\\n","exit_code":0,"status":"completed"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/repo/src/a.ts","kind":"update"}],"status":"completed"}}',
      ].join('\n')
    );

    const tools = groups.flatMap((group) => group.items).filter((item) => item.type === 'tool');

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      type: 'tool',
      tool: {
        id: 'item_1',
        name: 'Bash',
        input: { command: 'pwd' },
        isOrphaned: false,
        result: {
          content: '/repo\n',
          isError: false,
        },
      },
    });
    expect(tools[1]).toMatchObject({
      type: 'tool',
      tool: {
        id: 'item_2',
        name: 'Edit',
        input: { file_path: '/repo/src/a.ts' },
        isOrphaned: false,
        result: {
          content: 'File changes:\n- /repo/src/a.ts (update)',
          isError: false,
        },
      },
    });
  });

  it('renders projected Codex native system status rows from persisted logs', () => {
    const groups = parseStreamJsonToGroups(
      [
        '{"type":"system","subtype":"codex_native_thread_status","content":"Codex native thread started (thread-1).","codexNativeThreadStatus":"running","codexNativeThreadId":"thread-1"}',
        '{"type":"system","subtype":"codex_native_execution_summary","content":"Codex native execution summary: ephemeral live-only."}',
      ].join('\n')
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'output',
          content: 'Codex native thread started (thread-1).',
        }),
        expect.objectContaining({
          type: 'output',
          content: 'Codex native execution summary: ephemeral live-only.',
        }),
      ])
    );
  });

  it('keeps legacy assistant stream-json behavior', () => {
    const groups = parseStreamJsonToGroups(
      '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Legacy assistant output."}]}}'
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe('stream-group-msg_1');
    expect(groups[0]?.items).toEqual([
      expect.objectContaining({ type: 'output', content: 'Legacy assistant output.' }),
    ]);
  });
});
