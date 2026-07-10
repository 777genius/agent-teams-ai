import {
  closeSupersededTerminalCommandRuns,
  formatTerminalPromptLabel,
  formatWorkingDirectory,
  inferTerminalCommandCompletion,
  inferTerminalCommandOutputStatus,
  normalizeTerminalCommandRunEventDetail,
  resolveTerminalLocalAutocompleteSuggestion,
  settleTerminalCommandRuns,
  type TerminalCommandRunPresentation,
  upsertTerminalCommandRun,
} from '@features/terminal-workspace/renderer/ui/TerminalWorkspacePanel';
import { describe, expect, it } from 'vitest';

describe('terminal workspace panel internals fixture-e2e', () => {
  it('formats working directories for compact terminal chrome', () => {
    expect(formatWorkingDirectory(null, 'Shell default directory')).toBe('Shell default directory');
    expect(formatWorkingDirectory('   ', 'Shell default directory')).toBe(
      'Shell default directory'
    );
    expect(formatWorkingDirectory('/Users/belief/dev/projects/claude_team///')).toBe(
      '~/dev/projects/claude_team'
    );
    expect(formatWorkingDirectory('/tmp/sandbox/project/')).toBe('/tmp/sandbox/project');
    expect(formatWorkingDirectory('/Users/belief')).toBe('~');
  });

  it('uses a readable local-shell prompt when no cwd is available', () => {
    expect(formatTerminalPromptLabel(null, 'local shell')).toBe('local shell');
    expect(formatTerminalPromptLabel('/Users/belief/dev/quanta')).toBe('~/dev/quanta');
  });

  it('suggests a local-history autocomplete suffix from recent command prefixes', () => {
    expect(
      resolveTerminalLocalAutocompleteSuggestion({
        candidates: [
          { command: 'pnpm test', status: 'succeeded' },
          { command: 'pnpm typecheck', status: 'succeeded', startedAtMs: 1000 },
        ],
        draft: 'pnpm t',
      })
    ).toBe('pnpm typecheck');
  });

  it('prefers successful same-pane autocomplete candidates over failed commands', () => {
    expect(
      resolveTerminalLocalAutocompleteSuggestion({
        candidates: [
          {
            command: 'pnpm test --broken',
            paneId: 'pane-1',
            sessionId: 'session-1',
            startedAtMs: 5000,
            status: 'failed',
          },
          {
            command: 'pnpm test --filter renderer',
            paneId: 'pane-1',
            sessionId: 'session-1',
            startedAtMs: 1000,
            status: 'succeeded',
          },
        ],
        draft: 'pnpm test --',
        paneId: 'pane-1',
        sessionId: 'session-1',
      })
    ).toBe('pnpm test --filter renderer');
  });

  it('keeps autocomplete quiet for dismissed, exact, multiline, and unrelated drafts', () => {
    const candidates = [{ command: 'pnpm typecheck', status: 'succeeded' as const }];

    expect(
      resolveTerminalLocalAutocompleteSuggestion({
        candidates,
        dismissedDraft: 'pnpm t',
        draft: 'pnpm t',
      })
    ).toBeNull();
    expect(
      resolveTerminalLocalAutocompleteSuggestion({ candidates, draft: 'pnpm typecheck' })
    ).toBeNull();
    expect(resolveTerminalLocalAutocompleteSuggestion({ candidates, draft: 'pnpm\n' })).toBeNull();
    expect(resolveTerminalLocalAutocompleteSuggestion({ candidates, draft: 'git' })).toBeNull();
  });

  it('does not aggressively suggest dangerous shell commands from short prefixes', () => {
    const candidates = [
      { command: 'rm -rf ./dist', status: 'succeeded' as const },
      { command: 'git reset --hard HEAD~1', status: 'succeeded' as const },
    ];

    expect(resolveTerminalLocalAutocompleteSuggestion({ candidates, draft: 'rm' })).toBeNull();
    expect(resolveTerminalLocalAutocompleteSuggestion({ candidates, draft: 'git reset' })).toBe(
      'git reset --hard HEAD~1'
    );
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

  it('settles a plain command echo when the shell prompt is rendered on the following line', () => {
    const next = settleTerminalCommandRuns(
      [createRun({ command: "print 'fdfd'", startedAtMs: 1000 })],
      ["print 'fdfd'", 'fdfd', '~/dev/projects/claude/claude_team %'],
      1350,
      false
    );

    expect(next[0]).toMatchObject({
      durationMs: 350,
      status: 'succeeded',
    });
  });

  it('settles from restored history when the live screen lags and duplicates the first input character', () => {
    const next = settleTerminalCommandRuns(
      [createRun({ command: 'not_a_real_command', startedAtMs: 1000 })],
      [
        { source: 'live', text: 'shell % not_a_real_command' },
        { source: 'history', text: 'shell % nnot_a_real_command' },
        { source: 'history', text: 'zsh: command not found: not_a_real_command' },
        { source: 'history', text: 'shell %' },
      ],
      1420,
      false
    );

    expect(next[0]).toMatchObject({
      durationMs: 420,
      status: 'failed',
    });
  });

  it('ignores restored history captured before the current command started', () => {
    const run = createRun({ command: 'echo ok', startedAtMs: 2000 });
    const runs = [run];
    const next = settleTerminalCommandRuns(
      runs,
      [
        { source: 'live', text: 'shell % echo ok' },
        { historyCapturedAtMs: 1500n, source: 'history', text: 'shell % eecho ok' },
        { historyCapturedAtMs: 1500n, source: 'history', text: 'old output' },
        { historyCapturedAtMs: 1500n, source: 'history', text: 'shell %' },
      ],
      2400,
      false
    );

    expect(next).toBe(runs);
    expect(next[0]).toBe(run);
  });

  it('uses shell integration completion marks and exit codes instead of output heuristics', () => {
    const succeeded = settleTerminalCommandRuns(
      [createRun({ command: 'true', startedAtMs: 1000 })],
      [
        {
          text: 'shell % true',
          semantic_marks: [{ kind: 'input_start', col: 8 }],
        },
        {
          text: '',
          semantic_marks: [{ kind: 'command_finished', col: 0, exit_code: 0 }],
        },
      ],
      1125,
      false
    );
    const failed = settleTerminalCommandRuns(
      [createRun({ command: 'custom-command', startedAtMs: 2000 })],
      [
        {
          text: 'λ custom-command',
          semantic_marks: [{ kind: 'input_start', col: 2 }],
        },
        { text: 'ordinary output' },
        {
          text: '',
          semantic_marks: [{ kind: 'command_finished', col: 0, exit_code: 7 }],
        },
      ],
      2400,
      false
    );

    expect(succeeded[0]).toMatchObject({ durationMs: 125, exitCode: 0, status: 'succeeded' });
    expect(failed[0]).toMatchObject({ durationMs: 400, exitCode: 7, status: 'failed' });
  });

  it('lets an authoritative successful exit correct an earlier heuristic failure', () => {
    const next = settleTerminalCommandRuns(
      [
        createRun({
          command: 'build-with-warning',
          durationMs: 180,
          status: 'failed',
        }),
      ],
      [
        { text: 'shell % build-with-warning' },
        { text: 'error: recovered by fallback' },
        {
          text: '',
          semantic_marks: [{ kind: 'command_finished', col: 0, exit_code: 0 }],
        },
      ],
      2500,
      false
    );

    expect(next[0]).toMatchObject({
      durationMs: 180,
      exitCode: 0,
      status: 'succeeded',
    });
  });

  it('settles recovered unknown metadata when completed output is still visible', () => {
    const next = settleTerminalCommandRuns(
      [
        createRun({
          command: 'echo recovered',
          durationMs: 90,
          status: 'unknown',
        }),
      ],
      ['shell % echo recovered', 'recovered', 'shell %'],
      3000,
      false
    );

    expect(next[0]).toMatchObject({
      durationMs: 90,
      status: 'succeeded',
    });
  });

  it('requires the active cursor before treating prompt-like output as a prompt boundary', () => {
    expect(
      inferTerminalCommandCompletion(
        [
          { text: 'shell % stream-prices' },
          { text: 'total $' },
          { text: 'still streaming', isActiveCursorLine: true },
        ],
        'stream-prices'
      )
    ).toEqual({ completed: false, outputLines: [] });

    expect(
      inferTerminalCommandCompletion(
        [
          { text: 'shell % stream-prices' },
          { text: 'total $' },
          { text: 'done' },
          { text: '~/sandbox $', isActiveCursorLine: true },
        ],
        'stream-prices'
      )
    ).toEqual({
      completed: true,
      outputLines: ['total $', 'done'],
    });
  });

  it('only treats the restored history tail as a prompt-only completion boundary', () => {
    expect(
      inferTerminalCommandCompletion(
        [
          { source: 'history', text: "shell % printf 'total $\\nstill ok\\n'" },
          { source: 'history', text: 'total $' },
          { source: 'history', text: 'still ok' },
          { isHistoryTailLine: true, source: 'history', text: 'shell %' },
        ],
        "printf 'total $\\nstill ok\\n'"
      )
    ).toEqual({
      completed: true,
      outputLines: ['total $', 'still ok'],
    });
  });

  it('uses the first raw echo in a prompt segment when output repeats the full command', () => {
    expect(
      inferTerminalCommandCompletion(
        ['shell %', "print 'same'", "print 'same'", 'shell %'],
        "print 'same'"
      )
    ).toEqual({
      completed: true,
      outputLines: ["print 'same'"],
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

  it('settles long wrapped commands using terminal emulator fragments', () => {
    const command =
      "printf 'TP_LONG_1781452725001_%s\\n' 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'";
    const next = settleTerminalCommandRuns(
      [createRun({ command, startedAtMs: 1000 })],
      [
        "(venv312) shell % printf 'TP_LONG_",
        "<                      1781452725001_%s\\n' 'abcdefghijklmnop",
        "<                      abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'",
        'TP_LONG_1781452725001_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        'shell %',
      ],
      1844,
      false
    );

    expect(next[0]).toMatchObject({
      durationMs: 844,
      status: 'succeeded',
    });
  });

  it('settles a final ANSI command from durable wrapped history without another command', () => {
    const command = "printf '\\033[31mRED_V032\\033[0m\\n'";
    const next = settleTerminalCommandRuns(
      [createRun({ command, startedAtMs: 1000 })],
      [
        {
          source: 'history',
          text: "shell % printf '\\033",
        },
        {
          source: 'history',
          text: "[31mRED_V032\\033[0m\\n'",
        },
        { source: 'history', text: 'RED_V032' },
        {
          isHistoryTailLine: true,
          source: 'history',
          text: 'shell %',
        },
      ],
      2400,
      true
    );

    expect(next[0]).toMatchObject({
      durationMs: 1400,
      status: 'succeeded',
    });
  });

  it('marks visible shell failures as failed before the next prompt is visible', () => {
    const next = settleTerminalCommandRuns(
      [createRun({ command: 'ls __tp_missing_1781452725003', startedAtMs: 1000 })],
      [
        '(venv312) shell % ls __tp_missing_',
        '<                      1781452725003',
        'ls: __tp_missing_1781452725003: No such file or directory',
      ],
      2285,
      false
    );

    expect(next[0]).toMatchObject({
      durationMs: 1285,
      status: 'failed',
    });
  });

  it('promotes unknown wrapped shell failures after stderr appears', () => {
    const next = settleTerminalCommandRuns(
      [
        createRun({
          command: 'ls __tp_missing_verify_1781453698049',
          durationMs: 1210,
          status: 'unknown',
        }),
      ],
      [
        '(venv312) shell % ls __tp_missing_verify_',
        '<                      1781453698049',
        'ls: __tp_missing_verify_1781453698049: No such file or directory',
        'shell %',
      ],
      2400,
      true
    );

    expect(next[0]).toMatchObject({
      durationMs: 1210,
      status: 'failed',
    });
  });

  it('closes superseded running commands with a duration when a new command starts', () => {
    const running = createRun({
      command:
        'echo TP_LONG_VERIFY_1781454013183_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      startedAtMs: 1000,
      status: 'running',
    });
    const nextRun = createRun({
      clientEventId: 'event-next',
      command: 'sleep 0.4; echo TP_TIMING_VERIFY_1781454013184',
      startedAtMs: 2600,
      status: 'running',
    });

    const next = closeSupersededTerminalCommandRuns(
      [running],
      nextRun,
      [
        '<                      23456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        'TP_LONG_VERIFY_1781454013183_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      ],
      2600
    );

    expect(next[0]).toMatchObject({
      durationMs: 1600,
      status: 'unknown',
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
