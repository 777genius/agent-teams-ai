import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { ToolApprovalSettingsSynchronizer } from '@renderer/store/team/teamToolApprovalSettingsSync';
import { type ToolApprovalEvent, type ToolApprovalRequest } from '@shared/types';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('tool approval policy synchronization safe e2e', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('survives rapid edits and a long IPC outage, then auto-allows without prompting', async () => {
    vi.useFakeTimers();
    const service = new TeamProvisioningService();
    const emittedEvents: ToolApprovalEvent[] = [];
    service.setToolApprovalEventEmitter((event) => emittedEvents.push(event));

    let transportAttempts = 0;
    const synchronizer = new ToolApprovalSettingsSynchronizer({
      retryDelaysMs: [1, 2],
      update: async (teamName, settings) => {
        transportAttempts += 1;
        if (transportAttempts <= 5) {
          throw new Error(`simulated IPC outage ${transportAttempts}`);
        }
        service.updateToolApprovalSettings(teamName, settings);
      },
    });
    const intermediate = {
      ...DEFAULT_TOOL_APPROVAL_SETTINGS,
      autoAllowSafeBash: true,
    };
    const latest = {
      ...intermediate,
      autoAllowAll: true,
      timeoutAction: 'deny' as const,
    };

    synchronizer.schedule('sandbox-approval-e2e', intermediate);
    await vi.advanceTimersByTimeAsync(0);
    const latestRevision = synchronizer.schedule('sandbox-approval-e2e', latest);
    const acknowledged = synchronizer.waitForAcknowledgement(
      'sandbox-approval-e2e',
      latestRevision
    );
    await vi.runAllTimersAsync();
    await acknowledged;

    expect(transportAttempts).toBe(6);

    const writes: string[] = [];
    const run = {
      runId: 'sandbox-run',
      teamName: 'sandbox-approval-e2e',
      request: {
        color: 'blue',
        displayName: 'Sandbox Approval E2E',
        members: [],
      },
      child: {
        stdin: {
          writable: true,
          write: vi.fn((data: string, callback?: (error?: Error | null) => void) => {
            writes.push(data);
            callback?.(null);
            return true;
          }),
        },
      },
      pendingApprovals: new Map<string, ToolApprovalRequest>(),
      processedPermissionRequestIds: new Set<string>(),
      mixedSecondaryLanes: [],
    };

    const approvalBoundary = service as unknown as {
      handleControlRequest(run: unknown, message: Record<string, unknown>): void;
    };
    approvalBoundary.handleControlRequest(run, {
      request_id: 'sandbox-request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'mcp__agent-teams__member_work_sync_status',
        input: {
          teamName: 'sandbox-approval-e2e',
          memberName: 'jack',
        },
      },
    });

    expect(run.pendingApprovals.size).toBe(0);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'sandbox-request',
        response: { behavior: 'allow', updatedInput: {} },
      },
    });
    expect(emittedEvents).toContainEqual({
      autoResolved: true,
      requestId: 'sandbox-request',
      runId: 'sandbox-run',
      teamName: 'sandbox-approval-e2e',
      reason: 'auto_allow_category',
    });

    synchronizer.dispose();
  });
});
