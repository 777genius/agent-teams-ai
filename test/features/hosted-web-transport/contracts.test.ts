import {
  HOSTED_WEB_ERROR_CODE_PREFIX,
  HOSTED_WEB_LAST_EVENT_ID_HEADER,
  HOSTED_WEB_SSE_EVENT_TYPES,
  hostedWebErrorCode,
  type HostedWebEvent,
  hostedWebTeamEventsRoute,
  hostedWebTeamRoute,
  type HostedWebTeamSnapshotResponse,
  parseHostedWebSseEvent,
} from '@features/hosted-web-transport/contracts';
import { describe, expect, it } from 'vitest';

describe('hosted web transport contracts', () => {
  it('encodes hosted v1 route identities without raw path segments', () => {
    expect(hostedWebTeamRoute('team/slash value')).toBe(
      '/api/hosted/v1/teams/team%2Fslash%20value'
    );
    expect(hostedWebTeamEventsRoute('team/slash value', { cursor: 'event 1' })).toBe(
      '/api/hosted/v1/events?teamId=team%2Fslash+value&cursor=event+1'
    );
    expect(HOSTED_WEB_LAST_EVENT_ID_HEADER).toBe('Last-Event-ID');
  });

  it('models hosted snapshots with workspace ref DTOs and no backend-only provider fields', () => {
    const snapshot: HostedWebTeamSnapshotResponse = {
      team: {
        teamId: 'demo-team',
        displayName: 'Demo Team',
        description: 'Hosted-safe team',
        project: {
          workspaceRef: {
            id: 'workspace_123',
            displayName: 'agent-teams-ai',
            repositoryLabel: 'agent-teams-ai',
            branchLabel: 'feature/hosted',
          },
        },
        members: [
          {
            memberId: 'lead',
            displayName: 'Lead',
            currentTaskId: null,
            taskCount: 1,
            isolation: 'managed-worktree',
            provider: {
              providerId: 'codex',
              modelId: 'gpt-5.2',
            },
          },
        ],
        taskCount: 1,
        lastActivity: '2026-07-10T00:00:00.000Z',
        runtime: {
          isAlive: true,
          terminalAvailable: true,
          activeProcessCount: 1,
        },
      },
      tasks: [
        {
          taskId: 'task-1',
          subject: 'Build transport contract',
          status: 'in_progress',
          ownerMemberId: 'lead',
        },
      ],
      kanban: [{ status: 'in_progress', taskIds: ['task-1'] }],
      revision: 'rev-1',
    };

    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('"workspaceRef":{"id":"workspace_123"');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('"cwd"');
    expect(serialized).not.toContain('"providerBackendId"');
    expect(serialized).not.toContain('"rawProviderJson"');
  });

  it('validates typed SSE envelopes, payloads, and resume cursors at runtime', () => {
    const event: HostedWebEvent = {
      type: 'hosted.runtime.state',
      eventId: 'event-1',
      teamId: 'demo-team',
      emittedAt: '2026-07-10T00:00:00.000Z',
      payload: {
        isAlive: true,
        terminalAvailable: true,
        activeTerminalSessionIds: [],
      },
    };

    expect(
      parseHostedWebSseEvent('hosted.runtime.state', JSON.stringify(event), {
        lastEventId: 'event-1',
      })
    ).toEqual(event);
    expect(() => parseHostedWebSseEvent('hosted.task.changed', JSON.stringify(event))).toThrow(
      /type mismatch/
    );
    expect(() =>
      parseHostedWebSseEvent(
        'hosted.runtime.state',
        JSON.stringify({ ...event, payload: { isAlive: 'yes' } })
      )
    ).toThrow(/payload.isAlive/);
    expect(() =>
      parseHostedWebSseEvent('hosted.runtime.state', JSON.stringify(event), {
        lastEventId: 'event-0',
      })
    ).toThrow(/cursor mismatch/);
  });

  it('validates nested SSE team, task, and member payload fields', () => {
    const snapshotEvent: HostedWebEvent = {
      type: 'hosted.team.snapshot',
      eventId: 'event-snapshot',
      teamId: 'demo-team',
      emittedAt: '2026-07-10T00:00:00.000Z',
      payload: {
        team: {
          teamId: 'demo-team',
          displayName: 'Demo Team',
          description: '',
          project: null,
          members: [
            {
              memberId: 'lead',
              displayName: 'Lead',
              provider: { providerId: 'codex', modelId: 'gpt-5.2', effort: 'high' },
              currentTaskId: null,
              taskCount: 1,
            },
          ],
          taskCount: 1,
          lastActivity: null,
          runtime: { isAlive: true, terminalAvailable: true, activeProcessCount: 1 },
        },
        tasks: [{ taskId: 'task-1', subject: 'Validate payloads', status: 'pending' }],
        kanban: [{ status: 'pending', taskIds: ['task-1'] }],
        revision: 'rev-1',
      },
    };
    expect(parseHostedWebSseEvent('hosted.team.snapshot', JSON.stringify(snapshotEvent))).toEqual(
      snapshotEvent
    );

    expect(() =>
      parseHostedWebSseEvent(
        'hosted.team.snapshot',
        JSON.stringify({
          ...snapshotEvent,
          payload: {
            ...snapshotEvent.payload,
            team: {
              ...snapshotEvent.payload.team,
              members: [
                {
                  ...snapshotEvent.payload.team.members[0],
                  provider: { providerId: 'unsafe-provider' },
                },
              ],
            },
          },
        })
      )
    ).toThrow(/provider\.providerId/);

    const memberMessageEvent: HostedWebEvent = {
      type: 'hosted.member.message',
      eventId: 'event-message',
      teamId: 'demo-team',
      emittedAt: '2026-07-10T00:00:00.000Z',
      payload: {
        messageId: 'message-1',
        fromMemberId: 'lead',
        summary: 'Done',
        body: 'Task finished',
        createdAt: '2026-07-10T00:00:00.000Z',
      },
    };
    expect(() =>
      parseHostedWebSseEvent(
        'hosted.member.message',
        JSON.stringify({
          ...memberMessageEvent,
          payload: { ...memberMessageEvent.payload, summary: 42 },
        })
      )
    ).toThrow(/payload\.summary/);
  });

  it('keeps hosted error payloads namespaced under /api/hosted/v1', () => {
    const namespaced = hostedWebErrorCode('not_found');
    expect(namespaced).toBe(`${HOSTED_WEB_ERROR_CODE_PREFIX}not_found`);

    const event: HostedWebEvent = {
      type: 'hosted.error',
      eventId: 'event-2',
      teamId: 'demo-team',
      emittedAt: '2026-07-10T00:00:00.000Z',
      payload: {
        code: namespaced,
        message: 'Not found',
      },
    };

    expect(parseHostedWebSseEvent('hosted.error', JSON.stringify(event))).toEqual(event);
    expect(() =>
      parseHostedWebSseEvent(
        'hosted.error',
        JSON.stringify({ ...event, payload: { code: 'not_found', message: 'Not found' } })
      )
    ).toThrow(/namespaced/);
  });

  it('does not define terminal byte delivery over SSE', () => {
    expect(HOSTED_WEB_SSE_EVENT_TYPES).not.toContain('hosted.terminal.bytes');
  });
});
