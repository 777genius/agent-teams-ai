import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [10_000, 20_000];
const RETRYABLE_NETWORK_ERROR =
  /(?:response code|status(?: code)?)[=: ]+5\d\d|\bERR_PNPM_FETCH_5\d\d\b|\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|ERR_SOCKET_TIMEOUT|UND_ERR_[A-Z_]*TIMEOUT)\b|socket (?:hang up|timeout)|network timeout/i;
const TERMINAL_INSTALL_ERROR =
  /\bERR_PNPM_OUTDATED_LOCKFILE\b|unsupported engine|(?:response code|status(?: code)?)[=: ]+4\d\d/i;

export function isRetryableInstallFailure(output) {
  return RETRYABLE_NETWORK_ERROR.test(output) && !TERMINAL_INSTALL_ERROR.test(output);
}

function runInstall() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['install', '--frozen-lockfile'],
      {
        env: process.env,
        shell: process.platform === 'win32',
        stdio: ['inherit', 'pipe', 'pipe'],
      }
    );
    let retryableFailureSeen = false;
    let terminalFailureSeen = false;
    let outputTail = '';

    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        const combinedOutput = outputTail + text;
        retryableFailureSeen ||= RETRYABLE_NETWORK_ERROR.test(combinedOutput);
        terminalFailureSeen ||= TERMINAL_INSTALL_ERROR.test(combinedOutput);
        outputTail = (outputTail + text).slice(-256);
        const destination = stream === child.stdout ? process.stdout : process.stderr;
        destination.write(chunk);
      });
    }

    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code: code ?? 1,
        retryableFailureSeen,
        terminalFailureSeen,
        signal,
      });
    });
  });
}

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await runInstall();
    if (result.code === 0) return;

    const canRetry =
      attempt < MAX_ATTEMPTS && result.retryableFailureSeen && !result.terminalFailureSeen;
    if (!canRetry) {
      if (result.signal) console.error(`pnpm install stopped by signal ${result.signal}.`);
      process.exitCode = result.code;
      return;
    }

    const delayMs = RETRY_DELAYS_MS[attempt - 1];
    console.warn(
      `pnpm install hit a transient network error (attempt ${attempt}/${MAX_ATTEMPTS}); ` +
        `retrying in ${delayMs / 1000}s.`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
