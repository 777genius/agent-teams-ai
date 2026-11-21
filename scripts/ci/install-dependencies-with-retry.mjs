import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [10_000, 20_000];
const RETRYABLE_NETWORK_ERROR =
  /(?:response code|status(?: code)?)[=: ]+5\d\d|\bERR_PNPM_FETCH_5\d\d\b|\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|ERR_SOCKET_TIMEOUT|UND_ERR_[A-Z_]*TIMEOUT)\b|socket (?:hang up|timeout)|network timeout|the operation was aborted due to timeout|TypeError: terminated|\. postinstall: TypeError: fetch failed|other side closed/i;
const TERMINAL_INSTALL_ERROR =
  /\bERR_PNPM_(?:OUTDATED_LOCKFILE|UNSUPPORTED_ENGINE|FETCH_404)\b|(?:response code|status(?: code)?)[=: ]+4\d\d/i;
const ENGINE_FAILURE = /\bUnsupported engine\b/i;
const ENGINE_WARNING = /(?:\[\s*WARN(?:ING)?\s*\]|\bWARN(?:ING)?)\s*Unsupported engine\b/i;
const ENGINE_WARNING_PREFIX = /^\s*(?:\[\s*WARN(?:ING)?\s*\]|WARN(?:ING)?\b)/i;

// pnpm colors warnings and HTTP diagnostics when a terminal is detected.
const ANSI_COLORS = /\x1b\[[0-9;]*m/g;

function stripColorCodes(output) {
  return output.replace(ANSI_COLORS, '');
}

function hasTerminalInstallFailure(output) {
  // pnpm may warn about an unrelated workspace's Node engine before a
  // transient Electron download 5xx. A warning must not suppress retries.
  return TERMINAL_INSTALL_ERROR.test(output) || output.split(/\r?\n/).some((line) =>
    ENGINE_FAILURE.test(line) && !ENGINE_WARNING.test(line) && !ENGINE_WARNING_PREFIX.test(line));
}

export function isRetryableInstallFailure(output) {
  const normalized = stripColorCodes(output);
  return RETRYABLE_NETWORK_ERROR.test(normalized) && !hasTerminalInstallFailure(normalized);
}

// Keep stream boundaries distinct: stdout and stderr may interleave between
// arbitrary chunks, including the two halves of a fatal pnpm error code.
// A shared tail would lose that code and could wrongly retry an HTTP 404.
export function createInstallFailureTracker() {
  const tails = { stdout: '', stderr: '' };
  // An unfinished warning can exceed the retained suffix; keep its prefix
  // classification independently to avoid treating its engine text as fatal.
  const warningLines = { stdout: false, stderr: false };
  let retryableFailureSeen = false;
  let terminalFailureSeen = false;

  return {
    observe(source, chunk) {
      if (source !== 'stdout' && source !== 'stderr') {
        throw new TypeError('Unknown pnpm output stream');
      }
      const combined = tails[source] + chunk.toString('utf8');
      const normalized = stripColorCodes(combined);
      retryableFailureSeen ||= RETRYABLE_NETWORK_ERROR.test(normalized);
      terminalFailureSeen ||= TERMINAL_INSTALL_ERROR.test(normalized);
      const lines = normalized.split(/\r?\n/);
      lines.forEach((line, index) => {
        const warning =
          (index === 0 && warningLines[source]) ||
          ENGINE_WARNING_PREFIX.test(line) || ENGINE_WARNING.test(line);
        if (ENGINE_FAILURE.test(line) && !warning) terminalFailureSeen = true;
        if (index === lines.length - 1) warningLines[source] = warning;
      });
      // Only retain the current line for markers split across chunks.
      tails[source] = lines[lines.length - 1].slice(-256);
    },
    snapshot() {
      return { retryableFailureSeen, terminalFailureSeen };
    },
  };
}

function runInstall(installArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      installArgs,
      {
        env: process.env,
        shell: process.platform === 'win32',
        stdio: ['inherit', 'pipe', 'pipe'],
      }
    );
    const tracker = createInstallFailureTracker();
    for (const [source, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      stream.on('data', (chunk) => {
        tracker.observe(source, chunk);
        const destination = source === 'stdout' ? process.stdout : process.stderr;
        destination.write(chunk);
      });
    }

    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code: code ?? 1,
        ...tracker.snapshot(),
        signal,
      });
    });
  });
}

async function main() {
  const options = process.argv.slice(2);
  if (options.length > 1 || options.length === 1 && options[0] !== '--child-concurrency=1') {
    throw new TypeError('Unsupported frozen-install option');
  }
  const installArgs = ['install', '--frozen-lockfile', ...options];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await runInstall(installArgs);
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
