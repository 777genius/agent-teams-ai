import {
  deriveMemberLaunchState,
  isAutoClearableLaunchFailureReason,
  isBootstrapCheckInTimeoutFailureReason,
  isBootstrapInstructionPromptFailureReason,
  isBootstrapMcpResourceReadFailureReason,
  isCliProvisionedButNotAliveFailureReason,
  isConfigRegistrationFailureReason,
  isLaunchCleanupBootstrapIncompleteFailureReason,
  isLaunchGraceWindowFailureReason,
  isNativeAppManagedBootstrapCheckFailureReason,
  isNativeBootstrapControlFailureReason,
  isNeverSpawnedDuringLaunchReason,
  isOpenCodeBridgeLaunchFailureReason,
  isProcessTableUnavailableFailureReason,
  isProvisionedButNotAliveFailureReason,
  isRegisteredRuntimeMetadataFailureReason,
  stripProcessTableUnavailableDiagnosticSuffix,
} from '@main/services/team/provisioning/TeamProvisioningLaunchFailurePolicy';
import { extractBootstrapFailureReason } from '@main/services/team/provisioning/TeamProvisioningPromptBuilders';
import { isBootstrapConfirmedProvisionedButNotAliveFailure } from '@shared/utils/teamLaunchFailureReason';
import { describe, expect, it } from 'vitest';

describe('TeamProvisioningLaunchFailurePolicy', () => {
  it('recognizes exact launch failure reasons that are safe to auto-clear', () => {
    expect(isNeverSpawnedDuringLaunchReason(' Teammate was never spawned during launch. ')).toBe(
      true
    );
    expect(
      isLaunchGraceWindowFailureReason('Teammate did not join within the launch grace window.')
    ).toBe(true);
    expect(
      isConfigRegistrationFailureReason(
        'Teammate was not registered in config.json during launch. Persistent spawn failed.'
      )
    ).toBe(true);
    expect(
      isOpenCodeBridgeLaunchFailureReason('OpenCode bridge reported member launch failure')
    ).toBe(true);
    expect(
      isRegisteredRuntimeMetadataFailureReason('registered runtime metadata without live process')
    ).toBe(true);
    expect(
      isProvisionedButNotAliveFailureReason(
        'CLI process exited (code 1) \u2014 team provisioned but not alive'
      )
    ).toBe(true);
    expect(
      isProvisionedButNotAliveFailureReason(
        'CLI process exited (code unknown) - team provisioned but not alive; process table unavailable'
      )
    ).toBe(true);
    expect(
      isCliProvisionedButNotAliveFailureReason(
        'CLI process exited (code ?) - team provisioned but not alive'
      )
    ).toBe(true);
  });

  it('recognizes bootstrap-specific failure reasons without accepting unrelated text', () => {
    expect(
      isBootstrapMcpResourceReadFailureReason(
        'resources/read failed for member_briefing: MCP error method not found'
      )
    ).toBe(true);
    expect(
      isBootstrapMcpResourceReadFailureReason('resources/read failed for other resource')
    ).toBe(false);
    expect(
      isBootstrapCheckInTimeoutFailureReason(
        'Teammate was registered but did not bootstrap-confirm before timeout.'
      )
    ).toBe(true);
    expect(
      isBootstrapCheckInTimeoutFailureReason(
        'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before submitted-confirmation timeout (3m). Last transport stage: bootstrap_submitted'
      )
    ).toBe(true);
    expect(
      isBootstrapCheckInTimeoutFailureReason(
        'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before timeout.'
      )
    ).toBe(false);
    expect(
      isBootstrapInstructionPromptFailureReason(
        'You are bootstrapping into team atlas. Your first action is to call the MCP tool member_briefing.'
      )
    ).toBe(true);
    expect(
      isLaunchCleanupBootstrapIncompleteFailureReason(
        'Launch ended before teammate bootstrap completed. Runtime process was alive after bootstrap failure'
      )
    ).toBe(true);
    const nativeBootstrapCheck =
      '<agent_teams_native_app_managed_bootstrap_check> startup context loaded </agent_teams_native_app_managed_bootstrap_check>';
    const nativeBootstrapControl =
      '<agent_teams_native_bootstrap_control> System-level bootstrap rules </agent_teams_native_bootstrap_control>';
    const truncatedNativeBootstrapControl =
      '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.';
    expect(isNativeAppManagedBootstrapCheckFailureReason(nativeBootstrapCheck)).toBe(true);
    expect(isNativeBootstrapControlFailureReason(nativeBootstrapCheck)).toBe(true);
    expect(isNativeBootstrapControlFailureReason(nativeBootstrapControl)).toBe(true);
    expect(isNativeBootstrapControlFailureReason(truncatedNativeBootstrapControl)).toBe(true);
    expect(extractBootstrapFailureReason(nativeBootstrapCheck)).toBe(null);
    expect(extractBootstrapFailureReason(nativeBootstrapControl)).toBe(null);
    expect(extractBootstrapFailureReason(truncatedNativeBootstrapControl)).toBe(null);
    expect(
      extractBootstrapFailureReason(
        `Bootstrap failed after receiving ${truncatedNativeBootstrapControl}`
      )
    ).toContain('Bootstrap failed');
  });

  it('handles process-table unavailable reasons and suffixes conservatively', () => {
    expect(isProcessTableUnavailableFailureReason('process table unavailable')).toBe(true);
    expect(
      isProcessTableUnavailableFailureReason(
        'runtime pid could not be verified because process table is unavailable'
      )
    ).toBe(true);
    expect(
      isProcessTableUnavailableFailureReason('runtime failed; process table unavailable')
    ).toBe(false);
    expect(
      stripProcessTableUnavailableDiagnosticSuffix(
        'Teammate did not join within the launch grace window.; process table unavailable'
      )
    ).toBe('Teammate did not join within the launch grace window.');
  });

  it('keeps auto-clear policy narrow but accepts known recoverable suffixes', () => {
    expect(isAutoClearableLaunchFailureReason('Teammate was never spawned during launch.')).toBe(
      true
    );
    expect(isAutoClearableLaunchFailureReason('process table is unavailable')).toBe(true);
    expect(
      isAutoClearableLaunchFailureReason(
        'Teammate did not join within the launch grace window.; process table unavailable'
      )
    ).toBe(true);
    expect(
      isAutoClearableLaunchFailureReason(
        'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before submitted-confirmation timeout (3m). Last transport stage: bootstrap_submitted'
      )
    ).toBe(true);
    expect(
      isAutoClearableLaunchFailureReason(
        '<agent_teams_native_app_managed_bootstrap_check> startup context loaded </agent_teams_native_app_managed_bootstrap_check>'
      )
    ).toBe(true);
    expect(
      isAutoClearableLaunchFailureReason(
        '<agent_teams_native_bootstrap_control> System-level bootstrap rules </agent_teams_native_bootstrap_control>'
      )
    ).toBe(true);
    expect(
      isAutoClearableLaunchFailureReason(
        '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.'
      )
    ).toBe(true);
    expect(
      isAutoClearableLaunchFailureReason(
        'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before timeout.'
      )
    ).toBe(false);
    expect(
      isAutoClearableLaunchFailureReason(
        'CLI process exited (code 1) \u2014 team provisioned but not alive'
      )
    ).toBe(false);
    expect(isAutoClearableLaunchFailureReason('model not found')).toBe(false);
    expect(isAutoClearableLaunchFailureReason()).toBe(false);
  });

  it('requires bootstrap proof before treating provisioned-but-not-alive as healed', () => {
    const reason = 'CLI process exited (code 1) \u2014 team provisioned but not alive';

    expect(
      isBootstrapConfirmedProvisionedButNotAliveFailure({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: reason,
        bootstrapConfirmed: true,
      })
    ).toBe(true);

    expect(
      isBootstrapConfirmedProvisionedButNotAliveFailure({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'model not found',
        error: reason,
        bootstrapConfirmed: true,
      })
    ).toBe(false);

    expect(
      isBootstrapConfirmedProvisionedButNotAliveFailure({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: reason,
        bootstrapConfirmed: false,
        livenessKind: 'registered_only',
      })
    ).toBe(false);

    expect(
      isBootstrapConfirmedProvisionedButNotAliveFailure({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        runtimeDiagnostic: reason,
        bootstrapConfirmed: true,
      })
    ).toBe(true);
  });

  it('derives member launch state by the existing precedence order', () => {
    expect(deriveMemberLaunchState({ skippedForLaunch: true, hardFailure: true })).toBe(
      'skipped_for_launch'
    );
    expect(deriveMemberLaunchState({ hardFailure: true, bootstrapConfirmed: true })).toBe(
      'failed_to_start'
    );
    expect(deriveMemberLaunchState({ bootstrapConfirmed: true })).toBe('confirmed_alive');
    expect(deriveMemberLaunchState({ pendingPermissionRequestIds: ['req-1'] })).toBe(
      'runtime_pending_permission'
    );
    expect(deriveMemberLaunchState({ runtimeAlive: true })).toBe('runtime_pending_bootstrap');
    expect(deriveMemberLaunchState({ agentToolAccepted: true })).toBe('runtime_pending_bootstrap');
    expect(deriveMemberLaunchState({})).toBe('starting');
  });
});
