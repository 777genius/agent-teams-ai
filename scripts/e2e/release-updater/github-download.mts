import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

// The caller owns producer identity, byte digests and evidence recording.
export async function downloadGithubFile(
  executable: string,
  endpoint: string,
  file: string,
  options: { timeoutMs?: number } = {}
): Promise<{ exitCode: number; stderr: string; error: string }> {
  const actionsArchive = /^repos\/[^/?#]+\/[^/?#]+\/actions\/artifacts\/[1-9]\d*\/zip$/.test(
    endpoint
  );
  const releaseAsset = /^repos\/[^/?#]+\/[^/?#]+\/releases\/assets\/[1-9]\d*$/.test(endpoint);
  if (!actionsArchive && !releaseAsset) throw new Error('Unsupported GitHub download endpoint');
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_200_000)
    throw new Error('Invalid bounded GitHub download timeout');
  const accept = actionsArchive ? 'application/json' : 'application/octet-stream';
  const args = ['api', endpoint, '-H', `Accept: ${accept}`];
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const completion = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 128));
  });
  let exitCode = 128;
  let error = '';
  try {
    [, exitCode] = await Promise.all([
      pipeline(child.stdout, createWriteStream(file, { flags: 'wx' })),
      completion,
    ]);
  } catch (cause) {
    child.kill('SIGKILL');
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    clearTimeout(timer);
  }
  return { exitCode, stderr: Buffer.concat(stderr).toString(), error };
}
