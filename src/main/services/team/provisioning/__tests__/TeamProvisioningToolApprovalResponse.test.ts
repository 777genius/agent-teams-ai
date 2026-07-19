import { describe, expect, it, vi } from 'vitest';

import {
  answerRuntimeToolApprovalResponse,
  respondToToolApprovalResponse,
  type TeamProvisioningToolApprovalResponsePorts,
  type TeamProvisioningToolApprovalResponseRun,
} from '../TeamProvisioningToolApprovalResponse';

import type { RuntimeToolApprovalEntry } from '../../approvals/RuntimeToolApprovalCoordinator';
import type { TeamProvisioningLeadToolApprovalResponsePorts } from '../TeamProvisioningLeadToolApproval';
import type { OpenCodeRuntimeToolApprovalAnswerPorts } from '../TeamProvisioningRuntimeToolApprovalAnswer';
import type { InboxMessage, ToolApprovalRequest } from '@shared/types';

describe('tool approval response boundary', () => {
  it('returns after runtime approvals handle the response', async () => {
    const ports = createResponsePorts({
      runtimeRespond: vi.fn(async () => true),
      leadPorts: {
        getTrackedRunId: vi.fn(() => {
          throw new Error('lead response should not be consulted');
        }),
      },
    });

    await respondToToolApprovalResponse(
      {
        teamName: 'alpha',
        runId: 'run-1',
        requestId: 'req-runtime',
        allow: true,
      },
      ports
    );

    expect(ports.runtimeToolApprovalCoordinator.respond).toHaveBeenCalledWith(
      'alpha',
      'run-1',
      'req-runtime',
      true,
      undefined
    );
  });

  it('responds to teammate permission requests and clears approval state', async () => {
    const run = buildRun({ leadName: 'Exact Lead Identity' });
    run.pendingApprovals.set('req-worker', buildApproval({ requestId: 'req-worker' }));
    const persistedMessages: InboxMessage[] = [];
    const dismissApprovalNotification = vi.fn();
    const ports = createResponsePorts({
      run,
      teammatePorts: {
        persistInboxMessage: vi.fn((_teamName, _recipient, message) => {
          persistedMessages.push(message);
        }),
      },
      leadPorts: { dismissApprovalNotification },
    });

    await respondToToolApprovalResponse(
      {
        teamName: 'alpha',
        runId: 'run-1',
        requestId: 'req-worker',
        allow: false,
        message: 'not now',
      },
      ports
    );

    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0]).toMatchObject({
      from: 'Exact Lead Identity',
      to: 'Worker',
      summary: 'Denied Bash request',
      source: 'lead_process',
    });
    expect(run.pendingApprovals.has('req-worker')).toBe(false);
    expect(ports.leadToolApprovalResponsePorts.inFlightResponses.has('req-worker')).toBe(false);
    expect(dismissApprovalNotification).toHaveBeenCalledWith('req-worker');
  });

  it('holds the non-lead claim across an allow redirect and releases it after completion', async () => {
    const run = buildRun();
    run.pendingApprovals.set(
      'req-worker',
      buildApproval({
        requestId: 'req-worker',
        permissionSuggestions: [{ type: 'addRules', rules: [{ toolName: 'Edit' }] }],
      })
    );
    let releaseConfigRead: (() => void) | undefined;
    const configRead = new Promise<void>((resolve) => {
      releaseConfigRead = resolve;
    });
    const ports = createResponsePorts({
      run,
      teammatePorts: {
        readConfigForStrictDecision: vi.fn(async () => {
          await configRead;
          return null;
        }),
      },
    });

    const firstResponse = respondToToolApprovalResponse(
      {
        teamName: 'alpha',
        runId: 'run-1',
        requestId: 'req-worker',
        allow: true,
      },
      ports
    );
    await vi.waitFor(() => {
      expect(ports.leadToolApprovalResponsePorts.inFlightResponses.has('req-worker')).toBe(true);
    });

    await expect(
      respondToToolApprovalResponse(
        {
          teamName: 'alpha',
          runId: 'run-1',
          requestId: 'req-worker',
          allow: false,
        },
        ports
      )
    ).resolves.toBeUndefined();
    expect(run.pendingApprovals.has('req-worker')).toBe(true);

    releaseConfigRead?.();
    await firstResponse;

    expect(run.pendingApprovals.has('req-worker')).toBe(false);
    expect(ports.leadToolApprovalResponsePorts.inFlightResponses.has('req-worker')).toBe(false);
  });

  it('restores timeout tracking when teammate permission response fails', async () => {
    const run = buildRun();
    run.pendingApprovals.set('req-worker', buildApproval({ requestId: 'req-worker' }));
    const startApprovalTimeout = vi.fn();
    const ports = createResponsePorts({
      run,
      teammatePorts: {
        persistInboxMessage: vi.fn(() => {
          throw new Error('inbox unavailable');
        }),
      },
      leadPorts: { startApprovalTimeout },
    });

    await expect(
      respondToToolApprovalResponse(
        {
          teamName: 'alpha',
          runId: 'run-1',
          requestId: 'req-worker',
          allow: false,
        },
        ports
      )
    ).rejects.toThrow('inbox unavailable');

    expect(run.pendingApprovals.has('req-worker')).toBe(true);
    expect(ports.leadToolApprovalResponsePorts.inFlightResponses.has('req-worker')).toBe(false);
    expect(startApprovalTimeout).toHaveBeenCalledWith(run, 'req-worker');
  });

  it('releases the non-lead claim when successful delivery cleanup throws', async () => {
    const run = buildRun();
    run.pendingApprovals.set('req-worker', buildApproval({ requestId: 'req-worker' }));
    const ports = createResponsePorts({
      run,
      leadPorts: {
        dismissApprovalNotification: vi.fn(() => {
          throw new Error('notification cleanup failed');
        }),
      },
    });

    await expect(
      respondToToolApprovalResponse(
        {
          teamName: 'alpha',
          runId: 'run-1',
          requestId: 'req-worker',
          allow: false,
        },
        ports
      )
    ).rejects.toThrow('notification cleanup failed');

    expect(run.pendingApprovals.has('req-worker')).toBe(false);
    expect(ports.leadToolApprovalResponsePorts.inFlightResponses.has('req-worker')).toBe(false);
  });

  it('delegates runtime approval answers through the extracted runtime answer use case', async () => {
    await expect(
      answerRuntimeToolApprovalResponse(
        {
          entry: buildRuntimeEntry({
            providerId: 'anthropic' as RuntimeToolApprovalEntry['providerId'],
          }),
          allow: true,
        },
        {} as OpenCodeRuntimeToolApprovalAnswerPorts<TestRuntimeRun>
      )
    ).rejects.toThrow('Runtime approval provider is not supported: anthropic');
  });
});

interface TestRun extends TeamProvisioningToolApprovalResponseRun {
  child: {
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
    };
  };
}

interface TestRuntimeRun {
  mixedSecondaryLanes?: [];
}

function createResponsePorts(
  input: {
    run?: TestRun;
    runtimeRespond?: ReturnType<typeof vi.fn>;
    leadPorts?: Partial<TeamProvisioningLeadToolApprovalResponsePorts<TestRun>>;
    teammatePorts?: Partial<
      TeamProvisioningToolApprovalResponsePorts<TestRun>['teammatePermissionResponsePorts']
    >;
  } = {}
): TeamProvisioningToolApprovalResponsePorts<TestRun> {
  const run = input.run ?? buildRun();
  const inFlightResponses = new Set<string>();
  const leadPorts: TeamProvisioningLeadToolApprovalResponsePorts<TestRun> = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getTrackedRunId: vi.fn(() => run.runId),
    getRun: vi.fn((runId) => (runId === run.runId ? run : undefined)),
    clearApprovalTimeout: vi.fn(),
    tryClaimResponse: vi.fn((requestId: string) => {
      if (inFlightResponses.has(requestId)) return false;
      inFlightResponses.add(requestId);
      return true;
    }),
    inFlightResponses,
    startApprovalTimeout: vi.fn(),
    dismissApprovalNotification: vi.fn(),
    buildLeadToolApprovalDecisionPayload: vi.fn(() => {
      throw new Error('lead control response should not be written');
    }),
    ...input.leadPorts,
  };

  return {
    runtimeToolApprovalCoordinator: {
      respond: input.runtimeRespond ?? vi.fn(async () => false),
    },
    leadToolApprovalResponsePorts: leadPorts,
    teammatePermissionResponsePorts: {
      readConfigForStrictDecision: vi.fn(async () => null),
      addPermissionRulesToSettings: vi.fn(async () => 0),
      persistInboxMessage: vi.fn(),
      emitTeamChange: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
      nowMs: vi.fn(() => 123),
      joinPath: vi.fn((...parts: string[]) => parts.join('/')),
      teammateOperationalToolNames: [],
      ...input.teammatePorts,
    },
  };
}

function buildRun(options: { leadName?: string } = {}): TestRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    request: {
      color: 'blue',
      displayName: 'Alpha Team',
      members: [{ name: options.leadName ?? 'Lead', role: 'lead' }],
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
  };
}

function buildApproval(
  input: Partial<ToolApprovalRequest> & { requestId: string }
): ToolApprovalRequest {
  return {
    requestId: input.requestId,
    runId: input.runId ?? 'run-1',
    teamName: input.teamName ?? 'alpha',
    source: input.source ?? 'Worker',
    toolName: input.toolName ?? 'Bash',
    toolInput: input.toolInput ?? { command: 'pnpm test' },
    receivedAt: input.receivedAt ?? '2026-01-01T00:00:00.000Z',
    permissionSuggestions: input.permissionSuggestions,
  };
}

function buildRuntimeEntry(
  input: Partial<RuntimeToolApprovalEntry> = {}
): RuntimeToolApprovalEntry {
  const approval = buildApproval({ requestId: 'runtime-req', source: 'Worker' });
  return {
    providerId: 'opencode',
    providerRequestId: 'provider-req',
    laneId: 'primary',
    memberName: 'Worker',
    approval,
    ...input,
  };
}
