import {
  deriveMemberLaunchState,
  isAutoClearableLaunchFailureReason,
  isBootstrapCheckInTimeoutFailureReason,
  isBootstrapInstructionPromptFailureReason,
  isBootstrapMcpResourceReadFailureReason,
  isConfigRegistrationFailureReason,
  isLaunchCleanupBootstrapIncompleteFailureReason,
  isLaunchGraceWindowFailureReason,
  isNeverSpawnedDuringLaunchReason,
  isOpenCodeBridgeLaunchFailureReason,
  isProcessTableUnavailableFailureReason,
  isRegisteredRuntimeMetadataFailureReason,
  stripProcessTableUnavailableDiagnosticSuffix,
} from '@main/services/team/provisioning/TeamProvisioningLaunchFailurePolicy';
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
    expect(isOpenCodeBridgeLaunchFailureReason('OpenCode bridge reported member launch failure')).toBe(
      true
    );
    expect(
      isRegisteredRuntimeMetadataFailureReason('registered runtime metadata without live process')
    ).toBe(true);
  });

  it('recognizes bootstrap-specific failure reasons without accepting unrelated text', () => {
    expect(
      isBootstrapMcpResourceReadFailureReason(
        'resources/read failed for member_briefing: MCP error method not found'
      )
    ).toBe(true);
    expect(isBootstrapMcpResourceReadFailureReason('resources/read failed for other resource')).toBe(
      false
    );
    expect(
      isBootstrapCheckInTimeoutFailureReason(
        'Teammate was registered but did not bootstrap-confirm before timeout.'
      )
    ).toBe(true);
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
  });

  it('handles process-table unavailable reasons and suffixes conservatively', () => {
    expect(isProcessTableUnavailableFailureReason('process table unavailable')).toBe(true);
    expect(
      isProcessTableUnavailableFailureReason(
        'runtime pid could not be verified because process table is unavailable'
      )
    ).toBe(true);
    expect(isProcessTableUnavailableFailureReason('runtime failed; process table unavailable')).toBe(
      false
    );
    expect(
      stripProcessTableUnavailableDiagnosticSuffix(
        'Teammate did not join within the launch grace window.; process table unavailable'
      )
    ).toBe('Teammate did not join within the launch grace window.');
  });

  it('keeps auto-clear policy narrow but accepts known recoverable suffixes', () => {
    expect(
      isAutoClearableLaunchFailureReason('Teammate was never spawned during launch.')
    ).toBe(true);
    expect(isAutoClearableLaunchFailureReason('process table is unavailable')).toBe(true);
    expect(
      isAutoClearableLaunchFailureReason(
        'Teammate did not join within the launch grace window.; process table unavailable'
      )
    ).toBe(true);
    expect(isAutoClearableLaunchFailureReason('model not found')).toBe(false);
    expect(isAutoClearableLaunchFailureReason(undefined)).toBe(false);
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
    expect(deriveMemberLaunchState({ agentToolAccepted: true })).toBe(
      'runtime_pending_bootstrap'
    );
    expect(deriveMemberLaunchState({})).toBe('starting');
  });
});
