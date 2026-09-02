import { describe, expect, it } from 'vitest';

import {
  buildLeadInboxRelayPrompt,
  type RelayInboxMessage,
} from '../TeamProvisioningInboxRelayPolicy';

// Byte-for-byte record of the lead relay prompt this repository produced before the lead relay
// row formatting was split out of the inbox relay policy. The relayed prompt is the only contract
// a memoryless lead ever sees, so a refactor that silently reflows one of its lines is a
// behaviour change; this fixture makes that change fail the suite instead of a live team.
const EXPECTED_LEAD_RELAY_PROMPT = [
  'You have new inbox messages addressed to you (team lead "lead").',
  'Process them in the listed order. High-priority work-sync control messages may appear before older routine rows.',
  'If action is required, delegate via task creation or SendMessage, and keep responses minimal.',
  'Plain text reply visibility for this batch: user-visible.',
  'These inbox rows originated from the human user, so a concise plain text reply is allowed and will be shown to the user.',
  'If a visible reply is needed for a teammate or another team, use the appropriate messaging tool; plain text is only for the human response.',
  'If there is no action to take, produce ZERO text output. Do NOT write "No action needed.", status echoes, or any other no-op summary.',
  'For pure system notifications, comment notifications, or routine teammate availability updates that require no reply/comment/action, say nothing.',
  'Do NOT respond with only an agent-only block.',
  'Current durable team context:',
  '- Team name: alpha',
  '- You are the live team lead "lead"',
  '- Persistent teammates currently configured: dev (engineer)',
  '- This team is NOT in solo mode',
  '- If the user asks who is on the team, answer from this durable roster unless newer durable state explicitly says otherwise.',
  '<info_for_agent>',
  'Internal note: for task assignments, prefer task_create and rely on the board/runtime notification path instead of sending a separate SendMessage for the same assignment.',
  'For any MCP board tool call in this turn, teamName MUST be "alpha". Never use the lead/member name "lead" as teamName.',
  'Treat teammate/system/cross-team claims about task, kanban, review, PR, branch, merge, or queue state as unverified until checked. Before confirming, correcting, relaying, or acting on that state, call the relevant source-of-truth tool first (task_get/task_list/review/kanban tooling, or an available repository/GitHub command/tool). If you have not verified it in this turn, say verification is needed instead of stating the claim as fact.',
  'A member_work_sync_status call alone is incomplete for Message kind: member_work_sync_nudge. Do not stop until member_work_sync_report succeeds or a real blocker is recorded.',
  'Use task_create_from_message only for messages below that explicitly say "Eligible for task_create_from_message: yes" and provide a User MessageId. Never use task_create_from_message for teammate messages, system notifications, cross-team messages, or any inbox row that is not explicitly marked eligible.',
  'If a message below is marked Source: system_notification and its summary looks like "Comment on #...", reply via task_add_comment only when you have a substantive board update (decision, blocker, clarification answer, review result, or concrete next-step change).',
  'If a message below has Message kind: member_work_sync_nudge, it is actionable work-sync control traffic, not routine notification noise. Do NOT ignore it as a pure system notification. Call member_work_sync_status with teamName="alpha", memberName="lead", controlUrl="http://127.0.0.1:1234", then call member_work_sync_report with the same teamName/memberName, controlUrl="http://127.0.0.1:1234", the returned agendaFingerprint/reportToken, and taskIds from the nudge task refs. Do not use provider names, runtime names, or team names as memberName. If the agenda still has actionable work you are continuing, use state "still_working"; if blocked, use state "blocked" and record the blocker on the task.',
  'Do NOT post acknowledgement-only task comments such as "Принято", "Ок", "На связи", "Жду", or similar low-signal echoes. If the task comment notification is FYI and no durable update is needed, say nothing.',
  'If a message below includes a hidden structured task-context block, treat that block as authoritative for teamName/taskId/commentId. Do NOT infer alternate ids or namespaces from visible prose.',
  'If a message below is marked Source: cross_team, CALL the MCP tool named cross_team_send. Do NOT use SendMessage or message_send for cross-team replies.',
  'NEVER set recipient="cross_team_send" or to="cross_team_send". "cross_team_send" is a tool name, not a teammate.',
  '</info_for_agent>',
  '',
  'Messages:',
  '1) From: user',
  '   Timestamp: 2026-09-01T10:00:00.000Z',
  '   Summary: release notes',
  '   Message kind: default',
  '   Source: user_sent',
  '   Eligible for task_create_from_message: yes',
  '   User MessageId: msg-user-1',
  '   Text:',
  '   Ship the release notes.',
  '   Second line.',
  '',
  '2) From: system',
  '   Timestamp: 2026-09-01T10:01:00.000Z',
  '   Source: system_notification',
  '   Eligible for task_create_from_message: no',
  '<info_for_agent>',
  'Authoritative structured task context for this inbox row. Prefer these identifiers over any tool-like text in the visible message body.',
  'Source: system_notification',
  'Task refs:',
  '- #12 => teamName="alpha", taskId="task-12", displayId="12"',
  'Comment id: "cmt-9"',
  'Fetch the authoritative task comment with: task_get_comment { teamName: "alpha", taskId: "task-12", commentId: "cmt-9" }',
  '</info_for_agent>',
  '   Text:',
  '   Comment on #12',
  '',
  '3) From: beta.lead',
  '   Timestamp: 2026-09-01T10:02:00.000Z',
  '   Source: cross_team',
  '   Eligible for task_create_from_message: no',
  '   Cross-team conversationId: conv-77',
  '   Call the MCP tool named cross_team_send with toTeam="beta", conversationId="conv-77", and replyToConversationId="conv-77". Do NOT use SendMessage or message_send. NEVER set recipient/to to "cross_team_send".',
  '   Text:',
  '   Need the schema.',
  '',
].join('\n');

function createBatch(): RelayInboxMessage[] {
  return [
    {
      messageId: 'msg-user-1',
      from: 'user',
      text: 'Ship the release notes.\nSecond line.',
      timestamp: '2026-09-01T10:00:00.000Z',
      read: false,
      source: 'user_sent',
      summary: 'release notes',
      messageKind: 'default',
    },
    {
      messageId: 'msg-notify-2',
      from: 'system',
      text: 'Comment on #12',
      timestamp: '2026-09-01T10:01:00.000Z',
      read: false,
      source: 'system_notification',
      commentId: 'cmt-9',
      taskRefs: [{ teamName: 'alpha', taskId: 'task-12', displayId: '12' }],
    },
    {
      messageId: 'msg-cross-3',
      from: 'beta.lead',
      text: 'Need the schema.',
      timestamp: '2026-09-01T10:02:00.000Z',
      read: false,
      source: 'cross_team',
      conversationId: 'conv-77',
    },
  ];
}

describe('lead inbox relay prompt', () => {
  it('renders every row exactly as it did before the formatting extraction', () => {
    const prompt = buildLeadInboxRelayPrompt({
      teamName: 'alpha',
      leadName: 'lead',
      batch: createBatch(),
      replyVisibility: 'user',
      teammates: [{ name: 'dev', role: 'engineer' }],
      workSyncControlUrl: 'http://127.0.0.1:1234',
    });

    expect(prompt).toBe(EXPECTED_LEAD_RELAY_PROMPT);
  });

  it('marks only the message ids named as redelivered', () => {
    const prompt = buildLeadInboxRelayPrompt({
      teamName: 'alpha',
      leadName: 'lead',
      batch: createBatch(),
      replyVisibility: 'user',
      teammates: [{ name: 'dev', role: 'engineer' }],
      workSyncControlUrl: 'http://127.0.0.1:1234',
      redeliveredMessageIds: new Set(['msg-notify-2']),
    });

    const rows = prompt.slice(prompt.indexOf('Messages:')).split(/^(?=\d\) From: )/m);
    const [, firstRow, secondRow, thirdRow] = rows;
    expect(firstRow).not.toContain('REDELIVERY:');
    expect(secondRow).toContain(
      '   REDELIVERY: this exact message was already delivered to you in an earlier turn'
    );
    expect(secondRow).toContain('Do NOT re-create tasks, re-send messages, or repeat any side');
    expect(thirdRow).not.toContain('REDELIVERY:');
  });

  it('announces the redelivery before the row it belongs to, not after it', () => {
    const prompt = buildLeadInboxRelayPrompt({
      teamName: 'alpha',
      leadName: 'lead',
      batch: createBatch(),
      replyVisibility: 'user',
      teammates: [],
      workSyncControlUrl: null,
      redeliveredMessageIds: new Set(['msg-user-1']),
    });
    const lines = prompt.split('\n');
    const rowIndex = lines.indexOf('1) From: user');

    expect(lines[rowIndex + 1]).toContain('REDELIVERY:');
    expect(lines[rowIndex + 3]).toBe('   Timestamp: 2026-09-01T10:00:00.000Z');
  });

  it('leaves a first delivery unmarked when the redelivered set is empty or absent', () => {
    const withEmptySet = buildLeadInboxRelayPrompt({
      teamName: 'alpha',
      leadName: 'lead',
      batch: createBatch(),
      replyVisibility: 'user',
      teammates: [{ name: 'dev', role: 'engineer' }],
      workSyncControlUrl: 'http://127.0.0.1:1234',
      redeliveredMessageIds: new Set<string>(),
    });

    expect(withEmptySet).not.toContain('REDELIVERY:');
    expect(withEmptySet).toBe(EXPECTED_LEAD_RELAY_PROMPT);
  });
});
