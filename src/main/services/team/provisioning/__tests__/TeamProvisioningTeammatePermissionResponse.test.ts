import { describe, expect, it, vi } from 'vitest';

import {
  respondToTeammatePermission,
  type TeamProvisioningTeammatePermissionResponsePorts,
  type TeamProvisioningTeammatePermissionRun,
} from '../TeamProvisioningTeammatePermissionResponse';

import type { InboxMessage, TeamConfig } from '@shared/types';

function createRun(
  overrides: Partial<TeamProvisioningTeammatePermissionRun> = {}
): TeamProvisioningTeammatePermissionRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    request: {
      members: [
        { name: 'Lead', role: 'Team Lead' },
        { name: 'worker', role: 'Engineer' },
      ],
    },
    ...overrides,
  };
}

function createPorts(
  overrides: Partial<TeamProvisioningTeammatePermissionResponsePorts> = {}
): TeamProvisioningTeammatePermissionResponsePorts {
  return {
    readConfigForStrictDecision: vi.fn().mockResolvedValue({
      projectPath: '/repo',
      members: [{ cwd: '/member-cwd' }],
    } as TeamConfig),
    addPermissionRulesToSettings: vi.fn().mockResolvedValue(1),
    persistInboxMessage: vi.fn(),
    emitTeamChange: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    nowIso: () => '2026-01-01T00:00:00.000Z',
    nowMs: () => 1234,
    joinPath: (...parts) => parts.join('/'),
    teammateOperationalToolNames: [
      'mcp__agent-teams__task_create',
      'mcp__agent-teams__task_update',
    ],
    ...overrides,
  };
}

function lastInboxMessage(ports: TeamProvisioningTeammatePermissionResponsePorts): InboxMessage {
  const persistInboxMessage = vi.mocked(ports.persistInboxMessage);
  expect(persistInboxMessage).toHaveBeenCalled();
  return persistInboxMessage.mock.calls.at(-1)![2];
}

describe('teammate permission responses', () => {
  it('sends a deny permission_response inbox payload', async () => {
    const ports = createPorts();

    await respondToTeammatePermission(
      {
        run: createRun(),
        agentId: 'worker',
        requestId: 'req-1',
        allow: false,
        message: 'No',
        toolName: 'Bash',
      },
      ports
    );

    expect(ports.persistInboxMessage).toHaveBeenCalledWith(
      'alpha',
      'worker',
      expect.objectContaining({
        from: 'Lead',
        to: 'worker',
        timestamp: '2026-01-01T00:00:00.000Z',
        read: false,
        summary: 'Denied Bash request',
        messageId: 'permission-response-run-1-req-1-1234',
        source: 'lead_process',
      })
    );
    expect(JSON.parse(lastInboxMessage(ports).text)).toEqual({
      type: 'permission_response',
      request_id: 'req-1',
      subtype: 'error',
      error: 'No',
    });
    expect(ports.emitTeamChange).toHaveBeenCalledWith({
      type: 'inbox',
      teamName: 'alpha',
      detail: 'inboxes/worker.json',
    });
  });

  it('sends success when allow has no suggestions', async () => {
    const ports = createPorts();

    await respondToTeammatePermission(
      {
        run: createRun(),
        agentId: 'worker',
        requestId: 'req-2',
        allow: true,
        toolName: 'Read',
      },
      ports
    );

    expect(ports.addPermissionRulesToSettings).not.toHaveBeenCalled();
    expect(JSON.parse(lastInboxMessage(ports).text)).toEqual({
      type: 'permission_response',
      request_id: 'req-2',
      subtype: 'success',
      response: {
        permission_updates: [],
      },
    });
  });

  it('translates setMode acceptEdits and bypassPermissions into settings rules', async () => {
    const ports = createPorts();

    await respondToTeammatePermission(
      {
        run: createRun(),
        agentId: 'worker',
        requestId: 'req-3',
        allow: true,
        permissionSuggestions: [
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ],
      },
      ports
    );

    expect(ports.addPermissionRulesToSettings).toHaveBeenNthCalledWith(
      1,
      '/repo/.claude/settings.local.json',
      ['Edit', 'Write', 'NotebookEdit'],
      'allow'
    );
    expect(ports.addPermissionRulesToSettings).toHaveBeenNthCalledWith(
      2,
      '/repo/.claude/settings.local.json',
      ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Read', 'Grep', 'Glob'],
      'allow'
    );
  });

  it('expands teammate operational tool addRules', async () => {
    const ports = createPorts();

    await respondToTeammatePermission(
      {
        run: createRun(),
        agentId: 'worker',
        requestId: 'req-4',
        allow: true,
        permissionSuggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'localSettings',
            rules: [{ toolName: 'mcp__agent-teams__task_create' }, { toolName: 'Edit' }],
          },
        ],
      },
      ports
    );

    expect(ports.addPermissionRulesToSettings).toHaveBeenCalledWith(
      '/repo/.claude/settings.local.json',
      ['mcp__agent-teams__task_create', 'Edit', 'mcp__agent-teams__task_update'],
      'allow'
    );
  });

  it('sends success without writing settings when project cwd is missing', async () => {
    const ports = createPorts({
      readConfigForStrictDecision: vi.fn().mockResolvedValue({ members: [] } as unknown as TeamConfig),
    });

    await respondToTeammatePermission(
      {
        run: createRun(),
        agentId: 'worker',
        requestId: 'req-5',
        allow: true,
        permissionSuggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Edit' }],
          },
        ],
      },
      ports
    );

    expect(ports.addPermissionRulesToSettings).not.toHaveBeenCalled();
    expect(JSON.parse(lastInboxMessage(ports).text)).toMatchObject({
      type: 'permission_response',
      request_id: 'req-5',
      subtype: 'success',
    });
  });

  it('writes stdin control_response success with updatedInput fallback', async () => {
    const write = vi.fn((_data: string, callback?: (err?: Error | null) => void) => {
      callback?.();
    });
    const ports = createPorts();

    await respondToTeammatePermission(
      {
        run: createRun({
          child: {
            stdin: {
              writable: true,
              write,
            },
          },
        }),
        agentId: 'worker',
        requestId: 'req-6',
        allow: true,
      },
      ports
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-6',
        response: { behavior: 'allow', updatedInput: {} },
      },
    });
  });
});
