import {
  buildProcessBootstrapPendingDiagnostic,
  buildProcessBootstrapTimeoutDiagnostic,
  deriveProcessTransportProjectionPhase,
  sanitizeProcessRuntimeEventFilePrefix,
  summarizeProcessBootstrapTransportEvents,
} from '@main/services/team/ProcessBootstrapTransportEvidence';
import { describe, expect, it } from 'vitest';

describe('ProcessBootstrapTransportEvidence', () => {
  it('keeps retryable submit rejection non-terminal when a later submit succeeds', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'runtime_ready',
        timestamp: '2026-05-07T10:00:00.000Z',
        detail: 'ready',
      },
      {
        type: 'bootstrap_submit_rejected',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'temporary backoff',
        retryable: true,
      },
      {
        type: 'bootstrap_submitted',
        timestamp: '2026-05-07T10:00:02.000Z',
        detail: 'messageId=abc',
      },
    ]);

    expect(summary).toMatchObject({
      submitted: true,
      hasProgress: true,
    });
    expect(summary?.terminalFailure).toBeUndefined();
    expect(summary?.lastStage).toContain('bootstrap submitted');
  });

  it('treats non-retryable submit rejection as terminal', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'bootstrap_submit_rejected',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'fatal submit rejection',
        retryable: false,
      },
    ]);

    expect(summary?.terminalFailure).toMatchObject({
      kind: 'non_retryable_submit_rejection',
      reason: 'bootstrap submit rejected: fatal submit rejection',
    });
  });

  it('treats accepted submit without a message id as terminal', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'bootstrap_submit_accepted_without_uuid',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'accepted but missing message id',
      },
    ]);

    expect(summary?.terminalFailure).toMatchObject({
      kind: 'accepted_without_message_id',
      reason: 'bootstrap submit accepted without message id: accepted but missing message id',
    });
  });

  it('redacts secrets and paths from transport diagnostics', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'bootstrap_submit_rejected',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail:
          'failed in /Users/belief/dev/project with token sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
        retryable: false,
      },
    ]);

    expect(summary?.terminalFailure?.reason).toContain('[path]');
    expect(summary?.terminalFailure?.reason).toContain('[redacted]');
    expect(summary?.terminalFailure?.reason).not.toContain('/Users/belief');
    expect(summary?.terminalFailure?.reason).not.toContain('sk-ant-api03');
  });

  it('does not surface raw command or cwd details for parent-owned process stages', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'process_spawned',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'spawned /Users/belief/project with command secret',
      },
    ]);

    expect(summary?.lastStage).toBe('process spawned');
  });

  it('surfaces headless startup checkpoints as transport progress', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'cli_started',
        timestamp: '2026-05-07T10:00:00.000Z',
        detail: 'teammateRuntime=headless',
      },
      {
        type: 'startup_checkpoint',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'commands_agents_loaded',
      },
    ]);

    expect(summary).toMatchObject({
      submitted: false,
      hasProgress: true,
      lastStage: 'startup checkpoint: commands_agents_loaded',
    });
    expect(buildProcessBootstrapTimeoutDiagnostic(summary!)).toBe(
      'Bootstrap prompt was not submitted before timeout. Last transport stage: startup checkpoint: commands_agents_loaded'
    );
  });

  it('builds stable pending and timeout diagnostics from the last transport stage', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'bootstrap_prompt_observed',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'prompt seen',
      },
    ]);

    expect(summary).not.toBeNull();
    expect(buildProcessBootstrapPendingDiagnostic(summary!)).toBe(
      'Bootstrap prompt has not been submitted yet. Last transport stage: bootstrap prompt observed: prompt seen.'
    );
    expect(buildProcessBootstrapTimeoutDiagnostic(summary!)).toBe(
      'Bootstrap prompt was not submitted before timeout. Last transport stage: bootstrap prompt observed: prompt seen'
    );
  });

  it('reports inbox poller readiness as progress without treating bootstrap as submitted', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'mailbox_bootstrap_written',
        timestamp: '2026-05-07T10:00:00.000Z',
        detail: 'messageId=bootstrap-1; readbackAttempts=1',
      },
      {
        type: 'inbox_poller_ready',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'initial poll observed bootstrap prompt',
      },
    ]);

    expect(summary).toMatchObject({
      submitted: false,
      hasProgress: true,
      lastStage: 'inbox poller ready: initial poll observed bootstrap prompt',
    });
    expect(buildProcessBootstrapPendingDiagnostic(summary!)).toBe(
      'Bootstrap prompt has not been submitted yet. Last transport stage: inbox poller ready: initial poll observed bootstrap prompt.'
    );
    expect(buildProcessBootstrapTimeoutDiagnostic(summary!)).toBe(
      'Bootstrap prompt was not submitted before timeout. Last transport stage: inbox poller ready: initial poll observed bootstrap prompt'
    );
  });

  it('treats runtime failure after mailbox write as terminal without marking bootstrap submitted', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'mailbox_bootstrap_written',
        timestamp: '2026-05-07T10:00:00.000Z',
        detail: 'messageId=bootstrap-1',
      },
      {
        type: 'failed',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'teammate process exited before inbox_poller_ready',
      },
    ]);

    expect(summary).toMatchObject({
      submitted: false,
      hasProgress: true,
      lastStage: 'runtime failed: teammate process exited before inbox_poller_ready',
      terminalFailure: {
        kind: 'runtime_failed_before_confirmation',
        reason: 'runtime failed: teammate process exited before inbox_poller_ready',
      },
    });
  });

  it('treats process exit after submit attempt as terminal without durable submit proof', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'bootstrap_submit_attempted',
        timestamp: '2026-05-07T10:00:00.000Z',
        detail: 'submitting bootstrap prompt',
      },
      {
        type: 'exited',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'process exited before bootstrap_submitted',
      },
    ]);

    expect(summary).toMatchObject({
      submitted: false,
      hasProgress: true,
      lastStage: 'runtime exited: process exited before bootstrap_submitted',
      terminalFailure: {
        kind: 'process_exited_before_confirmation',
        reason: 'runtime exited: process exited before bootstrap_submitted',
      },
    });
  });

  it('distinguishes submitted bootstrap prompts from not-submitted transport timeouts', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'bootstrap_submitted',
        timestamp: '2026-05-07T10:00:02.000Z',
        detail: 'messageId=abc',
      },
    ]);

    expect(summary).not.toBeNull();
    expect(buildProcessBootstrapPendingDiagnostic(summary!)).toBe(
      'Bootstrap prompt was submitted; waiting for bootstrap confirmation. Last transport stage: bootstrap submitted: messageId=abc.'
    );
    expect(buildProcessBootstrapTimeoutDiagnostic(summary!)).toBe(
      'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before timeout. Last transport stage: bootstrap submitted: messageId=abc'
    );
  });

  it('keeps submitted state when the runtime fails before bootstrap confirmation', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'mailbox_bootstrap_written',
        timestamp: '2026-05-07T10:00:00.000Z',
        detail: 'messageId=bootstrap-alice-1',
      },
      {
        type: 'bootstrap_submitted',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'messageId=bootstrap-alice-1',
      },
      {
        type: 'failed',
        timestamp: '2026-05-07T10:00:02.000Z',
        detail: 'bootstrap confirmation timeout',
      },
    ]);

    expect(summary).toMatchObject({
      submitted: true,
      hasProgress: true,
      lastStage: 'runtime failed: bootstrap confirmation timeout',
      terminalFailure: {
        kind: 'runtime_failed_before_confirmation',
        reason: 'runtime failed: bootstrap confirmation timeout',
      },
    });
    expect(buildProcessBootstrapTimeoutDiagnostic(summary!)).toBe(
      'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before timeout. Last transport stage: runtime failed: bootstrap confirmation timeout'
    );
  });

  it('keeps submitted state when the process exits after durable bootstrap submission', () => {
    const summary = summarizeProcessBootstrapTransportEvents([
      {
        type: 'bootstrap_submitted',
        timestamp: '2026-05-07T10:00:01.000Z',
        detail: 'messageId=bootstrap-bob-1',
      },
      {
        type: 'exited',
        timestamp: '2026-05-07T10:00:02.000Z',
        detail: 'process exited before bootstrap confirmation',
      },
    ]);

    expect(summary).toMatchObject({
      submitted: true,
      hasProgress: true,
      lastStage: 'runtime exited: process exited before bootstrap confirmation',
      terminalFailure: {
        kind: 'process_exited_before_confirmation',
        reason: 'runtime exited: process exited before bootstrap confirmation',
      },
    });
    expect(buildProcessBootstrapPendingDiagnostic(summary!)).toBe(
      'Bootstrap prompt was submitted; waiting for bootstrap confirmation. Last transport stage: runtime exited: process exited before bootstrap confirmation.'
    );
  });

  it('keeps active phase pending and turns final timeout into final projection', () => {
    expect(deriveProcessTransportProjectionPhase({ launchPhase: 'active' })).toBe('active');
    expect(
      deriveProcessTransportProjectionPhase({
        launchPhase: 'active',
        finalTimeoutReached: true,
      })
    ).toBe('final');
    expect(deriveProcessTransportProjectionPhase({ launchPhase: 'finished' })).toBe('final');
  });

  it('matches orchestrator runtime-event filename sanitization for important names', () => {
    expect(sanitizeProcessRuntimeEventFilePrefix('jack')).toBe('jack');
    expect(sanitizeProcessRuntimeEventFilePrefix('con.txt')).toBe('con-txt');
    expect(sanitizeProcessRuntimeEventFilePrefix('CON')).toBe('_con');
    expect(sanitizeProcessRuntimeEventFilePrefix('alice/bob')).toBe('alice-bob');
  });
});
