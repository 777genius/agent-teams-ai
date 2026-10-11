import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Cdp } from './runtime.ts';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function groupProcesses(group: number) {
  const { stdout } = await promisify(execFile)('ps', ['-eo', 'pid=,pgid=,stat=,comm='], {
    timeout: 2000,
  });
  return stdout
    .trim()
    .split('\n')
    .flatMap((line) => {
      const [pid, pgid, state, command] = line.trim().split(/\s+/);
      return Number(pgid) === group && !state.startsWith('Z')
        ? [{ pid: Number(pid), state, command }]
        : [];
    });
}

// A rejected evaluation is expected only if Chromium actually closes the owned target.
export async function gracefulClose(cdp: Cdp, port: number, group: number) {
  const startedAt = new Date().toISOString();
  const native = (await groupProcesses(group)).filter((p) => p.command === 'electron');
  assert(native.length, 'No owned native Electron process found before close');
  let closeError: string | undefined;
  let settled = false;
  const evaluation = cdp.evaluate('window.electronAPI.windowControls.close()').then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      closeError = String(error);
      settled = true;
    }
  );
  const deadline = Date.now() + 20_000;
  let endpointClosed = false;
  let nativeExited = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1500),
      });
      assert(response.ok, 'Owned endpoint HTTP failure: ' + response.status);
      const targets = (await response.json()) as { type: string }[];
      endpointClosed = !targets.some((target) => target.type === 'page');
    } catch (error) {
      // A timeout/HTTP/protocol failure does not prove the window closed.
      if ((error as { cause?: NodeJS.ErrnoException }).cause?.code !== 'ECONNREFUSED') throw error;
      endpointClosed = true;
    }
    nativeExited = !(await groupProcesses(group)).some((p) => native.some((n) => n.pid === p.pid));
    if (settled && endpointClosed && nativeExited) break;
    if (
      settled &&
      closeError &&
      !/CDP connection closed|[Tt]arget closed|[Ss]ession closed|[Ee]xecution context was destroyed|[Ii]nspected target navigated or closed/.test(
        closeError
      )
    )
      throw new Error('Native close evaluation failed: ' + closeError);
    await pause(100);
  }
  assert(endpointClosed && nativeExited && settled, 'Native close did not finish within 20s');
  await evaluation;
  if (closeError)
    assert(
      /CDP connection closed|[Tt]arget closed|[Ss]ession closed|[Ee]xecution context was destroyed|[Ii]nspected target navigated or closed/.test(
        closeError
      ),
      closeError
    );
  return {
    startedAt,
    closedAt: new Date().toISOString(),
    native,
    endpointClosed,
    nativeExited,
    closeError,
  };
}

export async function stopOwnedGroup(group: number) {
  for (const [signal, timeout] of [
    ['SIGTERM', 3000],
    ['SIGKILL', 2000],
  ] as const) {
    const remaining = await groupProcesses(group);
    if (!remaining.length) return;
    try {
      process.kill(-group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!(await groupProcesses(group)).length) return;
      await pause(100);
    }
  }
  assert.equal((await groupProcesses(group)).length, 0, 'Owned process group survived cleanup');
}
