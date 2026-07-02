import { execCli, killProcessTree, spawnCli } from '@main/utils/childProcess';
import { isProcessAlive } from '@main/utils/processHealth';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { type ChildProcess, type spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveGeminiRuntimeAuth } from '../../runtime/geminiRuntimeAuth';
import {
  buildProviderControlPlaneCliCommandArgs,
  buildProviderLaunchCliCommandArgs,
} from '../../runtime/providerCliCommandArgs';
import { ProviderConnectionService } from '../../runtime/ProviderConnectionService';
import {
  buildProviderPreflightPingArgs,
  getProviderModelProbeExpectedOutput,
  getProviderModelProbeTimeoutMs,
  normalizeProviderModelProbeFailureReason,
} from '../../runtime/providerModelProbe';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';
import { atomicWriteAsync } from '../atomicWrite';
import { getConfiguredCliCommandLabel } from '../cliFlavor';

import { buildCombinedLogs } from './TeamProvisioningCliExitPresentation';
import { boundProbeOutputBuffer } from './TeamProvisioningProgressBuffers';
import {
  appendPreflightDebugLog,
  buildAgentTeamsMcpValidationError as buildAgentTeamsMcpValidationErrorMessage,
  buildRuntimeProviderReadinessWarning,
  extractAuthStatusReadiness,
  PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
  truncatePreflightDebugText,
} from './TeamProvisioningProviderPreflight';
import { getTeamProviderLabel } from './TeamProvisioningRuntimeDiagnostics';
import {
  type AuthStatusCommandResponse,
  extractJsonObjectFromCli,
  isProbeTimeoutMessage,
  type RuntimeStatusCommandResponse,
} from './TeamProvisioningRuntimeLaunchSelection';

import type { TeamProviderId } from '@shared/types';

const { AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES } = agentTeamsControllerModule;

const PREFLIGHT_BINARY_TIMEOUT_MS = 8000;
export const PREFLIGHT_AUTH_RETRY_DELAY_MS = 2000;
const PREFLIGHT_AUTH_MAX_RETRIES = 2;
const VERIFY_TIMEOUT_MS = 15_000;
const MCP_PREFLIGHT_INITIALIZE_TIMEOUT_MS = 45_000;
const MCP_PREFLIGHT_SHUTDOWN_GRACE_MS = 250;
const MCP_PREFLIGHT_SHUTDOWN_TIMEOUT_MS = 2_000;
const MCP_PREFLIGHT_SHUTDOWN_POLL_MS = 50;

export interface SpawnProbeOptions {
  /**
   * Optional early success predicate. If this returns true based on
   * buffered stdout/stderr, the probe resolves immediately (and the process
   * is best-effort terminated) instead of waiting for `close`.
   */
  resolveOnOutputMatch?: (ctx: { stdout: string; stderr: string }) => boolean;
}

export interface SpawnProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type TeamProvisioningProbeChild = ReturnType<typeof spawn>;

export interface TeamProvisioningProviderDiagnosticsPorts {
  execCli: typeof execCli;
  spawnCli: typeof spawnCli;
  killProcessTree: typeof killProcessTree;
  isProcessAlive(pid: number): boolean;
  addTransientProbeProcess(child: TeamProvisioningProbeChild): void;
  removeTransientProbeProcess(child: TeamProvisioningProbeChild): void;
  pathExistsAsDirectory(candidatePath: string): Promise<boolean>;
  readFileUtf8(filePath: string): Promise<string>;
  makeTempDir(prefix: string): Promise<string>;
  mkdirRecursive(directoryPath: string): Promise<void>;
  writeFileUtf8(filePath: string, contents: string): Promise<void>;
  removeDirectory(directoryPath: string): Promise<void>;
  tmpdir(): string;
  spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    options?: SpawnProbeOptions
  ): Promise<SpawnProbeResult>;
  getConfiguredCodexCustomProviderModel(): string | null;
  isAuthFailureWarning(text: string, source: 'probe'): boolean;
  normalizeApiRetryErrorMessage(text: string): string;
  appendPreflightDebugLog(event: string, data: Record<string, unknown>): void;
  info(message: string): void;
  warn(message: string): void;
  sleep(ms: number): Promise<void>;
}

export function createDefaultTeamProvisioningProviderDiagnosticsPorts(input: {
  transientProbeProcesses: Set<TeamProvisioningProbeChild>;
  providerConnectionService?: Pick<
    ProviderConnectionService,
    'getConfiguredCodexCustomProviderModel'
  >;
  logger: {
    info(message: string): void;
    warn(message: string): void;
  };
  isAuthFailureWarning(text: string, source: 'probe'): boolean;
  normalizeApiRetryErrorMessage(text: string): string;
  appendPreflightDebugLog?: (event: string, data: Record<string, unknown>) => void;
}): TeamProvisioningProviderDiagnosticsPorts {
  const providerConnectionService =
    input.providerConnectionService ?? ProviderConnectionService.getInstance();
  const processPorts = {
    spawnCli,
    killProcessTree,
    addTransientProbeProcess: (child: TeamProvisioningProbeChild) => {
      input.transientProbeProcesses.add(child);
    },
    removeTransientProbeProcess: (child: TeamProvisioningProbeChild) => {
      input.transientProbeProcesses.delete(child);
    },
  };

  return {
    execCli,
    ...processPorts,
    isProcessAlive,
    pathExistsAsDirectory,
    readFileUtf8: (filePath) => fs.promises.readFile(filePath, 'utf8'),
    makeTempDir: (prefix) => fs.promises.mkdtemp(prefix),
    mkdirRecursive: async (directoryPath) => {
      await fs.promises.mkdir(directoryPath, { recursive: true });
    },
    writeFileUtf8: (filePath, contents) => atomicWriteAsync(filePath, contents),
    removeDirectory: async (directoryPath) => {
      await fs.promises.rm(directoryPath, { recursive: true, force: true });
    },
    tmpdir: () => os.tmpdir(),
    spawnProbe: (claudePath, args, cwd, env, timeoutMs, options) =>
      spawnProbe({ claudePath, args, cwd, env, timeoutMs, options, ports: processPorts }),
    getConfiguredCodexCustomProviderModel: () =>
      providerConnectionService.getConfiguredCodexCustomProviderModel(),
    isAuthFailureWarning: input.isAuthFailureWarning,
    normalizeApiRetryErrorMessage: input.normalizeApiRetryErrorMessage,
    appendPreflightDebugLog: input.appendPreflightDebugLog ?? appendPreflightDebugLog,
    info: (message) => input.logger.info(message),
    warn: (message) => input.logger.warn(message),
    sleep,
  };
}

/**
 * Two-stage preflight check:
 * 1. `claude --version` verifies the binary is executable.
 * 2. Runtime control-plane commands verify provider auth/team-launch readiness.
 *
 * Do not use `-p` here: full print mode can initialize MCP/plugin/LSP startup context
 * before the first response, which makes Create Team preflight slow and flaky.
 */
export async function probeClaudeRuntime({
  claudePath,
  cwd,
  env,
  providerId = 'anthropic',
  providerArgs = [],
  ports,
}: {
  claudePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerId?: TeamProviderId;
  providerArgs?: string[];
  ports: TeamProvisioningProviderDiagnosticsPorts;
}): Promise<{ warning?: string }> {
  const resolvedProviderId = resolveTeamProviderId(providerId);
  const cliCommandLabel = getConfiguredCliCommandLabel();
  if (!(await ports.pathExistsAsDirectory(cwd))) {
    return {
      warning: `Working directory does not exist: ${cwd}`,
    };
  }

  try {
    const versionProbe = await ports.spawnProbe(
      claudePath,
      ['--version'],
      cwd,
      env,
      PREFLIGHT_BINARY_TIMEOUT_MS
    );
    if (versionProbe.exitCode !== 0) {
      const errorText =
        buildCombinedLogs(versionProbe.stdout, versionProbe.stderr) ||
        `${cliCommandLabel} exited with code ${versionProbe.exitCode ?? 'unknown'} during warm-up`;
      return {
        warning: `${cliCommandLabel} binary failed to start correctly. Details: ${errorText}`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingCwdSpawnError(message) && !(await ports.pathExistsAsDirectory(cwd))) {
      return {
        warning: `Working directory does not exist: ${cwd}`,
      };
    }
    return {
      warning: `${cliCommandLabel} binary failed to start. Details: ${message}`,
    };
  }

  if (resolvedProviderId === 'gemini') {
    const authState = await resolveGeminiRuntimeAuth(env);
    if (authState.authenticated) {
      return {};
    }
    return {
      warning:
        authState.statusMessage ??
        'Gemini provider is not configured for runtime use. Set GEMINI_API_KEY or Google ADC credentials (plus GOOGLE_CLOUD_PROJECT when needed) and retry.',
    };
  }

  if (resolvedProviderId === 'anthropic' || resolvedProviderId === 'codex') {
    return await probeProviderRuntimeControlPlane({
      claudePath,
      cwd,
      env,
      providerId: resolvedProviderId,
      providerArgs,
      ports,
    });
  }

  return {};
}

export async function probeProviderRuntimeControlPlane({
  claudePath,
  cwd,
  env,
  providerId,
  providerArgs,
  ports,
}: {
  claudePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerId: TeamProviderId;
  providerArgs: string[];
  ports: Pick<TeamProvisioningProviderDiagnosticsPorts, 'execCli' | 'appendPreflightDebugLog'>;
}): Promise<{ warning?: string }> {
  const cliCommandLabel = getConfiguredCliCommandLabel();
  const providerLabel = getTeamProviderLabel(providerId);

  try {
    const runtimeStatus = await ports.execCli(
      claudePath,
      buildProviderControlPlaneCliCommandArgs(providerArgs, [
        'runtime',
        'status',
        '--json',
        '--summary',
        '--provider',
        providerId,
      ]),
      {
        cwd,
        env,
        timeout: PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
      }
    );
    const parsed = extractJsonObjectFromCli<RuntimeStatusCommandResponse>(runtimeStatus.stdout);
    const providerStatus = parsed.providers?.[providerId] ?? null;
    const warning = buildRuntimeProviderReadinessWarning(providerId, providerStatus);
    ports.appendPreflightDebugLog('provider_runtime_control_plane_status', {
      providerId,
      cwd,
      ready: !warning,
      authenticated: providerStatus?.authenticated,
      teamLaunch: providerStatus?.capabilities?.teamLaunch,
      oneShot: providerStatus?.capabilities?.oneShot,
      warning,
    });
    return warning ? { warning } : {};
  } catch (runtimeStatusError) {
    const runtimeStatusMessage =
      runtimeStatusError instanceof Error ? runtimeStatusError.message : String(runtimeStatusError);
    try {
      const authStatus = await ports.execCli(
        claudePath,
        buildProviderControlPlaneCliCommandArgs(providerArgs, [
          'auth',
          'status',
          '--json',
          '--provider',
          providerId,
        ]),
        {
          cwd,
          env,
          timeout: 8_000,
        }
      );
      const parsed = extractJsonObjectFromCli<AuthStatusCommandResponse>(authStatus.stdout);
      const authReadiness = extractAuthStatusReadiness(providerId, parsed);
      const readinessWarning = authReadiness.providerStatus
        ? buildRuntimeProviderReadinessWarning(providerId, authReadiness.providerStatus)
        : null;
      if (authReadiness.authenticated === false || readinessWarning) {
        const authWarning =
          readinessWarning ??
          `${providerLabel} provider is not authenticated. Runtime auth status reported logged out.`;
        ports.appendPreflightDebugLog('provider_runtime_control_plane_auth_fallback', {
          providerId,
          cwd,
          ready: false,
          runtimeStatusError: runtimeStatusMessage,
          warning: authWarning,
        });
        return { warning: authWarning };
      }
      if (authReadiness.authenticated === true) {
        const warning =
          `${cliCommandLabel} runtime status was unavailable, but auth status passed. ` +
          `Proceeding with catalog checks. Details: ${runtimeStatusMessage}`;
        ports.appendPreflightDebugLog('provider_runtime_control_plane_auth_fallback', {
          providerId,
          cwd,
          ready: true,
          runtimeStatusError: runtimeStatusMessage,
          warning,
        });
        return { warning };
      }
    } catch (authStatusError) {
      const authStatusMessage =
        authStatusError instanceof Error ? authStatusError.message : String(authStatusError);
      ports.appendPreflightDebugLog('provider_runtime_control_plane_auth_fallback', {
        providerId,
        cwd,
        ready: false,
        runtimeStatusError: runtimeStatusMessage,
        authStatusError: authStatusMessage,
      });
      return {
        warning:
          `${cliCommandLabel} runtime status check did not complete. ` +
          `Proceeding with catalog checks. Details: ${runtimeStatusMessage}; auth status failed: ${authStatusMessage}`,
      };
    }

    return {
      warning:
        `${cliCommandLabel} runtime status was unavailable and auth status did not report ${providerLabel} authentication. ` +
        `Proceeding with catalog checks. Details: ${runtimeStatusMessage}`,
    };
  }
}

export async function runProviderOneShotDiagnostic({
  claudePath,
  cwd,
  env,
  providerId = 'anthropic',
  providerArgs = [],
  ports,
}: {
  claudePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerId?: TeamProviderId;
  providerArgs?: string[];
  ports: TeamProvisioningProviderDiagnosticsPorts;
}): Promise<{ warning?: string }> {
  const cliCommandLabel = getConfiguredCliCommandLabel();
  const resolvedProviderId = resolveTeamProviderId(providerId);

  if (!(await ports.pathExistsAsDirectory(cwd))) {
    ports.appendPreflightDebugLog('provider_one_shot_diagnostic_skipped', {
      providerId: resolvedProviderId,
      cwd,
      reason: 'missing_cwd',
    });
    return {};
  }

  const args = buildProviderCliCommandArgs(providerArgs, getPreflightPingArgs(providerId, ports));
  const timeoutMs = getPreflightTimeoutMs(providerId);
  ports.appendPreflightDebugLog('provider_one_shot_diagnostic_start', {
    providerId: resolvedProviderId,
    cwd,
    timeoutMs,
    args,
  });

  for (let attempt = 1; attempt <= PREFLIGHT_AUTH_MAX_RETRIES; attempt++) {
    let pingProbe: SpawnProbeResult | null = null;
    try {
      pingProbe = await ports.spawnProbe(claudePath, args, cwd, env, timeoutMs, {
        resolveOnOutputMatch: ({ stdout, stderr }) => {
          const combined = `${stdout}\n${stderr}`.trim();
          return /\bPONG\b/i.test(combined);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isProbeTimeoutMessage(message) && attempt < PREFLIGHT_AUTH_MAX_RETRIES) {
        ports.appendPreflightDebugLog('provider_one_shot_diagnostic_retry', {
          providerId: resolvedProviderId,
          cwd,
          attempt,
          reason: truncatePreflightDebugText(message),
        });
        ports.warn(
          `One-shot diagnostic failed (attempt ${attempt}/${PREFLIGHT_AUTH_MAX_RETRIES}), ` +
            `retrying in ${PREFLIGHT_AUTH_RETRY_DELAY_MS}ms: ${message}`
        );
        await ports.sleep(PREFLIGHT_AUTH_RETRY_DELAY_MS);
        continue;
      }
      const normalizedMessage = normalizeProviderModelProbeFailureReason(message);
      ports.appendPreflightDebugLog('provider_one_shot_diagnostic_complete', {
        providerId: resolvedProviderId,
        cwd,
        attempt,
        ok: false,
        reason: isProbeTimeoutMessage(message) ? 'timeout' : 'error',
        message: truncatePreflightDebugText(normalizedMessage),
      });
      return {
        warning:
          (isProbeTimeoutMessage(message)
            ? 'One-shot diagnostic timed out after runtime readiness passed. '
            : 'One-shot diagnostic did not complete after runtime readiness passed. ') +
          `This does not mark selected models unavailable. Details: ${normalizedMessage}`,
      };
    }

    const combinedOutput = buildCombinedLogs(pingProbe.stdout, pingProbe.stderr);
    const isAuthFailure = ports.isAuthFailureWarning(combinedOutput, 'probe');

    if (isAuthFailure && attempt < PREFLIGHT_AUTH_MAX_RETRIES) {
      ports.appendPreflightDebugLog('provider_one_shot_diagnostic_retry', {
        providerId: resolvedProviderId,
        cwd,
        attempt,
        exitCode: pingProbe.exitCode,
        reason: 'auth_failure',
        output: truncatePreflightDebugText(combinedOutput),
      });
      ports.warn(
        `One-shot diagnostic auth failure detected (attempt ${attempt}/${PREFLIGHT_AUTH_MAX_RETRIES}), ` +
          `retrying in ${PREFLIGHT_AUTH_RETRY_DELAY_MS}ms - likely stale locks from interrupted process`
      );
      await ports.sleep(PREFLIGHT_AUTH_RETRY_DELAY_MS);
      continue;
    }

    if (isAuthFailure || pingProbe.exitCode !== 0) {
      const normalizedOutput =
        ports.normalizeApiRetryErrorMessage(combinedOutput) || combinedOutput.trim();
      const hint = isAuthFailure
        ? resolvedProviderId === 'codex'
          ? 'Codex provider is not authenticated for `-p` mode. ' +
            `Authenticate Codex in ${cliCommandLabel} and retry.` +
            (attempt > 1 ? ` (failed after ${attempt} attempts)` : '')
          : `${cliCommandLabel} \`-p\` mode is not authenticated. ` +
            (cliCommandLabel === 'claude'
              ? 'Run `claude auth login` (or start `claude` and run `/login`) to authenticate. '
              : `Authenticate Anthropic in ${cliCommandLabel} and retry. `) +
            'For automation/headless use, set ANTHROPIC_API_KEY.' +
            (attempt > 1 ? ` (failed after ${attempt} attempts)` : '')
        : normalizedOutput
          ? `${cliCommandLabel} preflight check failed (exit code ${pingProbe.exitCode ?? 'unknown'}). Details: ${normalizedOutput}`
          : `${cliCommandLabel} preflight check failed (exit code ${pingProbe.exitCode ?? 'unknown'}).`;
      ports.appendPreflightDebugLog('provider_one_shot_diagnostic_complete', {
        providerId: resolvedProviderId,
        cwd,
        attempt,
        ok: false,
        exitCode: pingProbe.exitCode,
        authFailure: isAuthFailure,
        output: truncatePreflightDebugText(normalizedOutput || combinedOutput),
      });
      return {
        warning:
          'One-shot diagnostic failed after runtime readiness passed. ' +
          `This does not mark selected models unavailable. Details: ${hint}`,
      };
    }

    const pongCandidate = pingProbe.stdout.trim() || pingProbe.stderr.trim();
    const isPong = new RegExp(`\\b${getProviderModelProbeExpectedOutput()}\\b`, 'i').test(
      pongCandidate
    );
    if (!isPong) {
      ports.appendPreflightDebugLog('provider_one_shot_diagnostic_complete', {
        providerId: resolvedProviderId,
        cwd,
        attempt,
        ok: false,
        exitCode: pingProbe.exitCode,
        reason: 'unexpected_output',
        output: truncatePreflightDebugText(combinedOutput),
      });
      return {
        warning:
          'One-shot diagnostic completed but did not return the expected PONG. ' +
          'This does not mark selected models unavailable. ' +
          `Output: ${combinedOutput || '(empty)'}`,
      };
    }

    if (attempt > 1) {
      ports.info(
        `One-shot diagnostic succeeded on attempt ${attempt} (previous attempt had auth failure)`
      );
    }
    ports.appendPreflightDebugLog('provider_one_shot_diagnostic_complete', {
      providerId: resolvedProviderId,
      cwd,
      attempt,
      ok: true,
      exitCode: pingProbe.exitCode,
    });
    return {};
  }

  return {};
}

export function buildAgentTeamsMcpValidationError(
  output: string,
  normalizeApiRetryErrorMessage: (text: string) => string = (text) => text.trim()
): string {
  return buildAgentTeamsMcpValidationErrorMessage(output, normalizeApiRetryErrorMessage);
}

interface AgentTeamsMcpConfigEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
}

interface AgentTeamsMcpConfigFile {
  mcpServers?: Record<string, AgentTeamsMcpConfigEntry>;
}

export interface AgentTeamsMcpLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

interface McpJsonRpcErrorPayload {
  code?: number;
  message?: string;
}

interface McpJsonRpcResponse<TResult> {
  id?: number;
  result?: TResult;
  error?: McpJsonRpcErrorPayload;
}

interface McpToolsListResult {
  tools?: {
    name?: string;
    _meta?: Record<string, unknown>;
  }[];
}

interface McpToolCallResult {
  content?: {
    type?: string;
    text?: string;
  }[];
  isError?: boolean;
}

interface AgentTeamsMcpValidationFixture {
  claudeDir: string;
  teamName: string;
  memberName: string;
}

export function parseAgentTeamsMcpLaunchSpec(
  parsed: AgentTeamsMcpConfigFile,
  mcpConfigPath: string,
  buildValidationError: (output: string) => string = buildAgentTeamsMcpValidationError
): AgentTeamsMcpLaunchSpec {
  const server = parsed.mcpServers?.['agent-teams'];
  if (!server) {
    throw new Error(
      buildValidationError(
        `Generated MCP config ${mcpConfigPath} does not contain an "agent-teams" server entry.`
      )
    );
  }

  if (typeof server.command !== 'string' || server.command.trim().length === 0) {
    throw new Error(
      buildValidationError('Generated agent-teams MCP config is missing a valid launch command.')
    );
  }

  if (server.args !== undefined && !isStringArray(server.args)) {
    throw new Error(
      buildValidationError(
        'Generated agent-teams MCP config has invalid args; expected a string array.'
      )
    );
  }

  if (server.cwd !== undefined && typeof server.cwd !== 'string') {
    throw new Error(
      buildValidationError(
        'Generated agent-teams MCP config has invalid cwd; expected a string path.'
      )
    );
  }

  return {
    command: server.command,
    args: server.args ?? [],
    cwd: typeof server.cwd === 'string' ? server.cwd : undefined,
    env: normalizeRecordStringValues(server.env),
  };
}

export async function readAgentTeamsMcpLaunchSpec({
  mcpConfigPath,
  ports,
}: {
  mcpConfigPath: string;
  ports: Pick<
    TeamProvisioningProviderDiagnosticsPorts,
    'readFileUtf8' | 'normalizeApiRetryErrorMessage'
  >;
}): Promise<AgentTeamsMcpLaunchSpec> {
  let parsed: AgentTeamsMcpConfigFile;
  try {
    const raw = await ports.readFileUtf8(mcpConfigPath);
    parsed = JSON.parse(raw) as AgentTeamsMcpConfigFile;
  } catch (error) {
    throw new Error(
      buildAgentTeamsMcpValidationError(
        `Failed to read generated MCP config ${mcpConfigPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ports.normalizeApiRetryErrorMessage
      )
    );
  }

  return parseAgentTeamsMcpLaunchSpec(parsed, mcpConfigPath, (output) =>
    buildAgentTeamsMcpValidationError(output, ports.normalizeApiRetryErrorMessage)
  );
}

export async function createAgentTeamsMcpValidationFixture({
  projectPath,
  ports,
}: {
  projectPath: string;
  ports: Pick<
    TeamProvisioningProviderDiagnosticsPorts,
    'makeTempDir' | 'tmpdir' | 'mkdirRecursive' | 'writeFileUtf8'
  >;
}): Promise<AgentTeamsMcpValidationFixture> {
  const claudeDir = await ports.makeTempDir(path.join(ports.tmpdir(), 'agent-teams-mcp-validate-'));
  const teamName = 'mcp-validation-team';
  const memberName = 'mcp-validation-member';
  const teamDir = path.join(claudeDir, 'teams', teamName);

  await ports.mkdirRecursive(teamDir);
  await ports.writeFileUtf8(
    path.join(teamDir, 'config.json'),
    JSON.stringify(
      {
        name: teamName,
        projectPath,
        members: [
          { name: 'team-lead', agentType: 'team-lead', role: 'lead' },
          { name: memberName, agentType: 'teammate', role: 'developer' },
        ],
      },
      null,
      2
    )
  );

  return {
    claudeDir,
    teamName,
    memberName,
  };
}

export async function validateAgentTeamsMcpRuntime({
  cwd,
  env,
  mcpConfigPath,
  options = {},
  ports,
}: {
  claudePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcpConfigPath: string;
  options?: {
    isCancelled?: () => boolean;
  };
  ports: TeamProvisioningProviderDiagnosticsPorts;
}): Promise<void> {
  const launchSpec = await readAgentTeamsMcpLaunchSpec({ mcpConfigPath, ports });
  const fixture = await createAgentTeamsMcpValidationFixture({ projectPath: cwd, ports });
  let child: TeamProvisioningProbeChild | null = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let nextRequestId = 1;
  let cancellationTriggered = false;
  let cancellationTimer: ReturnType<typeof setInterval> | null = null;
  const cancellationMessage = 'agent-teams MCP preflight cancelled by app shutdown';
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeoutHandle: ReturnType<typeof setTimeout>;
    }
  >();

  const rejectAll = (error: Error): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timeoutHandle);
      entry.reject(error);
      pending.delete(id);
    }
  };

  const getCancellationError = (): Error => new Error(cancellationMessage);
  const cancelPreflightIfNeeded = (): boolean => {
    if (cancellationTriggered) {
      return true;
    }
    if (!options.isCancelled?.()) {
      return false;
    }
    cancellationTriggered = true;
    const error = getCancellationError();
    rejectAll(error);
    if (child?.pid) {
      ports.killProcessTree(child);
    }
    return true;
  };
  const throwIfCancelled = (): void => {
    if (cancelPreflightIfNeeded()) {
      throw getCancellationError();
    }
  };

  try {
    throwIfCancelled();
    child = ports.spawnCli(launchSpec.command, launchSpec.args, {
      cwd: launchSpec.cwd ?? cwd,
      env: {
        ...env,
        ...launchSpec.env,
        AGENT_TEAMS_MCP_CLAUDE_DIR: fixture.claudeDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    ports.addTransientProbeProcess(child);
    if (options.isCancelled) {
      cancellationTimer = setInterval(() => {
        if (cancelPreflightIfNeeded() && cancellationTimer) {
          clearInterval(cancellationTimer);
          cancellationTimer = null;
        }
      }, 100);
      cancellationTimer.unref?.();
    }

    const parseStdoutLine = (line: string): void => {
      let message: McpJsonRpcResponse<unknown>;
      try {
        message = JSON.parse(line) as McpJsonRpcResponse<unknown>;
      } catch (error) {
        ports.warn(
          `agent-teams MCP preflight emitted non-JSON stdout line: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      }

      if (typeof message.id !== 'number') {
        return;
      }

      const entry = pending.get(message.id);
      if (!entry) {
        return;
      }

      clearTimeout(entry.timeoutHandle);
      pending.delete(message.id);

      if (message.error) {
        entry.reject(new Error(message.error.message ?? 'Unknown MCP JSON-RPC error'));
        return;
      }

      entry.resolve(message.result);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      stdoutBuffer += chunk.toString();

      while (true) {
        const newlineIndex = stdoutBuffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }

        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        parseStdoutLine(line);
      }
      stdoutBuffer = boundProbeOutputBuffer(stdoutBuffer);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderrBuffer = boundProbeOutputBuffer(stderrBuffer + chunk.toString());
    });

    child.once('error', (error) => {
      rejectAll(error instanceof Error ? error : new Error(String(error)));
    });

    child.once('close', (code, signal) => {
      if (pending.size === 0) {
        return;
      }
      rejectAll(
        new Error(
          `agent-teams MCP process exited unexpectedly during preflight (code=${
            code ?? 'null'
          } signal=${signal ?? 'null'})`
        )
      );
    });

    const request = <TResult>(
      method: string,
      params: Record<string, unknown>,
      timeoutMs: number = VERIFY_TIMEOUT_MS
    ): Promise<TResult> =>
      new Promise<TResult>((resolve, reject) => {
        if (cancelPreflightIfNeeded()) {
          reject(getCancellationError());
          return;
        }
        if (!child?.stdin) {
          reject(new Error('agent-teams MCP stdin is not available'));
          return;
        }

        const id = nextRequestId++;
        const timeoutHandle = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`agent-teams MCP request timed out: ${method}`));
        }, timeoutMs);

        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeoutHandle,
        });

        if (cancelPreflightIfNeeded()) {
          clearTimeout(timeoutHandle);
          pending.delete(id);
          reject(getCancellationError());
          return;
        }

        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
          (error) => {
            if (!error) {
              return;
            }
            clearTimeout(timeoutHandle);
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        );
      });

    const notify = async (method: string, params?: Record<string, unknown>): Promise<void> => {
      if (!child?.stdin) {
        throw new Error('agent-teams MCP stdin is not available');
      }
      const stdin = child.stdin;

      await new Promise<void>((resolve, reject) => {
        stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`,
          (error) => {
            if (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            resolve();
          }
        );
      });
    };

    await request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agent-teams-ai', version: '1.0.0' },
      },
      MCP_PREFLIGHT_INITIALIZE_TIMEOUT_MS
    );
    throwIfCancelled();
    await notify('notifications/initialized');

    const toolsList = await request<McpToolsListResult>('tools/list', {});
    throwIfCancelled();
    const availableTools = new Set((toolsList.tools ?? []).map((tool) => tool.name));
    const requiredTools = Array.from(
      new Set([
        ...AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES,
        'lead_briefing',
        'runtime_bootstrap_checkin',
        'runtime_deliver_message',
        'runtime_task_event',
        'runtime_heartbeat',
      ])
    );
    const missingTools = requiredTools.filter((toolName) => !availableTools.has(toolName));
    if (missingTools.length > 0) {
      throw new Error(
        `agent-teams MCP started but tools/list did not include required tool(s): ${missingTools.join(
          ', '
        )}`
      );
    }

    const memberBriefing = await request<McpToolCallResult>('tools/call', {
      name: 'member_briefing',
      arguments: {
        claudeDir: fixture.claudeDir,
        teamName: fixture.teamName,
        memberName: fixture.memberName,
        runtimeProvider: 'opencode',
        includeActiveProcesses: false,
      },
    });
    throwIfCancelled();

    if (memberBriefing.isError) {
      throw new Error(
        memberBriefing.content?.[0]?.text ??
          'agent-teams MCP returned an unspecified error for member_briefing'
      );
    }

    const briefingText = memberBriefing.content?.find((item) => item.type === 'text')?.text ?? '';
    if (briefingText.trim().length === 0) {
      throw new Error('agent-teams MCP returned empty content for member_briefing');
    }

    const leadBriefing = await request<McpToolCallResult>('tools/call', {
      name: 'lead_briefing',
      arguments: {
        claudeDir: fixture.claudeDir,
        teamName: fixture.teamName,
      },
    });
    throwIfCancelled();

    if (leadBriefing.isError) {
      throw new Error(
        leadBriefing.content?.[0]?.text ??
          'agent-teams MCP returned an unspecified error for lead_briefing'
      );
    }

    const leadBriefingText = leadBriefing.content?.find((item) => item.type === 'text')?.text ?? '';
    if (leadBriefingText.trim().length === 0) {
      throw new Error('agent-teams MCP returned empty content for lead_briefing');
    }
  } catch (error) {
    if (error instanceof Error && error.message === cancellationMessage) {
      throw error;
    }
    const detail = buildCombinedLogs('', stderrBuffer).trim();
    const errorText =
      error instanceof Error && detail.length > 0
        ? `${error.message}\n${detail}`
        : detail || String(error);
    throw new Error(
      buildAgentTeamsMcpValidationError(errorText, ports.normalizeApiRetryErrorMessage)
    );
  } finally {
    if (cancellationTimer) {
      clearInterval(cancellationTimer);
      cancellationTimer = null;
    }
    rejectAll(new Error('agent-teams MCP preflight session closed'));
    if (child) {
      ports.removeTransientProbeProcess(child);
    }
    if (child?.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
      const stdin = child.stdin;
      await new Promise<void>((resolve) => {
        try {
          stdin.end(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    if (child?.pid) {
      await waitForChildProcessToExit(child, MCP_PREFLIGHT_SHUTDOWN_GRACE_MS, ports);
      if (ports.isProcessAlive(child.pid)) {
        ports.killProcessTree(child);
        await waitForPidsToExit([child.pid], {
          timeoutMs: MCP_PREFLIGHT_SHUTDOWN_TIMEOUT_MS,
          pollMs: MCP_PREFLIGHT_SHUTDOWN_POLL_MS,
          ports,
        });
        await waitForChildProcessToExit(child, MCP_PREFLIGHT_SHUTDOWN_GRACE_MS, ports);
      }
    }
    await ports.removeDirectory(fixture.claudeDir).catch(() => {});
  }
}

export async function spawnProbe({
  claudePath,
  args,
  cwd,
  env,
  timeoutMs,
  options,
  ports,
}: {
  claudePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  options?: SpawnProbeOptions;
  ports: Pick<
    TeamProvisioningProviderDiagnosticsPorts,
    'spawnCli' | 'killProcessTree' | 'addTransientProbeProcess' | 'removeTransientProbeProcess'
  >;
}): Promise<SpawnProbeResult> {
  return new Promise((resolve, reject) => {
    const child = ports.spawnCli(claudePath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ports.addTransientProbeProcess(child);
    const cleanupProbe = (): void => {
      ports.removeTransientProbeProcess(child);
    };
    let stdoutText = '';
    let stderrText = '';
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      settled = true;
      cleanupProbe();
      ports.killProcessTree(child);
      reject(new Error(`Timeout running: ${getConfiguredCliCommandLabel()} ${args.join(' ')}`));
    }, timeoutMs);
    timeoutHandle.unref?.();

    const maybeResolveEarly = (): void => {
      if (settled) return;
      if (!options?.resolveOnOutputMatch) return;
      const ctx = { stdout: stdoutText.trim(), stderr: stderrText.trim() };
      if (!options.resolveOnOutputMatch(ctx)) return;

      settled = true;
      clearTimeout(timeoutHandle);
      cleanupProbe();
      // If the process printed the match but hangs during teardown, don't
      // block the UI; terminate best-effort and resolve.
      ports.killProcessTree(child);
      resolve({ exitCode: 0, stdout: ctx.stdout, stderr: ctx.stderr });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutText = boundProbeOutputBuffer(stdoutText + chunk.toString('utf8'));
      maybeResolveEarly();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText = boundProbeOutputBuffer(stderrText + chunk.toString('utf8'));
      maybeResolveEarly();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      cleanupProbe();
      reject(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      cleanupProbe();
      resolve({
        exitCode,
        stdout: stdoutText.trim(),
        stderr: stderrText.trim(),
      });
    });
  });
}

function getPreflightPingArgs(
  providerId: TeamProviderId | undefined,
  ports: Pick<TeamProvisioningProviderDiagnosticsPorts, 'getConfiguredCodexCustomProviderModel'>
): string[] {
  const codexCustomModel =
    resolveTeamProviderId(providerId) === 'codex'
      ? ports.getConfiguredCodexCustomProviderModel()
      : null;
  return buildProviderPreflightPingArgs(providerId, { modelOverride: codexCustomModel });
}

function getPreflightTimeoutMs(providerId: TeamProviderId | undefined): number {
  return getProviderModelProbeTimeoutMs(providerId);
}

function buildProviderCliCommandArgs(providerArgs: string[], args: string[]): string[] {
  return buildProviderLaunchCliCommandArgs(providerArgs, args);
}

function isMissingCwdSpawnError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('spawn ') && lower.includes(' enoent');
}

async function pathExistsAsDirectory(candidatePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(candidatePath);
    return stat.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function normalizeRecordStringValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === 'string' ? [[key, entry]] : []
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidsToExit(
  pids: readonly number[],
  opts: {
    timeoutMs: number;
    pollMs: number;
    ports: Pick<TeamProvisioningProviderDiagnosticsPorts, 'isProcessAlive' | 'sleep'>;
  }
): Promise<number[]> {
  if (pids.length === 0) {
    return [];
  }

  const deadline = Date.now() + opts.timeoutMs;
  let remainingPids = [...new Set(pids)];
  while (Date.now() < deadline) {
    remainingPids = remainingPids.filter((pid) => opts.ports.isProcessAlive(pid));
    if (remainingPids.length === 0) {
      return [];
    }
    await opts.ports.sleep(opts.pollMs);
  }

  return remainingPids;
}

async function waitForChildProcessToExit(
  child: ChildProcess | null | undefined,
  timeoutMs: number,
  ports: Pick<TeamProvisioningProviderDiagnosticsPorts, 'isProcessAlive'>
): Promise<void> {
  if (!child?.pid || !ports.isProcessAlive(child.pid)) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      child.off('close', finish);
      child.off('exit', finish);
      child.off('error', finish);
      resolve();
    };

    timeoutHandle = setTimeout(finish, timeoutMs);
    child.once('close', finish);
    child.once('exit', finish);
    child.once('error', finish);
  });
}
