/* eslint-disable no-param-reassign -- ProvisioningRun object is intentionally mutated as a state tracker throughout the provisioning lifecycle */
import {
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { ClaudeBinaryResolver } from './ClaudeBinaryResolver';
import { TeamConfigReader } from './TeamConfigReader';

import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamProvisioningState,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const RUN_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_POLL_MS = 500;
const STDERR_RING_LIMIT = 64 * 1024;
const STDOUT_RING_LIMIT = 64 * 1024;
const LOG_PROGRESS_THROTTLE_MS = 300;
const UI_LOGS_TAIL_LIMIT = 8000;
const SHELL_ENV_TIMEOUT_MS = 12000;
const CLI_PREPARE_TIMEOUT_MS = 10000;
const PREFLIGHT_TIMEOUT_MS = 30000;
const KEYCHAIN_TIMEOUT_MS = 5000;
const FS_MONITOR_POLL_MS = 2000;
const TASK_WAIT_FALLBACK_MS = 15_000;

const execFileAsync = promisify(execFile);

type TeamsBaseLocation = 'configured' | 'default';

type ValidConfigProbeResult =
  | { ok: true; location: TeamsBaseLocation; configPath: string }
  | { ok: false };

function getTeamsBasePathsToProbe(): { location: TeamsBaseLocation; basePath: string }[] {
  const configured = getTeamsBasePath();
  const defaultBase = path.join(getAutoDetectedClaudeBasePath(), 'teams');
  if (path.resolve(configured) === path.resolve(defaultBase)) {
    return [{ location: 'configured', basePath: configured }];
  }
  return [
    { location: 'configured', basePath: configured },
    { location: 'default', basePath: defaultBase },
  ];
}

function logsSuggestShutdownOrCleanup(logs: string): boolean {
  const text = logs.toLowerCase();
  return (
    text.includes('shutdown') ||
    text.includes('clean up') ||
    text.includes('cleanup') ||
    text.includes('deactivate') ||
    text.includes('deactivated') ||
    text.includes('resources') ||
    // Russian keywords observed in some CLI outputs / user environments
    text.includes('очист') ||
    text.includes('очищ') ||
    text.includes('заверш') ||
    text.includes('деактив')
  );
}

interface ProvisioningRun {
  runId: string;
  teamName: string;
  startedAt: string;
  progress: TeamProvisioningProgress;
  stdoutBuffer: string;
  stderrBuffer: string;
  processKilled: boolean;
  finalizingByTimeout: boolean;
  cancelRequested: boolean;
  teamsBasePathsToProbe: { location: TeamsBaseLocation; basePath: string }[];
  child: ReturnType<typeof spawn> | null;
  timeoutHandle: NodeJS.Timeout | null;
  fsMonitorHandle: NodeJS.Timeout | null;
  onProgress: (progress: TeamProvisioningProgress) => void;
  expectedMembers: string[];
  request: TeamCreateRequest;
  lastLogProgressAt: number;
  fsPhase: 'waiting_config' | 'waiting_members' | 'waiting_tasks' | 'all_files_found';
  waitingTasksSince: number | null;
  provisioningComplete: boolean;
}

type ProvisioningAuthSource =
  | 'anthropic_api_key'
  | 'anthropic_auth_token'
  | 'claude_code_oauth_token_env'
  | 'claude_code_oauth_token_credentials'
  | 'none';

interface ProvisioningEnvResolution {
  env: NodeJS.ProcessEnv;
  authSource: ProvisioningAuthSource;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedInteractiveShellEnv: NodeJS.ProcessEnv | null = null;
let shellEnvResolvePromise: Promise<NodeJS.ProcessEnv> | null = null;

function parseNullSeparatedEnv(content: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  const lines = content.split('\0');
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    parsed[key] = value;
  }
  return parsed;
}

async function readShellEnv(shellPath: string, args: string[]): Promise<NodeJS.ProcessEnv> {
  const envDump = await new Promise<string>((resolve, reject) => {
    const child = spawn(shellPath, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
      timeoutHandle = null;
      child.kill();
      reject(new Error('shell env resolve timeout'));
    }, SHELL_ENV_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.once('error', (error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      reject(error);
    });
    child.once('close', () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
  return parseNullSeparatedEnv(envDump);
}

async function resolveInteractiveShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedInteractiveShellEnv) {
    return cachedInteractiveShellEnv;
  }
  if (shellEnvResolvePromise) {
    return shellEnvResolvePromise;
  }
  if (process.platform === 'win32') {
    cachedInteractiveShellEnv = {};
    return cachedInteractiveShellEnv;
  }

  shellEnvResolvePromise = (async () => {
    const shellPath = process.env.SHELL || '/bin/zsh';
    try {
      const loginEnv = await readShellEnv(shellPath, ['-lic', 'env -0']);
      cachedInteractiveShellEnv = loginEnv;
      return loginEnv;
    } catch (loginError) {
      const loginMessage = loginError instanceof Error ? loginError.message : String(loginError);
      logger.warn(`Failed to resolve login shell env: ${loginMessage}`);
      try {
        const interactiveEnv = await readShellEnv(shellPath, ['-ic', 'env -0']);
        cachedInteractiveShellEnv = interactiveEnv;
        return interactiveEnv;
      } catch (interactiveError) {
        const interactiveMessage =
          interactiveError instanceof Error ? interactiveError.message : String(interactiveError);
        logger.warn(`Failed to resolve interactive shell env: ${interactiveMessage}`);
        return {};
      }
    } finally {
      shellEnvResolvePromise = null;
    }
  })();

  return shellEnvResolvePromise;
}

async function ensureCwdExists(cwd: string): Promise<void> {
  await fs.promises.mkdir(cwd, { recursive: true });
  const stat = await fs.promises.stat(cwd);
  if (!stat.isDirectory()) {
    throw new Error('cwd must be a directory');
  }
}

function buildMembersPrompt(members: TeamCreateRequest['members']): string {
  return members
    .map((member) => {
      const rolePart = member.role?.trim() ? ` (role: ${member.role.trim()})` : '';
      return `- ${member.name}${rolePart}`;
    })
    .join('\n');
}

function buildProvisioningPrompt(request: TeamCreateRequest): string {
  const displayName = request.displayName?.trim() || request.teamName;
  const description = request.description?.trim() || 'No description';
  const members = buildMembersPrompt(request.members);

  return `You are running in a non-interactive CLI session. Do not ask questions. Do everything in a single turn.
Output must be in English.

Goal: Provision a Claude Code agent team with live teammates and an initial task.

Constraints:
- Do NOT call TeamDelete under any circumstances.
- Do NOT use TodoWrite — use TaskCreate for tasks.
- Do NOT send shutdown_request messages (SendMessage type: "shutdown_request" is FORBIDDEN).
- Do NOT shut down, terminate, or clean up the team or its members.
- Keep assistant text minimal.

Steps (execute in this exact order):

1) TeamCreate — create team "${request.teamName}":
   - description: "${description}"

2) Spawn each member as a live teammate using the Task tool:
   - team_name: "${request.teamName}"
   - name: the member's name
   - subagent_type: "general-purpose"
   - prompt: "You are {name}, a {role} on team \\"${displayName}\\" (${request.teamName}). Wait for messages from the team lead and respond accordingly.

MANDATORY TASK STATUS PROTOCOL — you MUST follow this for EVERY task:
1. Use this command to mark task started:
   node \\"$HOME/.claude/teams/${request.teamName}/tools/teamctl.js\\" task start <taskId>
2. Use this command to mark task completed BEFORE sending your final reply:
   node \\"$HOME/.claude/teams/${request.teamName}/tools/teamctl.js\\" task complete <taskId>
3. If you are asked to review and task is accepted, move it to APPROVED (not DONE):
   node \\"$HOME/.claude/teams/${request.teamName}/tools/teamctl.js\\" review approve <taskId>
4. If review fails and changes are needed:
   node \\"$HOME/.claude/teams/${request.teamName}/tools/teamctl.js\\" review request-changes <taskId> --comment \\"<what to fix>\\"
5. NEVER skip status updates. A task is NOT done until completed status is written.
Failure to follow this protocol means the task board will show incorrect status."

3) TaskCreate — create 1 initial task:
   - subject: "Bootstrap check"
   - description: "Confirm team provisioning succeeded. Each member replied OK."

4) SendMessage to each teammate:
   - type: "message"
   - summary: "Bootstrap"
   - content: "Team \\"${displayName}\\" is ready. Your role: {role}. Reply with 'OK' when you are available."

5) Wait for all teammates to reply OK, then output a short summary.

Members:
${members}
`;
}

function updateProgress(
  run: ProvisioningRun,
  state: Exclude<TeamProvisioningState, 'idle'>,
  message: string,
  extras?: Pick<TeamProvisioningProgress, 'pid' | 'error' | 'warnings' | 'cliLogsTail'>
): TeamProvisioningProgress {
  run.progress = {
    ...run.progress,
    state,
    message,
    updatedAt: nowIso(),
    pid: extras?.pid ?? run.progress.pid,
    error: extras?.error,
    warnings: extras?.warnings,
    cliLogsTail: extras?.cliLogsTail ?? run.progress.cliLogsTail,
  };
  return run.progress;
}

function buildCombinedLogs(stdoutBuffer: string, stderrBuffer: string): string {
  const stdoutTrimmed = stdoutBuffer.trim();
  const stderrTrimmed = stderrBuffer.trim();

  if (stdoutTrimmed.length === 0 && stderrTrimmed.length === 0) {
    return '';
  }
  if (stdoutTrimmed.length > 0 && stderrTrimmed.length === 0) {
    return stdoutTrimmed;
  }
  if (stdoutTrimmed.length === 0 && stderrTrimmed.length > 0) {
    return stderrTrimmed;
  }
  return [`[stdout]`, stdoutTrimmed, '', `[stderr]`, stderrTrimmed].join('\n');
}

function extractLogsTail(stdoutBuffer: string, stderrBuffer: string): string | undefined {
  const trimmed = buildCombinedLogs(stdoutBuffer, stderrBuffer).trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(-UI_LOGS_TAIL_LIMIT);
}

function emitLogsProgress(run: ProvisioningRun): void {
  const logsTail = extractLogsTail(run.stdoutBuffer, run.stderrBuffer);
  if (!logsTail) {
    return;
  }
  run.progress = {
    ...run.progress,
    updatedAt: nowIso(),
    cliLogsTail: logsTail,
  };
  run.onProgress(run.progress);
}

function buildCliExitError(code: number | null, stdoutText: string, stderrText: string): string {
  const trimmed = buildCombinedLogs(stdoutText, stderrText).trim();
  if (trimmed.length > 0) {
    if (trimmed.toLowerCase().includes('please run /login')) {
      return 'CLI output indicates that `-p` mode is not authenticated. `claude -p` typically requires `ANTHROPIC_API_KEY` (Agent SDK). `/login` is interactive-only and does not fix `-p`.';
    }
    return trimmed.slice(-4000);
  }

  if (code === 1) {
    return 'Claude CLI exited with code 1. Typical causes: missing auth/onboarding for CLI, or command requiring interactive TTY. Run `claude` in a normal terminal, complete setup, and retry.';
  }

  return `Claude CLI exited with code ${code ?? 'unknown'}`;
}

export class TeamProvisioningService {
  private readonly runs = new Map<string, ProvisioningRun>();
  private readonly activeByTeam = new Map<string, string>();

  constructor(private readonly configReader: TeamConfigReader = new TeamConfigReader()) {}

  async prepareForProvisioning(cwd?: string): Promise<TeamProvisioningPrepareResult> {
    const claudePath = await ClaudeBinaryResolver.resolve();
    if (!claudePath) {
      throw new Error('Claude CLI not found; install it or provide a valid path');
    }

    const { env: executionEnv, authSource } = await this.buildProvisioningEnv();
    const targetCwd = cwd?.trim() || process.cwd();
    if (!path.isAbsolute(targetCwd)) {
      throw new Error('cwd must be an absolute path');
    }
    await ensureCwdExists(targetCwd);

    const warnings: string[] = [];

    if (authSource === 'none') {
      // No explicit auth found. Still attempt preflight — the CLI may
      // authenticate through a mechanism we don't know about (e.g. a
      // managed apiKeyHelper, SSO, or a future auth flow).
      warnings.push(
        'No explicit auth env var found (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN). ' +
          'Attempting preflight check to verify if CLI can authenticate on its own.'
      );
    }

    if (authSource === 'anthropic_auth_token') {
      warnings.push(
        'Using ANTHROPIC_AUTH_TOKEN (proxy) mapped to ANTHROPIC_API_KEY for `-p` mode.'
      );
    }
    if (authSource === 'claude_code_oauth_token_credentials') {
      const source =
        process.platform === 'darwin'
          ? 'macOS Keychain or credentials file'
          : `${path.join(getClaudeBasePath(), '.credentials.json')}`;
      warnings.push(
        `Using OAuth token from ${source}. ` +
          'Note: this token may be stale if Claude Code refreshed it in-memory without persisting. ' +
          'If auth fails, run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN.'
      );
    }

    const probe = await this.probeClaudeRuntime(claudePath, targetCwd, executionEnv);

    if (probe.warning) {
      if (authSource === 'none') {
        // Preflight also failed — auth is truly missing
        return {
          ready: false,
          message: probe.warning,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
      // We had an auth source but preflight still complained — warn but allow
      warnings.push(probe.warning);
    }

    return {
      ready: true,
      message: 'CLI is warmed up and ready to launch',
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    if (this.activeByTeam.has(request.teamName)) {
      throw new Error('Provisioning already running');
    }

    const teamsBasePathsToProbe = getTeamsBasePathsToProbe();
    for (const probe of teamsBasePathsToProbe) {
      const configPath = path.join(probe.basePath, request.teamName, 'config.json');
      if (await this.pathExists(configPath)) {
        const suffix = probe.location === 'configured' ? '' : ` (found under ${probe.basePath})`;
        throw new Error(`Team already exists${suffix}`);
      }
    }

    await ensureCwdExists(request.cwd);

    const claudePath = await ClaudeBinaryResolver.resolve();
    if (!claudePath) {
      throw new Error('Claude CLI not found; install it or provide a valid path');
    }

    const runId = randomUUID();
    const startedAt = nowIso();
    const run: ProvisioningRun = {
      runId,
      teamName: request.teamName,
      startedAt,
      stdoutBuffer: '',
      stderrBuffer: '',
      processKilled: false,
      finalizingByTimeout: false,
      cancelRequested: false,
      teamsBasePathsToProbe,
      child: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      onProgress,
      expectedMembers: request.members.map((member) => member.name),
      request,
      lastLogProgressAt: 0,
      waitingTasksSince: null,
      provisioningComplete: false,
      fsPhase: 'waiting_config',
      progress: {
        runId,
        teamName: request.teamName,
        state: 'validating',
        message: 'Validating team provisioning request',
        startedAt,
        updatedAt: startedAt,
        cliLogsTail: undefined,
      },
    };

    this.runs.set(runId, run);
    this.activeByTeam.set(request.teamName, runId);
    run.onProgress(run.progress);

    const prompt = buildProvisioningPrompt(request);
    let child: ReturnType<typeof spawn>;
    const { env: shellEnv, authSource } = await this.buildProvisioningEnv();
    if (authSource === 'none') {
      logger.warn(
        'No explicit auth env var found for `-p` mode. ' +
          'Attempting spawn anyway — CLI may authenticate via apiKeyHelper, SSO, or other mechanism.'
      );
    }
    try {
      child = spawn(
        claudePath,
        [
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--setting-sources',
          'user,project,local',
          '--disallowedTools',
          'TeamDelete,TodoWrite',
        ],
        {
          cwd: request.cwd,
          env: {
            ...shellEnv,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
    } catch (error) {
      this.runs.delete(runId);
      this.activeByTeam.delete(request.teamName);
      throw error;
    }

    updateProgress(run, 'spawning', 'Starting Claude CLI process', { pid: child.pid ?? undefined });
    run.onProgress(run.progress);
    run.child = child;

    // Send provisioning prompt as first stream-json message (SDKUserMessage format)
    if (child.stdin) {
      const message = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      });
      child.stdin.write(message + '\n');
    }

    if (child.stdout) {
      let stdoutLineBuf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        run.stdoutBuffer += text;
        if (run.stdoutBuffer.length > STDOUT_RING_LIMIT) {
          run.stdoutBuffer = run.stdoutBuffer.slice(run.stdoutBuffer.length - STDOUT_RING_LIMIT);
        }

        // Parse stream-json lines (newline-delimited JSON)
        stdoutLineBuf += text;
        const lines = stdoutLineBuf.split('\n');
        stdoutLineBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as Record<string, unknown>;
            this.handleStreamJsonMessage(run, msg);
          } catch {
            // Not valid JSON — raw text output, ignore
          }
        }

        const currentTs = Date.now();
        if (currentTs - run.lastLogProgressAt >= LOG_PROGRESS_THROTTLE_MS) {
          run.lastLogProgressAt = currentTs;
          emitLogsProgress(run);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        run.stderrBuffer += chunk.toString('utf8');
        if (run.stderrBuffer.length > STDERR_RING_LIMIT) {
          run.stderrBuffer = run.stderrBuffer.slice(run.stderrBuffer.length - STDERR_RING_LIMIT);
        }
        const currentTs = Date.now();
        if (currentTs - run.lastLogProgressAt >= LOG_PROGRESS_THROTTLE_MS) {
          run.lastLogProgressAt = currentTs;
          emitLogsProgress(run);
        }
      });
    }

    // Filesystem-based progress monitor: actively polls team files instead
    // of relying on stdout (which only arrives at the end in text mode).
    // When config + members + tasks are all present, kill the process early
    // rather than waiting for it to deadlock on system-reminder shutdown.
    this.startFilesystemMonitor(run, request);

    run.timeoutHandle = setTimeout(() => {
      if (!run.processKilled && !run.provisioningComplete) {
        run.processKilled = true;
        run.finalizingByTimeout = true;
        void (async () => {
          const readyOnTimeout = await this.tryCompleteAfterTimeout(run);
          run.child?.stdin?.end();
          run.child?.kill();
          if (readyOnTimeout) {
            return; // cleanupRun already called inside tryCompleteAfterTimeout
          }

          const progress = updateProgress(run, 'failed', 'Timed out waiting for CLI', {
            error:
              'Timed out waiting for CLI. Run `claude` once in terminal to complete onboarding and try again.',
            cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
          });
          run.onProgress(progress);
          this.cleanupRun(run);
        })();
      }
    }, RUN_TIMEOUT_MS);

    child.once('error', (error) => {
      const progress = updateProgress(run, 'failed', 'Failed to start Claude CLI', {
        error: error.message,
        cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
    });

    child.once('exit', (code) => {
      void this.handleProcessExit(run, code);
    });

    return { runId };
  }

  async getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error('Unknown runId');
    }
    return run.progress;
  }

  async cancelProvisioning(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error('Unknown runId');
    }
    if (!['spawning', 'monitoring', 'verifying'].includes(run.progress.state)) {
      throw new Error('Provisioning cannot be cancelled in current state');
    }

    run.cancelRequested = true;
    run.processKilled = true;
    run.child?.stdin?.end();
    run.child?.kill();
    const progress = updateProgress(run, 'cancelled', 'Provisioning cancelled by user');
    run.onProgress(progress);
    this.cleanupRun(run);
  }

  /**
   * Send a message to the team's lead process via stream-json stdin.
   * The lead will receive it as a new user turn and can delegate to teammates.
   */
  async sendMessageToTeam(teamName: string, message: string): Promise<void> {
    const runId = this.activeByTeam.get(teamName);
    if (!runId) {
      throw new Error(`No active process for team "${teamName}"`);
    }
    const run = this.runs.get(runId);
    if (!run?.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }
    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
    });
    run.child.stdin.write(payload + '\n');
  }

  /**
   * Check if a team has a live process.
   */
  isTeamAlive(teamName: string): boolean {
    const runId = this.activeByTeam.get(teamName);
    if (!runId) return false;
    const run = this.runs.get(runId);
    return run?.child != null && !run.processKilled && !run.cancelRequested;
  }

  /**
   * Get list of teams with active processes.
   */
  getAliveTeams(): string[] {
    return Array.from(this.activeByTeam.keys()).filter((name) => this.isTeamAlive(name));
  }

  /**
   * Process a parsed stream-json message from stdout.
   * Extracts assistant text for progress reporting and detects turn completion.
   */
  private handleStreamJsonMessage(run: ProvisioningRun, msg: Record<string, unknown>): void {
    // stream-json output has various message types:
    // {"type":"assistant","content":[{"type":"text","text":"..."},...]}
    // {"type":"result","subtype":"success",...}
    if (msg.type === 'assistant' && Array.isArray(msg.content)) {
      const textParts = (msg.content as Record<string, unknown>[])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string);
      if (textParts.length > 0) {
        const text = textParts.join('');
        logger.debug(`[${run.teamName}] assistant: ${text.slice(0, 200)}`);
      }
    }

    if (msg.type === 'result') {
      const subtype = msg.subtype as string | undefined;
      if (subtype === 'success') {
        logger.info(`[${run.teamName}] stream-json result: success — turn complete, process alive`);
        if (!run.provisioningComplete) {
          void this.handleProvisioningTurnComplete(run);
        }
      } else if (subtype === 'error') {
        const errorMsg =
          typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error ?? 'unknown');
        logger.warn(`[${run.teamName}] stream-json result: error — ${errorMsg}`);
        if (!run.provisioningComplete) {
          const progress = updateProgress(
            run,
            'failed',
            'CLI reported an error during provisioning',
            {
              error: errorMsg,
              cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
            }
          );
          run.onProgress(progress);
          // Kill the process on provisioning error
          run.processKilled = true;
          run.child?.stdin?.end();
          run.child?.kill();
          this.cleanupRun(run);
        }
      }
    }
  }

  /**
   * Called when the first stream-json turn completes successfully.
   * Verifies provisioning files exist and marks as ready.
   * Process stays alive for subsequent tasks.
   */
  private async handleProvisioningTurnComplete(run: ProvisioningRun): Promise<void> {
    run.provisioningComplete = true;

    // Clear provisioning timeout — no longer needed
    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
    this.stopFilesystemMonitor(run);

    // Quick verification: config should exist by now
    const configProbe = await this.waitForValidConfig(run, 5000);
    if (!configProbe.ok) {
      logger.warn(
        `[${run.teamName}] Provisioning turn completed but no config.json found — marking ready anyway`
      );
    }

    if (configProbe.ok && configProbe.location === 'default') {
      const configuredTeamsBasePath = getTeamsBasePath();
      const progress = updateProgress(run, 'failed', 'Provisioning failed validation', {
        error:
          `TeamCreate produced config.json under a different Claude root (${configProbe.configPath}). ` +
          `This app is configured to read teams from ${configuredTeamsBasePath}. ` +
          'Align the app Claude root setting with the CLI, then retry.',
        cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
      });
      run.onProgress(progress);
      run.processKilled = true;
      run.child?.stdin?.end();
      run.child?.kill();
      this.cleanupRun(run);
      return;
    }

    // Patch config with expected members (fallback if CLI didn't register all)
    await this.patchConfigWithExpectedMembers(run.teamName, run.request);

    const progress = updateProgress(run, 'ready', 'Team provisioned — process alive and ready', {
      cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
    });
    run.onProgress(progress);
    // NOTE: do NOT remove from activeByTeam — process stays alive
    logger.info(`[${run.teamName}] Provisioning complete. Process alive for subsequent tasks.`);
  }

  /**
   * Remove a run from tracking maps.
   */
  private cleanupRun(run: ProvisioningRun): void {
    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
    this.stopFilesystemMonitor(run);
    this.activeByTeam.delete(run.teamName);
  }

  /**
   * Polls the filesystem to track provisioning progress in real time.
   * Emits progress updates as team files appear (config, inboxes, tasks).
   */
  private startFilesystemMonitor(run: ProvisioningRun, request: TeamCreateRequest): void {
    const configuredTeamDir = path.join(getTeamsBasePath(), run.teamName);
    const defaultTeamDir = path.join(getAutoDetectedClaudeBasePath(), 'teams', run.teamName);
    const tasksDir = path.join(getTasksBasePath(), run.teamName);

    const resolveTeamDir = async (): Promise<string | null> => {
      const configPath = path.join(configuredTeamDir, 'config.json');
      try {
        await fs.promises.access(configPath, fs.constants.F_OK);
        return configuredTeamDir;
      } catch {
        // fallback to default location
      }
      if (path.resolve(configuredTeamDir) !== path.resolve(defaultTeamDir)) {
        const defaultConfigPath = path.join(defaultTeamDir, 'config.json');
        try {
          await fs.promises.access(defaultConfigPath, fs.constants.F_OK);
          return defaultTeamDir;
        } catch {
          // not found in either location
        }
      }
      return null;
    };

    const countFiles = async (dir: string, ext: string): Promise<number> => {
      try {
        const entries = await fs.promises.readdir(dir);
        return entries.filter((e) => e.endsWith(ext) && !e.startsWith('.')).length;
      } catch {
        return 0;
      }
    };

    const poll = async (): Promise<void> => {
      if (run.cancelRequested || run.processKilled || run.progress.state === 'ready') {
        return;
      }

      try {
        if (run.fsPhase === 'waiting_config') {
          const teamDir = await resolveTeamDir();
          if (teamDir) {
            run.fsPhase = 'waiting_members';
            const progress = updateProgress(
              run,
              'monitoring',
              'Team config created, waiting for members'
            );
            run.onProgress(progress);
          }
        }

        if (run.fsPhase === 'waiting_members') {
          const teamDir = (await resolveTeamDir()) ?? configuredTeamDir;
          const inboxDir = path.join(teamDir, 'inboxes');
          const inboxCount = await countFiles(inboxDir, '.json');
          if (inboxCount >= request.members.length) {
            run.fsPhase = 'waiting_tasks';
            const progress = updateProgress(
              run,
              'monitoring',
              `All ${inboxCount} member inboxes created, waiting for tasks`
            );
            run.onProgress(progress);
          } else if (inboxCount > 0) {
            const progress = updateProgress(
              run,
              'monitoring',
              `${inboxCount}/${request.members.length} member inboxes created`
            );
            run.onProgress(progress);
          }
        }

        if (run.fsPhase === 'waiting_tasks') {
          if (run.waitingTasksSince === null) {
            run.waitingTasksSince = Date.now();
          }
          const taskCount = await countFiles(tasksDir, '.json');
          const taskFound = taskCount > 0;
          const taskFallbackExpired =
            !taskFound && Date.now() - run.waitingTasksSince >= TASK_WAIT_FALLBACK_MS;

          if (taskFound || taskFallbackExpired) {
            run.fsPhase = 'all_files_found';
            const message = taskFound
              ? `Team provisioned: ${taskCount} task(s). Teammates working...`
              : 'Team provisioned (no task file yet). Teammates working...';
            const progress = updateProgress(run, 'monitoring', message);
            run.onProgress(progress);
            // No early-kill — let the process run naturally.
            // The lead will finish when teammates complete their work,
            // then system-reminder fires, --disallowedTools blocks TeamDelete,
            // and the process exits on its own.
          }
        }
      } catch (error) {
        logger.debug(
          `FS monitor poll error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    run.fsMonitorHandle = setInterval(() => {
      void poll();
    }, FS_MONITOR_POLL_MS);

    // Run first poll immediately
    void poll();
  }

  private stopFilesystemMonitor(run: ProvisioningRun): void {
    if (run.fsMonitorHandle) {
      clearInterval(run.fsMonitorHandle);
      run.fsMonitorHandle = null;
    }
  }

  private async handleProcessExit(run: ProvisioningRun, code: number | null): Promise<void> {
    if (run.finalizingByTimeout) {
      return;
    }
    if (run.progress.state === 'failed' || run.cancelRequested) {
      return;
    }

    // === Process exited AFTER provisioning completed ===
    // This means the team went offline (crash, kill, or natural exit).
    if (run.provisioningComplete) {
      const message =
        code === 0
          ? 'Team process exited normally'
          : `Team process exited unexpectedly (code ${code ?? 'unknown'})`;
      logger.info(`[${run.teamName}] ${message}`);
      const progress = updateProgress(run, 'disconnected', message, {
        cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    // === Process exited DURING provisioning ===
    // Try to verify if files were created before the process died.
    updateProgress(run, 'verifying', 'Process exited — verifying provisioning results');
    run.onProgress(run.progress);

    if (run.cancelRequested) {
      return;
    }

    const configProbe = await this.waitForValidConfig(run);
    if (run.cancelRequested) {
      return;
    }

    if (configProbe.ok && configProbe.location === 'default') {
      const configuredTeamsBasePath = getTeamsBasePath();
      const progress = updateProgress(run, 'failed', 'Provisioning failed validation', {
        error:
          `TeamCreate produced config.json under a different Claude root (${configProbe.configPath}). ` +
          `This app is configured to read teams from ${configuredTeamsBasePath}. ` +
          'Align the app Claude root setting with the CLI, then retry.',
        cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    const visibleInList =
      configProbe.ok && configProbe.location === 'configured'
        ? await this.waitForTeamInList(run.teamName, run)
        : false;
    if (run.cancelRequested) {
      return;
    }

    if (configProbe.ok && visibleInList) {
      // Files exist but process died — provisioned but not alive.
      const warnings: string[] = [
        `CLI process exited (code ${code ?? 'unknown'}) — team provisioned but not alive`,
      ];
      const missingInboxes = await this.waitForMissingInboxes(run);
      if (run.cancelRequested) {
        return;
      }
      if (missingInboxes.length > 0) {
        warnings.push('Some inboxes not created yet');
      }
      await this.patchConfigWithExpectedMembers(run.teamName, run.request);
      // Mark as disconnected since the process is dead
      const progress = updateProgress(
        run,
        'disconnected',
        'Team provisioned but process is no longer alive',
        {
          warnings,
          cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
        }
      );
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    if (code === 0) {
      const configuredConfigPath = path.join(getTeamsBasePath(), run.teamName, 'config.json');
      const defaultTeamsBasePath = path.join(getAutoDetectedClaudeBasePath(), 'teams');
      const defaultConfigPath = path.join(defaultTeamsBasePath, run.teamName, 'config.json');
      const combinedLogs = buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer);
      const cleanupHint = logsSuggestShutdownOrCleanup(combinedLogs)
        ? ' CLI output suggests the team was shut down / cleaned up, so no persisted config was left on disk.'
        : '';

      const errorMessage = !configProbe.ok
        ? `No valid config.json found at ${configuredConfigPath}${
            path.resolve(defaultTeamsBasePath) === path.resolve(getTeamsBasePath())
              ? ''
              : ` (also checked ${defaultConfigPath})`
          } within ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s.${cleanupHint}`
        : 'Team did not appear in team:list after provisioning';
      const progress = updateProgress(run, 'failed', 'Provisioning failed validation', {
        error: errorMessage,
        cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    const errorText = buildCliExitError(code, run.stdoutBuffer, run.stderrBuffer);
    const progress = updateProgress(run, 'failed', 'Claude CLI exited with an error', {
      error: errorText,
      cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
    });
    run.onProgress(progress);
    this.cleanupRun(run);
    logger.warn(`Provisioning failed for ${run.teamName}: ${progress.error ?? errorText}`);
  }

  private async waitForValidConfig(
    run: ProvisioningRun,
    timeoutMs: number = VERIFY_TIMEOUT_MS
  ): Promise<ValidConfigProbeResult> {
    const probes = run.teamsBasePathsToProbe.map((probe) => ({
      ...probe,
      configPath: path.join(probe.basePath, run.teamName, 'config.json'),
    }));
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (run.cancelRequested) {
        return { ok: false };
      }
      for (const probe of probes) {
        try {
          const raw = await fs.promises.readFile(probe.configPath, 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object') {
            const candidate = parsed as { name?: unknown };
            if (typeof candidate.name === 'string' && candidate.name.trim().length > 0) {
              return { ok: true, location: probe.location, configPath: probe.configPath };
            }
          }
        } catch {
          // Best-effort polling until deadline.
        }
      }
      await sleep(VERIFY_POLL_MS);
    }

    return { ok: false };
  }

  private async waitForTeamInList(teamName: string, run?: ProvisioningRun): Promise<boolean> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (run?.cancelRequested) {
        return false;
      }
      try {
        const teams = await this.configReader.listTeams();
        if (teams.some((team) => team.teamName === teamName)) {
          return true;
        }
      } catch {
        // Keep polling until deadline.
      }
      await sleep(VERIFY_POLL_MS);
    }
    return false;
  }

  private async waitForMissingInboxes(run: ProvisioningRun): Promise<string[]> {
    if (run.expectedMembers.length === 0) {
      return [];
    }
    const inboxDir = path.join(getTeamsBasePath(), run.teamName, 'inboxes');
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let missing = new Set(run.expectedMembers);

    while (Date.now() < deadline && missing.size > 0) {
      if (run.cancelRequested || run.progress.state === 'cancelled') {
        return Array.from(missing);
      }
      const nextMissing = new Set<string>();
      for (const member of missing) {
        const inboxPath = path.join(inboxDir, `${member}.json`);
        if (!(await this.pathExists(inboxPath))) {
          nextMissing.add(member);
        }
      }
      missing = nextMissing;
      if (missing.size === 0) {
        break;
      }
      await sleep(VERIFY_POLL_MS);
    }

    return Array.from(missing);
  }

  private async tryCompleteAfterTimeout(run: ProvisioningRun): Promise<boolean> {
    if (run.cancelRequested) {
      return false;
    }

    const configProbe = await this.waitForValidConfig(run);
    if (!configProbe.ok || configProbe.location !== 'configured') {
      return false;
    }

    const visibleInList = await this.waitForTeamInList(run.teamName);
    if (!visibleInList) {
      return false;
    }

    const warnings: string[] = [
      'CLI timed out after config was created — team provisioned but process killed',
    ];
    const missingInboxes = await this.waitForMissingInboxes(run);
    if (run.cancelRequested) {
      return false;
    }
    if (missingInboxes.length > 0) {
      warnings.push('Some inboxes not created yet');
    }

    await this.patchConfigWithExpectedMembers(run.teamName, run.request);
    // Process was killed by timeout — mark as disconnected, not ready
    const progress = updateProgress(run, 'disconnected', 'Team provisioned but process timed out', {
      warnings,
    });
    run.onProgress(progress);
    this.cleanupRun(run);
    return true;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async buildProvisioningEnv(): Promise<ProvisioningEnvResolution> {
    const shellEnv = await resolveInteractiveShellEnv();
    const home = shellEnv.HOME?.trim() || process.env.HOME?.trim() || os.homedir();
    const user = shellEnv.USER?.trim() || process.env.USER?.trim() || os.userInfo().username;
    const shell = shellEnv.SHELL?.trim() || process.env.SHELL?.trim() || '/bin/zsh';
    const xdgConfigHome =
      shellEnv.XDG_CONFIG_HOME?.trim() || process.env.XDG_CONFIG_HOME?.trim() || `${home}/.config`;
    const xdgStateHome =
      shellEnv.XDG_STATE_HOME?.trim() ||
      process.env.XDG_STATE_HOME?.trim() ||
      `${home}/.local/state`;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...shellEnv,
      HOME: home,
      USER: user,
      LOGNAME: shellEnv.LOGNAME?.trim() || process.env.LOGNAME?.trim() || user,
      SHELL: shell,
      TERM: shellEnv.TERM?.trim() || process.env.TERM?.trim() || 'xterm-256color',
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_STATE_HOME: xdgStateHome,
      // Ensure CLI reads/writes from the same Claude root as the app.
      // This aligns teams/tasks locations when the app overrides claudeRootPath.
      CLAUDE_CONFIG_DIR: getClaudeBasePath(),
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    };

    // 1. Explicit ANTHROPIC_API_KEY — works with `-p` mode directly
    if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim().length > 0) {
      return { env, authSource: 'anthropic_api_key' };
    }

    // 2. Proxy token (ANTHROPIC_AUTH_TOKEN) — `-p` mode does NOT read this var,
    //    so we must copy it into ANTHROPIC_API_KEY for it to work.
    if (
      typeof env.ANTHROPIC_AUTH_TOKEN === 'string' &&
      env.ANTHROPIC_AUTH_TOKEN.trim().length > 0
    ) {
      env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
      return { env, authSource: 'anthropic_auth_token' };
    }

    // 3. CLAUDE_CODE_OAUTH_TOKEN already in env (e.g. from `claude setup-token`)
    if (
      typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' &&
      env.CLAUDE_CODE_OAUTH_TOKEN.trim().length > 0
    ) {
      return { env, authSource: 'claude_code_oauth_token_env' };
    }

    // 4. Try reading OAuth token from platform credential storage.
    //    macOS: Keychain (service "Claude Code-credentials")
    //    Linux: ~/.claude/.credentials.json
    //    Note: keychain tokens may be stale — Claude Code refreshes in-memory
    //    but does not always write back. We still try as best-effort.
    const oauthToken = await this.readOAuthTokenFromStorage(home);
    if (oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      return { env, authSource: 'claude_code_oauth_token_credentials' };
    }

    return { env, authSource: 'none' };
  }

  /**
   * Attempts to read the OAuth access token from platform-specific storage.
   *
   * On macOS: reads from the encrypted Keychain (service "Claude Code-credentials").
   * On Linux: reads from ~/.claude/.credentials.json.
   *
   * Warning: the token retrieved here may be expired. Claude Code refreshes
   * tokens in-memory but does not always persist the refreshed value back to
   * the credential store. A subsequent preflight check (`claude -p "ping"`)
   * will detect if the token is actually usable.
   */
  private async readOAuthTokenFromStorage(home: string): Promise<string | null> {
    const claudeBasePath = getClaudeBasePath();
    if (process.platform === 'darwin') {
      const keychainToken = await this.readOAuthTokenFromKeychain();
      if (keychainToken) {
        return keychainToken;
      }
      // Fallback: ~/.claude/.credentials.json (or overridden Claude root)
      return this.readOAuthTokenFromCredentialsFile(claudeBasePath, home);
    }
    return this.readOAuthTokenFromCredentialsFile(claudeBasePath, home);
  }

  private async readOAuthTokenFromKeychain(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: KEYCHAIN_TIMEOUT_MS }
      );
      const parsed = JSON.parse(stdout.trim()) as unknown;
      return this.extractOAuthAccessToken(parsed);
    } catch {
      return null;
    }
  }

  private async readOAuthTokenFromCredentialsFile(
    claudeBasePath: string,
    homeFallback: string
  ): Promise<string | null> {
    // Preferred: current Claude root (supports claudeRootPath override)
    const primaryPath = path.join(claudeBasePath, '.credentials.json');
    // Back-compat: legacy location under HOME
    const legacyPath = path.join(homeFallback, '.claude', '.credentials.json');
    try {
      const raw = await fs.promises.readFile(primaryPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return this.extractOAuthAccessToken(parsed);
    } catch {
      try {
        const raw = await fs.promises.readFile(legacyPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        return this.extractOAuthAccessToken(parsed);
      } catch {
        return null;
      }
    }
  }

  private extractOAuthAccessToken(parsed: unknown): string | null {
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const root = parsed as { claudeAiOauth?: unknown };
    if (!root.claudeAiOauth || typeof root.claudeAiOauth !== 'object') {
      return null;
    }
    const oauth = root.claudeAiOauth as { accessToken?: unknown };
    if (typeof oauth.accessToken !== 'string') {
      return null;
    }
    const token = oauth.accessToken.trim();
    return token.length > 0 ? token : null;
  }

  /**
   * After the CLI creates config.json (with only team-lead), patch in the
   * expected members from the provisioning request. The simplified prompt
   * sends bootstrap messages to inboxes but does not spawn actual teammate
   * processes, so the members array would otherwise only contain the lead.
   */
  private async patchConfigWithExpectedMembers(
    teamName: string,
    request: TeamCreateRequest
  ): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      const existingMembers = Array.isArray(config.members)
        ? (config.members as Record<string, unknown>[])
        : [];

      const existingNames = new Set(
        existingMembers.filter((m) => typeof m.name === 'string').map((m) => m.name as string)
      );

      const memberColors = ['blue', 'green', 'yellow', 'cyan', 'magenta', 'red'];
      let colorIdx = 0;

      for (const member of request.members) {
        if (existingNames.has(member.name)) {
          continue;
        }

        existingMembers.push({
          agentId: `${member.name}@${teamName}`,
          name: member.name,
          agentType: 'general-purpose',
          role: member.role?.trim() || undefined,
          color: memberColors[colorIdx % memberColors.length],
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: request.cwd,
          subscriptions: [],
        });
        colorIdx++;
      }

      config.members = existingMembers;
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
      logger.info(
        `Patched config.json for ${teamName}: added ${request.members.length - (existingNames.size - 1)} members`
      );
    } catch (error) {
      logger.warn(
        `Failed to patch config.json with members: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Two-stage preflight check:
   * 1. `claude --version` — verifies binary is executable and returns version info.
   * 2. `claude -p "ping"` — verifies that `-p` mode is actually authenticated.
   *    This catches the common case where interactive `claude` works (OAuth/keychain)
   *    but `-p` mode fails with "Not logged in" due to missing env vars.
   */
  private async probeClaudeRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ warning?: string }> {
    // Stage 1: verify binary works
    const versionProbe = await this.spawnProbe(
      claudePath,
      ['--version'],
      cwd,
      env,
      CLI_PREPARE_TIMEOUT_MS
    );
    if (versionProbe.exitCode !== 0) {
      const errorText =
        buildCombinedLogs(versionProbe.stdout, versionProbe.stderr) ||
        `Claude CLI exited with code ${versionProbe.exitCode ?? 'unknown'} during warm-up`;
      throw new Error(`Failed to warm up Claude CLI: ${errorText}`);
    }

    // Stage 2: verify `-p` mode auth actually works
    const pingProbe = await this.spawnProbe(
      claudePath,
      ['-p', 'Reply with the single word PONG and nothing else', '--output-format', 'text'],
      cwd,
      env,
      PREFLIGHT_TIMEOUT_MS
    );

    const combinedOutput = buildCombinedLogs(pingProbe.stdout, pingProbe.stderr);
    const lowerOutput = combinedOutput.toLowerCase();
    const isAuthFailure =
      lowerOutput.includes('not logged in') ||
      lowerOutput.includes('please run /login') ||
      lowerOutput.includes('missing api key') ||
      lowerOutput.includes('invalid api key');

    if (isAuthFailure || pingProbe.exitCode !== 0) {
      const hint = isAuthFailure
        ? 'Claude CLI `-p` mode is not authenticated. ' +
          'Set ANTHROPIC_API_KEY, or run `claude setup-token` to generate a long-lived OAuth token, ' +
          'then export it as CLAUDE_CODE_OAUTH_TOKEN.'
        : `Claude CLI preflight check failed (exit code ${pingProbe.exitCode ?? 'unknown'}).`;
      return { warning: hint };
    }

    return {};
  }

  private async spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(claudePath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timeoutHandle = setTimeout(() => {
        child.kill();
        reject(new Error(`Timeout running: claude ${args.join(' ')}`));
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.once('error', (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timeoutHandle);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString('utf8').trim(),
          stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
        });
      });
    });
  }
}
/* eslint-enable no-param-reassign -- Re-enable after TeamProvisioningService class */
