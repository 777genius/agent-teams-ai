import { describe, expect, it } from 'vitest';

import {
  buildUncommittableOpenCodeSessionDiagnostic,
  classifyOpenCodeLeadLaunchEvidence,
  describeBlockedOpenCodePrimaryLaneLaunch,
  describeClearedOpenCodePrimaryLaneStorage,
  describeDeferredOpenCodeLaunchPrompt,
  describeUnavailableOpenCodeLaunchPromptLead,
  OPENCODE_LAUNCH_PROMPT_DEFERRED_DIAGNOSTIC,
} from '../TeamProvisioningOpenCodeBlockedLaunchReporting';

import {
  buildFailedOpenCodeLaunchResult,
  buildRetainableOpenCodeLaunchResult,
  buildUncommittedPrimaryLeadLaunchResult,
} from './support/openCodeUncommittedPrimaryLane';

import type { TeamRuntimeLaunchResult } from '../../runtime';

describe('reporting never changes a launch', () => {
  // NEGATIVE CONTROL: every export in this module is a pure string builder. If
  // one of them ever grew a side effect it would have to take a port, and this
  // call - made with no ports at all - would stop compiling.
  it('produces reports from the result alone, with no ports and no writes', () => {
    const result = buildFailedOpenCodeLaunchResult('team-lead', 'runtime binary unreachable');
    const before = JSON.parse(JSON.stringify(result)) as TeamRuntimeLaunchResult;

    describeBlockedOpenCodePrimaryLaneLaunch({ teamName: 'lane-team', runId: 'run-a1', result });
    describeClearedOpenCodePrimaryLaneStorage({ teamName: 'lane-team', runId: 'run-a1' });
    describeUnavailableOpenCodeLaunchPromptLead({
      teamName: 'lane-team',
      leadName: 'team-lead',
      primaryResult: result,
    });
    describeDeferredOpenCodeLaunchPrompt({ teamName: 'lane-team', leadName: 'team-lead' });
    buildUncommittableOpenCodeSessionDiagnostic({
      memberName: 'team-lead',
      reason: 'missing_runtime_session_id',
    });

    // The launch result the reports were built from is byte-identical afterwards.
    expect(result).toEqual(before);
  });

  // NEGATIVE CONTROL: a team that is not blocked produces zero reports.
  it('reports nothing at all for a healthy lead', () => {
    expect(
      describeUnavailableOpenCodeLaunchPromptLead({
        teamName: 'lane-team',
        leadName: 'team-lead',
        primaryResult: buildRetainableOpenCodeLaunchResult('team-lead'),
      })
    ).toBeNull();
  });

  it('reports nothing when the primary lane carries no entry for the lead', () => {
    expect(
      describeUnavailableOpenCodeLaunchPromptLead({
        teamName: 'lane-team',
        leadName: 'team-lead',
        primaryResult: buildRetainableOpenCodeLaunchResult('Ada'),
      })
    ).toBeNull();
  });
});

describe('describeBlockedOpenCodePrimaryLaneLaunch', () => {
  it('names the pre-launch gate, the reason and the members that failed', () => {
    const result = buildFailedOpenCodeLaunchResult('team-lead', 'runtime binary unreachable');
    result.preLaunchGate = { blocked: true, reason: 'runtime_unreachable', retryable: true };
    result.diagnostics = ['probe timed out'];

    expect(
      describeBlockedOpenCodePrimaryLaneLaunch({ teamName: 'lane-team', runId: 'run-a1', result })
    ).toBe(
      '[lane-team] opencode_primary_lane_launch_blocked run=run-a1 ' +
        'preLaunchGate=runtime_unreachable/retryable=true reason=runtime binary unreachable ' +
        'members=team-lead diagnostics=probe timed out'
    );
  });

  it('says so explicitly when there is no gate, no reason and no diagnostics', () => {
    const result = buildUncommittedPrimaryLeadLaunchResult({ teamLaunchState: 'partial_failure' });

    expect(
      describeBlockedOpenCodePrimaryLaneLaunch({ teamName: 'lane-team', runId: 'run-a1', result })
    ).toBe(
      '[lane-team] opencode_primary_lane_launch_blocked run=run-a1 preLaunchGate=none ' +
        'reason=unknown members=none diagnostics=none'
    );
  });

  // The report goes to a durable sink, and a runtime that failed while starting
  // prints the command line it was given. Nothing downstream redacts a
  // persisted log line, so the redaction has to happen here.
  it('redacts secrets out of the member reason and the lane diagnostics', () => {
    const result = buildFailedOpenCodeLaunchResult(
      'team-lead',
      'spawn failed: opencode --api-key sk-abcdefghijklmnop01 serve'
    );
    result.diagnostics = ['probe rejected: Authorization: Bearer abc.def'];

    const report = describeBlockedOpenCodePrimaryLaneLaunch({
      teamName: 'lane-team',
      runId: 'run-a1',
      result,
    });

    expect(report).toBe(
      '[lane-team] opencode_primary_lane_launch_blocked run=run-a1 preLaunchGate=none ' +
        'reason=spawn failed: opencode --api-key [redacted] serve members=team-lead ' +
        'diagnostics=probe rejected: Authorization: Bearer [redacted]'
    );
  });

  it('falls back to the gate reason when no member carries one', () => {
    const result = buildUncommittedPrimaryLeadLaunchResult({ teamLaunchState: 'partial_failure' });
    result.preLaunchGate = { blocked: true, reason: 'shared_runtime_timeout', retryable: false };

    expect(
      describeBlockedOpenCodePrimaryLaneLaunch({ teamName: 'lane-team', runId: 'run-a1', result })
    ).toContain('reason=shared_runtime_timeout');
  });
});

describe('describeUnavailableOpenCodeLaunchPromptLead', () => {
  // Same durable sink, same free-form fields: the lead's own runtime
  // diagnostic is whatever the bridge printed.
  it('redacts the reason it quotes from the lead evidence', () => {
    const result = buildFailedOpenCodeLaunchResult('team-lead', '   ');
    result.members['team-lead'].runtimeDiagnostic =
      'host refused: Authorization: Bearer eyJhbGciOi.payload';

    expect(
      describeUnavailableOpenCodeLaunchPromptLead({
        teamName: 'lane-team',
        leadName: 'team-lead',
        primaryResult: result,
      })
    ).toBe(
      '[lane-team] opencode_launch_prompt_lead_unavailable lead=team-lead ' +
        'reason=host refused: Authorization: Bearer [redacted]'
    );
  });
});

describe('describeClearedOpenCodePrimaryLaneStorage', () => {
  it('names the run whose evidence was destroyed', () => {
    expect(
      describeClearedOpenCodePrimaryLaneStorage({ teamName: 'lane-team', runId: 'run-a1' })
    ).toBe(
      '[lane-team] opencode_primary_lane_storage_cleared run=run-a1 ' +
        'reason=unretainable_launch detail=lane_has_no_session_record'
    );
  });
});

describe('buildUncommittableOpenCodeSessionDiagnostic', () => {
  it('distinguishes a missing session id from a candidate mismatch', () => {
    expect(
      buildUncommittableOpenCodeSessionDiagnostic({
        memberName: 'team-lead',
        reason: 'missing_runtime_session_id',
      })
    ).toBe('opencode_bootstrap_session_not_committed:team-lead:missing_runtime_session_id');
    expect(
      buildUncommittableOpenCodeSessionDiagnostic({
        memberName: 'team-lead',
        reason: 'app_managed_candidate_mismatch',
      })
    ).toBe('opencode_bootstrap_session_not_committed:team-lead:app_managed_candidate_mismatch');
  });
});

describe('classifyOpenCodeLeadLaunchEvidence', () => {
  it('is unknown when the lane reports no entry for the lead', () => {
    expect(classifyOpenCodeLeadLaunchEvidence(null, 'team-lead')).toBe('unknown');
    expect(
      classifyOpenCodeLeadLaunchEvidence(buildRetainableOpenCodeLaunchResult('Ada'), 'team-lead')
    ).toBe('unknown');
  });

  it('is retainable for a lead the lane reports as alive', () => {
    expect(
      classifyOpenCodeLeadLaunchEvidence(
        buildRetainableOpenCodeLaunchResult('team-lead'),
        'team-lead'
      )
    ).toBe('retainable');
  });

  it('is unretainable for a lead the lane explicitly failed', () => {
    expect(
      classifyOpenCodeLeadLaunchEvidence(
        buildFailedOpenCodeLaunchResult('team-lead', 'runtime binary unreachable'),
        'team-lead'
      )
    ).toBe('unretainable');
  });

  it('matches the lead by its evidence member name, not the record key', () => {
    const result = buildRetainableOpenCodeLaunchResult('team-lead');
    result.members['lane-0'] = result.members['team-lead'];
    delete result.members['team-lead'];

    expect(classifyOpenCodeLeadLaunchEvidence(result, 'TEAM-LEAD')).toBe('retainable');
  });
});

describe('describeUnavailableOpenCodeLaunchPromptLead', () => {
  it('names the failure the lane reported for the lead', () => {
    expect(
      describeUnavailableOpenCodeLaunchPromptLead({
        teamName: 'lane-team',
        leadName: 'team-lead',
        primaryResult: buildFailedOpenCodeLaunchResult('team-lead', 'runtime binary unreachable'),
      })
    ).toBe(
      '[lane-team] opencode_launch_prompt_lead_unavailable ' +
        'lead=team-lead reason=runtime binary unreachable'
    );
  });

  it('falls back to a named reason when the lane gave none', () => {
    const result = buildFailedOpenCodeLaunchResult('team-lead', '');
    result.members['team-lead'] = { ...result.members['team-lead'], hardFailureReason: undefined };

    expect(
      describeUnavailableOpenCodeLaunchPromptLead({
        teamName: 'lane-team',
        leadName: 'team-lead',
        primaryResult: result,
      })
    ).toContain('reason=primary_lane_produced_no_runtime_evidence');
  });
});

describe('describeDeferredOpenCodeLaunchPrompt', () => {
  it('names the lead the dispatch is waiting on', () => {
    expect(
      describeDeferredOpenCodeLaunchPrompt({ teamName: 'lane-team', leadName: 'team-lead' })
    ).toBe(`[lane-team] ${OPENCODE_LAUNCH_PROMPT_DEFERRED_DIAGNOSTIC} lead=team-lead`);
  });
});
