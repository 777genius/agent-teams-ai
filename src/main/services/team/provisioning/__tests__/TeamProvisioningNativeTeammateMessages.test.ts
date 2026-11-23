import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  handleNativeTeammateUserMessage,
  type TeamProvisioningNativeTeammateMessagePorts,
  type TeamProvisioningNativeTeammateRun,
} from '../TeamProvisioningNativeTeammateMessages';

import type { ParsedPermissionRequest } from '@shared/utils/inboxNoise';
import type { ParsedTeammateContent } from '@shared/utils/teammateMessageParser';

function teammateMessage(memberName: string, content: string): string {
  return `<teammate-message teammate_id="${memberName}" color="blue" summary="s">${content}</teammate-message>`;
}

function createRun(
  overrides: Partial<TeamProvisioningNativeTeammateRun> = {}
): TeamProvisioningNativeTeammateRun {
  return {
    teamName: 'alpha',
    activeCrossTeamReplyHints: [],
    ...overrides,
  };
}

function createPorts(
  overrides: Partial<
    TeamProvisioningNativeTeammateMessagePorts<TeamProvisioningNativeTeammateRun>
  > = {}
): TeamProvisioningNativeTeammateMessagePorts<TeamProvisioningNativeTeammateRun> {
  return {
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    recentCrossTeamLeadDeliveryTtlMs: 60_000,
    nowMs: () => 1_000,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    getRunLeadName: () => 'lead',
    handleTeammatePermissionRequest: vi.fn(),
    matchCrossTeamLeadInboxMessages: vi.fn().mockResolvedValue([]),
    markInboxMessagesRead: vi.fn().mockResolvedValue(undefined),
    setMemberSpawnStatus: vi.fn(),
    rememberSameTeamNativeFingerprints: vi.fn(),
    reconcileSameTeamNativeDeliveries: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('native teammate message helpers', () => {
  it('ignores the exact echoed Main hydration rather than promoting its Alice example', () => {
    // Pin the exact Main-built LF hydration across checkout line endings.
    const prompt = readFileSync(
      'tools/owned-process-broker/fixtures/retainedLegacyHydrationPrompt.txt',
      'utf8'
    ).replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(prompt).digest('hex')).toBe(
      '6bd919e892140dc3665f6c517d10b21b9e43ce65607f84210c3af4ec4dc6f0dc'
    );
    const ports = createPorts();
    handleNativeTeammateUserMessage(
      createRun(),
      {
        type: 'user',
        message: { role: 'user', content: prompt },
      },
      ports
    );
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
    expect(ports.rememberSameTeamNativeFingerprints).not.toHaveBeenCalled();
    expect(ports.reconcileSameTeamNativeDeliveries).not.toHaveBeenCalled();
  });

  const native = teammateMessage('worker', 'Ready for tasks');
  const result = { type: 'tool_result', tool_use_id: 'TEST-tool', content: native };
  it.each<[string, Record<string, unknown>]>([
    ['inline example', { content: `Example: ${native}` }],
    ['quoted code', { content: `\`\`\`xml\n${native}\n\`\`\`` }],
    [
      'top quote over nested protocol',
      { content: `Example: ${native}`, message: { content: native } },
    ],
    ['nested tool result with top protocol', { content: native, message: { content: [result] } }],
    ['top tool result without text', { content: [result], message: { content: native } }],
    ['mixed top tool result and text', { content: [result, { type: 'text', text: native }] }],
    ['explicit tool-result source', { content: native, sourceToolUseID: 'TEST-tool' }],
    [
      'tool results beat explicit protocol',
      { content: native, protocolKind: 'teammate-message', toolResults: [result] },
    ],
    ['coordinator provenance', { content: native, origin: { kind: 'coordinator' } }],
    ['compact summary', { content: native, isCompactSummary: true }],
    ['empty top string', { content: '', message: { content: native } }],
  ])('ignores %s without native delivery effects', (_label, message) => {
    const ports = createPorts();
    handleNativeTeammateUserMessage(createRun(), message, ports);
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
    expect(ports.handleTeammatePermissionRequest).not.toHaveBeenCalled();
    expect(ports.rememberSameTeamNativeFingerprints).not.toHaveBeenCalled();
    expect(ports.reconcileSameTeamNativeDeliveries).not.toHaveBeenCalled();
    expect(ports.matchCrossTeamLeadInboxMessages).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['whitespace', { content: ` \n${native}` }],
    ['Human prefix', { content: `Human: ${native}` }],
    ['User prefix', { content: `User: ${native}` }],
    [
      'top protocol over nested quote',
      { content: native, message: { content: `Example: ${native}` } },
    ],
    ['nested protocol', { message: { content: native } }],
    ['empty top array fallback', { content: [], message: { content: native } }],
    ['invalid top fallback', { content: { text: native }, message: { content: native } }],
    [
      'blank top text fallback',
      { content: [{ type: 'text', text: ' ' }], message: { content: native } },
    ],
    ['protocol provenance', { content: `Delivery: ${native}`, protocolKind: 'teammate-message' }],
    ['teammate origin', { content: `Delivery: ${native}`, origin: { kind: 'teammate' } }],
    [
      'Markdown body',
      { content: teammateMessage('worker', 'Ready\n```js\nconst value = 1;\n```') },
    ],
  ])('preserves genuine native %s', (_label, message) => {
    const run = createRun(),
      ports = createPorts();
    handleNativeTeammateUserMessage(run, message, ports);
    expect(ports.setMemberSpawnStatus).toHaveBeenCalledExactlyOnceWith(
      run,
      'worker',
      'online',
      undefined,
      'heartbeat'
    );
    expect(ports.rememberSameTeamNativeFingerprints).toHaveBeenCalledOnce();
    expect(ports.reconcileSameTeamNativeDeliveries).toHaveBeenCalledOnce();
  });

  it('preserves multiple envelopes and dynamic teammate names', () => {
    const run = createRun(),
      ports = createPorts();
    handleNativeTeammateUserMessage(
      run,
      {
        content: `${native}\n${teammateMessage('dynamic-worker', 'Ready')}`,
      },
      ports
    );
    expect(vi.mocked(ports.setMemberSpawnStatus).mock.calls.map((call) => call[1])).toEqual([
      'worker',
      'dynamic-worker',
    ]);
    expect(ports.rememberSameTeamNativeFingerprints).toHaveBeenCalledOnce();
  });

  it('intercepts teammate permission requests from native user messages', () => {
    const run = createRun();
    const ports = createPorts();
    const permissionRequest = {
      type: 'permission_request',
      request_id: 'req-1',
      agent_id: 'worker',
      tool_name: 'Edit',
      tool_use_id: 'tool-1',
      description: 'edit file',
      input: {},
      permission_suggestions: [],
    };

    handleNativeTeammateUserMessage(
      run,
      { content: teammateMessage('worker', JSON.stringify(permissionRequest)) },
      ports
    );

    expect(ports.handleTeammatePermissionRequest).toHaveBeenCalledWith(
      run,
      expect.objectContaining<Partial<ParsedPermissionRequest>>({
        requestId: 'req-1',
        agentId: 'worker',
        toolName: 'Edit',
      }),
      '2026-01-01T00:00:00.000Z'
    );
  });

  it('sets same-team heartbeat statuses and schedules same-team reconciliation', () => {
    const run = createRun();
    const ports = createPorts();

    handleNativeTeammateUserMessage(
      run,
      { content: teammateMessage('worker', 'Ready for tasks') },
      ports
    );

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      run,
      'worker',
      'online',
      undefined,
      'heartbeat'
    );
    expect(ports.rememberSameTeamNativeFingerprints).toHaveBeenCalledWith('alpha', [
      expect.objectContaining<Partial<ParsedTeammateContent>>({
        teammateId: 'worker',
        content: 'Ready for tasks',
      }),
    ]);
    expect(ports.reconcileSameTeamNativeDeliveries).toHaveBeenCalledWith('alpha', 'lead');
  });

  it('records bootstrap failure messages from same-team blocks', () => {
    const run = createRun();
    const ports = createPorts();

    handleNativeTeammateUserMessage(
      run,
      { content: teammateMessage('worker', 'Bootstrap failed: member_briefing tool not found') },
      ports
    );

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      run,
      'worker',
      'error',
      'Bootstrap failed: member_briefing tool not found'
    );
  });

  it('reconciles cross-team blocks and records reply hints for fresh matches', async () => {
    const run = createRun();
    const ports = createPorts({
      matchCrossTeamLeadInboxMessages: vi.fn().mockResolvedValue([
        {
          teammateId: 'beta.team-lead',
          content: 'body',
          toTeam: 'beta',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          wasRead: false,
        },
      ]),
    });

    handleNativeTeammateUserMessage(
      run,
      {
        content: teammateMessage(
          'beta.team-lead',
          '<cross-team from="beta.team-lead" depth="0" conversationId="conv-1" />\nhello'
        ),
      },
      ports
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ports.matchCrossTeamLeadInboxMessages).toHaveBeenCalledWith('alpha', 'lead', [
      expect.objectContaining({
        teammateId: 'beta.team-lead',
        toTeam: 'beta',
        conversationId: 'conv-1',
      }),
    ]);
    expect(ports.markInboxMessagesRead).toHaveBeenCalledWith('alpha', 'lead', [
      expect.objectContaining({ messageId: 'msg-1' }),
    ]);
    expect(run.activeCrossTeamReplyHints).toEqual([{ toTeam: 'beta', conversationId: 'conv-1' }]);
  });

  it('isolates cross-team matching failures from the fire-and-forget caller', async () => {
    const existingHints = [{ toTeam: 'gamma', conversationId: 'conv-existing' }];
    const run = createRun({ activeCrossTeamReplyHints: existingHints });
    const ports = createPorts({
      matchCrossTeamLeadInboxMessages: vi.fn().mockRejectedValue(new Error('inbox unavailable')),
    });

    handleNativeTeammateUserMessage(
      run,
      {
        content: teammateMessage(
          'beta.team-lead',
          '<cross-team from="beta.team-lead" depth="0" conversationId="conv-1" />\nhello'
        ),
      },
      ports
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ports.matchCrossTeamLeadInboxMessages).toHaveBeenCalledOnce();
    expect(ports.markInboxMessagesRead).not.toHaveBeenCalled();
    expect(run.activeCrossTeamReplyHints).toBe(existingHints);
  });

  it('ignores stale cross-team matches for active reply hints', async () => {
    const recent = new Map([['alpha', new Map([['msg-1', 900]])]]);
    const run = createRun();
    const ports = createPorts({
      recentCrossTeamLeadDeliveryMessageIds: recent,
      matchCrossTeamLeadInboxMessages: vi.fn().mockResolvedValue([
        {
          teammateId: 'beta.team-lead',
          content: 'body',
          toTeam: 'beta',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          wasRead: true,
        },
      ]),
    });

    handleNativeTeammateUserMessage(
      run,
      {
        content: teammateMessage(
          'beta.team-lead',
          '<cross-team from="beta.team-lead" depth="0" conversationId="conv-1" />\nhello'
        ),
      },
      ports
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(run.activeCrossTeamReplyHints).toEqual([]);
  });
});
