import { describe, expect, it } from 'vitest';

import {
  addIgnoredTeamRun,
  isTeamRunIgnored,
  removeIgnoredTeamRunOwner,
} from '../../../src/renderer/store/team/teamProvisioningRunIdentity';

describe('provisioning run owner identity', () => {
  it('retains each owner when one run is shared and removes only the requested owner', () => {
    const first = addIgnoredTeamRun({}, 'run-1', 'builders');
    expect(first['run-1']).toBe('builders');
    const shared = addIgnoredTeamRun(first, 'run-1', 'ptc-a');
    const repeated = addIgnoredTeamRun(shared, 'run-1', 'builders');

    expect(isTeamRunIgnored(repeated, 'run-1', 'builders')).toBe(true);
    expect(isTeamRunIgnored(repeated, 'run-1', 'ptc-a')).toBe(true);
    expect(isTeamRunIgnored(repeated, 'run-1', 'ptc-b')).toBe(false);
    expect(repeated['run-1']).toEqual(['builders', 'ptc-a']);

    const remaining = removeIgnoredTeamRunOwner(repeated, 'builders');
    expect(remaining).toEqual({ 'run-1': 'ptc-a' });
    expect(removeIgnoredTeamRunOwner(remaining, 'ptc-a')).toEqual({});
    expect(first).toEqual({ 'run-1': 'builders' });
  });

  it.each([
    '["run-1","ptc-a"]',
    'run-1\u0000ptc-a',
    'run-1:ptc-a',
    'constructor',
    '__proto__',
    'toString',
  ])('keeps a raw run ID %j independent from another run and owner', (rawRunId) => {
    expect(isTeamRunIgnored({}, rawRunId, 'ptc-a')).toBe(false);
    let ignored = addIgnoredTeamRun({}, 'run-1', 'builders');
    ignored = addIgnoredTeamRun(ignored, 'run-1', 'ptc-a');
    ignored = addIgnoredTeamRun(ignored, rawRunId, 'ptc-b');

    expect(isTeamRunIgnored(ignored, 'run-1', 'ptc-a')).toBe(true);
    expect(isTeamRunIgnored(ignored, rawRunId, 'ptc-a')).toBe(false);
    expect(isTeamRunIgnored(ignored, rawRunId, 'ptc-b')).toBe(true);
    expect(Object.keys(ignored)).toEqual(['run-1', rawRunId]);
    expect(removeIgnoredTeamRunOwner(ignored, 'ptc-a')).toEqual({
      'run-1': 'builders',
      [rawRunId]: 'ptc-b',
    });
  });
});
