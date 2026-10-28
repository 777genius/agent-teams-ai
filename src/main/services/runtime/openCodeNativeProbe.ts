import { type ChildProcess, spawn } from 'node:child_process';

const retainedProbes = new Set<ChildProcess>();
export const NATIVE_PROBE_CLEANUP_UNCONFIRMED = 'OPENCODE_NATIVE_PROBE_CLEANUP_UNCONFIRMED';

function canceled(): Error {
  return Object.assign(new Error('Native evidence query canceled'), { name: 'AbortError' });
}

export function isNativeProbeFatal(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      ('code' in error && error.code === NATIVE_PROBE_CLEANUP_UNCONFIRMED))
  );
}

/** A timeout starts termination; only observed child/pipe closure permits an ordinary probe failure. */
export function runOpenCodeNativeProbe(
  binary: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(canceled());
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(binary, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    retainedProbes.add(child);
    let failure: Error | null = null;
    let stopped = false,
      exited = false,
      settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let closure: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    let bytes = 0;
    const settleFailure = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const terminate = (reason: Error): void => {
      failure ??= reason;
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      if (!exited) {
        child.kill('SIGTERM');
        escalation = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, 100);
      }
      closure = setTimeout(
        () =>
          settleFailure(
            Object.assign(new Error('Native evidence query closure could not be verified'), {
              code: NATIVE_PROBE_CLEANUP_UNCONFIRMED,
            })
          ),
        1500
      );
      // An unconfirmed child remains retained, with its close observer, after rejection.
    };
    const append = (chunk: Buffer | string, output: boolean): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > 4096) {
        terminate(new Error('Native evidence query output exceeded its bound'));
        return;
      }
      if (output) stdout.push(data);
    };
    child.stdout?.on('data', (chunk: Buffer) => append(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, false));
    child.on('error', (error) => terminate(error));
    child.once('exit', () => {
      exited = true;
      clearTimeout(escalation);
    });
    const abort = (): void => terminate(canceled());
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('close', (code) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(closure);
      options.signal?.removeEventListener('abort', abort);
      retainedProbes.delete(child);
      if (settled) return;
      if (failure || code !== 0)
        settleFailure(failure ?? new Error('Native evidence query failed'));
      else {
        settled = true;
        resolve(Buffer.concat(stdout).toString('utf8').trim());
      }
    });
    const timeout = options.timeoutMs ?? 3000;
    const deadline = setTimeout(
      () => terminate(new Error('Native evidence query timed out')),
      Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 3000) : 3000
    );
    if (options.signal?.aborted) abort();
  });
}
