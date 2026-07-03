import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  autoAllowLeadControlRequest,
  autoDenyLeadControlRequest,
  createDefaultLeadToolApprovalPorts,
  handleLeadControlRequest,
  respondToLeadToolApproval,
  type TeamProvisioningLeadToolApprovalPorts,
  type TeamProvisioningLeadToolApprovalResponsePorts,
  type TeamProvisioningLeadToolApprovalRun,
} from '../TeamProvisioningLeadToolApproval';
import {
  buildLeadToolApprovalDecisionPayload,
  buildLeadToolApprovalRequest,
  TOOL_APPROVAL_TIMEOUT_CONTROL_DENY_MESSAGE,
} from '../TeamProvisioningToolApprovalFlow';

import type { ToolApprovalEvent, ToolApprovalRequest, ToolApprovalSettings } from '@shared/types';

describe('lead tool approval control requests', () => {
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let settings: ToolApprovalSettings;
  let emittedEvents: ToolApprovalEvent[];
  let startApprovalTimeout: ReturnType<typeof vi.fn>;
  let maybeShowToolApprovalOsNotification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    settings = buildSettings();
    emittedEvents = [];
    startApprovalTimeout = vi.fn();
    maybeShowToolApprovalOsNotification = vi.fn();
  });

  it('warns and no-ops when request_id is missing', () => {
    const run = buildRun();

    handleLeadControlRequest(
      run,
      { request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } },
      createPorts()
    );

    expect(logger.warn).toHaveBeenCalledWith('[alpha] control_request missing request_id, ignoring');
    expect(run.pendingApprovals.size).toBe(0);
    expect(run.child?.stdin?.write).not.toHaveBeenCalled();
    expect(emittedEvents).toEqual([]);
  });

  it('auto-allows non-tool control requests', () => {
    const run = buildRun();

    handleLeadControlRequest(
      run,
      { request_id: 'req-hook', request: { subtype: 'hook_callback' } },
      createPorts()
    );

    expect(logger.debug).toHaveBeenCalledWith(
      '[alpha] control_request subtype=hook_callback, auto-allowing to prevent deadlock'
    );
    expect(run.child?.stdin?.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-hook',
          response: { behavior: 'allow', updatedInput: {} },
        },
      })}\n`,
      expect.any(Function)
    );
    expect(run.pendingApprovals.size).toBe(0);
  });

  it('auto-allows matching can_use_tool requests and emits an auto-resolved event', () => {
    const run = buildRun();

    handleLeadControlRequest(
      run,
      {
        request_id: 'req-auto',
        request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: 'a.ts' } },
      },
      createPorts({
        shouldAutoAllow: vi.fn(() => ({ autoAllow: true, reason: 'auto_allow_category' })),
      })
    );

    expect(logger.info).toHaveBeenCalledWith(
      '[alpha] Auto-allowing Edit (auto_allow_category)'
    );
    expect(run.child?.stdin?.write).toHaveBeenCalledTimes(1);
    expect(emittedEvents).toEqual([
      {
        autoResolved: true,
        requestId: 'req-auto',
        runId: 'run-1',
        teamName: 'alpha',
        reason: 'auto_allow_category',
      },
    ]);
    expect(run.pendingApprovals.size).toBe(0);
  });

  it('tracks manual lead approvals before starting timeout and notification', () => {
    const run = buildRun();

    handleLeadControlRequest(
      run,
      {
        request_id: 'req-manual',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { provider: 'codex', command: 'pnpm test' },
        },
      },
      createPorts()
    );

    const approval = run.pendingApprovals.get('req-manual');
    expect(approval).toMatchObject({
      requestId: 'req-manual',
      runId: 'run-1',
      teamName: 'alpha',
      providerId: 'codex',
      source: 'lead',
      toolName: 'Bash',
      toolInput: { provider: 'codex', command: 'pnpm test' },
      teamColor: 'blue',
      teamDisplayName: 'Alpha Team',
    });
    expect(emittedEvents).toEqual([approval]);
    expect(startApprovalTimeout).toHaveBeenCalledWith(run, 'req-manual');
    expect(maybeShowToolApprovalOsNotification).toHaveBeenCalledWith(run, approval);
    expect(startApprovalTimeout.mock.invocationCallOrder[0]).toBeLessThan(
      maybeShowToolApprovalOsNotification.mock.invocationCallOrder[0]
    );
  });

  it('writes auto allow and deny payloads and logs write errors', () => {
    const allowRun = buildRun({ writeError: new Error('allow failed') });
    const denyRun = buildRun({ writeError: new Error('deny failed') });
    const ports = createPorts();

    autoAllowLeadControlRequest(allowRun, 'req-allow', ports);
    autoDenyLeadControlRequest(denyRun, 'req-deny', ports);

    expect(allowRun.child?.stdin?.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-allow',
          response: { behavior: 'allow', updatedInput: {} },
        },
      })}\n`,
      expect.any(Function)
    );
    expect(denyRun.child?.stdin?.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-deny',
          response: {
            behavior: 'deny',
            message: TOOL_APPROVAL_TIMEOUT_CONTROL_DENY_MESSAGE,
          },
        },
      })}\n`,
      expect.any(Function)
    );
    expect(logger.error).toHaveBeenCalledWith(
      '[alpha] Failed to auto-allow control_request req-allow: allow failed'
    );
    expect(logger.error).toHaveBeenCalledWith(
      '[alpha] Failed to auto-deny control_request req-deny: deny failed'
    );
  });

  function createPorts(
    overrides: Partial<TeamProvisioningLeadToolApprovalPorts<TestRun>> = {}
  ): TeamProvisioningLeadToolApprovalPorts<TestRun> {
    return {
      ...createDefaultLeadToolApprovalPorts<TestRun>({
        logger,
        getSettings: () => settings,
        emitToolApprovalEvent: (event) => emittedEvents.push(event),
        startApprovalTimeout,
        maybeShowToolApprovalOsNotification,
      }),
      ...overrides,
    };
  }
});

describe('lead tool approval responses', () => {
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let run: TestRun;
  let runs: Map<string, TestRun>;
  let inFlightResponses: Set<string>;
  let clearApprovalTimeout: ReturnType<typeof vi.fn>;
  let startApprovalTimeout: ReturnType<typeof vi.fn>;
  let dismissApprovalNotification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    run = buildRun();
    runs = new Map([[run.runId, run]]);
    inFlightResponses = new Set();
    clearApprovalTimeout = vi.fn();
    startApprovalTimeout = vi.fn();
    dismissApprovalNotification = vi.fn();
  });

  it('rejects stale run approvals before writing', async () => {
    run.pendingApprovals.set('req-stale', buildApproval({ requestId: 'req-stale' }));

    await expect(
      respondToLeadToolApproval(
        { teamName: 'alpha', runId: 'stale-run', requestId: 'req-stale', allow: true },
        createResponsePorts()
      )
    ).rejects.toThrow('Stale approval: runId mismatch (expected run-1, got stale-run)');

    expect(clearApprovalTimeout).not.toHaveBeenCalled();
    expect(run.child?.stdin?.write).not.toHaveBeenCalled();
  });

  it('restarts timeout and leaves pending approval when stdin is not writable', async () => {
    run = buildRun({ writable: false });
    runs.set(run.runId, run);
    run.pendingApprovals.set('req-unwritable', buildApproval({ requestId: 'req-unwritable' }));

    await expect(
      respondToLeadToolApproval(
        { teamName: 'alpha', runId: 'run-1', requestId: 'req-unwritable', allow: true },
        createResponsePorts()
      )
    ).rejects.toThrow('Team "alpha" process stdin is not writable');

    expect(clearApprovalTimeout).toHaveBeenCalledWith('req-unwritable');
    expect(startApprovalTimeout).toHaveBeenCalledWith(run, 'req-unwritable');
    expect(run.pendingApprovals.has('req-unwritable')).toBe(true);
    expect(inFlightResponses.has('req-unwritable')).toBe(false);
  });

  it('writes lead control_response and cleans pending state on success', async () => {
    const approval = buildApproval({ requestId: 'req-success' });
    run.pendingApprovals.set('req-success', approval);

    await expect(
      respondToLeadToolApproval(
        {
          teamName: 'alpha',
          runId: 'run-1',
          requestId: 'req-success',
          allow: true,
          message: 'approved',
        },
        createResponsePorts()
      )
    ).resolves.toEqual({ handled: true });

    expect(run.child?.stdin?.write).toHaveBeenCalledWith(
      `${JSON.stringify(
        buildLeadToolApprovalDecisionPayload({
          requestId: 'req-success',
          approval,
          allow: true,
          message: 'approved',
        })
      )}\n`,
      expect.any(Function)
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[alpha] Writing control_response for req-success: allow'
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[alpha] control_response written successfully for req-success'
    );
    expect(run.pendingApprovals.has('req-success')).toBe(false);
    expect(inFlightResponses.has('req-success')).toBe(false);
    expect(dismissApprovalNotification).toHaveBeenCalledWith('req-success');
  });

  it('restarts timeout and keeps pending approval when write fails', async () => {
    run = buildRun({ writeError: new Error('write failed') });
    runs.set(run.runId, run);
    run.pendingApprovals.set('req-fail', buildApproval({ requestId: 'req-fail' }));

    await expect(
      respondToLeadToolApproval(
        { teamName: 'alpha', runId: 'run-1', requestId: 'req-fail', allow: false },
        createResponsePorts()
      )
    ).rejects.toThrow('write failed');

    expect(logger.error).toHaveBeenCalledWith(
      '[alpha] Failed to write control_response: write failed'
    );
    expect(startApprovalTimeout).toHaveBeenCalledWith(run, 'req-fail');
    expect(run.pendingApprovals.has('req-fail')).toBe(true);
    expect(inFlightResponses.has('req-fail')).toBe(false);
  });

  it('restarts timeout and keeps pending approval when write callback times out', async () => {
    vi.useFakeTimers();
    try {
      run = buildRun({ writeCallback: false });
      runs.set(run.runId, run);
      run.pendingApprovals.set('req-timeout', buildApproval({ requestId: 'req-timeout' }));

      const response = respondToLeadToolApproval(
        { teamName: 'alpha', runId: 'run-1', requestId: 'req-timeout', allow: true },
        createResponsePorts()
      );
      const responseExpectation = expect(response).rejects.toThrow(
        'Timeout writing control_response to stdin (process may have exited)'
      );
      await vi.advanceTimersByTimeAsync(5000);

      await responseExpectation;
      expect(startApprovalTimeout).toHaveBeenCalledWith(run, 'req-timeout');
      expect(run.pendingApprovals.has('req-timeout')).toBe(true);
      expect(inFlightResponses.has('req-timeout')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  function createResponsePorts(
    overrides: Partial<TeamProvisioningLeadToolApprovalResponsePorts<TestRun>> = {}
  ): TeamProvisioningLeadToolApprovalResponsePorts<TestRun> {
    return {
      logger,
      getTrackedRunId: () => 'run-1',
      getRun: (runId) => runs.get(runId),
      clearApprovalTimeout,
      tryClaimResponse: (requestId) => {
        if (inFlightResponses.has(requestId)) return false;
        inFlightResponses.add(requestId);
        return true;
      },
      inFlightResponses,
      startApprovalTimeout,
      dismissApprovalNotification,
      buildLeadToolApprovalDecisionPayload,
      ...overrides,
    };
  }
});

interface TestRun extends TeamProvisioningLeadToolApprovalRun {
  child: {
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
    };
  };
}

function buildRun(
  options: { writable?: boolean; writeError?: Error; writeCallback?: boolean } = {}
): TestRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    request: {
      color: 'blue',
      displayName: 'Alpha Team',
    },
    child: {
      stdin: {
        writable: options.writable ?? true,
        write: vi.fn((_data: string, callback?: (err?: Error | null) => void) => {
          if (options.writeCallback ?? true) {
            callback?.(options.writeError ?? null);
          }
          return true;
        }),
      },
    },
    pendingApprovals: new Map(),
  };
}

function buildSettings(input: Partial<ToolApprovalSettings> = {}): ToolApprovalSettings {
  return {
    autoAllowAll: false,
    autoAllowFileEdits: false,
    autoAllowSafeBash: false,
    timeoutAction: 'wait',
    timeoutSeconds: 30,
    ...input,
  };
}

function buildApproval(input: Partial<ToolApprovalRequest> & { requestId: string }): ToolApprovalRequest {
  return buildLeadToolApprovalRequest({
    requestId: input.requestId,
    runId: input.runId ?? 'run-1',
    teamName: input.teamName ?? 'alpha',
    toolName: input.toolName ?? 'Bash',
    toolInput: input.toolInput ?? { command: 'pnpm test' },
    receivedAt: input.receivedAt ?? '2026-01-01T00:00:00.000Z',
  });
}
