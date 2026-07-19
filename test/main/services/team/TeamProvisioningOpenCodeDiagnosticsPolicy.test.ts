import {
  boundOpenCodeAppManagedBriefingText,
  buildOpenCodeProviderVerificationDeferredLine,
  filterStaleOpenCodeOverlayDiagnostics,
  hasRealOpenCodeFailureDiagnostic,
  hasRealOpenCodeLaunchDiagnostic,
  hasStaleOpenCodeDiagnostics,
  isFileLockTimeoutError,
  isGenericOpenCodePersistedFailureReason,
  isOpenCodeModelPrepareBusyDeferred,
  isPersistedOpenCodeSecondaryLaneMember,
  isRetryableOpenCodePreflightBusyDiagnostic,
  looksLikeOpenCodeProviderPrepareDiagnostic,
  normalizeOpenCodePersistedFailureReason,
  normalizeOpenCodePrepareDiagnostic,
  OPENCODE_APP_MCP_UNREACHABLE_DIAGNOSTIC,
  OPENCODE_RUNTIME_BINARY_UNREACHABLE_DIAGNOSTIC,
  promoteOpenCodePersistedFailureReasonsFromDiagnostics,
  selectOpenCodeLaunchFailureDiagnostic,
  selectOpenCodeModelPreparePrimaryReason,
  selectOpenCodePersistedFailureReasonFromDiagnostics,
  selectOpenCodePrepareProviderDiagnostic,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeDiagnosticsPolicy';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE } from '@shared/utils/openCodeWindowsAccessDenied';
import { describe, expect, it, vi } from 'vitest';

import type { TeamRuntimePrepareResult } from '@main/services/team/runtime';
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
      hasRealOpenCodeFailureDiagnostic("cursor-acp error: You've hit your Cursor usage limit")
    ).toBe(true);
    expect(hasRealOpenCodeFailureDiagnostic('grpc_code=RESOURCE_EXHAUSTED')).toBe(true);
    expect(hasRealOpenCodeFailureDiagnostic('{"grpcCode":8}')).toBe(true);
    expect(hasRealOpenCodeFailureDiagnostic('HTTP 429 Too Many Requests')).toBe(true);
    expect(hasRealOpenCodeFailureDiagnostic('{"usage":{"input_tokens":429}}')).toBe(false);
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

  it('promotes Cursor quota above persisted readiness noise', () => {
    const cursorQuota = "cursor-acp error: You've hit your Cursor usage limit";
    const member = makeMember({
      hardFailureReason: 'model_unavailable',
      diagnostics: [
        'OpenCode command timed out after 10000ms',
        'CLI-authenticated providers missing from live host (github-copilot)',
        'OpenCode session status busy',
        'OpenCode prompt start exposed a terminal provider error in 1700ms',
        'OpenCode retry status exposed a terminal provider error',
        'OpenCode session messages request exposed a terminal provider error',
        'OpenCode retry/error payload exposed a terminal provider failure in 1800ms',
        'OpenCode assistant payload exposed a terminal provider failure in 1900ms',
        'Cursor native failure probe will retry after a transient failure in 2000ms',
        'Cursor native execution preflight hit a transient failure; falling back to the OpenCode execution probe',
        'Cursor native failure probe failed: temporary spawn failure',
        'Cursor native failure probe confirmed a terminal provider error in 2150ms',
        'Connection reset by server',
        'opencode_app_mcp_tool_proof_persisted_cache_hit',
        cursorQuota,
      ],
    });

    expect(selectOpenCodePersistedFailureReasonFromDiagnostics(member)).toBe(cursorQuota);
  });

  it('selects a member quota failure over unrelated launch diagnostics', () => {
    const cursorQuota = "cursor-acp error: You've hit your Cursor usage limit";

    expect(
      selectOpenCodeLaunchFailureDiagnostic([
        'CLI-authenticated providers missing from live host (github-copilot)',
        'OpenCode session status busy',
        'opencode_app_mcp_tool_proof_persisted_cache_hit',
        cursorQuota,
      ])
    ).toBe(cursorQuota);
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

  it('normalizes OpenCode prepare diagnostics for user-visible launch errors', () => {
    expect(normalizeOpenCodePrepareDiagnostic('bridge stdout was empty')).toBe(
      'OpenCode runtime check returned no output.'
    );
    expect(normalizeOpenCodePrepareDiagnostic('EPERM: operation not permitted')).toBe(
      OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE
    );
    expect(normalizeOpenCodePrepareDiagnostic('opencode cli not found')).toBe(
      OPENCODE_RUNTIME_BINARY_UNREACHABLE_DIAGNOSTIC
    );
    expect(
      normalizeOpenCodePrepareDiagnostic(
        'unable to connect to /experimental/tool - socket refused',
        'mcp_unavailable'
      )
    ).toBe(`${OPENCODE_APP_MCP_UNREACHABLE_DIAGNOSTIC} Details: socket refused`);
    expect(looksLikeOpenCodeProviderPrepareDiagnostic('mcp_unavailable')).toBe(true);
    expect(looksLikeOpenCodeProviderPrepareDiagnostic('model verification timed out')).toBe(false);
  });

  it('selects provider prepare reasons before generic OpenCode model failures', () => {
    const prepare = {
      ok: false,
      providerId: 'opencode',
      reason: 'unknown_error',
      diagnostics: ['model not found in live OpenCode catalog'],
      warnings: ['bridge stdout was empty'],
      retryable: false,
    } satisfies Extract<TeamRuntimePrepareResult, { ok: false }>;

    expect(selectOpenCodePrepareProviderDiagnostic(prepare)).toBe('bridge stdout was empty');
    expect(selectOpenCodeModelPreparePrimaryReason(prepare)).toBe('bridge stdout was empty');

    const mcpPrepare = {
      ...prepare,
      warnings: ['mcp_unavailable'],
    } satisfies Extract<TeamRuntimePrepareResult, { ok: false }>;

    expect(selectOpenCodePrepareProviderDiagnostic(mcpPrepare)).toBe('mcp_unavailable');
    expect(selectOpenCodeModelPreparePrimaryReason(mcpPrepare)).toBe('mcp_unavailable');
  });

  it('defers retryable busy prepare failures without hiding model verification timeouts', () => {
    const busyPrepare = {
      ok: false,
      providerId: 'opencode',
      reason: 'unknown_error',
      diagnostics: ['provider busy'],
      warnings: [],
      retryable: true,
    } satisfies Extract<TeamRuntimePrepareResult, { ok: false }>;
    expect(isRetryableOpenCodePreflightBusyDiagnostic('OpenCode session status busy')).toBe(true);
    expect(selectOpenCodeModelPreparePrimaryReason(busyPrepare)).toBe('provider busy');
    expect(isOpenCodeModelPrepareBusyDeferred(busyPrepare, 'provider busy')).toBe(true);
    expect(buildOpenCodeProviderVerificationDeferredLine('provider busy')).toBe(
      'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.'
    );

    const timeoutPrepare = {
      ...busyPrepare,
      diagnostics: ['provider busy', 'model verification timed out after 30s'],
    } satisfies Extract<TeamRuntimePrepareResult, { ok: false }>;
    expect(selectOpenCodeModelPreparePrimaryReason(timeoutPrepare)).toBe(
      'model verification timed out after 30s'
    );
    expect(
      isOpenCodeModelPrepareBusyDeferred(timeoutPrepare, 'model verification timed out after 30s')
    ).toBe(false);
  });
});
