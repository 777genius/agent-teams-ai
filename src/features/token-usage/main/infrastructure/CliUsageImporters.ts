import { spawn } from 'child_process';

import { StaticJsonUsageImporter } from './JsonUsageImporters';

import type { TokenUsageImporterPort } from '../../core/application';

type UsageCliSourceName = 'ccusage' | 'tokscale';

export interface CliUsageImporterOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  minRefreshIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 60_000;
const MAX_STDERR_BYTES = 16 * 1024;

export function createCliUsageImporter(
  sourceName: UsageCliSourceName,
  options: CliUsageImporterOptions
): TokenUsageImporterPort {
  return new StaticJsonUsageImporter(sourceName, createCachedCommandJsonLoader(options));
}

function createCachedCommandJsonLoader(options: CliUsageImporterOptions): () => Promise<unknown> {
  let cached: { expiresAt: number; value: unknown } | undefined;
  let inFlight: Promise<unknown> | undefined;

  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (inFlight) return inFlight;

    inFlight = readJsonFromCommand(options)
      .then((value) => {
        cached = {
          value,
          expiresAt: Date.now() + (options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS),
        };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

async function readJsonFromCommand(options: CliUsageImporterOptions): Promise<unknown> {
  const stdout = await readStdoutFromCommand(options);
  return JSON.parse(stdout) as unknown;
}

function readStdoutFromCommand(options: CliUsageImporterOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timeout = setTimeout(() => {
      fail(new Error(`Token usage importer command timed out: ${options.command}`));
      child.kill('SIGTERM');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) {
        fail(new Error(`Token usage importer command output exceeded ${maxBytes} bytes`));
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const remainingBytes = MAX_STDERR_BYTES - stderrBytes;
      if (remainingBytes <= 0) return;
      const nextChunk = chunk.subarray(0, remainingBytes);
      stderrBytes += nextChunk.byteLength;
      stderrChunks.push(nextChunk);
    });

    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(
          new Error(
            `Token usage importer command failed: ${options.command}${stderr ? `: ${stderr}` : ''}`
          )
        );
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString('utf8'));
    });
  });
}
