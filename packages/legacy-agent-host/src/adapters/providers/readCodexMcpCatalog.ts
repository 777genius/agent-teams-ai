import { readCodexConfiguredMcpCatalog } from '@agent-teams/provider-implementations/codex';
import { capturedNativeProcessFactory } from './capturedNativeProcessFactory.js';
import type { CodexConfiguredMcpCatalog } from '@agent-teams/provider-implementations/codex';
import type { CodexMemberProfile } from '../../composition/runtimeProfile.js';
import type { HostWindowsLaunch } from '../../owned-process/HostWindowsLaunch.js';

/** D owns native metadata decoding; Host retains only this original short-lived child handle. */
export async function readCodexMcpCatalog(
  profile: CodexMemberProfile,
  assertCurrent: () => void,
  signal?: AbortSignal,
  retainedWindowsLaunch?: HostWindowsLaunch
): Promise<CodexConfiguredMcpCatalog> {
  assertCurrent();
  const current = () => {
    try {
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const custody = capturedNativeProcessFactory(retainedWindowsLaunch)(profile, current);
  return readCodexConfiguredMcpCatalog(
    {
      cwd: profile.cwd,
      executablePath: profile.executable.path,
      environment: { ...profile.environment },
      timeoutMs: Math.min(profile.limits.timeoutMs, 180000),
      canRead: current,
      launch(request) {
        assertCurrent();
        const child = custody.launch({
          command: request.command,
          args: [...request.args],
          cwd: request.cwd,
          signal: request.signal,
        });
        const terminal = new Promise<{ exitCode: number | null; signal: string | null }>(
          (resolve) => {
            child.once('error', () => resolve({ exitCode: null, signal: 'spawn-error' }));
            child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
          }
        );
        return {
          async *read() {
            for await (const chunk of child.stdout) {
              if (!(chunk instanceof Uint8Array)) throw new Error('Codex catalog unavailable');
              yield chunk;
            }
          },
          terminal,
          async dispose() {
            child.stdin.end();
            return custody.confirmStopped();
          },
        };
      },
    },
    signal
  );
}
