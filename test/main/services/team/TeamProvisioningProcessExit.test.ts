import {
  buildCodeZeroProvisioningValidationError,
  buildCompletedProcessExitMessage,
  buildProvisionedButNotAliveWarnings,
  buildTimeoutCompletionWarnings,
  decideProcessExitAfterParserFlush,
  decideProcessExitBeforeParserFlush,
  decideTimeoutCompletion,
  hasIncompleteClaudeStdoutCarry,
  isProvisioningRunFailed,
} from '@main/services/team/provisioning/TeamProvisioningProcessExit';
import { describe, expect, it } from 'vitest';

describe('TeamProvisioningProcessExit', () => {
  it('classifies process exit guards before parser flushing', () => {
    expect(
      decideProcessExitBeforeParserFlush({
        finalizingByTimeout: true,
        progressState: 'verifying',
        cancelRequested: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'finalizing_by_timeout' });

    expect(
      decideProcessExitBeforeParserFlush({
        finalizingByTimeout: false,
        progressState: 'failed',
        cancelRequested: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'failed_or_cancelled' });

    expect(
      decideProcessExitBeforeParserFlush({
        finalizingByTimeout: false,
        progressState: 'verifying',
        cancelRequested: false,
        authRetryInProgress: true,
      })
    ).toEqual({ action: 'ignore', reason: 'auth_retry_in_progress' });

    expect(
      decideProcessExitBeforeParserFlush({
        finalizingByTimeout: false,
        progressState: 'verifying',
        cancelRequested: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'continue' });
  });

  it('classifies process exit guards after parser flushing', () => {
    expect(
      decideProcessExitAfterParserFlush({
        progressState: 'failed',
        cancelRequested: false,
        processKilled: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'failed' });

    expect(
      decideProcessExitAfterParserFlush({
        progressState: 'verifying',
        cancelRequested: true,
        processKilled: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'cancelled' });

    expect(
      decideProcessExitAfterParserFlush({
        progressState: 'verifying',
        cancelRequested: false,
        processKilled: true,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'process_killed' });

    expect(
      decideProcessExitAfterParserFlush({
        progressState: 'verifying',
        cancelRequested: false,
        processKilled: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'continue' });
  });

  it('builds stable process exit messages and warnings', () => {
    expect(buildCompletedProcessExitMessage(0)).toBe('Team process exited normally');
    expect(buildCompletedProcessExitMessage(2)).toBe('Team process exited unexpectedly (code 2)');
    expect(buildCompletedProcessExitMessage(null)).toBe(
      'Team process exited unexpectedly (code unknown)'
    );

    expect(buildProvisionedButNotAliveWarnings(null)).toEqual([
      'CLI process exited (code unknown) — team provisioned but not alive',
    ]);
    expect(buildProvisionedButNotAliveWarnings(1, ['worker'])).toEqual([
      'CLI process exited (code 1) — team provisioned but not alive',
      'Some inboxes not created yet',
    ]);
    expect(buildTimeoutCompletionWarnings(['worker'])).toEqual([
      'CLI timed out after config was created — team provisioned but process killed',
      'Some inboxes not created yet',
    ]);
  });

  it('builds code-zero validation errors from config visibility evidence', () => {
    expect(
      buildCodeZeroProvisioningValidationError({
        configFound: false,
        configuredTeamsBasePath: '/configured/teams',
        configuredConfigPath: '/configured/teams/demo/config.json',
        defaultTeamsBasePath: '/default/teams',
        defaultConfigPath: '/default/teams/demo/config.json',
        timeoutMs: 15_000,
        cleanupHint: ' cleanup hint',
      })
    ).toBe(
      'No valid config.json found at /configured/teams/demo/config.json (also checked /default/teams/demo/config.json) within 15s. cleanup hint'
    );

    expect(
      buildCodeZeroProvisioningValidationError({
        configFound: true,
        configuredTeamsBasePath: '/configured/teams',
        configuredConfigPath: '/configured/teams/demo/config.json',
        defaultTeamsBasePath: '/default/teams',
        defaultConfigPath: '/default/teams/demo/config.json',
        timeoutMs: 15_000,
      })
    ).toBe('Team did not appear in team:list after provisioning');
  });

  it('decides timeout completion from config, visibility, and cancellation state', () => {
    expect(
      decideTimeoutCompletion({
        cancelRequested: true,
        configProbe: { ok: true, location: 'configured', configPath: '/team/config.json' },
        visibleInList: true,
        missingInboxes: [],
      })
    ).toEqual({ action: 'skip', reason: 'cancelled' });

    expect(
      decideTimeoutCompletion({
        cancelRequested: false,
        configProbe: { ok: false },
        visibleInList: true,
        missingInboxes: [],
      })
    ).toEqual({ action: 'skip', reason: 'config_missing' });

    expect(
      decideTimeoutCompletion({
        cancelRequested: false,
        configProbe: { ok: true, location: 'default', configPath: '/team/config.json' },
        visibleInList: true,
        missingInboxes: [],
      })
    ).toEqual({ action: 'skip', reason: 'config_not_configured_root' });

    expect(
      decideTimeoutCompletion({
        cancelRequested: false,
        configProbe: { ok: true, location: 'configured', configPath: '/team/config.json' },
        visibleInList: false,
        missingInboxes: [],
      })
    ).toEqual({ action: 'skip', reason: 'team_not_visible' });

    expect(
      decideTimeoutCompletion({
        cancelRequested: false,
        configProbe: { ok: true, location: 'configured', configPath: '/team/config.json' },
        visibleInList: true,
        missingInboxes: ['worker'],
      })
    ).toEqual({
      action: 'complete',
      warnings: [
        'CLI timed out after config was created — team provisioned but process killed',
        'Some inboxes not created yet',
      ],
    });
  });

  it('detects failed progress and incomplete stream-json carry', () => {
    expect(isProvisioningRunFailed({ progress: { state: 'failed' } })).toBe(true);
    expect(isProvisioningRunFailed({ progress: { state: 'verifying' } })).toBe(false);

    expect(
      hasIncompleteClaudeStdoutCarry({
        stdoutParserCarry: ' {"type": "assistant"',
        stdoutParserCarryIsCompleteJson: false,
        stdoutParserCarryLooksLikeClaudeJson: true,
      })
    ).toBe(true);
    expect(
      hasIncompleteClaudeStdoutCarry({
        stdoutParserCarry: ' {"type": "assistant"}',
        stdoutParserCarryIsCompleteJson: true,
        stdoutParserCarryLooksLikeClaudeJson: true,
      })
    ).toBe(false);
  });
});
