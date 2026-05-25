import {
  buildCliExitFailurePresentation,
  buildCombinedLogs,
  buildDeterministicBootstrapExitFailure,
  buildSanitizedCliExitError,
  type CliExitPresentationRun,
  formatPendingBootstrapMemberNames,
  parseCliLogLinesFromText,
} from '@main/services/team/provisioning/TeamProvisioningCliExitPresentation';
import { describe, expect, it } from 'vitest';

function run(overrides: Partial<CliExitPresentationRun> = {}): CliExitPresentationRun {
  return {
    stdoutBuffer: '',
    stderrBuffer: '',
    claudeLogLines: [],
    deterministicBootstrap: false,
    deterministicBootstrapMemberSpawnSeen: false,
    expectedMembers: [],
    memberSpawnStatuses: new Map(),
    ...overrides,
  };
}

describe('TeamProvisioningCliExitPresentation', () => {
  it('combines stdout and stderr with stable stream markers', () => {
    expect(buildCombinedLogs('', '')).toBe('');
    expect(buildCombinedLogs(' stdout only ', '')).toBe('stdout only');
    expect(buildCombinedLogs('', ' stderr only ')).toBe('stderr only');
    expect(buildCombinedLogs('out', 'err')).toBe('[stdout]\nout\n\n[stderr]\nerr');
  });

  it('parses stream markers and ignores blank log lines', () => {
    expect(parseCliLogLinesFromText('[stdout]\nhello\n\n[stderr]\nboom')).toEqual([
      { stream: 'stdout', text: 'hello' },
      { stream: 'stderr', text: 'boom' },
    ]);
  });

  it('extracts structured CLI errors while filtering setup noise', () => {
    const sanitized = buildSanitizedCliExitError(
      run({
        claudeLogLines: [
          '[stdout]',
          '{"type":"system","subtype":"init","message":"ignore"}',
          '[stderr]',
          '{"type":"error","message":"Invalid API key"}',
          '{"type":"result","subtype":"error","error":"Quota exceeded"}',
          'TodoWrite hook_progress should stay hidden',
          'plain stderr failure',
        ],
      })
    );

    expect(sanitized).toBe('Invalid API key\nQuota exceeded\nplain stderr failure');
  });

  it('adds final partial buffer errors when line history already exists', () => {
    expect(
      buildSanitizedCliExitError(
        run({
          claudeLogLines: ['[stderr]', 'first failure'],
          stderrBuffer: 'first failure\nsecond failure without newline',
        })
      )
    ).toBe('first failure\nsecond failure without newline');
  });

  it('reports login guidance before generic sanitized errors', () => {
    expect(
      buildCliExitFailurePresentation(
        run({ stderrBuffer: 'Please run /login to authenticate' }),
        1,
        { cliCommandLabel: 'Claude CLI' }
      ).error
    ).toContain('Claude CLI reports it is not authenticated');
  });

  it('formats deterministic bootstrap failures by observed stage', () => {
    expect(
      buildDeterministicBootstrapExitFailure(run({ deterministicBootstrap: true })).error
    ).toContain('before deterministic team bootstrap started');

    expect(
      buildDeterministicBootstrapExitFailure(
        run({
          deterministicBootstrap: true,
          lastDeterministicBootstrapEvent: 'team_bootstrap',
          lastDeterministicBootstrapPhase: 'planning',
        })
      ).error
    ).toContain('Last bootstrap event: team_bootstrap/planning');
  });

  it('summarizes pending bootstrap members with a stable cap', () => {
    expect(
      formatPendingBootstrapMemberNames(
        run({
          expectedMembers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
          memberSpawnStatuses: new Map([
            ['a', { bootstrapConfirmed: true }],
            ['b', { bootstrapConfirmed: false }],
          ]),
        })
      )
    ).toBe('b, c, d, e, f, g and 1 more');
  });

  it('falls back to deterministic or generic exit presentations when logs are not useful', () => {
    expect(
      buildCliExitFailurePresentation(
        run({
          deterministicBootstrap: true,
          lastDeterministicBootstrapEvent: 'team_bootstrap',
          deterministicBootstrapMemberSpawnSeen: true,
          expectedMembers: ['lead', 'worker'],
          memberSpawnStatuses: new Map([['lead', { bootstrapConfirmed: true }]]),
        }),
        1,
        { cliCommandLabel: 'Codex runtime' }
      )
    ).toEqual({
      message: 'Launch bootstrap was not confirmed',
      error:
        'Bootstrap was not confirmed before the Codex runtime exited. Pending teammates: worker.',
    });

    expect(
      buildCliExitFailurePresentation(run(), 1, { cliCommandLabel: 'Claude CLI' }).error
    ).toContain('Claude CLI exited with code 1 without user-facing stdout/stderr');
    expect(
      buildCliExitFailurePresentation(run(), null, { cliCommandLabel: 'Claude CLI' }).error
    ).toBe('Claude CLI exited with code unknown');
  });
});
