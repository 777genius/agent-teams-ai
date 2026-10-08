import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer/CodexBinaryResolver';
import { buildProviderAwareCliEnv } from '@main/services/runtime/providerAwareCliEnv';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { killProcessTreeAndWait, spawnCli, untrackCliProcess } from '@main/utils/childProcess';

import { nativeAgentRunArgs } from './nativeAgentRunArgs';

import type { ConnectionInfoV1, ExternalAgentRunProvider } from '../contracts';
import type { PreparedExternalAgentRun } from './ExternalAgentRunService';
import type { ChildProcess } from 'node:child_process';

export { nativeAgentRunArgs } from './nativeAgentRunArgs';
const MAX_PROTOCOL_LINE = 2 * 1024 * 1024;

/** Native binaries and environment stay main-owned; input prompt is written through stdin. */
export async function prepareNativeAgentRun(
  provider: ExternalAgentRunProvider,
  connection: ConnectionInfoV1
): Promise<PreparedExternalAgentRun> {
  const binary =
    provider === 'codex'
      ? await CodexBinaryResolver.resolve()
      : await ClaudeBinaryResolver.resolveNative();
  if (!binary) throw new Error('Native provider binary not found');
  const preparedEnv = await buildProviderAwareCliEnv({
    binaryPath: binary,
    providerId: provider,
    providerBackendId: provider === 'codex' ? 'codex-native' : 'cli-sdk',
  });
  if (preparedEnv.connectionIssues[provider]) throw new Error('Provider connection is unavailable');
  const env = { ...preparedEnv.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.ELECTRON_RUN_AS_NODE;
  const nativeArgs = nativeAgentRunArgs(provider, connection);
  const args = [
    ...(provider === 'codex' ? nativeArgs.slice(0, -1) : nativeArgs),
    ...preparedEnv.providerArgs,
    ...(provider === 'codex' ? ['-'] : []),
  ];
  // The provider never starts from a user project and cannot inherit its project settings.
  const cwd = await mkdtemp(join(tmpdir(), 'agent-teams-native-prompt-'));
  let child: ChildProcess | null = null;
  let closed: Promise<void> | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped = true;
    stopPromise ??= child
      ? killProcessTreeAndWait(child, 'SIGKILL').then(async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              closed,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Native process did not close')), 5_000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        })
      : Promise.resolve();
    return stopPromise;
  };
  return {
    stop,
    async dispose() {
      await stop();
      untrackCliProcess(child);
      await rm(cwd, { recursive: true, force: true });
    },
    launch(prompt, onOutput) {
      if (stopped || child) throw new Error('Native run cannot be started again');
      child = spawnCli(binary, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const ownedChild = child;
      let resolveClosed!: () => void;
      closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      return new Promise<{ successful: boolean }>((resolve) => {
        let failed = false;
        let resultSuccess = false;
        let stdout = '';
        let stderr = '';
        let droppingStdout = false;
        let droppingStderr = false;
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        const line = (value: string, isStdout: boolean) => {
          onOutput(value.slice(0, 32_000));
          if (!isStdout) return;
          try {
            const event = JSON.parse(value) as {
              type?: string;
              subtype?: string;
              is_error?: boolean;
            };
            if (provider === 'anthropic' && event.type === 'result') {
              resultSuccess = event.is_error !== true && event.subtype === 'success';
              failed ||= !resultSuccess;
            }
            if (provider === 'codex') {
              resultSuccess ||= event.type === 'turn.completed';
              failed ||= event.type === 'turn.failed' || event.type === 'error';
            }
          } catch {
            /* plain diagnostics are still useful output */
          }
        };
        const append = (chunk: Buffer | string, isStdout: boolean) => {
          const decoded =
            typeof chunk === 'string'
              ? chunk
              : (isStdout ? stdoutDecoder : stderrDecoder).write(chunk);
          let incoming = decoded;
          if (isStdout ? droppingStdout : droppingStderr) {
            const end = incoming.indexOf('\n');
            if (end < 0) return;
            incoming = incoming.slice(end + 1);
            if (isStdout) droppingStdout = false;
            else droppingStderr = false;
          }
          const text = `${isStdout ? stdout : stderr}${incoming}`;
          const lines = text.split('\n');
          const tail = lines.pop() ?? '';
          for (const complete of lines) {
            if (complete.length <= MAX_PROTOCOL_LINE) line(complete, isStdout);
            else line('Native output event exceeded the display/protocol limit', false);
          }
          if (tail.length > MAX_PROTOCOL_LINE) {
            line('Native output event exceeded the display/protocol limit', false);
            if (isStdout) {
              stdout = '';
              droppingStdout = true;
            } else {
              stderr = '';
              droppingStderr = true;
            }
          } else if (isStdout) stdout = tail;
          else stderr = tail;
        };
        ownedChild.stdout?.on('data', (chunk: Buffer) => append(chunk, true));
        ownedChild.stderr?.on('data', (chunk: Buffer) => append(chunk, false));
        ownedChild.on('error', () => {
          failed = true;
        });
        ownedChild.stdin?.on('error', () => {
          failed = true;
        });
        ownedChild.once('close', (code) => {
          stdout += stdoutDecoder.end();
          stderr += stderrDecoder.end();
          if (stdout) line(stdout, true);
          if (stderr) line(stderr, false);
          resolveClosed();
          resolve({ successful: code === 0 && resultSuccess && !failed && !stopped });
        });
        ownedChild.stdin?.end(prompt);
      });
    },
  };
}
