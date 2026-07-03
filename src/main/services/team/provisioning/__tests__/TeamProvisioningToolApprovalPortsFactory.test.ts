import { type InboxMessage } from '@shared/types';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeRuntimeToolApprovalAnswerPortsFromDeps,
  createTeamProvisioningToolApprovalPortsBoundary,
  createTeamProvisioningToolApprovalResponsePortsFromDeps,
  type TeamProvisioningToolApprovalPortsFactoryDeps,
  type TeamProvisioningToolApprovalPortsFactoryRun,
} from '../TeamProvisioningToolApprovalPortsFactory';

describe('team provisioning tool approval ports factory', () => {
  it('wires lead control requests to approval dependencies', () => {
    const run = buildRun();
    const deps = buildDeps(run);
    const boundary = createTeamProvisioningToolApprovalPortsBoundary(deps);

    boundary.handleControlRequest(run, {
      request_id: 'req-lead',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'rm -rf dist' },
      },
    });

    expect(deps.getToolApprovalSettings).toHaveBeenCalledWith('alpha');
    expect(deps.emitToolApprovalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-lead',
        runId: 'run-1',
        teamName: 'alpha',
        toolName: 'Bash',
      })
    );
    expect(deps.startApprovalTimeout).toHaveBeenCalledWith(run, 'req-lead');
    expect(deps.maybeShowToolApprovalOsNotification).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ requestId: 'req-lead' })
    );
  });

  it('builds teammate permission response ports from the same dependency seam', async () => {
    const run = buildRun();
    const persistedMessages: InboxMessage[] = [];
    const deps = buildDeps(run, {
      persistInboxMessage: vi.fn((_teamName, _recipient, message) => {
        persistedMessages.push(message);
      }),
    });
    const boundary = createTeamProvisioningToolApprovalPortsBoundary(deps);

    await boundary.respondToTeammatePermission({
      run,
      agentId: 'Worker',
      requestId: 'req-worker',
      allow: false,
      message: 'denied',
      toolName: 'Bash',
    });

    expect(deps.persistInboxMessage).toHaveBeenCalledWith(
      'alpha',
      'Worker',
      expect.objectContaining({
        from: 'Lead',
        to: 'Worker',
        summary: 'Denied Bash request',
        source: 'lead_process',
      })
    );
    expect(persistedMessages).toHaveLength(1);
    expect(deps.emitTeamChange).toHaveBeenCalledWith({
      type: 'inbox',
      teamName: 'alpha',
      detail: 'inboxes/Worker.json',
    });
  });

  it('wires response and runtime answer ports explicitly', () => {
    const run = buildRun();
    const deps = buildDeps(run);

    const responsePorts = createTeamProvisioningToolApprovalResponsePortsFromDeps(deps);
    expect(responsePorts.runtimeToolApprovalCoordinator).toBe(deps.runtimeToolApprovalCoordinator);

    responsePorts.leadToolApprovalResponsePorts.clearApprovalTimeout('req-lead');
    expect(deps.clearApprovalTimeout).toHaveBeenCalledWith('req-lead');

    const runtimePorts = createOpenCodeRuntimeToolApprovalAnswerPortsFromDeps(deps);
    runtimePorts.setRuntimeAdapterRunByTeam('alpha', {
      runId: 'run-1',
      providerId: 'opencode',
    });
    runtimePorts.emitTeamChange({
      type: 'process',
      teamName: 'alpha',
      runId: 'run-1',
      detail: 'permission-allowed',
    });

    expect(deps.setRuntimeAdapterRunByTeam).toHaveBeenCalledWith('alpha', {
      runId: 'run-1',
      providerId: 'opencode',
    });
    expect(deps.emitTeamChange).toHaveBeenCalledWith({
      type: 'process',
      teamName: 'alpha',
      runId: 'run-1',
      detail: 'permission-allowed',
    });
  });
});

interface TestRun extends TeamProvisioningToolApprovalPortsFactoryRun {
  child: {
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
    };
  };
}

function buildRun(): TestRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    request: {
      color: 'blue',
      displayName: 'Alpha Team',
      members: [
        { name: 'Lead', role: 'lead' },
        { name: 'Worker', role: 'engineer' },
      ],
    },
    child: {
      stdin: {
        writable: true,
        write: vi.fn((_data: string, callback?: (err?: Error | null) => void) => {
          callback?.(null);
          return true;
        }),
      },
    },
    pendingApprovals: new Map(),
    processedPermissionRequestIds: new Set(),
    mixedSecondaryLanes: [],
  };
}

function buildDeps(
  run: TestRun,
  overrides: Partial<TeamProvisioningToolApprovalPortsFactoryDeps<TestRun>> = {}
): TeamProvisioningToolApprovalPortsFactoryDeps<TestRun> {
  const inFlightResponses = new Set<string>();
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getToolApprovalSettings: vi.fn(() => DEFAULT_TOOL_APPROVAL_SETTINGS),
    emitToolApprovalEvent: vi.fn(),
    startApprovalTimeout: vi.fn(),
    clearApprovalTimeout: vi.fn(),
    tryClaimResponse: vi.fn((requestId: string) => {
      if (inFlightResponses.has(requestId)) return false;
      inFlightResponses.add(requestId);
      return true;
    }),
    maybeShowToolApprovalOsNotification: vi.fn(),
    dismissApprovalNotification: vi.fn(),
    getTrackedRunId: vi.fn(() => run.runId),
    getRun: vi.fn((runId) => (runId === run.runId ? run : undefined)),
    inFlightResponses,
    runtimeToolApprovalCoordinator: {
      respond: vi.fn(async () => false),
    },
    getOpenCodeRuntimeAdapter: vi.fn(() => null),
    readLaunchState: vi.fn(async () => null),
    persistOpenCodeRuntimeAdapterLaunchResult: vi.fn(async (result) => ({ result })),
    deleteRuntimeAdapterRunByTeam: vi.fn(),
    setRuntimeAdapterRunByTeam: vi.fn(),
    setAliveRunId: vi.fn(),
    guardCommittedOpenCodeSecondaryLaneEvidence: vi.fn(async ({ result }) => result),
    publishMixedSecondaryLaneStatusChange: vi.fn(async () => undefined),
    syncOpenCodeRuntimeToolApprovals: vi.fn(),
    emitTeamChange: vi.fn(),
    readConfigForStrictDecision: vi.fn(async () => null),
    addPermissionRulesToSettings: vi.fn(async () => 0),
    persistInboxMessage: vi.fn(),
    nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
    nowMs: vi.fn(() => 123),
    joinPath: vi.fn((...parts: string[]) => parts.join('/')),
    teammateOperationalToolNames: [],
    ...overrides,
  };
}
