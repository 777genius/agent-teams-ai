import { createServer } from 'node:net';

import {
  classifyRestartFailure,
  type CommandResult,
  type RestartDiagnosticReport,
  restartHostedV1LifecycleOwnerWithDiagnostics,
  type RunCommand,
} from '../../../scripts/e2e/hosted-v1/restartDiagnostics';

function failure(metadata: CommandResult, message = 'restart failed'): Error & CommandResult {
  return Object.assign(new Error(message), metadata);
}

function retainedStrings(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(retainedStrings);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(retainedStrings);
}

describe('Phase 8 restart diagnostics', () => {
  it.each([
    [{ code: 23, signal: null, killed: false }, 'nonzero_exit'],
    [{ code: null, signal: 'SIGTERM', killed: true }, 'timeout_associated_termination'],
    [{ code: null, signal: 'SIGKILL', killed: false }, 'external_signal'],
    [{}, 'missing_metadata'],
  ] as const)('classifies %j as %s', (metadata, expected) => {
    expect(classifyRestartFailure(metadata)).toBe(expected);
  });

  it('records health history, selected state, capped redacted output, readiness, and each stage once', async () => {
    const calls: string[][] = [];
    let report: RestartDiagnosticReport | undefined;
    let clock = 1_800_000_000_000;
    const runCommand: RunCommand = async (_executable, args) => {
      calls.push([...args]);
      clock += 7;
      if (args.includes('ps')) {
        return {
          stdout: [
            JSON.stringify({ ID: 'controller-id', Service: 'hosted-controller', State: 'running', Health: 'starting' }),
            JSON.stringify({ ID: 'owner-id', Service: 'fake-runtime', State: 'running', Health: 'healthy' }),
          ].join('\n'),
        };
      }
      if (args[0] === 'inspect') {
        return {
          stdout: JSON.stringify([
            {
              Id: 'controller-id',
              RestartCount: 4,
              State: {
                Status: 'running',
                Pid: 91,
                Error: `${'E'.repeat(40_000)}inspect-error-secret`,
                Health: { Status: 'starting', Log: [{ Start: 'then', End: 'now', ExitCode: 1, Output: 'not ready' }] },
              },
              Config: { Env: ['API_TOKEN=do-not-retain'] },
            },
            { Id: 'owner-id', RestartCount: 2, State: { Status: 'running', Pid: 92 } },
          ]),
        };
      }
      if (args.includes('logs')) {
        return {
          stdout: [
            'Cookie: first-cookie-secret=one; Cookie: second-cookie-secret=two',
            'Cookie: "quoted-first-cookie-secret"; sid=quoted-followup-secret',
            'body=multiline-first-secret\n  multiline-continuation-secret',
            'serialized={"payload":"{\\"cookie\\":\\"nested-serialized-secret\\"}"}',
            '{"bo\\u0064y":"escaped-json-key-secret"}',
            '{"body": {',
            '  "innocentLookingField": "nested-body-secret",',
            '  "nested": { "password": "nested-password-secret" }',
            '}, "safe": "retained"}',
            '{"cookie":"first-json-cookie-secret","cookie":"second-json-cookie-secret"}',
            'body=first-body-fragment,second-body-fragment',
            '{"body":{"malformed":]malformed-body-secret',
            `${'x'.repeat(200)} cookie=session-secret API_TOKEN=credential`,
          ].join('\n'),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return {
        stdout: 'body=private-value\n' + 'y'.repeat(10_000),
        stderr: '',
        code: 0,
        signal: null,
        killed: false,
      };
    };

    await restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: [
        'compose',
        '--project-name',
        'diagnostic-test',
        '--file',
        '/tmp/compose.yml',
        '--credential',
        'stage-secret',
      ],
      origin: 'https://127.0.0.1:4443',
      runCommand,
      fetch: async () => new Response('', {
        status: 503,
        headers: { 'x-agent-teams-lifecycle-owner-readiness': 'starting' },
      }),
      now: () => clock,
      toIso: (value) => `time-${value}`,
      diagnosticLimits: {
        commandDeadlineMs: 20,
        commandOutputCapBytes: 512,
        readinessDeadlineMs: 20,
        readinessIntervalMs: 0,
        readinessObservationLimit: 3,
        retainedOutputCapBytes: 4_096,
      },
      emit: (value) => { report = value; },
    });

    expect(report).toBeDefined();
    expect(report!.stages.map((stage) => stage.stage)).toEqual([
      'stop_controller', 'restart_owner', 'wait_owner', 'start_controller',
    ]);
    const restartCalls = calls.filter((args) =>
      args.includes('stop') || args.includes('restart') || (args.includes('up') && !args.includes('logs'))
    );
    expect(restartCalls).toHaveLength(4);
    expect(restartCalls.map((args) => args.slice(7))).toEqual([
      ['stop', '--timeout', '45', 'hosted-controller'],
      ['restart', 'fake-runtime'],
      ['up', '--no-build', '--detach', '--wait', '--no-deps', 'fake-runtime'],
      ['up', '--no-build', '--detach', '--wait', '--no-deps', 'hosted-controller'],
    ]);
    expect(report!.stages.every((stage) => stage.configuredDeadlineMs === 60_000)).toBe(true);
    expect(report!.stages.every((stage) => stage.configuredOutputCapBytes === 8 * 1024 * 1024)).toBe(true);
    expect(report!.stages.every((stage) => Buffer.byteLength(stage.stdout) <= 4_096)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private-value');
    expect(JSON.stringify(report)).not.toContain('session-secret');
    expect(JSON.stringify(report)).not.toContain('first-cookie-secret');
    expect(JSON.stringify(report)).not.toContain('second-cookie-secret');
    expect(JSON.stringify(report)).not.toContain('quoted-first-cookie-secret');
    expect(JSON.stringify(report)).not.toContain('quoted-followup-secret');
    expect(JSON.stringify(report)).not.toContain('multiline-first-secret');
    expect(JSON.stringify(report)).not.toContain('multiline-continuation-secret');
    expect(JSON.stringify(report)).not.toContain('nested-serialized-secret');
    expect(JSON.stringify(report)).not.toContain('escaped-json-key-secret');
    expect(JSON.stringify(report)).not.toContain('nested-body-secret');
    expect(JSON.stringify(report)).not.toContain('nested-password-secret');
    expect(JSON.stringify(report)).not.toContain('first-json-cookie-secret');
    expect(JSON.stringify(report)).not.toContain('second-json-cookie-secret');
    expect(JSON.stringify(report)).not.toContain('second-body-fragment');
    expect(JSON.stringify(report)).not.toContain('malformed-body-secret');
    expect(JSON.stringify(report)).not.toContain('do-not-retain');
    expect(JSON.stringify(report)).not.toContain('stage-secret');
    expect(report!.containerState[0]).toMatchObject({
      phase: 'before_restart',
      services: expect.arrayContaining([expect.objectContaining({ ID: 'controller-id', Health: 'starting' })]),
      inspect: expect.arrayContaining([
        expect.objectContaining({
          Id: 'controller-id',
          RestartCount: 4,
          State: expect.objectContaining({
            Status: 'running',
            Health: expect.objectContaining({ Log: expect.arrayContaining([expect.objectContaining({ ExitCode: 1 })]) }),
          }),
        }),
      ]),
    });
    expect(report!.readiness).toHaveLength(3);
    expect(report!.readiness[0]).toMatchObject({ status: 503, readinessHeader: 'starting' });
    const controllerInspect = report!.containerState[0]!.inspect.find((entry) =>
      typeof entry === 'object' && entry !== null && Reflect.get(entry, 'Id') === 'controller-id'
    );
    expect(controllerInspect).toBeDefined();
    const inspectState = Reflect.get(controllerInspect as object, 'State') as object;
    const inspectError = Reflect.get(inspectState, 'Error');
    expect(Buffer.byteLength(String(inspectError), 'utf8')).toBeLessThanOrEqual(4_096);
    expect(inspectError).not.toContain('inspect-error-secret');
  });

  it('caps every retained inspect string at the configured 64-byte limit', async () => {
    let report: RestartDiagnosticReport | undefined;
    const longFlag = `--${'a'.repeat(40_000)}`;
    await restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: ['compose', longFlag],
      origin: 'https://127.0.0.1',
      runCommand: async (_executable, args) => {
        if (args.includes('ps')) return { stdout: JSON.stringify({ ID: 'controller-id' }) };
        if (args[0] === 'inspect') {
          return { stdout: JSON.stringify([{ Id: 'controller-id', State: { Error: 's'.repeat(40_000) } }]) };
        }
        if (args.includes('logs')) return { stdout: '' };
        return { stdout: '', code: 0, signal: null, killed: false };
      },
      fetch: async () => new Response('', {
        status: 503,
        headers: { 'x-agent-teams-lifecycle-owner-readiness': 'body=readiness-header-secret' },
      }),
      diagnosticLimits: { retainedOutputCapBytes: 64, readinessObservationLimit: 1 },
      emit: (value) => { report = value; },
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('s'.repeat(65));
    expect(serialized).not.toContain('readiness-header-secret');
    expect(report!.readiness[0]!.readinessHeader).toBe('[REDACTED_HEADER]');
    expect(retainedStrings(report).every((value) => Buffer.byteLength(value, 'utf8') <= 64)).toBe(true);
    expect(report!.stages.every((stage) => stage.args.every(
      (arg) => Buffer.byteLength(arg, 'utf8') <= 64
    ))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(longFlag);
    const state = Reflect.get(report!.containerState[0]!.inspect[0] as object, 'State') as object;
    expect(Buffer.byteLength(String(Reflect.get(state, 'Error')), 'utf8')).toBeLessThanOrEqual(64);
  });

  it('caps every retained string, including labels and timestamps, at an extreme one-byte limit', async () => {
    let report: RestartDiagnosticReport | undefined;
    await restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: ['compose', `--${'a'.repeat(40_000)}`],
      origin: 'https://127.0.0.1',
      runCommand: async (_executable, args) => {
        if (args.includes('ps')) {
          return {
            stdout: JSON.stringify({
              ID: 'controller-id',
              Service: 'hosted-controller',
              State: 'running',
              Health: 'starting',
            }),
          };
        }
        if (args[0] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              Id: 'controller-id',
              RestartCount: 7,
              State: {
                Status: 'running',
                Error: 'inspect-state-error',
                Health: {
                  Status: 'starting',
                  Log: [{ Start: 'long-start', End: 'long-end', ExitCode: 1, Output: 'not-ready' }],
                },
              },
            }]),
          };
        }
        if (args.includes('logs')) return { stdout: 'controller log output' };
        return {
          stdout: 'stage standard output',
          stderr: 'stage standard error',
          code: 0,
          signal: null,
          killed: false,
        };
      },
      fetch: async () => new Response('', {
        status: 503,
        headers: { 'x-agent-teams-lifecycle-owner-readiness': 'starting' },
      }),
      toIso: () => '2026-09-14T14:06:33.424Z',
      diagnosticLimits: {
        readinessObservationLimit: 1,
        retainedOutputCapBytes: 1,
      },
      emit: (value) => { report = value; },
    });

    const strings = retainedStrings(report);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.every((value) => Buffer.byteLength(value, 'utf8') <= 1)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('starting');
    expect(JSON.stringify(report)).not.toContain('2026-09-14');
    expect(JSON.stringify(report)).not.toContain('a'.repeat(2));
  });

  it('captures failure state before returning the identical original error', async () => {
    const original = failure(
      { code: null, signal: 'SIGTERM', killed: true, stdout: 'token=hidden', stderr: 'timed out' },
      'command timeout token=hidden'
    );
    let report: RestartDiagnosticReport | undefined;
    let stageExecutions = 0;
    let failureStateCollected = false;
    const runCommand: RunCommand = async (_executable, args) => {
      if (args.includes('ps')) {
        if (stageExecutions > 0) failureStateCollected = true;
        return { stdout: JSON.stringify({ ID: 'controller-id', State: 'exited', Health: 'starting' }) };
      }
      if (args[0] === 'inspect') {
        return { stdout: JSON.stringify([{ Id: 'controller-id', RestartCount: 8, State: { Status: 'exited' } }]) };
      }
      if (args.includes('logs')) return { stdout: 'authorization: Bearer forbidden' };
      stageExecutions += 1;
      throw original;
    };

    let caught: unknown;
    try {
      await restartHostedV1LifecycleOwnerWithDiagnostics({
        composeArgs: ['compose'],
        origin: 'https://127.0.0.1',
        runCommand,
        fetch: async () => { throw new Error('transport token=hidden'); },
        diagnosticLimits: { readinessIntervalMs: 0, readinessObservationLimit: 2 },
        emit: (value) => { report = value; },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(stageExecutions).toBe(1);
    expect(failureStateCollected).toBe(true);
    expect(report!.stages).toHaveLength(1);
    expect(report!.stages[0]).toMatchObject({
      stage: 'stop_controller',
      code: null,
      signal: 'SIGTERM',
      killed: true,
      classification: 'timeout_associated_termination',
    });
    expect(report!.containerState.some((entry) => entry.phase === 'failure_before_teardown')).toBe(true);
    expect(report!.logTails).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'failure_before_teardown', service: 'hosted-controller' }),
      expect.objectContaining({ phase: 'failure_before_teardown', service: 'fake-runtime' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('hidden');
    expect(JSON.stringify(report)).not.toContain('forbidden');
  });

  it('does not let diagnostic or evidence failures replace a restart error', async () => {
    const embeddedSecret = 'stderr-credential-that-must-not-survive';
    const original = failure(
      { code: 9 },
      `stderr body={\n  "apparentlySafe": "${embeddedSecret}"\n}\n${'z'.repeat(500)}`
    );
    let command = 0;
    let report: RestartDiagnosticReport | undefined;
    const runCommand: RunCommand = async (_executable, args) => {
      if (args.includes('ps') || args.includes('logs') || args[0] === 'inspect') {
        throw new Error('diagnostic unavailable');
      }
      command += 1;
      throw original;
    };

    let caught: unknown;
    try {
      await restartHostedV1LifecycleOwnerWithDiagnostics({
        composeArgs: ['compose'],
        origin: 'https://127.0.0.1',
        runCommand,
        fetch: async () => { throw new Error('readiness unavailable'); },
        diagnosticLimits: { readinessObservationLimit: 1, retainedOutputCapBytes: 64 },
        emit: (value) => {
          report = value;
          throw new Error(`attachment unavailable token=${embeddedSecret}${'q'.repeat(500)}`);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(command).toBe(1);
    expect(report).toBeDefined();
    expect(Buffer.byteLength(report!.stages[0]!.error ?? '', 'utf8')).toBeLessThanOrEqual(64);
    expect(report!.diagnosticFailures.every(
      (entry) => Buffer.byteLength(entry.error, 'utf8') <= 64
    )).toBe(true);
    expect(JSON.stringify(report)).not.toContain(embeddedSecret);
  });

  it.each([
    ...['b', 'f', 'n', 'r', 't', 'v', '0', 'x00', 'x1f', 'x7f', 'u0000', 'u001f', 'u007f'].map(
      (escape) => [
        `an escaped ASCII control (${escape})`,
        `causal connection refused\nbody\\${escape}: FIRST_SECRET\ntoken: SECOND_SECRET`,
      ]
    ),
    ['a split sensitive-key delimiter', 'causal connection refused\nbody\n:\nINFO hunter2'],
    ['an escaped serialized marker', 'causal connection refused\nbody\\":\nINFO hunter2'],
    ['an escaped form-feed separator', 'causal connection refused\nbody\\f:\nINFO hunter2\ntoken: second-secret'],
    ['an escaped Unicode line-feed separator', 'causal connection refused\nbody\\u000a:\nINFO hunter2\ntoken: second-secret'],
    ['an escaped hexadecimal line-feed separator', 'causal connection refused\nbody\\x0a:\nINFO hunter2\ntoken: second-secret'],
    ['an escaped Unicode NEL separator', 'causal connection refused\nbody\\u0085: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['an escaped hexadecimal NEL separator', 'causal connection refused\nbody\\x85: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a literal NEL separator', 'causal connection refused\nbody\u0085: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['the first escaped C1 control', 'causal connection refused\nbody\\u0080: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['the last escaped C1 control', 'causal connection refused\nbody\\u009f: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a leading-zero braced C1 control', 'causal connection refused\nbody\\u{0000080}: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['an escaped Unicode line separator', 'causal connection refused\nbody\\u2028: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a literal Unicode line separator', 'causal connection refused\nbody\u2028: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['an escaped Unicode paragraph separator', 'causal connection refused\nbody\\u2029: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a literal Unicode paragraph separator', 'causal connection refused\nbody\u2029: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a nested escaped line-feed separator', 'causal connection refused\nbody\\u005cn: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a nested escaped NEL separator', 'causal connection refused\nbody\\u005cu0085: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a braced escaped NEL separator', 'causal connection refused\nbody\\u{0085}: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a nested braced NEL separator', 'causal connection refused\nbody\\u005cu{0085}: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a leading-zero braced NEL separator', 'causal connection refused\nbody\\u{0000085}: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a nested leading-zero braced NEL separator', 'causal connection refused\nbody\\u005cu{0000085}: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a serialized leading-zero braced NEL separator', 'causal connection refused\nbody\\\\u{0000085}: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a braced escaped line separator', 'causal connection refused\nbody\\u{2028}: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a nested escaped line separator', 'causal connection refused\nbody\\u005cu2028: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a braced escaped paragraph separator', 'causal connection refused\nbody\\u{2029}: FIRST_SECRET\ntoken: SECOND_SECRET'],
    ['a nested escaped paragraph separator', 'causal connection refused\nbody\\u005cu2029: FIRST_SECRET\ntoken: SECOND_SECRET'],
  ])('makes %s begin a terminal redacted error tail', async (_variant, message) => {
    const original = failure({ code: 17, signal: null, killed: false }, message);
    let report: RestartDiagnosticReport | undefined;

    await expect(restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: ['compose'],
      origin: 'https://127.0.0.1',
      runCommand: async (_executable, args) => {
        if (args.includes('ps') || args.includes('logs')) return { stdout: '' };
        throw original;
      },
      fetch: async () => new Response('', { status: 503 }),
      diagnosticLimits: { readinessObservationLimit: 1 },
      emit: (value) => { report = value; },
    })).rejects.toBe(original);

    expect(report!.stages[0]).toMatchObject({
      code: 17,
      signal: null,
      classification: 'nonzero_exit',
      error: 'Error: causal connection refused\n[REDACTED_SENSITIVE_TAIL]',
    });
    expect(JSON.stringify(report)).not.toContain('hunter2');
    expect(JSON.stringify(report)).not.toContain('second-secret');
    expect(JSON.stringify(report)).not.toContain('FIRST_SECRET');
    expect(JSON.stringify(report)).not.toContain('SECOND_SECRET');
    expect(JSON.stringify(report)).not.toContain('INFO');
  });

  it.each([
    ['the maximum valid code point', 'u{000010ffff}'],
    ['an out-of-range code point', 'u{0000110000}'],
    ['an invalid braced escape', 'u{000000g}'],
  ])('safely handles %s in a braced Unicode escape', async (_variant, escape) => {
    const secret = 'BRACED_BOUNDARY_SECRET';
    const original = failure(
      { code: 17, signal: null, killed: false },
      `causal connection refused\nbody\\${escape}: ${secret}`
    );
    let report: RestartDiagnosticReport | undefined;

    await expect(restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: ['compose'],
      origin: 'https://127.0.0.1',
      runCommand: async (_executable, args) => {
        if (args.includes('ps') || args.includes('logs')) return { stdout: '' };
        throw original;
      },
      fetch: async () => new Response('', { status: 503 }),
      diagnosticLimits: { readinessObservationLimit: 1 },
      emit: (value) => { report = value; },
    })).rejects.toBe(original);

    expect(report!.stages[0]!.error).toMatch(/^Error: \[REDACTED_TEXT:\d+-bytes\]$/u);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it.each([
    ['an out-of-range code point', 'u{0000110000}'],
    ['an invalid braced escape', 'u{000000g}'],
  ])('fails closed for %s before a later sensitive marker', async (_variant, escape) => {
    const original = failure(
      { code: 17, signal: null, killed: false },
      `causal connection refused\nbody\\${escape}: FIRST_SECRET\ntoken: SECOND_SECRET`
    );
    let report: RestartDiagnosticReport | undefined;

    await expect(restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: ['compose'],
      origin: 'https://127.0.0.1',
      runCommand: async (_executable, args) => {
        if (args.includes('ps') || args.includes('logs')) return { stdout: '' };
        throw original;
      },
      fetch: async () => new Response('', { status: 503 }),
      diagnosticLimits: { readinessObservationLimit: 1 },
      emit: (value) => { report = value; },
    })).rejects.toBe(original);

    expect(report!.stages[0]!.error).toMatch(/^Error: \[REDACTED_TEXT:\d+-bytes\]$/u);
    expect(JSON.stringify(report)).not.toContain('FIRST_SECRET');
    expect(JSON.stringify(report)).not.toContain('SECOND_SECRET');
  });

  it.each([
    ['a direct malformed Unicode escape', 'body\\u00gg'],
    ['a nested malformed Unicode escape', 'body\\u005cu00gg'],
    ['a serialized malformed Unicode escape', 'body\\\\u00gg'],
    ['a direct malformed hexadecimal escape', 'body\\xgg'],
    ['a nested malformed hexadecimal escape', 'body\\u005cxgg'],
    ['a serialized malformed hexadecimal escape', 'body\\\\xgg'],
  ])('fails closed for %s before a later sensitive marker', async (_variant, marker) => {
    const original = failure(
      { code: 17, signal: null, killed: false },
      `causal connection refused\n${marker}: FIRST_SECRET\ntoken: SECOND_SECRET`
    );
    let report: RestartDiagnosticReport | undefined;

    await expect(restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: ['compose'],
      origin: 'https://127.0.0.1',
      runCommand: async (_executable, args) => {
        if (args.includes('ps') || args.includes('logs')) return { stdout: '' };
        throw original;
      },
      fetch: async () => new Response('', { status: 503 }),
      diagnosticLimits: { readinessObservationLimit: 1 },
      emit: (value) => { report = value; },
    })).rejects.toBe(original);

    expect(report!.stages[0]!.error).toMatch(/^Error: \[REDACTED_TEXT:\d+-bytes\]$/u);
    expect(JSON.stringify(report)).not.toContain('FIRST_SECRET');
    expect(JSON.stringify(report)).not.toContain('SECOND_SECRET');
  });

  it('preserves unrelated unrecognized escapes before redacting a later sensitive marker', async () => {
    const original = failure(
      { code: 17, signal: null, killed: false },
      'causal connection refused\\unknown\ntoken: SECOND_SECRET'
    );
    let report: RestartDiagnosticReport | undefined;

    await expect(restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: ['compose'],
      origin: 'https://127.0.0.1',
      runCommand: async (_executable, args) => {
        if (args.includes('ps') || args.includes('logs')) return { stdout: '' };
        throw original;
      },
      fetch: async () => new Response('', { status: 503 }),
      diagnosticLimits: { readinessObservationLimit: 1 },
      emit: (value) => { report = value; },
    })).rejects.toBe(original);

    expect(report!.stages[0]!.error).toBe(
      'Error: causal connection refused\\unknown\n[REDACTED_SENSITIVE_TAIL]'
    );
    expect(JSON.stringify(report)).not.toContain('SECOND_SECRET');
  });

  it('scans a large unrecognized backslash run in bounded time', async () => {
    const original = failure(
      { code: 17, signal: null, killed: false },
      `causal connection refused\n${'\\'.repeat(40_000)}ordinary\ntoken: LARGE_INPUT_SECRET`
    );
    let report: RestartDiagnosticReport | undefined;
    const started = Date.now();

    await expect(restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: ['compose'],
      origin: 'https://127.0.0.1',
      runCommand: async (_executable, args) => {
        if (args.includes('ps') || args.includes('logs')) return { stdout: '' };
        throw original;
      },
      fetch: async () => new Response('', { status: 503 }),
      diagnosticLimits: { readinessObservationLimit: 1 },
      emit: (value) => { report = value; },
    })).rejects.toBe(original);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(JSON.stringify(report)).not.toContain('LARGE_INPUT_SECRET');
  }, 2_000);

  it('enforces an absolute readiness deadline when fetch ignores its abort signal', async () => {
    let report: RestartDiagnosticReport | undefined;
    let observedSignal: AbortSignal | undefined;
    let fetchCalls = 0;
    const started = Date.now();

    await restartHostedV1LifecycleOwnerWithDiagnostics({
      composeArgs: ['compose'],
      origin: 'https://127.0.0.1',
      runCommand: async (_executable, args) => {
        if (args.includes('ps')) return { stdout: '' };
        if (args.includes('logs')) return { stdout: '' };
        return { stdout: '', code: 0, signal: null, killed: false };
      },
      fetch: ((_url, init) => {
        fetchCalls += 1;
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }) as typeof globalThis.fetch,
      diagnosticLimits: {
        readinessDeadlineMs: 25,
        readinessIntervalMs: 0,
        readinessObservationLimit: 1,
      },
      emit: (value) => { report = value; },
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(fetchCalls).toBe(1);
    expect(observedSignal).toBeDefined();
    expect((observedSignal as AbortSignal).aborted).toBe(true);
    expect(report!.readiness).toEqual([
      expect.objectContaining({
        configuredDeadlineMs: 25,
        status: null,
        readinessHeader: null,
        transportError: expect.stringContaining('readiness_deadline_exceeded'),
      }),
    ]);
  });

  it('aborts fetch and cancels response bodies on success and on a late response', async () => {
    const signals: AbortSignal[] = [];
    let cancellations = 0;
    const response = (): Response => new Response(new ReadableStream({
      cancel: () => { cancellations += 1; },
    }), {
      status: 503,
      headers: { 'x-agent-teams-lifecycle-owner-readiness': 'starting' },
    });
    const run = async (fetchImplementation: typeof globalThis.fetch): Promise<void> => {
      await restartHostedV1LifecycleOwnerWithDiagnostics({
        composeArgs: ['compose'],
        origin: 'https://127.0.0.1',
        runCommand: async (_executable, args) => {
          if (args.includes('ps') || args.includes('logs')) return { stdout: '' };
          return { stdout: '', code: 0, signal: null, killed: false };
        },
        fetch: fetchImplementation,
        diagnosticLimits: { readinessDeadlineMs: 10, readinessObservationLimit: 1 },
        emit: () => undefined,
      });
    };
    await run((async (_url, init) => {
      signals.push(init!.signal as AbortSignal);
      return response();
    }) as typeof globalThis.fetch);
    await run(((_url, init) => {
      signals.push(init!.signal as AbortSignal);
      return new Promise<Response>((resolve) => setTimeout(() => resolve(response()), 30));
    }) as typeof globalThis.fetch);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancellations).toBe(2);
  });

  it('uses a wall-clock deadline for an active native HTTP transport', async () => {
    const server = createServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nX-Unfinished-Header: ');
      const keepActive = setInterval(() => {
        if (socket.writable && !socket.destroyed) socket.write('a');
      }, 5);
      const stopWriting = (): void => clearInterval(keepActive);
      socket.once('error', stopWriting);
      socket.once('close', stopWriting);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server address unavailable');
    let report: RestartDiagnosticReport | undefined;
    const started = Date.now();

    try {
      await restartHostedV1LifecycleOwnerWithDiagnostics({
        composeArgs: ['compose'],
        origin: `http://127.0.0.1:${address.port}`,
        runCommand: async (_executable, args) => {
          if (args.includes('ps')) return { stdout: '' };
          if (args.includes('logs')) return { stdout: '' };
          return { stdout: '', code: 0, signal: null, killed: false };
        },
        diagnosticLimits: {
          readinessDeadlineMs: 30,
          readinessIntervalMs: 0,
          readinessObservationLimit: 1,
        },
        emit: (value) => { report = value; },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(Date.now() - started).toBeLessThan(500);
    expect(report!.readiness).toEqual([
      expect.objectContaining({
        configuredDeadlineMs: 30,
        status: null,
        readinessHeader: null,
        transportError: expect.stringContaining('readiness_deadline_exceeded'),
      }),
    ]);
  });
});
