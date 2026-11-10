import { killProcessTree } from '@main/utils/childProcess';

import type { ChildProcess } from 'node:child_process';

/** Teardown follows only the child owned by this supervisor, never an occupied listener. */
export async function stopOwnedMcpChild(
  child: ChildProcess | null,
  port: number | null,
  expectedStops: WeakSet<ChildProcess>,
  clearOwnedState: () => Promise<void>,
  waitForPortRelease: (port: number) => Promise<unknown>
): Promise<void> {
  if (!child) return;
  expectedStops.add(child);
  killProcessTree(child, 'SIGKILL');
  await clearOwnedState();
  if (port) await waitForPortRelease(port);
}

export async function waitForOwnedMcpPortRelease(
  canListen: () => Promise<boolean>,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canListen()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return canListen();
}
