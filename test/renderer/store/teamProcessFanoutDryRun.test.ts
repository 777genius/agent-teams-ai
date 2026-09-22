import { describe, expect, it } from 'vitest';

import {
  decideProcessFanoutMode,
  decideProcessFanoutDryRun,
  type TeamProcessFanoutInput,
} from '../../../src/renderer/store/teamProcessFanoutDryRun';

const baseInput: TeamProcessFanoutInput = {
  teamName: 'my-team',
  eventType: 'process',
  detail: 'processes.json',
  hasRunId: false,
  isStaleRuntimeEvent: false,
  isVisible: true,
  hasVisibleTeamData: true,
  hasActiveProvisioningRun: false,
  hasCurrentRuntimeRun: true,
};

describe('teamProcessFanoutDryRun', () => {
  it('does not mark non-process events as candidates', () => {
    expect(decideProcessFanoutDryRun({ ...baseInput, eventType: 'config' })).toEqual({
      wouldUseProcessLite: false,
      reason: 'not-process-event',
    });
  });

  it('does not mark stale runtime events as candidates', () => {
    expect(decideProcessFanoutDryRun({ ...baseInput, isStaleRuntimeEvent: true })).toEqual({
      wouldUseProcessLite: false,
      reason: 'stale-runtime-event',
    });
  });

  it('does not mark hidden teams as candidates', () => {
    expect(decideProcessFanoutDryRun({ ...baseInput, isVisible: false })).toEqual({
      wouldUseProcessLite: false,
      reason: 'hidden-team',
    });
  });

  it('does not mark visible teams without visible data as candidates', () => {
    expect(decideProcessFanoutDryRun({ ...baseInput, hasVisibleTeamData: false })).toEqual({
      wouldUseProcessLite: false,
      reason: 'missing-visible-team-data',
    });
  });

  it('does not mark teams without runtime or provisioning context as candidates', () => {
    expect(
      decideProcessFanoutDryRun({
        ...baseInput,
        hasActiveProvisioningRun: false,
        hasCurrentRuntimeRun: false,
      })
    ).toEqual({
      wouldUseProcessLite: false,
      reason: 'no-active-runtime-context',
    });
  });

  it('does not treat runId alone as a safe process-lite signal', () => {
    expect(
      decideProcessFanoutDryRun({
        ...baseInput,
        detail: 'cancelled',
        hasRunId: true,
      })
    ).toEqual({
      wouldUseProcessLite: false,
      reason: 'unsafe-process-detail',
    });
  });

  it('does not mark missing process detail as a candidate even with runId', () => {
    expect(
      decideProcessFanoutDryRun({
        ...baseInput,
        detail: undefined,
        hasRunId: true,
      })
    ).toEqual({
      wouldUseProcessLite: false,
      reason: 'unsafe-process-detail',
    });
  });

  it('marks visible processes.json updates with runtime context as candidates', () => {
    expect(decideProcessFanoutDryRun(baseInput)).toEqual({
      wouldUseProcessLite: true,
      reason: 'processes-json-visible-runtime-context',
    });
    expect(decideProcessFanoutMode(baseInput)).toEqual({
      mode: 'process-lite',
      reason: 'processes-json-visible-runtime-context',
    });
  });

  it('marks visible processes.json updates with active provisioning as candidates', () => {
    expect(
      decideProcessFanoutMode({
        ...baseInput,
        hasActiveProvisioningRun: true,
        hasCurrentRuntimeRun: false,
      })
    ).toEqual({
      mode: 'process-lite',
      reason: 'processes-json-visible-runtime-context',
    });
  });
});
