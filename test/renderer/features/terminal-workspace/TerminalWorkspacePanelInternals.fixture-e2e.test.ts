import {
  formatTerminalPromptLabel,
  formatWorkingDirectory,
  inferTerminalCommandCompletion,
  inferTerminalCommandOutputStatus,
  normalizeTerminalCommandRunEventDetail,
  settleTerminalCommandRuns,
  type TerminalCommandRunPresentation,
  upsertTerminalCommandRun,
} from '@features/terminal-workspace/renderer/ui/TerminalWorkspacePanel';
import { describe, expect, it } from 'vitest';

describe('terminal workspace panel internals fixture-e2e', () => {
  it('formats working directories for compact terminal chrome', () => {
    expect(formatWorkingDirectory(null)).toBe('Shell default directory');
    expect(formatWorkingDirectory('   ')).toBe('Shell default directory');
    expect(formatWorkingDirectory('/Users/belief/dev/projects/claude_team///')).toBe(
      '~/dev/projects/claude_team'
    );
    expect(formatWorkingDirectory('/tmp/sandbox/project/')).toBe('/tmp/sandbox/project');
    expect(formatWorkingDirectory('/Users/belief')).toBe('~');
  });

  it('uses a readable local-shell prompt when no cwd is available', () => {
    expect(formatTerminalPromptLabel(null)).toBe('local shell');
    expect(formatTerminalPromptLabel('/Users/belief/dev/quanta')).toBe('~/dev/quanta');
  });

  it('normalizes command lifecycle events from the command dock', () => {
    const detail = normalizeTerminalCommandRunEventDetail(
      new CustomEvent('tp-terminal-command-started', {
        detail: {
          clientEventId: 'event-1',
          command: '  pnpm test  ',
          durationMs: 27.5,
          paneId: 'pane-1',
          sessionId: 'session-1',
          startedAtMs: 1000,
        },
      })
    );

    expect(detail).toEqual({
      clientEventId: 'event-1',
      command: 'pnpm test',
      durationMs: 27.5,
      paneId: 'pane-1',
      sessionId: 'session-1',
      startedAtMs: 1000,
      status: 'running',
    });
  });

  it('rejects incomplete command lifecycle events before they reach history metadata', () => {
    expect(
      normalizeTerminalCommandRunEventDetail(
        new CustomEvent('tp-terminal-command-started', {
          detail: {
            clientEventId: 'event-1',
            command: 'pnpm test',
            paneId: '',
            sessionId: 'session-1',
          },
        })
      )
    ).toBeNull();
    expect(normalizeTerminalCommandRunEventDetail(new Event('plain'))).toBeNull();
  });

  it('upserts command runs by client event id and caps retained metadata', () => {
    const runs = Array.from({ length: 82 }, (_, index) =>
      createRun({
        clientEventId: `event-${index}`,
        command: `echo ${index}`,
        startedAtMs: index,
      })
    );

    const capped = upsertTerminalCommandRun(
      runs,
      createRun({
        clientEventId: 'event-10',
        command: 'echo replaced',
        durationMs: 10,
      }),
      'succeeded'
    );
    const appended = upsertTerminalCommandRun(
      capped,
      createRun({
        clientEventId: 'event-new',
        command: 'echo latest',
      }),
      'running'
    );

    expect(capped).toHaveLength(80);
    expect(capped.find((run) => run.clientEventId === 'event-10')).toMatchObject({
      command: 'echo replaced',
      durationMs: 10,
      status: 'succeeded',
    });
    expect(appended).toHaveLength(80);
    expect(appended.at(-1)).toMatchObject({
      clientEventId: 'event-new',
      command: 'echo latest',
      status: 'running',
    });
    expect(appended[0]?.clientEventId).toBe('event-3');
  });

  it('caps command presentation metadata per pane during busy multi-tab sessions', () => {
    let runs = [
      createRun({
        clientEventId: 'build-command',
        command: 'pnpm build',
        paneId: 'pane-build',
      }),
    ];

    for (let index = 0; index < 96; index += 1) {
      runs = upsertTerminalCommandRun(
        runs,
        createRun({
          clientEventId: `test-command-${index}`,
          command: `printf TEST_${index}\\n`,
          paneId: 'pane-tests',
          startedAtMs: 20_000 + index,
        }),
        'running'
      );
    }

    expect(runs.find((run) => run.clientEventId === 'build-command')).toMatchObject({
      command: 'pnpm build',
      paneId: 'pane-build',
    });
    expect(runs.filter((run) => run.paneId === 'pane-tests')).toHaveLength(80);
    expect(runs.find((run) => run.clientEventId === 'test-command-15')).toBeUndefined();
    expect(runs.find((run) => run.clientEventId === 'test-command-16')).toMatchObject({
      command: 'printf TEST_16\\n',
    });
  });

  it('settles a running command as succeeded when output appears before the next prompt', () => {
    const run = createRun({ command: "printf 'ok\\n'", startedAtMs: 1000 });
    const next = settleTerminalCommandRuns(
      [run],
      ["shell % printf 'ok\\n'", 'ok', 'shell %'],
      1375,
      false
    );

    expect(next).not.toBe([run]);
    expect(next[0]).toMatchObject({
      durationMs: 375,
      status: 'succeeded',
    });
  });

  it('settles a missing-file command as failed and stores its duration', () => {
    const next = settleTerminalCommandRuns(
      [createRun({ command: 'ls __missing_file__', startedAtMs: 1000 })],
      ['shell % ls __missing_file__', 'ls: __missing_file__: No such file or directory', 'shell %'],
      1294,
      false
    );

    expect(next[0]).toMatchObject({
      durationMs: 294,
      status: 'failed',
    });
  });

  it('does not falsely mark no-output commands as succeeded during the first screen pass', () => {
    const run = createRun({ command: 'true', startedAtMs: 1000 });
    const next = settleTerminalCommandRuns([run], ['shell % true', 'shell %'], 2100, false);

    expect(next).toBe(next);
    expect(next[0]).toBe(run);
  });

  it('marks no-output commands as unknown only after the quiet-period pass', () => {
    const next = settleTerminalCommandRuns(
      [createRun({ command: 'true', startedAtMs: 1000 })],
      ['shell % true', 'shell %'],
      2100,
      true
    );

    expect(next[0]).toMatchObject({
      durationMs: 1100,
      status: 'unknown',
    });
  });

  it('promotes already-settled commands to failed when later terminal output reveals an error', () => {
    const next = settleTerminalCommandRuns(
      [
        createRun({
          command: 'git status',
          durationMs: 90,
          status: 'unknown',
        }),
      ],
      [
        'shell % git status',
        'fatal: not a git repository (or any of the parent directories): .git',
        'shell %',
      ],
      2000,
      true
    );

    expect(next[0]).toMatchObject({
      durationMs: 90,
      status: 'failed',
    });
  });

  it('matches wrapped prompt command lines emitted by the terminal emulator', () => {
    expect(
      inferTerminalCommandCompletion(
        ['<                      echo TP_WRAPPED_OK', 'TP_WRAPPED_OK', 'shell %'],
        'echo   TP_WRAPPED_OK'
      )
    ).toEqual({
      completed: true,
      outputLines: ['TP_WRAPPED_OK'],
    });
  });

  it('does not complete a command until the next prompt boundary is visible', () => {
    expect(
      inferTerminalCommandCompletion(['shell % pnpm test', 'still running'], 'pnpm test')
    ).toEqual({
      completed: false,
      outputLines: [],
    });
  });

  it('infers command output status from common shell failures', () => {
    expect(inferTerminalCommandOutputStatus(['zsh: command not found: nope'])).toBe('failed');
    expect(inferTerminalCommandOutputStatus(['fatal: not a git repository'])).toBe('failed');
    expect(inferTerminalCommandOutputStatus(['permission denied'])).toBe('failed');
    expect(inferTerminalCommandOutputStatus(['ls: nope: No such file or directory'])).toBe(
      'failed'
    );
    expect(inferTerminalCommandOutputStatus(['all good'])).toBe('succeeded');
  });

  it('infers failed status from common process and package-manager failures', () => {
    expect(inferTerminalCommandOutputStatus(['Command exited with code 1'])).toBe('failed');
    expect(inferTerminalCommandOutputStatus(['process exit status 2'])).toBe('failed');
    expect(inferTerminalCommandOutputStatus(['npm ERR! missing script: build'])).toBe('failed');
    expect(inferTerminalCommandOutputStatus(['pnpm ERR! test failed'])).toBe('failed');
    expect(
      inferTerminalCommandOutputStatus([
        'Traceback (most recent call last):',
        'ValueError: fixture failed',
      ])
    ).toBe('failed');
  });

  it('does not treat successful output mentioning zero failures as an error', () => {
    expect(inferTerminalCommandOutputStatus(['Tests: 0 failed, 42 passed'])).toBe('succeeded');
    expect(inferTerminalCommandOutputStatus(['exit code 0'])).toBe('succeeded');
  });

  it('keeps quoted shell continuation prompts inside output rather than mixing commands', () => {
    expect(
      inferTerminalCommandCompletion(
        [
          'shell % printf "TP_QUOTE',
          'dquote> _OK\\n"',
          'TP_QUOTE_OK',
          'shell %',
          'shell % echo next',
        ],
        'printf "TP_QUOTE'
      )
    ).toEqual({
      completed: true,
      outputLines: ['dquote> _OK\\n"', 'TP_QUOTE_OK'],
    });
  });

  it('keeps the latest repeated command running when an older identical command completed', () => {
    expect(
      inferTerminalCommandCompletion(
        [
          'shell % pnpm test',
          'old run passed',
          'shell %',
          'shell % pnpm test',
          'new run still streaming',
        ],
        'pnpm test'
      )
    ).toEqual({
      completed: false,
      outputLines: [],
    });
  });

  it('settles the latest repeated command using only its latest output block', () => {
    expect(
      inferTerminalCommandCompletion(
        [
          'shell % pnpm test',
          'old run passed',
          'shell %',
          'shell % pnpm test',
          'pnpm ERR! latest run failed',
          'shell %',
        ],
        'pnpm test'
      )
    ).toEqual({
      completed: true,
      outputLines: ['pnpm ERR! latest run failed'],
    });
  });

  it('infers ANSI-colored terminal errors as failures', () => {
    expect(
      inferTerminalCommandOutputStatus(['\u001b[31mfatal:\u001b[0m not a git repository'])
    ).toBe('failed');
    expect(inferTerminalCommandOutputStatus(['\u001b[1;31mError:\u001b[0m build failed'])).toBe(
      'failed'
    );
  });
});

function createRun(
  overrides: Partial<TerminalCommandRunPresentation> = {}
): TerminalCommandRunPresentation {
  return {
    clientEventId: 'event-1',
    command: 'echo ok',
    paneId: 'pane-1',
    sessionId: 'session-1',
    startedAtMs: 1000,
    status: 'running',
    ...overrides,
  };
}
