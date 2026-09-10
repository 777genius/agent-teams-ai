// @vitest-environment node
import { createProcessStartTimeCache, readProcessStartTimeMs } from '@main/utils/processStartTime';
import * as childProcess from 'child_process';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

interface RecordedProbe {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number };
}

function recordProbes(result: {
  stdout?: string;
  stderr?: string;
  error?: Error;
}): RecordedProbe[] {
  const probes: RecordedProbe[] = [];
  (childProcess.execFile as unknown as Mock).mockImplementation(
    (
      command: string,
      args: string[],
      options: RecordedProbe['options'],
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      probes.push({ command, args, options });
      callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
      return {};
    }
  );
  return probes;
}

describe('processStartTime', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(['linux', 'win32'] as const)(
    'optionally observes failed identity on %s without changing null',
    async (platform) => {
      recordProbes({
        error: Object.assign(new Error('private command'), {
          code: 9,
          signal: 'SIGTERM',
          killed: true,
          errno: -2,
        }),
        stderr: 'denied TOKEN=mock-secret Authorization: Bearer mockbearersecret',
      });
      const observe = vi.fn();
      await expect(readProcessStartTimeMs(4321, platform, undefined, observe)).resolves.toBeNull();
      const message = observe.mock.calls[0][0];
      expect(message).toContain('process_start_time:');
      expect(message).toMatch(/durationMs=\d+; timeoutMs=2000/);
      expect(message).toContain('code=9; errno=-2; signal=SIGTERM; killed=true; timedOut=unknown');
      expect(message).not.toMatch(/mock-secret|mockbearersecret|private command/);
      await expect(readProcessStartTimeMs(4321, platform)).resolves.toBeNull();
      expect(observe).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['', 'not a date'])(
    'reports unavailable parsed identity without exposing stdout: %j',
    async (stdout) => {
      recordProbes({ stdout });
      const observe = vi.fn();
      await expect(readProcessStartTimeMs(4321, 'win32', 250, observe)).resolves.toBeNull();
      expect(observe.mock.calls[0][0]).toContain(
        stdout ? 'invalid start time' : 'empty start time'
      );
      expect(observe.mock.calls[0][0]).not.toMatch(/not a date|code=0/);
    }
  );

  it.each([false, true])('observer failure is isolated (async=%s)', async (asyncFailure) => {
    recordProbes({ error: new Error('probe failed') });
    const observe = () => {
      if (asyncFailure) return Promise.reject(new Error('observer failed'));
      throw new Error('observer failed');
    };
    await expect(readProcessStartTimeMs(4321, 'win32', 2_000, observe)).resolves.toBeNull();
  });

  it('does not observe successful probes even with stderr, and observes invalid Windows pid', async () => {
    recordProbes({ stdout: '2025-08-27T08:12:33Z', stderr: 'warning' });
    const observe = vi.fn();
    expect(await readProcessStartTimeMs(4321, 'win32', undefined, observe)).toBe(
      Date.parse('2025-08-27T08:12:33Z')
    );
    expect(observe).not.toHaveBeenCalled();
    await expect(readProcessStartTimeMs(0, 'win32', undefined, observe)).resolves.toBeNull();
    expect(observe.mock.calls[0][0]).toContain('invalid pid');
  });

  it('forces the C locale so POSIX lstart= stays parseable on a non-English desktop', async () => {
    vi.stubEnv('LC_ALL', 'de_DE.UTF-8');
    vi.stubEnv('LC_TIME', 'de_DE.UTF-8');
    vi.stubEnv('AGENT_TEAMS_PROBE_MARKER', 'kept');
    const probes = recordProbes({ stdout: 'Wed Aug 27 10:12:33 2025\n' });

    const startedAt = await readProcessStartTimeMs(4321, 'linux', 2_000);

    expect(startedAt).toBe(Date.parse('Wed Aug 27 10:12:33 2025'));
    expect(probes).toHaveLength(1);
    expect(probes[0].command).toBe('ps');
    expect(probes[0].args).toEqual(['-p', '4321', '-o', 'lstart=']);
    expect(probes[0].options.env?.LC_ALL).toBe('C');
    // The probe environment is an override of the app environment, not a replacement:
    // dropping PATH here would break `ps` lookup on some hosts.
    expect(probes[0].options.env?.AGENT_TEAMS_PROBE_MARKER).toBe('kept');
  });

  it('still reads the Windows round-trip start time through the forced locale', async () => {
    const probes = recordProbes({ stdout: '2025-08-27T08:12:33.1234567Z\n' });

    const startedAt = await readProcessStartTimeMs(4321, 'win32', 2_000);

    expect(startedAt).toBe(Date.parse('2025-08-27T08:12:33.123Z'));
    expect(probes[0].command).toBe('powershell.exe');
    expect(probes[0].args.at(-1)).toContain('Get-Process -Id 4321');
    expect(probes[0].options.env?.LC_ALL).toBe('C');
  });

  it('spends the timeout the caller asked for, and a bounded default when asked for none', async () => {
    const probes = recordProbes({ stdout: 'Wed Aug 27 10:12:33 2025\n' });

    await readProcessStartTimeMs(4321, 'linux', 250);
    await readProcessStartTimeMs(4321, 'linux');

    expect(probes[0].options.timeout).toBe(250);
    expect(probes[1].options.timeout).toBe(2_000);
    // A probe reads one short line; the buffer only has to stop a runaway child.
    expect(probes[0].options.maxBuffer).toBe(64 * 1024);
  });

  /**
   * The negative control that every caller depends on: a probe that could not
   * answer must read as "start time unobservable", never as "a different
   * process". A caller that treated a failed probe as a mismatch would evict a
   * live owner the moment the host got slow enough to time the probe out.
   */
  it('answers null when the probe fails instead of inventing a start time', async () => {
    recordProbes({ error: new Error('spawn ps ETIMEDOUT') });

    await expect(readProcessStartTimeMs(4321, 'linux', 2_000)).resolves.toBeNull();
  });

  it('refuses to build a Windows probe script from a pid that is not a positive integer', async () => {
    const probes = recordProbes({ stdout: '2025-08-27T08:12:33.1234567Z\n' });

    await expect(readProcessStartTimeMs(0, 'win32', 2_000)).resolves.toBeNull();
    await expect(readProcessStartTimeMs(Number.NaN, 'win32', 2_000)).resolves.toBeNull();
    expect(probes).toHaveLength(0);
  });
});

describe('createProcessStartTimeCache', () => {
  it('reads each pid once and keeps reading distinct pids', async () => {
    const read = vi.fn((pid: number) => Promise.resolve(pid * 10));
    const cached = createProcessStartTimeCache(read);

    await expect(cached(7)).resolves.toBe(70);
    await expect(cached(7)).resolves.toBe(70);
    await expect(cached(9)).resolves.toBe(90);

    expect(read.mock.calls.map(([pid]) => pid)).toEqual([7, 9]);
  });

  it('joins concurrent asks for the same pid onto one probe', async () => {
    let resolveRead!: (value: number | null) => void;
    const read = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          resolveRead = resolve;
        })
    );
    const cached = createProcessStartTimeCache(read);

    const both = Promise.all([cached(7), cached(7)]);
    resolveRead(1_234);

    await expect(both).resolves.toEqual([1_234, 1_234]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  /**
   * The fail-safe direction the destructive callers depend on: a reader that
   * rejects is one unobservable start time, not an exception that ends the
   * sweep for every pid queued behind it. A cached rejection would also make
   * every later ask for that pid reject again.
   */
  it('answers null for a rejected read instead of propagating the rejection', async () => {
    const read = vi.fn(() => Promise.reject(new Error('probe host is gone')));
    const cached = createProcessStartTimeCache(read);

    await expect(cached(7)).resolves.toBeNull();
    await expect(cached(7)).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  /**
   * The same fail-safe for a reader that never returns a promise at all. The
   * parameter is a plain function type, so a reader may reject its argument and
   * throw where it stands; unguarded, that exception leaves the cache and ends
   * the destructive sweep that was asking, mid-scan.
   */
  it('answers null for a reader that throws before it returns a promise', async () => {
    const read = vi.fn(() => {
      throw new Error('probe host is gone');
    });
    const cached = createProcessStartTimeCache(read);

    await expect(cached(7)).resolves.toBeNull();
    await expect(cached(7)).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('caches a null answer rather than re-probing a pid that could not be read', async () => {
    const read = vi.fn(() => Promise.resolve(null));
    const cached = createProcessStartTimeCache(read);

    await expect(cached(7)).resolves.toBeNull();
    await expect(cached(7)).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
