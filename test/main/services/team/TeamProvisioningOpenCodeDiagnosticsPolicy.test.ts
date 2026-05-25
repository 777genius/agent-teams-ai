import {
  boundOpenCodeAppManagedBriefingText,
  filterStaleOpenCodeOverlayDiagnostics,
  hasRealOpenCodeFailureDiagnostic,
  hasRealOpenCodeLaunchDiagnostic,
  hasStaleOpenCodeDiagnostics,
  isFileLockTimeoutError,
  isGenericOpenCodePersistedFailureReason,
  isPersistedOpenCodeSecondaryLaneMember,
  normalizeOpenCodePersistedFailureReason,
  promoteOpenCodePersistedFailureReasonsFromDiagnostics,
  selectOpenCodePersistedFailureReasonFromDiagnostics,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeDiagnosticsPolicy';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { describe, expect, it, vi } from 'vitest';

import type { PersistedTeamLaunchMemberState } from '@shared/types';

function makeMember(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Builder',
    providerId: 'opencode',
    laneKind: 'secondary',
    laneOwnerProviderId: 'opencode',
    laneId: 'opencode-secondary',
    launchState: 'failed_to_start',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: true,
    hardFailureReason: 'OpenCode bridge reported member launch failure',
    lastEvaluatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TeamProvisioningOpenCodeDiagnosticsPolicy', () => {
  it('recognizes only persisted OpenCode secondary lane members', () => {
    expect(isPersistedOpenCodeSecondaryLaneMember(makeMember())).toBe(true);
    expect(isPersistedOpenCodeSecondaryLaneMember(makeMember({ laneId: '  ' }))).toBe(false);
    expect(isPersistedOpenCodeSecondaryLaneMember(makeMember({ laneKind: 'primary' }))).toBe(false);
    expect(isPersistedOpenCodeSecondaryLaneMember(makeMember({ providerId: undefined }))).toBe(
      false
    );
  });

  it('keeps stale OpenCode diagnostics separate from real launch failures', () => {
    expect(hasStaleOpenCodeDiagnostics(['No lane runtime evidence was committed'])).toBe(true);
    expect(hasStaleOpenCodeDiagnostics(['OpenCode bridge reported member launch failure'])).toBe(
      true
    );
    expect(hasStaleOpenCodeDiagnostics(['model not found in live OpenCode catalog'])).toBe(false);
    expect(hasRealOpenCodeFailureDiagnostic('provider unavailable: quota exceeded')).toBe(true);
    expect(
      hasRealOpenCodeLaunchDiagnostic(
        makeMember({ runtimeDiagnostic: 'OpenCode bridge reported member launch failure' })
      )
    ).toBe(false);
    expect(hasRealOpenCodeLaunchDiagnostic(makeMember({ hardFailureReason: 'model not found' }))).toBe(
      true
    );
  });

  it('redacts secrets and bounds app-managed briefing text', () => {
    const normalized = normalizeOpenCodePersistedFailureReason(
      ' failed  --api-key sk-abcdefghijklmnopqrstuvwxyz  Bearer ABC123._+/=-  '
    );
    expect(normalized).toBe('failed --api-key [redacted] Bearer [redacted]');
    expect(isGenericOpenCodePersistedFailureReason('OpenCode bridge reported member launch failure')).toBe(
      true
    );

    const longBriefing = `${'x'.repeat(12_005)} --token secret-token`;
    const bounded = boundOpenCodeAppManagedBriefingText(longBriefing);
    expect(bounded.length).toBeGreaterThan(12_000);
    expect(bounded.length).toBeLessThanOrEqual(12_040);
    expect(bounded.endsWith('\n[truncated app-managed briefing]')).toBe(true);
    expect(bounded).not.toContain('secret-token');
  });

  it('promotes generic persisted failure reasons from specific diagnostics', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-03T04:05:06.000Z'));
    try {
      const generic = makeMember({
        diagnostics: [
          'OpenCode secondary lane timing: 100ms',
          'model not found in live OpenCode catalog',
        ],
      });
      expect(selectOpenCodePersistedFailureReasonFromDiagnostics(generic)).toBe(
        'model not found in live OpenCode catalog'
      );

      const snapshot = createPersistedLaunchSnapshot({
        teamName: 'demo',
        expectedMembers: ['Builder'],
        launchPhase: 'finished',
        members: { Builder: generic },
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const promoted = promoteOpenCodePersistedFailureReasonsFromDiagnostics(snapshot);
      expect(promoted?.members.Builder.hardFailureReason).toBe(
        'model not found in live OpenCode catalog'
      );
      expect(promoted?.members.Builder.runtimeDiagnostic).toBe(
        'model not found in live OpenCode catalog'
      );
      expect(promoted?.updatedAt).toBe('2026-02-03T04:05:06.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters stale overlay diagnostics and recognizes file lock timeouts', () => {
    expect(
      filterStaleOpenCodeOverlayDiagnostics([
        'No runtime evidence was committed',
        'model not found',
      ])
    ).toEqual(['model not found']);
    expect(isFileLockTimeoutError(new Error('File lock timeout while reading manifest'))).toBe(
      true
    );
    expect(isFileLockTimeoutError('other failure')).toBe(false);
  });
});
