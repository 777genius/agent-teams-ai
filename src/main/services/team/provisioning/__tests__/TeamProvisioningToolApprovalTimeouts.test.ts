import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamProvisioningToolApprovalTimeouts } from '../TeamProvisioningToolApprovalTimeouts';

import type {
  TeamProvisioningToolApprovalTimeoutPorts,
  TeamProvisioningToolApprovalTimeoutRun,
} from '../TeamProvisioningToolApprovalTimeouts';
import type { ToolApprovalRequest, ToolApprovalSettings } from '@shared/types';

function buildApproval(
  input: Partial<ToolApprovalRequest> & Pick<ToolApprovalRequest, 'requestId'>
): ToolApprovalRequest {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    source: 'lead',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf tmp' },
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  };
}

function buildSettings(input: Partial<ToolApprovalSettings> = {}): ToolApprovalSettings {
  return {
    autoAllowAll: false,
    autoAllowFileEdits: false,
    autoAllowSafeBash: false,
    timeoutAction: 'wait',
    timeoutSeconds: 1,
    ...input,
  };
}

describe('TeamProvisioningToolApprovalTimeouts', () => {
  let settings: ToolApprovalSettings;
  let run: TeamProvisioningToolApprovalTimeoutRun;
  let pendingTimeouts: Map<string, NodeJS.Timeout>;
  let inFlightResponses: Set<string>;
  let ports: TeamProvisioningToolApprovalTimeoutPorts<TeamProvisioningToolApprovalTimeoutRun>;
  let timeouts: TeamProvisioningToolApprovalTimeouts<TeamProvisioningToolApprovalTimeoutRun>;

  beforeEach(() => {
    vi.useFakeTimers();
    settings = buildSettings();
    run = {
      runId: 'run-1',
      teamName: 'team-a',
      pendingApprovals: new Map(),
    };
    pendingTimeouts = new Map();
    inFlightResponses = new Set();
    ports = {
      getSettings: vi.fn(() => settings),
      autoAllowControlRequest: vi.fn(),
      autoDenyControlRequest: vi.fn(),
      respondToTeammatePermission: vi.fn(async () => undefined),
      dismissApprovalNotification: vi.fn(),
      emitToolApprovalEvent: vi.fn(),
      logInfo: vi.fn(),
    };
    timeouts = new TeamProvisioningToolApprovalTimeouts(
      { pendingTimeouts, inFlightResponses },
      ports
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims each response id once until the claim is released by the caller', () => {
    expect(timeouts.tryClaimResponse('req-1')).toBe(true);
    expect(timeouts.tryClaimResponse('req-1')).toBe(false);

    inFlightResponses.delete('req-1');

    expect(timeouts.tryClaimResponse('req-1')).toBe(true);
  });

  it('auto-denies a pending lead approval when its timeout fires', () => {
    settings = buildSettings({ timeoutAction: 'deny', timeoutSeconds: 2 });
    run.pendingApprovals.set('req-deny', buildApproval({ requestId: 'req-deny' }));

    timeouts.start(run, 'req-deny');
    vi.advanceTimersByTime(2000);

    expect(ports.autoDenyControlRequest).toHaveBeenCalledWith(run, 'req-deny');
    expect(run.pendingApprovals.has('req-deny')).toBe(false);
    expect(inFlightResponses.has('req-deny')).toBe(false);
    expect(ports.dismissApprovalNotification).toHaveBeenCalledWith('req-deny');
    expect(ports.emitToolApprovalEvent).toHaveBeenCalledWith({
      autoResolved: true,
      requestId: 'req-deny',
      runId: 'run-1',
      teamName: 'team-a',
      reason: 'timeout_deny',
    });
  });

  it('leaves an approval pending when settings change to wait before the timeout fires', () => {
    settings = buildSettings({ timeoutAction: 'allow', timeoutSeconds: 1 });
    run.pendingApprovals.set('req-wait', buildApproval({ requestId: 'req-wait' }));

    timeouts.start(run, 'req-wait');
    settings = buildSettings({ timeoutAction: 'wait', timeoutSeconds: 1 });
    vi.advanceTimersByTime(1000);

    expect(ports.autoAllowControlRequest).not.toHaveBeenCalled();
    expect(ports.autoDenyControlRequest).not.toHaveBeenCalled();
    expect(run.pendingApprovals.has('req-wait')).toBe(true);
    expect(inFlightResponses.has('req-wait')).toBe(false);
    expect(pendingTimeouts.has('req-wait')).toBe(false);
  });

  it('keeps a timed-out teammate approval pending when the response fails', async () => {
    settings = buildSettings({ timeoutAction: 'deny', timeoutSeconds: 2 });
    run.pendingApprovals.set(
      'req-worker',
      buildApproval({ requestId: 'req-worker', source: 'Worker' })
    );
    vi.mocked(ports.respondToTeammatePermission).mockRejectedValueOnce(
      new Error('inbox unavailable')
    );

    timeouts.start(run, 'req-worker');
    await vi.advanceTimersByTimeAsync(2000);

    expect(run.pendingApprovals.has('req-worker')).toBe(true);
    expect(inFlightResponses.has('req-worker')).toBe(false);
    expect(pendingTimeouts.has('req-worker')).toBe(true);
    expect(ports.dismissApprovalNotification).not.toHaveBeenCalled();
    expect(ports.emitToolApprovalEvent).not.toHaveBeenCalled();
    expect(ports.logInfo).toHaveBeenCalledWith(
      '[team-a] Failed to auto-resolve teammate approval req-worker: inbox unavailable'
    );
  });

  it('restarts a timed-out teammate approval immediately when the response throws', () => {
    settings = buildSettings({ timeoutAction: 'deny', timeoutSeconds: 2 });
    run.pendingApprovals.set(
      'req-worker',
      buildApproval({ requestId: 'req-worker', source: 'Worker' })
    );
    vi.mocked(ports.respondToTeammatePermission).mockImplementationOnce(() => {
      throw new Error('inbox unavailable synchronously');
    });

    timeouts.start(run, 'req-worker');
    vi.advanceTimersByTime(2000);

    expect(ports.respondToTeammatePermission).toHaveBeenCalledTimes(1);
    expect(run.pendingApprovals.has('req-worker')).toBe(true);
    expect(inFlightResponses.has('req-worker')).toBe(false);
    expect(pendingTimeouts.has('req-worker')).toBe(true);
    expect(ports.dismissApprovalNotification).not.toHaveBeenCalled();
    expect(ports.emitToolApprovalEvent).not.toHaveBeenCalled();
    expect(ports.logInfo).toHaveBeenCalledWith(
      '[team-a] Failed to auto-resolve teammate approval req-worker: inbox unavailable synchronously'
    );
  });

  it('re-evaluates pending approvals for auto-allow and timeout setting changes', () => {
    settings = buildSettings({ autoAllowAll: true, timeoutAction: 'wait' });
    run.pendingApprovals.set('req-auto', buildApproval({ requestId: 'req-auto' }));

    timeouts.reEvaluate([run]);

    expect(ports.autoAllowControlRequest).toHaveBeenCalledWith(run, 'req-auto');
    expect(run.pendingApprovals.has('req-auto')).toBe(false);
    expect(inFlightResponses.has('req-auto')).toBe(false);
    expect(ports.emitToolApprovalEvent).toHaveBeenCalledWith({
      autoResolved: true,
      requestId: 'req-auto',
      runId: 'run-1',
      teamName: 'team-a',
      reason: 'auto_allow_category',
    });

    settings = buildSettings({ timeoutAction: 'allow', timeoutSeconds: 5 });
    run.pendingApprovals.set('req-timer', buildApproval({ requestId: 'req-timer' }));

    timeouts.reEvaluate([run]);

    expect(pendingTimeouts.has('req-timer')).toBe(true);

    settings = buildSettings({ timeoutAction: 'wait', timeoutSeconds: 5 });
    timeouts.reEvaluate([run]);

    expect(pendingTimeouts.has('req-timer')).toBe(false);
  });

  it('does not resolve a re-evaluated teammate approval before delivery succeeds', async () => {
    settings = buildSettings({ autoAllowAll: true, timeoutAction: 'wait' });
    run.pendingApprovals.set(
      'req-worker',
      buildApproval({ requestId: 'req-worker', source: 'Worker' })
    );
    let resolveResponse: (() => void) | undefined;
    vi.mocked(ports.respondToTeammatePermission).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveResponse = resolve;
        })
    );

    timeouts.reEvaluate([run]);

    expect(run.pendingApprovals.has('req-worker')).toBe(true);
    expect(inFlightResponses.has('req-worker')).toBe(true);
    expect(ports.dismissApprovalNotification).not.toHaveBeenCalled();
    expect(ports.emitToolApprovalEvent).not.toHaveBeenCalled();

    resolveResponse?.();
    await Promise.resolve();

    expect(run.pendingApprovals.has('req-worker')).toBe(false);
    expect(inFlightResponses.has('req-worker')).toBe(false);
    expect(ports.dismissApprovalNotification).toHaveBeenCalledTimes(1);
    expect(ports.emitToolApprovalEvent).toHaveBeenCalledTimes(1);
  });
});
