import {
  hasUnsafeProvisionedButNotAliveRuntimeEvidence,
  hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext,
  isBootstrapConfirmedProvisionedButNotAliveFailure,
} from '@shared/utils/teamLaunchFailureReason';
import { describe, expect, it } from 'vitest';

describe('teamLaunchFailureReason', () => {
  it('treats runtime process candidates as unsafe provisioned-but-not-alive evidence', () => {
    expect(
      hasUnsafeProvisionedButNotAliveRuntimeEvidence({
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        launchState: 'failed_to_start',
        livenessKind: 'runtime_process_candidate',
        runtimeDiagnostic:
          'OpenCode runtime process detected, but teammate bootstrap is not confirmed',
        runtimeDiagnosticSeverity: 'warning',
        status: 'error',
      })
    ).toBe(true);
  });

  it('treats permission-blocked runtime liveness as unsafe provisioned-but-not-alive evidence', () => {
    expect(
      hasUnsafeProvisionedButNotAliveRuntimeEvidence({
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        launchState: 'failed_to_start',
        livenessKind: 'permission_blocked',
        runtimeDiagnostic: 'runtime is waiting for permission approval',
        runtimeDiagnosticSeverity: 'warning',
        status: 'error',
      })
    ).toBe(true);
  });

  it('keeps process-table-unavailable registered metadata safe for bootstrap healing', () => {
    expect(
      hasUnsafeProvisionedButNotAliveRuntimeEvidence({
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        launchState: 'failed_to_start',
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
        runtimeDiagnosticSeverity: 'warning',
        status: 'error',
      })
    ).toBe(false);
  });

  it('treats missing liveness without process-table evidence as unsafe', () => {
    expect(
      hasUnsafeProvisionedButNotAliveRuntimeEvidence({
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        launchState: 'failed_to_start',
        status: 'error',
      })
    ).toBe(true);
  });

  it('keeps missing liveness safe when process-table evidence is explicit', () => {
    expect(
      hasUnsafeProvisionedButNotAliveRuntimeEvidence({
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason:
          'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
        launchState: 'failed_to_start',
        status: 'error',
      })
    ).toBe(false);
  });

  it('uses spawn process-table evidence for registered runtime metadata without diagnostics', () => {
    expect(
      hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext(
        {
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          launchState: 'failed_to_start',
          status: 'error',
        },
        {
          livenessKind: 'registered_only',
          runtimeDiagnosticSeverity: 'warning',
        }
      )
    ).toBe(false);
  });

  it('uses spawn process-table evidence for runtime metadata without liveness or diagnostics', () => {
    expect(
      hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext(
        {
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          launchState: 'failed_to_start',
          status: 'error',
        },
        {
          runtimeDiagnosticSeverity: 'warning',
        }
      )
    ).toBe(false);
  });

  it('keeps registered runtime metadata unsafe when runtime diagnostics contradict spawn proof', () => {
    expect(
      hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext(
        {
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          launchState: 'failed_to_start',
          status: 'error',
        },
        {
          livenessKind: 'registered_only',
          runtimeDiagnostic: 'Runtime heartbeat is not alive',
          runtimeDiagnosticSeverity: 'warning',
        }
      )
    ).toBe(true);
  });

  it('recognizes runtime-diagnostic-only provisioned-but-not-alive failures', () => {
    expect(
      isBootstrapConfirmedProvisionedButNotAliveFailure({
        bootstrapConfirmed: true,
        hardFailure: true,
        launchState: 'failed_to_start',
        runtimeDiagnostic: 'CLI process exited (code 1) - team provisioned but not alive',
        status: 'error',
      })
    ).toBe(true);
  });

  it('recognizes confirmed native bootstrap-control failures as recoverable launch failures', () => {
    expect(
      isBootstrapConfirmedProvisionedButNotAliveFailure({
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason:
          '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
        launchState: 'failed_to_start',
        status: 'error',
      })
    ).toBe(true);
    expect(
      isBootstrapConfirmedProvisionedButNotAliveFailure({
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason:
          '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
        launchState: 'failed_to_start',
        status: 'error',
      })
    ).toBe(false);
  });
});
