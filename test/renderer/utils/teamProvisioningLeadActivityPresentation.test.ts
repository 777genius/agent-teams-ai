import { applyLeadActivityToProvisioningPresentation } from '@renderer/utils/teamProvisioningLeadActivityPresentation';
import { buildTeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import { describe, expect, it } from 'vitest';

const activeInput = {
  leadActivity: 'active' as const,
  currentRuntimeRunId: 'run-1',
  title: 'Completing startup checks',
  detail: 'Lead is working while startup checks finish.',
};

function createPresentation() {
  return buildTeamProvisioningPresentation({
    progress: {
      runId: 'run-1',
      teamName: 'sandbox-team',
      state: 'finalizing',
      startedAt: '2026-09-06T12:00:00.000Z',
      updatedAt: '2026-09-06T12:00:05.000Z',
      message: 'Auditing registered teammates and bootstrap truth',
      pid: 1234,
    },
    members: [{ name: 'team-lead', agentType: 'team-lead' }, { name: 'alice' }],
  })!;
}

describe('observed lead activity during provisioning', () => {
  it('shows working activity while preserving incomplete startup and teammate gates', () => {
    const original = createPresentation();
    const presentation = applyLeadActivityToProvisioningPresentation(original, activeInput);

    expect(presentation).toMatchObject({
      panelTitle: activeInput.title,
      compactTitle: activeInput.title,
      panelMessage: activeInput.detail,
      isReady: false,
      isActive: true,
      canCancel: true,
      currentStepIndex: original.currentStepIndex,
      pendingSpawnCount: original.pendingSpawnCount,
      allTeammatesConfirmedAlive: false,
    });
    expect(presentation?.progress).toBe(original.progress);
  });

  it.each(['missing', 'stale', 'idle', 'offline'])(
    'ignores %s activity and does not infer work from a PID',
    (reason) => {
      const original = createPresentation();
      const presentation = applyLeadActivityToProvisioningPresentation(original, {
        ...activeInput,
        currentRuntimeRunId: reason === 'stale' ? 'old-run' : 'run-1',
        leadActivity:
          reason === 'missing'
            ? undefined
            : reason === 'idle' || reason === 'offline'
              ? reason
              : 'active',
      });

      expect(presentation).toBe(original);
    }
  );

  it.each(['failure', 'permission', 'warning'])(
    'preserves specific %s details while indicating active startup',
    (reason) => {
      const original = createPresentation();
      const detail =
        reason === 'permission' ? 'Awaiting permission for alice' : 'alice failed to start';
      original.panelMessage = detail;
      if (reason === 'failure') original.failedSpawnCount = 1;
      if (reason === 'warning') original.progress.messageSeverity = 'warning';

      expect(applyLeadActivityToProvisioningPresentation(original, activeInput)).toMatchObject({
        panelTitle: activeInput.title,
        panelMessage: detail,
        isReady: false,
      });
    }
  );

  it.each(['ready', 'failed', 'cancelled'])(
    'does not replace %s terminal presentation with working status',
    (state) => {
      const original = createPresentation();
      original.isActive = false;
      original.isReady = state === 'ready';
      original.isFailed = state === 'failed';

      expect(applyLeadActivityToProvisioningPresentation(original, activeInput)).toBe(original);
    }
  );
});
