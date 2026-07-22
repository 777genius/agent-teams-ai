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
