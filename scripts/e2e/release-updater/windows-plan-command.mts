import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export function artifactDownloadTimeout(size: number) {
  assert(Number.isSafeInteger(size) && size > 0, 'Authenticated artifact size required');
  if (size <= 256 * 1_048_576) return 300_000;
  // Large archives get 120 seconds overhead plus one second per MiB, capped at 20 minutes.
  return Math.min(1_200_000, 120_000 + Math.ceil(size / 1_048_576) * 1000);
}

export async function planCommand(
  executable: string,
  arguments_: string[],
  destination: string,
  timeoutMs = 300_000
) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1_200_000);
  const started = Date.now(),
    phase = `${path.basename(executable)}:${path.basename(destination)}`;
  let bytes = 0,
    stderr = '',
    timedOut = false;
  const errors: unknown[] = [];
  const report = (event: string, details: object = {}) =>
    process.stderr.write(
      `${JSON.stringify({ phase, event, elapsedMs: Date.now() - started, bytes, timeoutMs, ...details })}\n`
    );
  report('start');
  const controller = new AbortController();
  const child = spawn(executable, arguments_, {
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: controller.signal,
  });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-32_768);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (error) => errors.push(error));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let force: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    force = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy(new Error(`${phase} aborted stream after termination grace`));
      child.stderr.destroy();
    }, 2000);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    report('timeout');
    abort();
  }, timeoutMs);
  const progress = setInterval(() => report('progress'), 15_000);
  try {
    const transfer = pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' })).catch(
      (error: unknown) => {
        errors.push(error);
        abort();
      }
    );
    const [exit] = await Promise.all([closed, transfer]);
    report('closed', { ...exit, timedOut, errors: errors.length });
    if (timedOut || exit.code !== 0 || errors.length)
      throw new AggregateError(
        errors,
        `${phase} failed after ${Date.now() - started}ms, ${bytes} bytes, code ${exit.code}, signal ${exit.signal}, timedOut ${timedOut}: ${stderr}`
      );
  } finally {
    clearTimeout(deadline);
    clearTimeout(force);
    clearInterval(progress);
  }
}
