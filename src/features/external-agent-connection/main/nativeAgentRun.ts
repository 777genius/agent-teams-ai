import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { API_AUTH_REFERENCE_ENV } from '@features/local-http-auth/contracts';
import {
  applyApiAuthReference,
  privateDirectory,
  replacePrivateJson,
  validatePrivatePath,
} from '@features/local-http-auth/main';
import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer/CodexBinaryResolver';
import { buildProviderAwareCliEnv } from '@main/services/runtime/providerAwareCliEnv';
import { providerConnectionService } from '@main/services/runtime/ProviderConnectionService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { resolveAgentTeamsMcpLaunchSpec } from '@main/services/team/TeamMcpConfigBuilder';
import { killProcessTreeAndWait, spawnCli, untrackCliProcess } from '@main/utils/childProcess';

import {
  BOUND_CONTROL_AUTH_TOKEN_ENV,
  BOUND_CONTROL_CONTEXT_ENV,
  BOUND_CONTROL_URL_ENV,
} from '../contracts';

import { NATIVE_MCP_BEARER_TOKEN_ENV, nativeAgentRunArgs } from './nativeAgentRunArgs';

import type { ConnectionInfoV1, ExternalAgentRunProvider } from '../contracts';
import type { PreparedExternalAgentRun } from './ExternalAgentRunService';
import type { ChildProcess } from 'node:child_process';

export { nativeAgentRunArgs } from './nativeAgentRunArgs';
const MAX_PROTOCOL_LINE = 2 * 1024 * 1024;

interface NativeRunDesktopAuthority {
  controlUrl: string | null;
  controlAuthToken: string | null;
  claudeDir: string;
  userDataPath: string;
  mcpHandle: { url: string; generation: number; authToken: string } | null;
}

function assertCleanLoopbackUrl(value: string, pathname: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Native MCP endpoint is unavailable');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== pathname
  )
    throw new Error('Native MCP endpoint is unavailable');
}

function assertCredential(value: string | null | undefined): asserts value is string {
  if (!value || !/^\S{32,512}$/.test(value))
    throw new Error('Native MCP credential is unavailable');
}

/** Native binaries and environment stay main-owned; input prompt is written through stdin. */
export async function prepareNativeAgentRun(
  provider: ExternalAgentRunProvider,
  connection: ConnectionInfoV1,
  desktop?: NativeRunDesktopAuthority
): Promise<PreparedExternalAgentRun> {
  const binary =
    provider === 'codex'
      ? await CodexBinaryResolver.resolve()
      : await ClaudeBinaryResolver.resolveNative();
  if (!binary) throw new Error('Native provider binary not found');
  const preparedEnv = await buildProviderAwareCliEnv({
    binaryPath: binary,
    providerId: provider,
    codexLaunchDialect: provider === 'codex' ? 'native' : undefined,
    providerBackendId: provider === 'codex' ? 'codex-native' : 'cli-sdk',
  });
  if (preparedEnv.connectionIssues[provider]) throw new Error('Provider connection is unavailable');
  const env = { ...preparedEnv.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env[NATIVE_MCP_BEARER_TOKEN_ENV];
  const secrets: string[] = [];
  let managementMcpConfigPath: string | undefined;
  let managementDirectory: string | undefined;
  if (!connection.mcp.url) throw new Error('App MCP is unavailable');
  assertCleanLoopbackUrl(connection.mcp.url, '/mcp');
  if (provider === 'codex') {
    const handle = desktop?.mcpHandle;
    if (
      !handle ||
      handle.url !== connection.mcp.url ||
      handle.generation !== connection.mcp.generation
    )
      throw new Error('Native MCP authority changed');
    assertCredential(handle.authToken);
    env[NATIVE_MCP_BEARER_TOKEN_ENV] = handle.authToken;
    secrets.push(handle.authToken);
  }
  if (provider === 'anthropic') {
    if (!desktop?.controlUrl) throw new Error('Bound desktop control URL is unavailable');
    assertCleanLoopbackUrl(desktop.controlUrl, '/');
    assertCredential(desktop.controlAuthToken);
    const launchSpec = await resolveAgentTeamsMcpLaunchSpec();
    const managementEnv: Record<string, string> = {
      ...launchSpec.env,
      [BOUND_CONTROL_URL_ENV]: desktop.controlUrl,
      [BOUND_CONTROL_AUTH_TOKEN_ENV]: desktop.controlAuthToken,
      [BOUND_CONTROL_CONTEXT_ENV]: JSON.stringify(connection.context),
      AGENT_TEAMS_MCP_CLAUDE_DIR: desktop.claudeDir,
    };
    applyApiAuthReference(managementEnv, desktop.claudeDir, desktop.controlUrl);
    // A published instance reference follows API restarts; never retain a stale bearer fallback.
    if (managementEnv[API_AUTH_REFERENCE_ENV]) delete managementEnv[BOUND_CONTROL_AUTH_TOKEN_ENV];
    const managementMcp = { ...launchSpec, env: managementEnv };
    secrets.push(desktop.controlAuthToken);
    // The config contains credentials: keep it in the validated private profile,
    // with the same POSIX ownership and Windows ACL checks as API authority files.
    const directory = await privateDirectory(desktop.userDataPath);
    managementDirectory = await mkdtemp(join(directory, 'native-management-'));
    try {
      await validatePrivatePath(managementDirectory, true);
      managementMcpConfigPath = join(managementDirectory, 'mcp.json');
      await replacePrivateJson(
        managementMcpConfigPath,
        {
          mcpServers: {
            'agent-teams': {
              type: 'stdio',
              ...managementMcp,
              args: [...managementMcp.args, '--transport', 'stdio', '--tool-profile', 'management'],
            },
          },
        },
        validatePrivatePath
      );
    } catch (error) {
      await rm(managementDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  let cwd: string;
  let args: string[];
  try {
    const nativeArgs = nativeAgentRunArgs(provider, connection, managementMcpConfigPath);
    const customModel =
      provider === 'codex'
        ? providerConnectionService.getConfiguredCodexCustomProviderModel()
        : null;
    args = [
      ...(provider === 'codex' ? nativeArgs.slice(0, -1) : nativeArgs),
      ...preparedEnv.providerArgs,
      ...(customModel ? ['--model', customModel] : []),
      ...(provider === 'codex' ? ['-'] : []),
    ];
    // The provider never starts from a user project and cannot inherit its project settings.
    cwd = await mkdtemp(join(tmpdir(), 'agent-teams-native-prompt-'));
  } catch (error) {
    if (managementDirectory) await rm(managementDirectory, { recursive: true, force: true });
    throw error;
  }
  const redactions = [
    ...new Set(secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])),
  ];
  const redact = (value: string): string =>
    redactions.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
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
      // Retain owned scratch and tracking until process termination has been verified.
      await stop();
      untrackCliProcess(child);
      await rm(cwd, { recursive: true, force: true });
      if (managementDirectory) await rm(managementDirectory, { recursive: true, force: true });
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
          onOutput(redact(value).slice(0, 32_000));
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
          resolve({
            successful: code === 0 && resultSuccess && !failed && !stopped,
          });
        });
        ownedChild.stdin?.end(prompt);
      });
    },
  };
}
