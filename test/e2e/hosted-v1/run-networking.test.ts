import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  drainHostedV1ProcessGroup,
  type HostedV1ForegroundChild,
  runHostedV1ForegroundSubprocess,
} from '../../../scripts/e2e/hosted-v1/foregroundSubprocess';
import {
  assertDockerComposeServiceNotPublished,
  assertNoComposeResourcesRemain,
  beginHostedV1CleanupSignalScope,
  buildHostedV1AppImage,
  CADDY_HTTPS_TARGET_PORT,
  captureOriginalHostedV1HttpResponse,
  cleanupHostedV1SandboxRoots,
  createHostedV1ProbeDeadlineBudget,
  createHostedV1SharedAppImageLifecycle,
  createHostedV1SourceDeclaration,
  markerDerivedCaddyPublishedPort,
  mergeHostedV1CleanupInterruption,
  networkAddresses,
  parseDockerComposeCaddyPort,
  parseHostedV1AppImageEvidence,
  parseHostedV1BrowserSuite,
  readHostedV1ProbeResponseBody,
  registerHostedV1InterruptHandlers,
  removeHostedV1AppImage,
  restartHostedV1LifecycleOwner,
  restoreHostedV1NodeAbi,
  runComposeUpWithExplicitPort,
} from '../../../scripts/e2e/hosted-v1/run';
import { HOSTED_V1_BROWSER_SUITES } from '../../fixtures/hosted-v1/browserSuites';

describe('hosted-v1 independently gated browser suite selection', () => {
  it.each(['core', 'phase-6', 'phase-8'] as const)('accepts %s', (suite) => {
    expect(parseHostedV1BrowserSuite(suite)).toBe(suite);
  });

  it('defaults to core and rejects lists or unknown suites', () => {
    expect(parseHostedV1BrowserSuite(undefined)).toBe('core');
    expect(() => parseHostedV1BrowserSuite('phase-6,phase-8')).toThrow(
      'HOSTED_E2E_SUITE must be core, phase-6, or phase-8'
    );
  });

  it('maps every suite and case to a unique existing Playwright selection', async () => {
    const mappings = Object.entries(HOSTED_V1_BROWSER_SUITES);
    expect(new Set(mappings.map(([, value]) => value.testMatch)).size).toBe(mappings.length);
    for (const [suite, definition] of mappings) {
      expect(definition.cases.length, `${suite} must select at least one test`).toBeGreaterThan(0);
      expect(new Set(definition.cases.map(({ id }) => id)).size).toBe(definition.cases.length);
      const source = await readFile(new URL(definition.testMatch, import.meta.url), 'utf8');
      for (const browserCase of definition.cases) {
        if (browserCase.grep === null) continue;
        expect(source.split(browserCase.grep).length - 1, `${suite}/${browserCase.id}`).toBe(1);
      }
    }
  });

  it('validates suite selection before the Docker preflight', async () => {
    const runner = await readFile(resolve('scripts/e2e/hosted-v1/run.ts'), 'utf8');
    const main = runner.slice(runner.indexOf('async function runHostedV1Main'));
    const selection = main.indexOf('parseHostedV1BrowserSuite(process.env.HOSTED_E2E_SUITE)');
    const docker = main.indexOf("run('docker', ['version']");
    expect(selection).toBeGreaterThan(-1);
    expect(docker).toBeGreaterThan(-1);
    expect(selection).toBeLessThan(docker);
  });

  it('gates every declared suite in CI', async () => {
    const workflow = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('suite: [core, phase-6, phase-8]');
    expect(workflow).toContain('HOSTED_E2E_SUITE: ${{ matrix.suite }}');
    expect(workflow).toContain('hosted-v1-team-lifecycle-ui:');
    expect(workflow).toContain(
      'pnpm exec vitest run --maxWorkers=1 test/renderer/components/team/HostedTeamLifecycleControls.test.tsx test/renderer/components/team/HostedTeamWorkspace.test.tsx'
    );
  });
});

function originalResponse(input: {
  readonly body?: string;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
}) {
  const body = vi.fn(async () => new TextEncoder().encode(input.body ?? 'bounded'));
  return {
    body,
    response: {
      body,
      headersArray: async () => input.headers,
      request: () => ({ method: () => 'POST' }),
      status: () => 200,
      url: () => 'https://hosted-v1-e2e.localhost/api/hosted/v1/team-task-board/mutations',
    },
  };
}

describe('hosted-v1 original Playwright response capture', () => {
  const capture = (response: ReturnType<typeof originalResponse>['response']) =>
    captureOriginalHostedV1HttpResponse(response, {
      maximumBytes: 64 * 1024,
      overallDeadlineAtMs: Date.now() + 1_000,
    });

  it.each([
    ['missing length', []],
    [
      'duplicate length',
      [
        { name: 'Content-Length', value: '7' },
        { name: 'content-length', value: '7' },
      ],
    ],
    [
      'compressed body',
      [
        { name: 'content-length', value: '7' },
        { name: 'content-encoding', value: 'gzip' },
      ],
    ],
    [
      'transfer encoding',
      [
        { name: 'content-length', value: '7' },
        { name: 'transfer-encoding', value: 'chunked' },
      ],
    ],
  ] as const)('rejects %s before asking Playwright to buffer the body', async (_label, headers) => {
    const original = originalResponse({ headers });
    await expect(capture(original.response)).rejects.toThrow(
      'hosted_e2e_original_response_transport_bound_invalid'
    );
    expect(original.body).not.toHaveBeenCalled();
  });

  it('rejects an oversized declaration before body capture', async () => {
    const original = originalResponse({
      headers: [{ name: 'content-length', value: String(64 * 1024 + 1) }],
    });
    await expect(capture(original.response)).rejects.toThrow(
      'hosted_e2e_original_response_body_too_large'
    );
    expect(original.body).not.toHaveBeenCalled();
  });

  it('preserves exact evidence from one bounded identity-encoded original response', async () => {
    const original = originalResponse({
      body: 'bounded',
      headers: [
        { name: 'content-length', value: '7' },
        { name: 'content-encoding', value: 'identity' },
      ],
    });
    await expect(capture(original.response)).resolves.toEqual({
      capture: 'playwright_original_response',
      method: 'POST',
      url: 'https://hosted-v1-e2e.localhost/api/hosted/v1/team-task-board/mutations',
      status: 200,
      declaredBodyBytes: 7,
      bodyBytes: 7,
      rawBody: 'bounded',
    });
    expect(original.body).toHaveBeenCalledOnce();
  });
});

describe('hosted-v1 original response transport topology', () => {
  it.each([
    ['production OIDC', 'docker/caddy/Caddyfile', 'agent-teams-keycloak:3456'],
    ['production personal', 'docker/caddy/Caddyfile.personal', 'agent-teams-personal:3456'],
    ['production-shape E2E', 'docker/e2e/Caddyfile', 'hosted-controller:3456'],
  ])(
    'keeps %s hosted API responses identity encoded and no-transform',
    async (_name, path, app) => {
      const caddyfile = await readFile(path, 'utf8');

      expect(caddyfile).toContain('@hosted_api path /api/hosted/v1/*');
      expect(caddyfile).toMatch(/@hosted_non_api\s*\{\s*not path \/api\/hosted\/v1\/\*\s*\}/u);
      expect(caddyfile).toContain('encode @hosted_non_api zstd gzip');
      expect(caddyfile).toContain('header @hosted_api Cache-Control "no-store, no-transform"');
      expect(caddyfile).toContain(
        `reverse_proxy ${app} {\n\t\theader_up Accept-Encoding identity\n\t}`
      );
    }
  );
});

const execFileAsync = promisify(execFile);
const fixtureDigest = `sha256:${'0'.repeat(64)}`;
const caddyPsContainer = (publishers: readonly Record<string, unknown>[]) => ({
  ID: 'caddy-container-id',
  Name: 'hosted-v1-networking-test-caddy-1',
  Project: 'hosted-v1-networking-test',
  Publishers: publishers,
  Service: 'caddy',
  State: 'running',
});
const caddyPsObservationFromPublishers = (publishers: readonly Record<string, unknown>[]): string =>
  JSON.stringify(caddyPsContainer(publishers));
const caddyPsSingletonArrayObservation = (publishers: readonly Record<string, unknown>[]): string =>
  JSON.stringify([caddyPsContainer(publishers)]);
const caddyPsObservation = (publisher: Record<string, unknown>): string =>
  caddyPsObservationFromPublishers([publisher]);
const validCaddyPublisher = {
  Protocol: 'tcp',
  PublishedPort: 49_152,
  TargetPort: CADDY_HTTPS_TARGET_PORT,
  URL: '127.0.0.1',
};

function createProbeResponse(input: {
  readonly chunks: readonly Uint8Array[];
  readonly contentLength?: string;
}): {
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
  readonly response: Parameters<typeof readHostedV1ProbeResponseBody>[0];
} {
  const chunks = [...input.chunks];
  const cancel = vi.fn(async () => undefined);
  const read = vi.fn(async () => {
    const value = chunks.shift();
    return value === undefined
      ? ({ done: true, value: undefined } as const)
      : ({ done: false, value } as const);
  });
  return {
    cancel,
    read,
    response: {
      headers: {
        get: (name) =>
          name.toLowerCase() === 'content-length' ? (input.contentLength ?? null) : null,
      },
      body: { getReader: () => ({ cancel, read }) },
    },
  };
}

describe('hosted-v1 bounded probe responses', () => {
  const boundedReadOptions = (maximumBytes: number) => ({
    maximumBytes,
    signal: AbortSignal.timeout(1_000),
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid response byte cap %s',
    async (maximumBytes) => {
      const probe = createProbeResponse({ chunks: [] });

      await expect(
        readHostedV1ProbeResponseBody(probe.response, boundedReadOptions(maximumBytes))
      ).rejects.toThrow('hosted_e2e_probe_body_byte_limit_invalid');
      expect(probe.read).not.toHaveBeenCalled();
    }
  );

  it('accepts an exact byte cap and decodes a UTF-8 sequence split across chunks', async () => {
    const encoded = new TextEncoder().encode('a🧪');
    const probe = createProbeResponse({
      chunks: [encoded.subarray(0, 3), encoded.subarray(3)],
      contentLength: String(encoded.byteLength),
    });

    await expect(
      readHostedV1ProbeResponseBody(probe.response, boundedReadOptions(encoded.byteLength))
    ).resolves.toBe('a🧪');
    expect(probe.cancel).not.toHaveBeenCalled();
  });

  it('reads a body with no Content-Length without trusting an implicit size', async () => {
    const encoded = new TextEncoder().encode('missing-header');
    const probe = createProbeResponse({ chunks: [encoded] });

    await expect(
      readHostedV1ProbeResponseBody(probe.response, boundedReadOptions(encoded.byteLength))
    ).resolves.toBe('missing-header');
  });

  it('catches a deceptive Content-Length when later chunks cross the raw byte cap', async () => {
    const probe = createProbeResponse({
      chunks: [new TextEncoder().encode('ab'), new TextEncoder().encode('cd'), Uint8Array.of(0x65)],
      contentLength: '1',
    });

    await expect(
      readHostedV1ProbeResponseBody(probe.response, boundedReadOptions(4))
    ).rejects.toThrow('hosted_e2e_probe_body_byte_limit_exceeded');
    expect(probe.read).toHaveBeenCalledTimes(3);
    expect(probe.cancel).toHaveBeenCalledOnce();
  });

  it('rejects an oversized Content-Length and cancels before reading the body', async () => {
    const probe = createProbeResponse({ chunks: [Uint8Array.of(0x61)], contentLength: '5' });

    await expect(
      readHostedV1ProbeResponseBody(probe.response, boundedReadOptions(4))
    ).rejects.toThrow('hosted_e2e_probe_body_byte_limit_exceeded');
    expect(probe.read).not.toHaveBeenCalled();
    expect(probe.cancel).toHaveBeenCalledOnce();
  });

  it.each(['-1', '1.5', '1, 1', ''])('rejects malformed Content-Length %j', async (value) => {
    const probe = createProbeResponse({ chunks: [], contentLength: value });

    await expect(
      readHostedV1ProbeResponseBody(probe.response, boundedReadOptions(4))
    ).rejects.toThrow('hosted_e2e_probe_content_length_invalid');
    expect(probe.cancel).toHaveBeenCalledOnce();
  });

  it('cancels a hanging body read and preserves the abort reason', async () => {
    let markReadStarted = (): void => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const cancel = vi.fn(
      () =>
        new Promise<void>(() => {
          // A hostile stream may never acknowledge cancellation.
        })
    );
    const read = vi.fn(() => {
      markReadStarted();
      return new Promise<Readonly<{ done: true; value?: undefined }>>(() => {
        // Deliberately remain pending until the attempt signal cancels the reader.
      });
    });
    const controller = new AbortController();
    const reason = new Error('probe attempt deadline reached');
    const response: Parameters<typeof readHostedV1ProbeResponseBody>[0] = {
      headers: { get: () => null },
      body: { getReader: () => ({ cancel, read }) },
    };

    const result = readHostedV1ProbeResponseBody(response, {
      maximumBytes: 4,
      signal: controller.signal,
    });
    await readStarted;
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects invalid UTF-8 instead of replacing malformed bytes', async () => {
    const probe = createProbeResponse({ chunks: [Uint8Array.of(0xc3, 0x28)] });

    await expect(
      readHostedV1ProbeResponseBody(probe.response, boundedReadOptions(2))
    ).rejects.toThrow('hosted_e2e_probe_body_utf8_invalid');
  });
});

describe('hosted-v1 probe deadline budget', () => {
  it('uses one fixed monotonic deadline and clips attempts and retries to remaining time', () => {
    let nowMs = 1_000;
    const budget = createHostedV1ProbeDeadlineBudget({
      overallTimeoutMs: 50,
      perAttemptTimeoutMs: 20,
      now: () => nowMs,
    });

    expect(budget.overallDeadlineMs).toBe(1_050);
    expect(budget.nextAttemptTimeoutMs()).toBe(20);
    nowMs = 1_037;
    expect(budget.nextAttemptTimeoutMs()).toBe(13);
    expect(budget.clipRetryDelayMs(30)).toBe(13);

    nowMs = 1_010;
    expect(budget.remainingMs()).toBe(13);

    nowMs = 1_050;
    expect(budget.remainingMs()).toBe(0);
    expect(() => budget.nextAttemptTimeoutMs()).toThrow(
      'hosted_e2e_probe_overall_deadline_exhausted'
    );
    expect(() => budget.clipRetryDelayMs(1)).toThrow('hosted_e2e_probe_overall_deadline_exhausted');
  });

  it('normalizes fractional monotonic time to integer attempt durations', () => {
    let nowMs = 100.25;
    const budget = createHostedV1ProbeDeadlineBudget({
      overallTimeoutMs: 2,
      perAttemptTimeoutMs: 2,
      now: () => nowMs,
    });

    expect(budget.nextAttemptTimeoutMs()).toBe(2);
    nowMs = 101.5;
    expect(budget.remainingMs()).toBe(0);
    expect(() => budget.nextAttemptTimeoutMs()).toThrow(
      'hosted_e2e_probe_overall_deadline_exhausted'
    );
  });

  it('drives a hanging bounded read from one clipped attempt budget', async () => {
    const budget = createHostedV1ProbeDeadlineBudget({
      overallTimeoutMs: 100,
      perAttemptTimeoutMs: 10,
    });
    const cancel = vi.fn(
      () =>
        new Promise<void>(() => {
          // Deliberately never settle; rejection must still follow the attempt signal.
        })
    );
    const response: Parameters<typeof readHostedV1ProbeResponseBody>[0] = {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          cancel,
          read: () =>
            new Promise<Readonly<{ done: true; value?: undefined }>>(() => {
              // The deadline signal is the only completion path under test.
            }),
        }),
      },
    };

    await expect(
      readHostedV1ProbeResponseBody(response, {
        maximumBytes: 4,
        signal: AbortSignal.timeout(budget.nextAttemptTimeoutMs()),
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(budget.remainingMs()).toBeLessThan(100);
  });
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'aborts the runner on %s and removes both global handlers exactly once',
  (trigger) => {
    const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
    const removed: string[] = [];
    const interrupts = registerHostedV1InterruptHandlers({
      once: (signal, listener) => listeners.set(signal, listener),
      remove: (signal, listener) => {
        if (listeners.get(signal) === listener) removed.push(signal);
      },
    });

    listeners.get(trigger)?.();
    expect(interrupts.signal.aborted).toBe(true);
    expect(interrupts.signal.reason).toMatchObject({
      message: `hosted_e2e_interrupted:${trigger}`,
    });
    interrupts.dispose();
    interrupts.dispose();
    expect(removed.toSorted()).toEqual(['SIGINT', 'SIGTERM']);
  }
);

describe('hosted-v1 foreground process-group cleanup', () => {
  it('does not settle an aborted wrapper until its process group has drained', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 4_242 }) as HostedV1ForegroundChild;
    const controller = new AbortController();
    const reason = new Error('hosted_e2e_interrupted:SIGTERM');
    let releaseDrain = (): void => undefined;
    const drainReleased = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let markDrainStarted = (): void => undefined;
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });
    const runPromise = runHostedV1ForegroundSubprocess({
      args: ['exec', 'playwright', 'test'],
      command: 'pnpm',
      cwd: '/tmp/hosted-v1-process-group-test',
      drainProcessGroup: async (processGroupId) => {
        expect(processGroupId).toBe(4_242);
        markDrainStarted();
        await drainReleased;
      },
      environment: {},
      signal: controller.signal,
      spawnProcess: (_command, _args, options) => {
        expect(options).toMatchObject({ detached: true, stdio: 'inherit' });
        return child;
      },
      timeoutMs: 1_000,
    });
    let settled = false;
    const observeSettlement = runPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    controller.abort(reason);
    await drainStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    const rejection = expect(runPromise).rejects.toBe(reason);
    releaseDrain();
    await rejection;
    await observeSettlement;
    expect(settled).toBe(true);
  });

  it('waits for the complete process group to disappear after graceful termination', async () => {
    let alive = true;
    let now = 0;
    const trace: string[] = [];

    await drainHostedV1ProcessGroup({
      operations: {
        exists: () => {
          trace.push(`exists:${alive}`);
          return alive;
        },
        now: () => now,
        send: (signal) => {
          trace.push(`send:${signal}`);
          return alive;
        },
        wait: async (milliseconds) => {
          trace.push(`wait:${milliseconds}`);
          now += milliseconds;
          alive = false;
        },
      },
      killGraceMs: 2,
      pollMs: 1,
      termGraceMs: 2,
    });

    expect(trace).toEqual(['send:SIGTERM', 'exists:true', 'wait:1', 'exists:false']);
  });

  it('escalates to SIGKILL and proves descendants are gone before resolving', async () => {
    let alive = true;
    let now = 0;
    let phase: 'kill' | 'term' = 'term';
    const signals: string[] = [];
    let postKillAbsenceObserved = false;

    await drainHostedV1ProcessGroup({
      operations: {
        exists: () => {
          if (phase === 'kill' && !alive) postKillAbsenceObserved = true;
          return alive;
        },
        now: () => now,
        send: (signal) => {
          signals.push(signal);
          phase = signal === 'SIGKILL' ? 'kill' : 'term';
          return alive;
        },
        wait: async (milliseconds) => {
          now += milliseconds;
          if (phase === 'kill') alive = false;
        },
      },
      killGraceMs: 2,
      pollMs: 1,
      termGraceMs: 2,
    });

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(postKillAbsenceObserved).toBe(true);
  });

  it('fails cleanup when a descendant remains after the kill deadline', async () => {
    let now = 0;
    await expect(
      drainHostedV1ProcessGroup({
        operations: {
          exists: () => true,
          now: () => now,
          send: () => true,
          wait: async (milliseconds) => {
            now += milliseconds;
          },
        },
        killGraceMs: 1,
        pollMs: 1,
        termGraceMs: 1,
      })
    ).rejects.toThrow('hosted_e2e_process_group_cleanup_failed');
  });
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'does not swallow a late %s arriving after outer shared-image and sandbox cleanup',
  async (trigger) => {
    const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
    const interrupts = registerHostedV1InterruptHandlers({
      once: (signal, listener) => listeners.set(signal, listener),
      remove: () => undefined,
    });
    let activeSignal = interrupts.signal;
    const cleanupSignalScope = beginHostedV1CleanupSignalScope({
      activeSignal,
      replaceActiveSignal: (signal) => {
        activeSignal = signal;
      },
    });
    const imageLifecycle = createHostedV1SharedAppImageLifecycle({
      appImage: 'hosted-v1-late-interrupt-test:latest',
      environment: {},
      removeImage: async () => {
        expect(activeSignal.aborted).toBe(false);
      },
    });
    imageLifecycle.markBuildAttempted();
    await expect(imageLifecycle.cleanup(null)).resolves.toEqual({ runnerError: null });
    await expect(
      cleanupHostedV1SandboxRoots({
        sandboxes: [
          {
            marker: 'late-interrupt-marker',
            root: '/tmp/hosted-v1-late-interrupt-test',
          } as Parameters<typeof cleanupHostedV1SandboxRoots>[0]['sandboxes'][number],
        ],
        assertMarkerOwned: async () => undefined,
        removeRoot: async () => {
          expect(activeSignal.aborted).toBe(false);
        },
      })
    ).resolves.toMatchObject({ cleanupError: null });

    listeners.get(trigger)?.();
    const runnerError = mergeHostedV1CleanupInterruption(
      cleanupSignalScope.interruptedSignal,
      null
    );
    cleanupSignalScope.restore();

    expect(runnerError).toMatchObject({ message: `hosted_e2e_interrupted:${trigger}` });
    expect(activeSignal).toBe(interrupts.signal);
    expect(activeSignal.aborted).toBe(true);
    interrupts.dispose();
  }
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'keeps %s cleanup non-aborted through Compose, shared-image, and sandbox-root cleanup',
  async (trigger) => {
    const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
    const interrupts = registerHostedV1InterruptHandlers({
      once: (signal, listener) => listeners.set(signal, listener),
      remove: () => undefined,
    });
    listeners.get(trigger)?.();
    let activeSignal = interrupts.signal;
    const cleanupSignalScope = beginHostedV1CleanupSignalScope({
      activeSignal,
      replaceActiveSignal: (signal) => {
        activeSignal = signal;
      },
    });
    const trace: string[] = [];
    const assertCleanupSignal = (stage: string): void => {
      expect(activeSignal).toBe(cleanupSignalScope.cleanupSignal);
      expect(activeSignal.aborted).toBe(false);
      trace.push(stage);
    };
    const imageLifecycle = createHostedV1SharedAppImageLifecycle({
      appImage: 'hosted-v1-cleanup-signal-test:latest',
      environment: {},
      removeImage: async () => assertCleanupSignal('shared-image'),
    });
    imageLifecycle.markBuildAttempted();
    const sandbox = {
      marker: 'cleanup-signal-marker',
      root: '/tmp/hosted-v1-cleanup-signal-test',
    } as Parameters<typeof cleanupHostedV1SandboxRoots>[0]['sandboxes'][number];

    assertCleanupSignal('compose-down');
    expect(
      (await imageLifecycle.cleanup(new Error(`interrupted:${trigger}`))).runnerError
    ).not.toBe(null);
    const rootCleanup = await cleanupHostedV1SandboxRoots({
      sandboxes: [sandbox],
      assertMarkerOwned: async () => assertCleanupSignal('root-proof'),
      removeRoot: async () => assertCleanupSignal('sandbox-root'),
    });
    expect(rootCleanup.cleanupError).toBeNull();
    cleanupSignalScope.restore();

    expect(activeSignal).toBe(interrupts.signal);
    expect(activeSignal.aborted).toBe(true);
    expect(trace).toEqual(['compose-down', 'shared-image', 'root-proof', 'sandbox-root']);
    interrupts.dispose();
  }
);
const capturedHostedControllerObservation = JSON.stringify([
  {
    ID: 'cda25b38d87f',
    Name: 'hosted-v1-e2e-hosted-controller-1',
    Project: 'hosted-v1-e2e',
    Publishers: [{ URL: '', TargetPort: 3456, PublishedPort: 0, Protocol: 'tcp' }],
    Service: 'hosted-controller',
    State: 'running',
  },
]);
const capturedSyntheticOidcObservation = JSON.stringify([
  {
    ID: '4542d22b0dc3',
    Name: 'hosted-v1-e2e-synthetic-oidc-1',
    Project: 'hosted-v1-e2e',
    Publishers: [{ URL: '', TargetPort: 8080, PublishedPort: 0, Protocol: 'tcp' }],
    Service: 'synthetic-oidc',
    State: 'running',
  },
]);
const composeFixtureEnvironment = {
  ...process.env,
  CADDY_IMAGE_DIGEST: fixtureDigest,
  COMPOSE_PROJECT_NAME: 'hosted-v1-networking-test',
  E2E_APP_DATA_DIR: '/tmp/hosted-v1-networking-test/app-data',
  E2E_APP_GID: '1000',
  E2E_APP_IMAGE: 'hosted-v1-networking-test-app:latest',
  E2E_APP_IP: '172.30.0.3',
  E2E_APP_UID: '1000',
  E2E_BOOT_ID: 'boot_hosted-v1-networking-test',
  E2E_CADDY_DATA_DIR: '/tmp/hosted-v1-networking-test/caddy-data',
  E2E_CADDY_IP: '172.30.0.2',
  E2E_CADDY_PUBLISHED_PORT: '54321',
  E2E_CLAUDE_DIR: '/tmp/hosted-v1-networking-test/claude',
  E2E_FAKE_RUNTIME_STATE_DIR: '/tmp/hosted-v1-networking-test/fake-runtime',
  E2E_LIFECYCLE_BOOTSTRAP: '{}',
  E2E_LIFECYCLE_HIGH_WATER_DIR: '/tmp/hosted-v1-networking-test/lifecycle-high-water',
  E2E_LIFECYCLE_LAUNCHER_DIR: '/tmp/hosted-v1-networking-test/lifecycle-launcher',
  E2E_LIFECYCLE_RUN_DIR: '/tmp/hosted-v1-networking-test/lifecycle-run',
  E2E_LIFECYCLE_TRUST_DIR: '/tmp/hosted-v1-networking-test/lifecycle-trust',
  E2E_NETWORK_SUBNET: '172.30.0.0/24',
  E2E_OIDC_IP: '172.30.0.4',
  E2E_RUN_DIR: '/tmp/hosted-v1-networking-test/run',
  E2E_SOURCE_HEAD_COMMIT: '1'.repeat(40),
  E2E_SOURCE_PATCH_SHA256: '2'.repeat(64),
  E2E_RUNTIME_WORKSPACE_ID: '-workspaces-sandbox',
  E2E_TEAM_ID: 'team_hosted-v1-networking-test',
  E2E_TEAM_RUNTIME_WORKSPACE_ID: '-workspaces-team-sandbox',
  E2E_WORKSPACE_DIR: '/tmp/hosted-v1-networking-test/workspace',
  HOSTED_DOMAIN: 'hosted-v1-e2e.localhost',
  HOSTED_E2E_AUTH_MODE: 'oidc',
  HOSTED_E2E_OIDC_ORIGIN: 'https://oidc-v1-e2e.localhost:443',
  HOSTED_E2E_OIDC_ROLE: 'owner',
  HOSTED_E2E_ORIGIN: 'https://hosted-v1-e2e.localhost:443',
  HOSTED_HTTPS_PORT: '443',
  KEYCLOAK_IMAGE_DIGEST: fixtureDigest,
  NODE_IMAGE_DIGEST: fixtureDigest,
  OIDC_DOMAIN: 'oidc-v1-e2e.localhost',
} satisfies NodeJS.ProcessEnv;

describe('hosted-v1 explicit marker-derived Compose port', () => {
  it('admits a fresh production owner only after its replacement manifest is healthy', async () => {
    const calls: string[][] = [];

    await restartHostedV1LifecycleOwner({
      compose: async (...args) => {
        calls.push([...args]);
        return '';
      },
    });

    expect(calls).toEqual([
      ['stop', '--timeout', '45', 'hosted-controller'],
      ['restart', 'fake-runtime'],
      ['up', '--no-build', '--detach', '--wait', '--no-deps', 'fake-runtime'],
      ['up', '--no-build', '--detach', '--wait', '--no-deps', 'hosted-controller'],
    ]);
  });

  it('restores the Node ABI before scenario work', async () => {
    const calls: Array<{ args: readonly string[]; environment: NodeJS.ProcessEnv }> = [];
    const environment = { E2E_SEED_AUTH_MODE: 'oidc' };

    await restoreHostedV1NodeAbi({
      environment,
      runNode: async (args, receivedEnvironment) => {
        calls.push({ args, environment: receivedEnvironment });
      },
    });

    expect(calls).toEqual([
      {
        args: ['scripts/ci/rebuild-better-sqlite3-node.cjs'],
        environment,
      },
    ]);
  });

  it('accepts captured Compose v5 private-listener observations with port zero', () => {
    expect(() =>
      assertDockerComposeServiceNotPublished(
        capturedHostedControllerObservation,
        'hosted-controller'
      )
    ).not.toThrow();
    expect(() =>
      assertDockerComposeServiceNotPublished(capturedSyntheticOidcObservation, 'synthetic-oidc')
    ).not.toThrow();
    expect(() =>
      assertDockerComposeServiceNotPublished(
        JSON.stringify({ Publishers: [], Service: 'fake-runtime' }),
        'fake-runtime'
      )
    ).not.toThrow();
  });

  it('accepts absent or empty private-listener host fields when the published port is zero', () => {
    expect(() =>
      assertDockerComposeServiceNotPublished(
        JSON.stringify({
          Publishers: [{ HostIp: '', Protocol: 'tcp', PublishedPort: 0, TargetPort: 3456 }],
          Service: 'hosted-controller',
        }),
        'hosted-controller'
      )
    ).not.toThrow();
  });

  it.each(['hosted-controller', 'synthetic-oidc', 'fake-runtime'] as const)(
    'rejects every nonzero publication for %s',
    (service) => {
      expect(() =>
        assertDockerComposeServiceNotPublished(
          JSON.stringify({
            Publishers: [{ Protocol: 'tcp', PublishedPort: 49_152, TargetPort: 3456 }],
            Service: service,
          }),
          service
        )
      ).toThrow(`hosted_e2e_private_listener_published:${service}`);
    }
  );

  it('rejects a scaled second lifecycle owner even when neither owner publishes a port', () => {
    const owner = { Publishers: [], Service: 'fake-runtime' };
    expect(() =>
      assertDockerComposeServiceNotPublished(JSON.stringify([owner, owner]), 'fake-runtime')
    ).toThrow('hosted_e2e_private_listener_observation_invalid:fake-runtime');
  });

  it('requires cleanup to remove marker-owned containers, networks, and volumes', () => {
    expect(() =>
      assertNoComposeResourcesRemain({ containers: '', networks: '', volumes: '' })
    ).not.toThrow();
    expect(() =>
      assertNoComposeResourcesRemain({
        containers: '',
        networks: 'marker-owned-network-id',
        volumes: '',
      })
    ).toThrow('hosted_e2e_compose_orphans_remain');
  });

  it.each([
    ['malformed JSON', 'not-json'],
    ['no container', '[]'],
    ['missing Publishers', JSON.stringify({ Service: 'hosted-controller' })],
    [
      'nonnumeric PublishedPort',
      JSON.stringify({
        Publishers: [{ Protocol: 'tcp', PublishedPort: '0', TargetPort: 3456 }],
        Service: 'hosted-controller',
      }),
    ],
    [
      'host data on an unpublished record',
      JSON.stringify({
        Publishers: [{ HostIp: '127.0.0.1', Protocol: 'tcp', PublishedPort: 0, TargetPort: 3456 }],
        Service: 'hosted-controller',
      }),
    ],
  ])('fails closed for a %s private-listener observation', (_name, observation) => {
    expect(() => assertDockerComposeServiceNotPublished(observation, 'hosted-controller')).toThrow(
      'hosted_e2e_private_listener_observation_invalid:hosted-controller'
    );
  });

  it('derives distinct fixed service addresses from the marker-owned subnet', () => {
    expect(networkAddresses('1234'.padEnd(48, '0'))).toEqual({
      app: '10.82.52.3',
      caddy: '10.82.52.2',
      oidc: '10.82.52.4',
      subnet: '10.82.52.0/28',
    });
  });

  it('renders an explicit loopback-only publication for Caddy target port 443', async () => {
    const { stdout } = await execFileAsync(
      'docker',
      ['compose', '--file', 'docker/docker-compose.e2e.yml', 'config', '--format', 'json'],
      { env: composeFixtureEnvironment, timeout: 30_000 }
    );
    const rendered = JSON.parse(stdout) as {
      networks: Record<
        string,
        {
          driver?: string;
          internal?: boolean;
          name?: string;
        }
      >;
      services: Record<
        string,
        {
          build?: { labels?: Record<string, string> };
          command?: string[];
          depends_on?: Record<string, { condition?: string }>;
          environment?: Record<string, string>;
          extra_hosts?: string[];
          network_mode?: string;
          networks?: Record<string, Record<string, unknown> | null>;
          ports?: Array<Record<string, unknown>>;
          secrets?: Array<Record<string, unknown>>;
          volumes?: Array<Record<string, unknown>>;
        }
      > & {
        caddy: {
          environment?: Record<string, string>;
          networks: Record<string, Record<string, unknown> | null>;
          ports: Array<Record<string, unknown>>;
          volumes: Array<Record<string, unknown>>;
        };
      };
      volumes: Record<string, { name?: string }>;
    };

    expect(rendered.services.caddy.ports).toEqual([
      {
        host_ip: '127.0.0.1',
        mode: 'ingress',
        protocol: 'tcp',
        published: '54321',
        target: CADDY_HTTPS_TARGET_PORT,
      },
    ]);
    expect(rendered.services['hosted-controller'].extra_hosts).toEqual([
      'oidc-v1-e2e.localhost=172.30.0.2',
    ]);
    expect(rendered.services['hosted-controller'].build?.labels).toEqual({
      'org.agent-teams.hosted-e2e.source-head-commit':
        composeFixtureEnvironment.E2E_SOURCE_HEAD_COMMIT,
      'org.agent-teams.hosted-e2e.source-patch-sha256':
        composeFixtureEnvironment.E2E_SOURCE_PATCH_SHA256,
    });
    expect(rendered.services.caddy.environment).toMatchObject({
      OIDC_BACKCHANNEL_PORT: '54321',
    });
    expect(rendered.networks['hosted-e2e']).toMatchObject({ internal: true });
    expect(rendered.networks['hosted-e2e-ingress']).toMatchObject({
      driver: 'bridge',
      name: `${composeFixtureEnvironment.COMPOSE_PROJECT_NAME}_ingress`,
    });
    expect(rendered.networks['hosted-e2e-ingress'].internal).not.toBe(true);
    expect(Object.keys(rendered.services.caddy.networks).sort()).toEqual([
      'hosted-e2e',
      'hosted-e2e-ingress',
    ]);
    expect(rendered.services.caddy.networks['hosted-e2e']).toMatchObject({
      ipv4_address: '172.30.0.2',
    });
    expect(rendered.services['fake-runtime'].network_mode).toBe('none');
    expect(rendered.services['fake-runtime'].networks).toBeUndefined();
    expect(rendered.services['agent-teams-lifecycle-trust-init'].network_mode).toBe('none');
    expect(rendered.services['agent-teams-lifecycle-trust-init'].command).toEqual([
      '/usr/local/bin/hosted-volume-init',
      'lifecycle-trust-anchor',
    ]);
    expect(rendered.services['hosted-controller'].depends_on).toMatchObject({
      'agent-teams-lifecycle-trust-init': { condition: 'service_completed_successfully' },
    });
    expect(rendered.services['fake-runtime'].depends_on).toMatchObject({
      'agent-teams-lifecycle-trust-init': { condition: 'service_completed_successfully' },
    });
    expect(rendered.services['hosted-controller'].networks).toEqual({
      'hosted-e2e': { ipv4_address: '172.30.0.3' },
    });
    expect(rendered.volumes['agent-teams-lifecycle-trust']).toEqual({
      name: `${composeFixtureEnvironment.COMPOSE_PROJECT_NAME}_agent-teams-lifecycle-trust`,
    });
    expect(rendered.services['hosted-controller'].volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          read_only: true,
          source: composeFixtureEnvironment.E2E_LIFECYCLE_RUN_DIR,
          target: '/run/agent-teams-orchestrator',
          type: 'bind',
        }),
        expect.objectContaining({
          read_only: true,
          source: 'agent-teams-lifecycle-trust',
          target: '/run/agent-teams-lifecycle-trust',
          type: 'volume',
        }),
        expect.objectContaining({
          source: composeFixtureEnvironment.E2E_LIFECYCLE_HIGH_WATER_DIR,
          target: '/var/lib/agent-teams/lifecycle-owner-high-water',
          type: 'bind',
        }),
      ])
    );
    expect(rendered.services['fake-runtime'].volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: composeFixtureEnvironment.E2E_LIFECYCLE_RUN_DIR,
          target: '/run/agent-teams-orchestrator',
          type: 'bind',
        }),
        expect.objectContaining({
          read_only: true,
          source: composeFixtureEnvironment.E2E_LIFECYCLE_LAUNCHER_DIR,
          target: '/run/agent-teams-lifecycle-launcher',
          type: 'bind',
        }),
        expect.objectContaining({
          read_only: true,
          source: 'agent-teams-lifecycle-trust',
          target: '/run/agent-teams-lifecycle-trust',
          type: 'volume',
        }),
      ])
    );
    expect(rendered.services['agent-teams-lifecycle-trust-init'].volumes).toEqual([
      expect.objectContaining({
        source: 'agent-teams-lifecycle-trust',
        target: '/run/agent-teams-lifecycle-trust',
        type: 'volume',
      }),
    ]);
    expect(rendered.services['agent-teams-lifecycle-trust-init'].volumes?.[0]?.read_only).not.toBe(
      true
    );
    expect(rendered.services['agent-teams-lifecycle-trust-init'].secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'lifecycle_orchestrator_trust_anchor' }),
        expect.objectContaining({ source: 'lifecycle_owner_release_pin' }),
      ])
    );
    expect(rendered.services['hosted-controller'].environment).toMatchObject({
      HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE:
        '/run/agent-teams-orchestrator/lifecycle-owner-admission.json',
      HOSTED_LIFECYCLE_ORCHESTRATOR_HIGH_WATER_ROOT:
        '/var/lib/agent-teams/lifecycle-owner-high-water',
      HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE:
        '/run/agent-teams-lifecycle-trust/trust-anchor',
      HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE:
        '/run/agent-teams-lifecycle-trust/release-owner-pin.json',
    });
    expect(rendered.services['fake-runtime'].environment).toMatchObject({
      AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP:
        composeFixtureEnvironment.E2E_LIFECYCLE_BOOTSTRAP,
      HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE:
        '/run/agent-teams-orchestrator/lifecycle-owner-admission.json',
      HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE:
        '/run/agent-teams-lifecycle-trust/trust-anchor',
      HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE:
        '/run/agent-teams-lifecycle-trust/release-owner-pin.json',
    });
    expect(
      rendered.services['hosted-controller']?.environment
        ?.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR
    ).toBeUndefined();
    expect(
      rendered.services['hosted-controller']?.volumes?.find(
        (mount) => mount.target === '/var/lib/agent-teams/lifecycle-owner-high-water'
      )?.read_only
    ).not.toBe(true);
    expect(
      rendered.services['hosted-controller']?.volumes?.some(
        (mount) => mount.target === '/run/agent-teams-lifecycle-launcher'
      )
    ).toBe(false);
    expect(
      rendered.services['fake-runtime']?.volumes?.find(
        (mount) => mount.target === '/run/agent-teams-orchestrator'
      )?.read_only
    ).not.toBe(true);
    expect(rendered.services['fake-runtime'].volumes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: '/run/agent-teams' })])
    );
    expect(Object.keys(rendered.services['synthetic-oidc'].networks ?? {})).toEqual(['hosted-e2e']);
    expect(rendered.services['synthetic-oidc'].networks).toEqual({
      'hosted-e2e': { ipv4_address: '172.30.0.4' },
    });
    expect(
      new Set([
        rendered.services.caddy.networks['hosted-e2e']?.ipv4_address,
        rendered.services['hosted-controller'].networks?.['hosted-e2e']?.ipv4_address,
        rendered.services['synthetic-oidc'].networks?.['hosted-e2e']?.ipv4_address,
      ])
    ).toHaveLength(3);
    for (const [service, configuration] of Object.entries(rendered.services)) {
      if (service === 'caddy') continue;
      expect(configuration).not.toHaveProperty('ports');
      expect(configuration.networks ?? {}).not.toHaveProperty('hosted-e2e-ingress');
    }
    expect(rendered.services.caddy.volumes).toContainEqual(
      expect.objectContaining({
        source: composeFixtureEnvironment.E2E_CADDY_DATA_DIR,
        target: '/data',
        type: 'bind',
      })
    );
  });

  it('derives a deterministic high port from the marker and rejects invalid markers', () => {
    expect(markerDerivedCaddyPublishedPort('0'.repeat(48))).toBe(49_152);
    expect(markerDerivedCaddyPublishedPort('f'.repeat(48))).toBe(65_535);
    expect(markerDerivedCaddyPublishedPort('12345678'.padEnd(48, '0'))).toBe(54_904);
    expect(() => markerDerivedCaddyPublishedPort('not-a-marker')).toThrow(
      'hosted_e2e_marker_invalid'
    );
  });

  it('correlates the declared source digests with the inspected application image labels', () => {
    const patch = 'diff --git a/source.ts b/source.ts\n+added high-bit line: 🧪\n';
    const source = createHostedV1SourceDeclaration({
      headCommit: '1'.repeat(40),
      patch,
      untracked: '',
    });
    const imageId = `sha256:${'3'.repeat(64)}`;
    const image = parseHostedV1AppImageEvidence(
      JSON.stringify([
        {
          Id: imageId,
          RepoTags: ['hosted-v1-networking-test-app:latest'],
          RepoDigests: [],
          Config: {
            Labels: {
              'org.agent-teams.hosted-e2e.source-head-commit': source.headCommit,
              'org.agent-teams.hosted-e2e.source-patch-sha256': source.patchSha256,
            },
          },
        },
      ]),
      'hosted-v1-networking-test-app:latest',
      source
    );

    expect(source).toMatchObject({
      schemaVersion: 1,
      declaration: 'git-head-and-working-tree-patch-digest',
      headCommit: '1'.repeat(40),
      patchBytes: Buffer.byteLength(patch),
      patchSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      untrackedPaths: 0,
    });
    expect(source).not.toHaveProperty('patch');
    expect(image).toEqual({
      schemaVersion: 1,
      appImage: 'hosted-v1-networking-test-app:latest',
      imageId,
      repoDigests: [],
      sourceDeclarationCorrelation: {
        headCommit: source.headCommit,
        patchSha256: source.patchSha256,
      },
    });
    expect(() =>
      parseHostedV1AppImageEvidence(
        JSON.stringify([
          {
            Id: imageId,
            RepoTags: ['hosted-v1-networking-test-app:latest'],
            RepoDigests: [],
            Config: {
              Labels: {
                'org.agent-teams.hosted-e2e.source-head-commit': source.headCommit,
                'org.agent-teams.hosted-e2e.source-patch-sha256': '4'.repeat(64),
              },
            },
          },
        ]),
        'hosted-v1-networking-test-app:latest',
        source
      )
    ).toThrow('hosted_e2e_app_image_inspection_invalid');
  });

  it('refuses to make a source declaration when untracked source exists', () => {
    expect(() =>
      createHostedV1SourceDeclaration({
        headCommit: '1'.repeat(40),
        patch: '',
        untracked: 'untracked-source.ts\0',
      })
    ).toThrow('hosted_e2e_untracked_source_forbidden');
  });

  it('parses the Docker Compose v5 JSON publisher observation for Caddy', () => {
    expect(parseDockerComposeCaddyPort(caddyPsObservation(validCaddyPublisher), 49_152)).toBe(
      49_152
    );
    expect(
      parseDockerComposeCaddyPort(
        caddyPsObservation({ ...validCaddyPublisher, URL: undefined, HostIp: '127.0.0.1' }),
        49_152
      )
    ).toBe(49_152);
  });

  it('accepts a singleton-array Compose publisher observation for compatible versions', () => {
    expect(
      parseDockerComposeCaddyPort(caddyPsSingletonArrayObservation([validCaddyPublisher]), 49_152)
    ).toBe(49_152);
  });

  it('accepts the captured Compose v5.3.1 publisher shape with unpublished service ports', () => {
    const capturedPublishers = [
      { Protocol: 'tcp', PublishedPort: 0, TargetPort: 80, URL: '' },
      { Protocol: 'udp', PublishedPort: 0, TargetPort: 443, URL: '' },
      { Protocol: 'tcp', PublishedPort: 0, TargetPort: 2019, URL: '' },
      validCaddyPublisher,
    ];

    expect(
      parseDockerComposeCaddyPort(caddyPsObservationFromPublishers(capturedPublishers), 49_152)
    ).toBe(49_152);
  });

  it.each([
    ['malformed JSON', 'not-json'],
    ['missing container', '[]'],
    [
      'multiple containers',
      JSON.stringify([
        { Publishers: [validCaddyPublisher], Service: 'caddy' },
        { Publishers: [validCaddyPublisher], Service: 'caddy' },
      ]),
    ],
    ['missing publisher', JSON.stringify([{ Publishers: [], Service: 'caddy' }])],
    [
      'multiple publishers',
      JSON.stringify([
        { Publishers: [validCaddyPublisher, validCaddyPublisher], Service: 'caddy' },
      ]),
    ],
    ['wildcard publisher', caddyPsObservation({ ...validCaddyPublisher, URL: '0.0.0.0' })],
    ['IPv6 publisher', caddyPsObservation({ ...validCaddyPublisher, URL: '::1' })],
    ['wrong target', caddyPsObservation({ ...validCaddyPublisher, TargetPort: 80 })],
    ['wrong protocol', caddyPsObservation({ ...validCaddyPublisher, Protocol: 'udp' })],
    ['wrong published port', caddyPsObservation({ ...validCaddyPublisher, PublishedPort: 49_153 })],
    [
      'second nonzero publisher',
      caddyPsObservationFromPublishers([
        validCaddyPublisher,
        { ...validCaddyPublisher, TargetPort: 80 },
      ]),
    ],
    [
      'unpublished publisher with a wildcard host',
      caddyPsObservationFromPublishers([
        { Protocol: 'tcp', PublishedPort: 0, TargetPort: 80, URL: '0.0.0.0' },
        validCaddyPublisher,
      ]),
    ],
    [
      'unpublished publisher with a loopback host',
      caddyPsObservationFromPublishers([
        { Protocol: 'tcp', PublishedPort: 0, TargetPort: 80, URL: '127.0.0.1' },
        validCaddyPublisher,
      ]),
    ],
    [
      'malformed unpublished publisher',
      caddyPsObservationFromPublishers([
        { Protocol: 'tcp', PublishedPort: 0, TargetPort: '80', URL: '' },
        validCaddyPublisher,
      ]),
    ],
  ])('rejects a %s observation', (_name, observation) => {
    expect(() => parseDockerComposeCaddyPort(observation, 49_152)).toThrow(
      'hosted_e2e_caddy_port_invalid'
    );
  });

  it('starts Caddy on the selected port, verifies it, then starts services without replacing Caddy', async () => {
    const trace: string[] = [];
    const runDocker = vi.fn(async (args: readonly string[]) => {
      trace.push(`docker:${args.join(' ')}`);
    });
    const startCaddy = vi.fn(async (environment: NodeJS.ProcessEnv) => {
      trace.push(`start-caddy:${environment.HOSTED_HTTPS_PORT}`);
    });
    const readCaddyPublishers = vi.fn(async (environment: NodeJS.ProcessEnv) => {
      trace.push(`read-caddy-port:${environment.HOSTED_HTTPS_PORT}`);
      return caddyPsObservation(validCaddyPublisher);
    });
    const startRemainingServices = vi.fn(async (environment: NodeJS.ProcessEnv) => {
      trace.push(`start-services:${environment.HOSTED_HTTPS_PORT}`);
    });

    const environment = await runComposeUpWithExplicitPort({
      buildImage: () =>
        buildHostedV1AppImage({
          composeArgs: ['compose', '--project-name', 'hosted-v1-networking-test'],
          environment: composeFixtureEnvironment,
          runDocker,
        }),
      createEnvironment: (port) => {
        trace.push(`environment:${port}`);
        return {
          HOSTED_E2E_OIDC_ORIGIN: `https://oidc-v1-e2e.localhost:${port}`,
          HOSTED_E2E_ORIGIN: `https://hosted-v1-e2e.localhost:${port}`,
          HOSTED_HTTPS_PORT: String(port),
        };
      },
      publishedPort: 49_152,
      readCaddyPublishers,
      startCaddy,
      startRemainingServices,
    });

    expect(trace).toEqual([
      'docker:compose --project-name hosted-v1-networking-test build hosted-controller',
      'environment:49152',
      'start-caddy:49152',
      'read-caddy-port:49152',
      'start-services:49152',
    ]);
    expect(runDocker).toHaveBeenCalledOnce();
    expect(runDocker).toHaveBeenCalledWith(
      ['compose', '--project-name', 'hosted-v1-networking-test', 'build', 'hosted-controller'],
      composeFixtureEnvironment,
      30 * 60_000
    );
    expect(environment.HOSTED_E2E_ORIGIN).toBe('https://hosted-v1-e2e.localhost:49152');
    expect(environment.HOSTED_E2E_OIDC_ORIGIN).toBe('https://oidc-v1-e2e.localhost:49152');
    expect(environment.HOSTED_HTTPS_PORT).toBe('49152');
    expect(startCaddy).toHaveBeenCalledOnce();
    expect(readCaddyPublishers).toHaveBeenCalledOnce();
    expect(startRemainingServices).toHaveBeenCalledOnce();
  });

  it('removes the shared app image after OIDC setup fails before Compose starts', async () => {
    const trace: string[] = [];
    const lifecycle = createHostedV1SharedAppImageLifecycle({
      appImage: 'hosted-v1-networking-test-app:latest',
      environment: composeFixtureEnvironment,
      removeImage: async (appImage) => {
        trace.push(`image rm ${appImage}`);
      },
    });

    lifecycle.markBuildAttempted();
    const setupFailure = new Error('oidc setup failed before compose');
    const cleanup = await lifecycle.cleanup(setupFailure);

    expect(cleanup.runnerError).toBe(setupFailure);
    expect(trace).toEqual(['image rm hosted-v1-networking-test-app:latest']);
  });

  it('probes and removes an image published before an interrupted build client returns', async () => {
    const appImage = 'hosted-v1-interrupted-build-app:latest';
    const imageId = `sha256:${'a'.repeat(64)}`;
    let imagePresent = true;
    const dockerCalls: string[][] = [];
    const lifecycle = createHostedV1SharedAppImageLifecycle({
      appImage,
      environment: composeFixtureEnvironment,
      removeImage: (tag, environment) =>
        removeHostedV1AppImage(tag, environment, async (args) => {
          dockerCalls.push([...args]);
          if (args[1] === 'ls') return imagePresent ? imageId : '';
          if (args[1] === 'rm') {
            imagePresent = false;
            return '';
          }
          throw new Error('unexpected Docker cleanup command');
        }),
    });
    lifecycle.markBuildAttempted();
    const interruption = new Error('hosted_e2e_interrupted:SIGTERM');

    await expect(lifecycle.cleanup(interruption)).resolves.toEqual({ runnerError: interruption });

    expect(imagePresent).toBe(false);
    expect(dockerCalls).toEqual([
      ['image', 'ls', '--quiet', '--no-trunc', '--filter', `reference=${appImage}`],
      ['image', 'rm', '--force', appImage],
      ['image', 'ls', '--quiet', '--no-trunc', '--filter', `reference=${appImage}`],
    ]);
  });

  it('preserves both the runner failure and image-cleanup failure as nested evidence', async () => {
    const cleanupFailure = new Error('image cleanup failed');
    const lifecycle = createHostedV1SharedAppImageLifecycle({
      appImage: 'hosted-v1-networking-test-app:latest',
      environment: composeFixtureEnvironment,
      removeImage: async () => Promise.reject(cleanupFailure),
    });
    lifecycle.markBuildAttempted();
    const runnerFailure = new Error('runner failed');

    const cleanup = await lifecycle.cleanup(runnerFailure);

    expect(cleanup.runnerError).toBeInstanceOf(AggregateError);
    expect((cleanup.runnerError as AggregateError).errors).toEqual([runnerFailure, cleanupFailure]);
  });

  it('fails closed before starting other services when Compose reports an invalid mapping', async () => {
    const startRemainingServices = vi.fn(async () => undefined);

    await expect(
      runComposeUpWithExplicitPort({
        createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
        publishedPort: 49_152,
        readCaddyPublishers: async () =>
          caddyPsObservation({ ...validCaddyPublisher, URL: '0.0.0.0' }),
        startCaddy: async () => undefined,
        startRemainingServices,
      })
    ).rejects.toThrow('hosted_e2e_caddy_port_invalid');
    expect(startRemainingServices).not.toHaveBeenCalled();
  });

  it('fails closed before starting other services when Compose reports no published mapping', async () => {
    const startRemainingServices = vi.fn(async () => undefined);

    await expect(
      runComposeUpWithExplicitPort({
        createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
        publishedPort: 49_152,
        readCaddyPublishers: async () => JSON.stringify([{ Publishers: [], Service: 'caddy' }]),
        startCaddy: async () => undefined,
        startRemainingServices,
      })
    ).rejects.toThrow('hosted_e2e_caddy_port_invalid');
    expect(startRemainingServices).not.toHaveBeenCalled();
  });

  it('fails closed before starting other services when Compose reports a different port', async () => {
    const startRemainingServices = vi.fn(async () => undefined);

    await expect(
      runComposeUpWithExplicitPort({
        createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
        publishedPort: 49_152,
        readCaddyPublishers: async () =>
          caddyPsObservation({ ...validCaddyPublisher, PublishedPort: 49_153 }),
        startCaddy: async () => undefined,
        startRemainingServices,
      })
    ).rejects.toThrow('hosted_e2e_caddy_port_invalid');
    expect(startRemainingServices).not.toHaveBeenCalled();
  });

  it('propagates Caddy startup failure without querying the port or starting services', async () => {
    const failure = new Error('caddy startup failed');
    const readCaddyPublishers = vi.fn(async () => caddyPsObservation(validCaddyPublisher));
    const startRemainingServices = vi.fn(async () => undefined);

    await expect(
      runComposeUpWithExplicitPort({
        createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
        publishedPort: 49_152,
        readCaddyPublishers,
        startCaddy: async () => {
          throw failure;
        },
        startRemainingServices,
      })
    ).rejects.toBe(failure);
    expect(readCaddyPublishers).not.toHaveBeenCalled();
    expect(startRemainingServices).not.toHaveBeenCalled();
  });
});
