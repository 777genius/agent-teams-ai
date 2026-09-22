import { describe, expect, it } from 'vitest';

import {
  getPreCompleteCliErrorTextFromRun,
  getRunTrackedCwdFromRun,
  isCurrentTrackedRunById,
} from '../TeamProvisioningLeadRunDerivation';

describe('lead run derivation helpers', () => {
  it('derives current tracked run from the tracked run id', () => {
    expect(isCurrentTrackedRunById({ teamName: 'team-a', runId: 'run-1' }, 'run-1')).toBe(true);
    expect(isCurrentTrackedRunById({ teamName: 'team-a', runId: 'run-1' }, 'run-2')).toBe(false);
    expect(isCurrentTrackedRunById({ teamName: 'team-a', runId: 'run-1' }, null)).toBe(false);
  });

  it('prefers request cwd over spawn cwd and trims before resolving', () => {
    const resolvePath = (cwd: string) => `/resolved/${cwd}`;

    expect(
      getRunTrackedCwdFromRun(
        {
          request: { cwd: '  project-a  ' },
          spawnContext: { cwd: 'project-b' },
        },
        resolvePath
      )
    ).toBe('/resolved/project-a');

    expect(
      getRunTrackedCwdFromRun(
        {
          request: { cwd: '   ' },
          spawnContext: { cwd: ' project-b ' },
        },
        resolvePath
      )
    ).toBe('/resolved/project-b');
  });

  it('returns only stderr and plaintext trailing stdout for pre-complete error checks', () => {
    expect(
      getPreCompleteCliErrorTextFromRun({
        stderrBuffer: ' stderr auth failure ',
        stdoutParserCarry: ' trailing stdout failure ',
        stdoutParserCarryIsCompleteJson: false,
        stdoutParserCarryLooksLikeClaudeJson: false,
      })
    ).toBe('stderr auth failure\ntrailing stdout failure');

    expect(
      getPreCompleteCliErrorTextFromRun({
        stderrBuffer: '',
        stdoutParserCarry: '{"type":"assistant"}',
        stdoutParserCarryIsCompleteJson: true,
        stdoutParserCarryLooksLikeClaudeJson: true,
      })
    ).toBe('');
  });
});
