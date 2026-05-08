import { describe, expect, it } from 'vitest';

import {
  buildProcessBootstrapPendingDiagnostic,
  buildProcessBootstrapTimeoutDiagnostic,
  deriveProcessTransportProjectionPhase,
  sanitizeProcessRuntimeEventFilePrefix,
  summarizeProcessBootstrapTransportEvents,
} from '@main/services/team/ProcessBootstrapTransportEvidence';

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
