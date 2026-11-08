import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';

/** Exclusive durable marker must precede any selection/CPU probe or child launch. */
export function durable(file: string, value: unknown): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface ChildClosure {
  code: number | null;
  signal: NodeJS.Signals | null;
  unknown: boolean;
  stdout: string;
  stderr: string;
}

/** A wrapper close is only transport evidence. Caller must also require worker terminal proof.
 * No PID lookup, process-tree inference, signal, or cleanup on UNKNOWN.
 * A deadline marks UNKNOWN, then retains the exact handle until actual close.
 */
export async function observe(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 180_000,
  onUnknown?: () => void
): Promise<ChildClosure> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      unknown = false;
    const markUnknown = (): void => {
      if (unknown) return;
      unknown = true;
      onUnknown?.();
    };
    const deadline = setTimeout(markUnknown, timeoutMs);
    child.on('error', markUnknown);
    const append = (value: Buffer, output: boolean): void => {
      if (stdout.length + stderr.length + value.length > 32_768) {
        markUnknown();
        return;
      }
      if (output) stdout += value.toString('utf8');
      else stderr += value.toString('utf8');
    };
    child.stdout.on('data', (value: Buffer) => append(value, true));
    child.stderr.on('data', (value: Buffer) => append(value, false));
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, unknown, stdout, stderr });
    });
  });
}

export function requireTerminal(closure: ChildClosure, terminal: unknown): void {
  if (
    closure.unknown ||
    closure.code !== 0 ||
    closure.signal !== null ||
    !terminal ||
    typeof terminal !== 'object' ||
    !('nativeClosed' in terminal) ||
    terminal.nativeClosed !== true
  )
    throw new Error('UNKNOWN_OR_FAILED_SELECTION: target halted; next pin prohibited');
}
