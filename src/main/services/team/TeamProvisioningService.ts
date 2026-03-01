/* eslint-disable no-param-reassign -- ProvisioningRun object is intentionally mutated as a state tracker throughout the provisioning lifecycle */
import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { killProcessTree, spawnCli } from '@main/utils/childProcess';
import {
  encodePath,
  extractBaseDir,
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
  getProjectsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import {
  AGENT_BLOCK_CLOSE,
  AGENT_BLOCK_OPEN,
  stripAgentBlocks,
} from '@shared/constants/agentBlocks';
import { getMemberColor } from '@shared/constants/memberColors';
import { resolveLanguageName } from '@shared/utils/agentLanguage';
import { createLogger } from '@shared/utils/logger';
import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { atomicWriteAsync } from './atomicWrite';
import { ClaudeBinaryResolver } from './ClaudeBinaryResolver';
import { withInboxLock } from './inboxLock';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';
import { TeamTaskReader } from './TeamTaskReader';

import type {
  InboxMessage,
  TeamChangeEvent,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamProvisioningState,
  TeamTask,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const RUN_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_POLL_MS = 500;
const STDERR_RING_LIMIT = 64 * 1024;
const STDOUT_RING_LIMIT = 64 * 1024;
const LOG_PROGRESS_THROTTLE_MS = 300;
const UI_LOGS_TAIL_LIMIT = 128 * 1024;
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
  isLaunch: boolean;
  leadRelayCapture: {
    leadName: string;
    startedAt: string;
    textParts: string[];
    settled: boolean;
    idleHandle: NodeJS.Timeout | null;
    idleMs: number;
    resolveOnce: (text: string) => void;
    rejectOnce: (error: string) => void;
    timeoutHandle: NodeJS.Timeout;
  } | null;
  /**
   * Accumulates assistant text for direct user→lead messages (no relay capture active).
   * Flushed to liveLeadProcessMessages on result.success.
   */
  directReplyParts: string[];
  /** Accumulates assistant text during provisioning phase for live UI preview. */
  provisioningOutputParts: string[];
  /** Session ID detected from stream-json output (result.session_id or message.session_id). */
  detectedSessionId: string | null;
  /** Lead process activity: 'active' during turn processing, 'idle' waiting for input, 'offline' after exit. */
  leadActivityState: LeadActivityState;
}

type LeadActivityState = 'active' | 'idle' | 'offline';

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
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
      timeoutHandle = null;
      child.kill();
      // SIGKILL fallback if SIGTERM is ignored (e.g., shell stuck on .zshrc)
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 3000);
      if (!settled) {
        settled = true;
        reject(new Error('shell env resolve timeout'));
      }
    }, SHELL_ENV_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.once('error', (error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
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

function wrapInAgentBlock(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return `${AGENT_BLOCK_OPEN}\n${trimmed}\n${AGENT_BLOCK_CLOSE}`;
}

function buildMembersPrompt(members: TeamCreateRequest['members']): string {
  return members
    .map((member) => {
      const rolePart = member.role?.trim() ? ` (role: ${member.role.trim()})` : '';
      return `- ${member.name}${rolePart}`;
    })
    .join('\n');
}

function buildTaskStatusProtocol(teamName: string): string {
  return wrapInAgentBlock(`MANDATORY TASK STATUS PROTOCOL — you MUST follow this for EVERY task:
1. Use this command to mark task started:
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task start <taskId>
2. Use this command to mark task completed BEFORE sending your final reply:
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task complete <taskId>
3. If you are asked to review and task is accepted, move it to APPROVED (not DONE):
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" review approve <taskId>
4. If review fails and changes are needed:
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" review request-changes <taskId> --comment "<what to fix>"
5. NEVER skip status updates. A task is NOT done until completed status is written.
6. To reply to a comment on a task:
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task comment <taskId> --text "<your reply>" --from "<your-name>"
7. When discussing a task with a teammate and you have important findings, decisions, blockers, or progress updates — record them as a task comment:
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task comment <taskId> --text "<summary of your finding or decision>" --from "<your-name>"
   Do NOT comment on trivial coordination messages. Only comment when the information is valuable context for the task.
8. When sending a message about a specific task, include #<taskId> in your SendMessage summary field for traceability.
9. Review workflow clarity (IMPORTANT):
   - The work task (e.g. #1) is the thing that must end up APPROVED after review.
   - If you are reviewing work for task #X, run review approve/request-changes on #X (the work task).
   - Do NOT approve a separate "review task" (e.g. #2 created just to ask for a review) — that will put the wrong task into APPROVED.
   - Typical flow:
     a) Owner finishes work on #X → task complete #X
     b) Reviewer accepts → review approve #X
10. CLARIFICATION PROTOCOL (CRITICAL — MANDATORY):
    When you are blocked and need information to continue a task, you MUST do BOTH steps below — skipping the Bash command breaks the task board:
    a) STEP 1 — FIRST, set the clarification flag via Bash (this updates the task board):
       node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-clarification <taskId> lead --from "<your-name>"
    b) STEP 2 — THEN, send a message to your team lead via SendMessage explaining what you need.
    IMPORTANT: Always run the Bash command BEFORE sending the message. The flag is what makes the task board show "needs clarification" — without it, your request is invisible on the board.
    c) The flag is auto-cleared when the lead adds a task comment on your task.
       If the lead replies via SendMessage instead, clear the flag yourself once you have the answer:
       node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-clarification <taskId> clear --from "<your-name>"
    d) Do NOT set clarification to "user" yourself — only the team lead escalates to the user.
Failure to follow this protocol means the task board will show incorrect status.`);
}

function buildProcessRegistrationProtocol(teamName: string): string {
  return wrapInAgentBlock(`BACKGROUND PROCESS REGISTRATION — when you start a background process (dev server, watcher, database, etc.):
1. Launch with & to get PID:
   pnpm dev &
2. Register immediately (--port and --url are optional, use when the process listens on a port):
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" process register --pid $! --label "<description>" --from "<your-name>" [--port <PORT> --url "http://localhost:<PORT>"]
3. VERIFY registration succeeded (MANDATORY — never skip this step):
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" process list
4. When stopping a process:
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" process unregister --pid <PID>
If verification in step 3 fails or the process is missing from the list, re-register it.`);
}

function buildTeamCtlOpsInstructions(teamName: string, leadName: string): string {
  return wrapInAgentBlock(
    [
      `Internal task board tooling (teamctl.js):`,
      `- Use teamctl.js (via Bash) for tasks that must appear on the team board (assigned work, substantial work, or when the user explicitly asks to create a task).`,
      ``,
      `Task board operations — use teamctl.js via Bash:`,
      `- Create task: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task create --subject "..." --description "..." --owner "<actual-member-name>" --notify --from "${leadName}"`,
      `- Assign/reassign owner: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-owner <id> <member-name> --notify --from "${leadName}"`,
      `- Clear owner: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-owner <id> clear`,
      `- Update status: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-status <id> <pending|in_progress|completed|deleted>`,
      ``,
      `Notification policy:`,
      `- The --notify flag sends the assignment to the member automatically, so do NOT send a separate SendMessage for the same task.`,
      ``,
      `Clarification handling (CRITICAL — MANDATORY for correct task board state):`,
      `- When a teammate needs clarification (needsClarification: "lead"), reply via task comment (preferred — auto-clears the flag) or SendMessage.`,
      `- If you reply via SendMessage instead of task comment, also clear the flag manually:`,
      `  node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-clarification <taskId> clear --from "${leadName}"`,
      `- If you cannot answer and the user needs to decide — ESCALATION PROTOCOL:`,
      `  1) FIRST, set the flag to "user" via Bash (this updates the task board):`,
      `     node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-clarification <taskId> user --from "${leadName}"`,
      `  2) THEN, send a message to "user" explaining the question.`,
      `  3) THEN, reply to the teammate telling them to wait.`,
      `  IMPORTANT: Always run the Bash command BEFORE sending messages. Without the flag, the task board won't show that the task is blocked waiting for user input.`,
    ].join('\n')
  );
}

function buildAgentBlockUsagePolicy(): string {
  return `Agent-only formatting policy (applies to ALL messages you write):
- Humans can see teammate inbox messages and coordination text in the UI.
- Keep normal reasoning, decisions, and user-facing communication OUTSIDE agent-only blocks.
- Any internal operational instructions about tooling/scripts MUST be hidden inside an agent-only block, including:
  - how to use internal scripts (e.g. teamctl.js), exact CLI commands, flags (e.g. --notify)
  - review command phrases like "review approve <id>" / "review request-changes <id>"
  - internal file paths under ~/.claude/ (tools, teams, tasks, kanban state, etc.)
  - meta coordination lines like "All teammates are online and have received their assignments via --notify."
- Use an agent-only fenced block (AGENT_BLOCK_OPEN / AGENT_BLOCK_CLOSE):
  - AGENT_BLOCK_OPEN is exactly: ${AGENT_BLOCK_OPEN}
  - AGENT_BLOCK_CLOSE is exactly: ${AGENT_BLOCK_CLOSE}
  - IMPORTANT: the fence lines must start at the beginning of the line (no indentation).
- Example (copy/paste exactly, no indentation):
${AGENT_BLOCK_OPEN}
(internal instructions: commands, script usage, paths, etc.)
${AGENT_BLOCK_CLOSE}
- Put ONLY the internal instructions inside the agent-only block.
- CRITICAL: Messages to "user" (the human) must NEVER contain agent-only blocks. Write them as plain readable text — the human sees these messages directly in the UI. Agent-only blocks are stripped before display, so a message containing ONLY an agent-only block will appear completely empty.
- CRITICAL: When processing relayed inbox messages, your text output is shown to the user. Do NOT wrap your entire response in an agent-only block. If you need agent-only instructions, put them in a separate block and include a brief human-readable summary outside of it (e.g. "Delegated task to carol." or "Acknowledged, no action needed.").`;
}

function getSystemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return process.env.LANG?.split('.')[0]?.replace('_', '-') ?? 'en';
  }
}

function getAgentLanguageInstruction(): string {
  const config = ConfigManager.getInstance().getConfig();
  const langCode = config.general.agentLanguage || 'system';
  const systemLocale = getSystemLocale();
  const languageName = resolveLanguageName(langCode, systemLocale);
  return `IMPORTANT: Communicate in ${languageName}. All messages, summaries, and task descriptions MUST be in ${languageName}.`;
}

/** Build a concise task snapshot for a specific member (pending/in_progress tasks only). */
function buildMemberTaskSnapshot(memberName: string, tasks: TeamTask[]): string {
  const activeTasks = tasks.filter(
    (t) =>
      t.owner === memberName &&
      (t.status === 'pending' || t.status === 'in_progress') &&
      !t.id.startsWith('_internal')
  );
  if (activeTasks.length === 0) return '';

  const lines = activeTasks.map((t) => {
    const desc = t.description ? ` — ${t.description.slice(0, 120)}` : '';
    return `  - #${t.id} [${t.status}] ${t.subject}${desc}`;
  });
  return `\nYour pending tasks from last session (RESUME these immediately):\n${lines.join('\n')}\n`;
}

/** Build a full task board snapshot for the lead. */
function buildTaskBoardSnapshot(tasks: TeamTask[]): string {
  const active = tasks.filter(
    (t) => (t.status === 'pending' || t.status === 'in_progress') && !t.id.startsWith('_internal')
  );
  if (active.length === 0) return '\nNo pending tasks on the board.\n';

  const lines = active.map((t) => {
    const owner = t.owner ? ` (owner: ${t.owner})` : ' (unassigned)';
    const desc = t.description ? ` — ${t.description.slice(0, 120)}` : '';
    return `  - #${t.id} [${t.status}]${owner} ${t.subject}${desc}`;
  });
  return `\nCurrent task board (pending/in_progress):\n${lines.join('\n')}\n`;
}

function buildProvisioningPrompt(request: TeamCreateRequest): string {
  const displayName = request.displayName?.trim() || request.teamName;
  const description = request.description?.trim() || 'No description';
  const members = buildMembersPrompt(request.members);
  const taskProtocol = buildTaskStatusProtocol(request.teamName);
  const processRegistration = buildProcessRegistrationProtocol(request.teamName);
  const languageInstruction = getAgentLanguageInstruction();
  const agentBlockPolicy = buildAgentBlockUsagePolicy();
  const userPromptBlock = request.prompt?.trim()
    ? `\nAdditional instructions from the user:\n${request.prompt.trim()}\n`
    : '';

  const leadName =
    request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
  const teamCtlOps = buildTeamCtlOpsInstructions(request.teamName, leadName);
  const projectName = path.basename(request.cwd);

  return `Team Start [Agent Team: "${request.teamName}" | Project: "${projectName}" | Lead: "${leadName}"]

You are running in a non-interactive CLI session. Do not ask questions. Do everything in a single turn.
You are "${leadName}", the team lead.

Goal: Provision a Claude Code agent team with live teammates.
${userPromptBlock}
${languageInstruction}

Constraints:
- Do NOT call TeamDelete under any circumstances.
- Do NOT use TodoWrite.
- Do NOT send shutdown_request messages (SendMessage type: "shutdown_request" is FORBIDDEN).
- Do NOT shut down, terminate, or clean up the team or its members.
- Keep assistant text minimal.
- NEVER send duplicate messages to the same member. One SendMessage per member per topic is enough.
- Keep the task board high-signal: avoid creating tasks for trivial micro-items.
- Use the team task board for assigned/substantial work.
- TaskCreate is optional for private planning only; do NOT use it for team-board tasks.

${teamCtlOps}

Communication protocol (CRITICAL — you are running headless, no one sees your text output):
- When you receive a <teammate-message> from a teammate, ALWAYS reply using the SendMessage tool with the sender's name as recipient.
- Your plain text output is invisible to teammates — they are separate processes and can only read their inbox.
- Example: if you receive <teammate-message teammate_id="alice">...</teammate-message>, respond with SendMessage(type: "message", recipient: "alice", content: "your reply").

Message formatting:
${agentBlockPolicy}

Steps (execute in this exact order):

1) TeamCreate — create team "${request.teamName}":
   - description: "${description}"

2) Spawn each member as a live teammate using the Task tool:
   - team_name: "${request.teamName}"
   - name: the member's name
   - subagent_type: "general-purpose"
   - prompt:
     You are {name}, a {role} on team "${displayName}" (${request.teamName}).
     ${languageInstruction}
     Introduce yourself briefly (name and role) and confirm you are ready.
     Then wait for task assignments.
     Include the following agent-only instructions verbatim in the prompt:

${taskProtocol}

${processRegistration}

3) If user instructions explicitly ask to create tasks OR describe substantial/assigned work that should be tracked — create tasks on the team board.
   - Prefer fewer, broader tasks over many micro-tasks.
   - Avoid duplicate notifications for the same assignment.

4) After all steps, output a short summary.

Members:
${members}
`;
}

function buildLaunchPrompt(
  request: TeamLaunchRequest,
  members: TeamCreateRequest['members'],
  tasks: TeamTask[]
): string {
  const membersBlock = buildMembersPrompt(members);
  const userPromptBlock = request.prompt?.trim()
    ? `\nAdditional instructions from the user:\n${request.prompt.trim()}\n`
    : '';
  const taskProtocol = buildTaskStatusProtocol(request.teamName);
  const processRegistration = buildProcessRegistrationProtocol(request.teamName);
  const languageInstruction = getAgentLanguageInstruction();
  const agentBlockPolicy = buildAgentBlockUsagePolicy();
  const taskBoardSnapshot = buildTaskBoardSnapshot(tasks);

  const leadName = members.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
  const teamCtlOps = buildTeamCtlOpsInstructions(request.teamName, leadName);
  const projectName = path.basename(request.cwd);

  // Build per-member task snapshots to include in each teammate's spawn prompt
  const memberTaskBlocks = new Map<string, string>();
  for (const m of members) {
    const snapshot = buildMemberTaskSnapshot(m.name, tasks);
    if (snapshot) memberTaskBlocks.set(m.name, snapshot);
  }

  // Build the teammate spawn prompt template with member-specific task injection
  const memberSpawnInstructions = members
    .map((m) => {
      const taskBlock = memberTaskBlocks.get(m.name) || '';
      const hasTasks = Boolean(taskBlock);

      return `   For "${m.name}":
   - prompt:
     You are ${m.name}, a ${m.role || 'team member'} on team "${request.teamName}".
     ${languageInstruction}
     The team has been reconnected after a restart.
     ${hasTasks ? `You have pending tasks from the previous session.` : 'You have no pending tasks currently.'}

     Your FIRST action: run this command to get your full task briefing with descriptions and comments:
     node "$HOME/.claude/tools/teamctl.js" --team "${request.teamName}" task briefing --for "${m.name}"
     Then resume in_progress tasks first, then pending tasks.
     If you have no tasks, wait for new assignments.`;
    })
    .join('\n\n');

  return `Team Start [Agent Team: "${request.teamName}" | Project: "${projectName}" | Lead: "${leadName}"]

You are running in a non-interactive CLI session. Do not ask questions. Do everything in a single turn.
You are "${leadName}", the team lead.

Goal: Reconnect with existing team "${request.teamName}" and resume pending work.
${userPromptBlock}
${languageInstruction}
${taskBoardSnapshot}
Constraints:
- Do NOT call TeamDelete under any circumstances.
- Do NOT use TodoWrite.
- Do NOT send shutdown_request messages (SendMessage type: "shutdown_request" is FORBIDDEN).
- Do NOT shut down, terminate, or clean up the team or its members.
- Keep assistant text minimal.
- NEVER send duplicate messages to the same member. One SendMessage per member per topic is enough.
- Keep the task board high-signal: avoid creating tasks for trivial micro-items.
- Use the team task board for assigned/substantial work.
- TaskCreate is optional for private planning only; do NOT use it for team-board tasks.

${teamCtlOps}

Communication protocol (CRITICAL — you are running headless, no one sees your text output):
- When you receive a <teammate-message> from a teammate, ALWAYS reply using the SendMessage tool with the sender's name as recipient.
- Your plain text output is invisible to teammates — they are separate processes and can only read their inbox.
- Example: if you receive <teammate-message teammate_id="alice">...</teammate-message>, respond with SendMessage(type: "message", recipient: "alice", content: "your reply").

Message formatting:
${agentBlockPolicy}

Steps (execute in this exact order):

1) Read team config at ~/.claude/teams/${request.teamName}/config.json — understand current team state.

2) Spawn each existing member as a live teammate using the Task tool:
   - team_name: "${request.teamName}"
   - name: the member's name
   - subagent_type: "general-purpose"
   - IMPORTANT: Include each member's pending tasks in their spawn prompt so they resume work immediately.
     Include the following agent-only instructions verbatim in each teammate's prompt:

${taskProtocol}

${processRegistration}

   Per-member spawn instructions:
${memberSpawnInstructions}

3) After spawning all members, check the task board. If any pending tasks are unassigned, assign them to appropriate members using teamctl.

4) After all steps, output a short summary of reconnected members and resumed tasks.

Members:
${membersBlock}
`;
}

function updateProgress(
  run: ProvisioningRun,
  state: Exclude<TeamProvisioningState, 'idle'>,
  message: string,
  extras?: Pick<TeamProvisioningProgress, 'pid' | 'error' | 'warnings' | 'cliLogsTail'>
): TeamProvisioningProgress {
  const assistantOutput =
    run.provisioningOutputParts.length > 0
      ? run.provisioningOutputParts.join('\n\n')
      : run.progress.assistantOutput;
  run.progress = {
    ...run.progress,
    state,
    message,
    updatedAt: nowIso(),
    pid: extras?.pid ?? run.progress.pid,
    error: extras?.error,
    warnings: extras?.warnings,
    cliLogsTail: extras?.cliLogsTail ?? run.progress.cliLogsTail,
    assistantOutput,
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
  const assistantOutput =
    run.provisioningOutputParts.length > 0 ? run.provisioningOutputParts.join('\n\n') : undefined;

  if (!logsTail && !assistantOutput) {
    return;
  }
  run.progress = {
    ...run.progress,
    updatedAt: nowIso(),
    ...(logsTail !== undefined && { cliLogsTail: logsTail }),
    ...(assistantOutput !== undefined && { assistantOutput }),
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

interface CachedProbeResult {
  claudePath: string;
  env: NodeJS.ProcessEnv;
  authSource: ProvisioningAuthSource;
  warning?: string;
}

let cachedProbeResult: CachedProbeResult | null = null;

export class TeamProvisioningService {
  private readonly runs = new Map<string, ProvisioningRun>();
  private readonly activeByTeam = new Map<string, string>();
  private readonly leadInboxRelayInFlight = new Map<string, Promise<number>>();
  private readonly relayedLeadInboxMessageIds = new Map<string, Set<string>>();
  private readonly relayedLeadInboxFallbackKeys = new Map<string, Set<string>>();
  private readonly liveLeadProcessMessages = new Map<string, InboxMessage[]>();
  private teamChangeEmitter: ((event: TeamChangeEvent) => void) | null = null;

  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore()
  ) {}

  setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void {
    this.teamChangeEmitter = emitter;
  }

  getLiveLeadProcessMessages(teamName: string): InboxMessage[] {
    return [...(this.liveLeadProcessMessages.get(teamName) ?? [])];
  }

  getLeadActivityState(teamName: string): 'active' | 'idle' | 'offline' {
    const runId = this.activeByTeam.get(teamName);
    if (!runId) return 'offline';
    const run = this.runs.get(runId);
    if (!run || run.processKilled || run.cancelRequested) return 'offline';
    return run.leadActivityState;
  }

  private setLeadActivity(run: ProvisioningRun, state: 'active' | 'idle' | 'offline'): void {
    if (run.leadActivityState === state) return;
    run.leadActivityState = state;
    this.teamChangeEmitter?.({
      type: 'lead-activity',
      teamName: run.teamName,
      detail: state,
    });
  }

  async warmup(): Promise<void> {
    try {
      const claudePath = await ClaudeBinaryResolver.resolve();
      if (!claudePath) return;
      const { env, authSource } = await this.buildProvisioningEnv();
      const cwd = process.cwd();
      const probe = await this.probeClaudeRuntime(claudePath, cwd, env);
      cachedProbeResult = { claudePath, env, authSource, warning: probe.warning };
      logger.info('CLI warmup completed');
    } catch (error) {
      logger.warn(`CLI warmup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async prepareForProvisioning(cwd?: string): Promise<TeamProvisioningPrepareResult> {
    // Always validate cwd even when cache is available
    const targetCwdForValidation = cwd?.trim() || process.cwd();
    if (targetCwdForValidation && path.isAbsolute(targetCwdForValidation)) {
      await ensureCwdExists(targetCwdForValidation);
    }

    if (cachedProbeResult) {
      const { warning, authSource } = cachedProbeResult;
      const warnings: string[] = [];
      if (warning) warnings.push(warning);
      const isAuthFailure = warning ? this.isAuthFailureWarning(warning) : false;
      return {
        ready: !warning || authSource !== 'none' || !isAuthFailure,
        message: 'CLI is warmed up and ready to launch',
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

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
      const isAuthFailure = this.isAuthFailureWarning(probe.warning);
      if (authSource === 'none' && isAuthFailure) {
        // No auth source + preflight indicates auth failure — block to avoid a confusing hang later.
        return {
          ready: false,
          message: probe.warning,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
      // Preflight warnings (including timeouts) should not block provisioning.
      warnings.push(probe.warning);
    }

    return {
      ready: true,
      message: 'CLI is warmed up and ready to launch',
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private isAuthFailureWarning(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes('not authenticated') ||
      lower.includes('not logged in') ||
      lower.includes('please run /login') ||
      lower.includes('missing api key') ||
      lower.includes('invalid api key')
    );
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
      isLaunch: false,
      fsPhase: 'waiting_config',
      leadRelayCapture: null,
      directReplyParts: [],
      provisioningOutputParts: [],
      detectedSessionId: null,
      leadActivityState: 'active',
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
      child = spawnCli(
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
          '--dangerously-skip-permissions',
          ...(request.model ? ['--model', request.model] : []),
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
    if (child.stdin?.writable) {
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
          killProcessTree(run.child);
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

  async launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    if (this.activeByTeam.has(request.teamName)) {
      throw new Error('Team is already running');
    }

    // Verify config.json exists — team must already be provisioned
    const configPath = path.join(getTeamsBasePath(), request.teamName, 'config.json');
    let configRaw: string;
    try {
      configRaw = await fs.promises.readFile(configPath, 'utf8');
    } catch {
      throw new Error(`Team "${request.teamName}" not found — config.json does not exist`);
    }

    const {
      members: expectedMemberSpecs,
      source,
      warning,
    } = await this.resolveLaunchExpectedMembers(request.teamName, configRaw);
    const expectedMembers = expectedMemberSpecs.map((m) => m.name);

    // Extract leadSessionId for session resume on reconnect.
    // If a valid JSONL file exists for the previous session, we can resume it
    // so the lead retains full context of prior work.
    // When clearContext is true, skip resume entirely to start a fresh session.
    let previousSessionId: string | undefined;
    if (request.clearContext) {
      logger.info(
        `[${request.teamName}] clearContext requested — skipping session resume, starting fresh`
      );
    } else {
      try {
        const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
        if (
          typeof configParsed.leadSessionId === 'string' &&
          configParsed.leadSessionId.trim().length > 0
        ) {
          const candidateId = configParsed.leadSessionId.trim();
          const projectPath =
            typeof configParsed.projectPath === 'string' &&
            configParsed.projectPath.trim().length > 0
              ? configParsed.projectPath.trim()
              : request.cwd;
          const projectId = encodePath(projectPath);
          const baseDir = extractBaseDir(projectId);
          const jsonlPath = path.join(getProjectsBasePath(), baseDir, `${candidateId}.jsonl`);
          if (await this.pathExists(jsonlPath)) {
            previousSessionId = candidateId;
            logger.info(
              `[${request.teamName}] Found previous session JSONL for resume: ${candidateId}`
            );
          } else {
            logger.info(
              `[${request.teamName}] Previous session JSONL not found at ${jsonlPath}, starting fresh`
            );
          }
        }
      } catch {
        logger.debug(
          `[${request.teamName}] Failed to extract leadSessionId from config for resume`
        );
      }
    }

    // IMPORTANT: The CLI auto-suffixes teammate names when they already exist in config.json.
    // Normalize config.json to keep only the team-lead before spawning the CLI, so we get stable names.
    await this.normalizeTeamConfigForLaunch(request.teamName, configRaw);

    let claudePath: string | null;
    try {
      await ensureCwdExists(request.cwd);

      claudePath = await ClaudeBinaryResolver.resolve();
      if (!claudePath) {
        throw new Error('Claude CLI not found; install it or provide a valid path');
      }
    } catch (error) {
      // Restore pre-launch backup so config.json is not left in normalized (lead-only) state
      await this.restorePrelaunchConfig(request.teamName);
      throw error;
    }

    const teamsBasePathsToProbe = getTeamsBasePathsToProbe();
    const runId = randomUUID();
    const startedAt = nowIso();

    // Build a synthetic TeamCreateRequest for reuse by shared infrastructure
    const syntheticRequest: TeamCreateRequest = {
      teamName: request.teamName,
      members: expectedMemberSpecs,
      cwd: request.cwd,
    };

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
      expectedMembers,
      request: syntheticRequest,
      lastLogProgressAt: 0,
      waitingTasksSince: null,
      provisioningComplete: false,
      isLaunch: true,
      fsPhase: 'waiting_members',
      leadRelayCapture: null,
      directReplyParts: [],
      provisioningOutputParts: [],
      detectedSessionId: null,
      leadActivityState: 'active',
      progress: {
        runId,
        teamName: request.teamName,
        state: 'validating',
        message:
          source === 'members-meta'
            ? 'Validating team launch request (members from members.meta.json)'
            : source === 'inboxes'
              ? 'Validating team launch request (members from inboxes)'
              : 'Validating team launch request (fallback members from config.json)',
        startedAt,
        updatedAt: startedAt,
        warnings: warning ? [warning] : undefined,
        cliLogsTail: undefined,
      },
    };

    this.runs.set(runId, run);
    this.activeByTeam.set(request.teamName, runId);
    run.onProgress(run.progress);

    // Read existing tasks to include in teammate prompts for work resumption
    const taskReader = new TeamTaskReader();
    let existingTasks: TeamTask[] = [];
    try {
      existingTasks = await taskReader.getTasks(request.teamName);
    } catch (error) {
      logger.warn(`[${request.teamName}] Failed to read tasks for launch prompt: ${String(error)}`);
    }

    const prompt = buildLaunchPrompt(request, expectedMemberSpecs, existingTasks);
    let child: ReturnType<typeof spawn>;
    const { env: shellEnv, authSource } = await this.buildProvisioningEnv();
    if (authSource === 'none') {
      logger.warn(
        'No explicit auth env var found for `-p` mode (launch). ' +
          'Attempting spawn anyway — CLI may authenticate via apiKeyHelper, SSO, or other mechanism.'
      );
    }
    const launchArgs = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'user,project,local',
      '--disallowedTools',
      'TeamDelete,TodoWrite',
      '--dangerously-skip-permissions',
    ];
    if (previousSessionId) {
      launchArgs.push('--resume', previousSessionId);
      logger.info(
        `[${request.teamName}] Launching with --resume ${previousSessionId} for session continuity`
      );
    }
    if (request.model) {
      launchArgs.push('--model', request.model);
    }
    // New sessions: CLI creates its own ID. No --resume with synthetic name — docs say
    // --resume is for existing sessions and may show an interactive picker if not found.

    try {
      child = spawnCli(claudePath, launchArgs, {
        cwd: request.cwd,
        env: {
          ...shellEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.runs.delete(runId);
      this.activeByTeam.delete(request.teamName);
      await this.restorePrelaunchConfig(request.teamName);
      throw error;
    }

    const resumeHint = previousSessionId ? ' (resuming previous session)' : '';
    updateProgress(run, 'spawning', `Starting Claude CLI process for team launch${resumeHint}`, {
      pid: child.pid ?? undefined,
    });
    run.onProgress(run.progress);
    run.child = child;

    // Send launch prompt
    if (child.stdin?.writable) {
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
            // Not valid JSON
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

    // For launch, skip the filesystem monitor — files (config, inboxes, tasks)
    // already exist from the previous run and would trigger immediate false
    // completion on the first poll. Rely on stream-json result.success instead.
    updateProgress(run, 'monitoring', 'CLI running — reconnecting with teammates');
    run.onProgress(run.progress);

    run.timeoutHandle = setTimeout(() => {
      if (!run.processKilled && !run.provisioningComplete) {
        run.processKilled = true;
        run.finalizingByTimeout = true;
        void (async () => {
          const readyOnTimeout = await this.tryCompleteAfterTimeout(run);
          run.child?.stdin?.end();
          killProcessTree(run.child);
          if (readyOnTimeout) {
            return;
          }

          const progress = updateProgress(run, 'failed', 'Timed out waiting for CLI (launch)', {
            error: 'Timed out waiting for CLI during team launch.',
            cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
          });
          run.onProgress(progress);
          this.cleanupRun(run);
        })();
      }
    }, RUN_TIMEOUT_MS);

    child.once('error', (error) => {
      const progress = updateProgress(run, 'failed', 'Failed to start Claude CLI (launch)', {
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
    killProcessTree(run.child);
    const progress = updateProgress(run, 'cancelled', 'Provisioning cancelled by user');
    run.onProgress(progress);
    this.cleanupRun(run);
  }

  /**
   * Send a message to the team's lead process via stream-json stdin.
   * The lead will receive it as a new user turn and can delegate to teammates.
   */
  async sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: { data: string; mimeType: string }[]
  ): Promise<void> {
    const runId = this.activeByTeam.get(teamName);
    if (!runId) {
      throw new Error(`No active process for team "${teamName}"`);
    }
    const run = this.runs.get(runId);
    if (!run?.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }

    const contentBlocks: Record<string, unknown>[] = [{ type: 'text', text: message }];
    if (attachments?.length) {
      for (const att of attachments) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: att.mimeType,
            data: att.data,
          },
        });
      }
    }

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      },
    });
    run.child.stdin.write(payload + '\n');
    this.setLeadActivity(run, 'active');
  }

  /**
   * Relay unread inbox messages addressed to the team lead into the live lead process.
   *
   * Why: teammates (and the UI) write to `inboxes/<lead>.json`, but the live lead CLI
   * process consumes new turns via stream-json stdin. Without relaying, the lead
   * appears unresponsive to direct messages.
   *
   * Returns the number of messages relayed.
   */
  async relayLeadInboxMessages(teamName: string): Promise<number> {
    const existing = this.leadInboxRelayInFlight.get(teamName);
    if (existing) {
      return existing;
    }

    const work = (async (): Promise<number> => {
      const runId = this.activeByTeam.get(teamName);
      if (!runId) return 0;
      const run = this.runs.get(runId);
      if (!run?.child || run.processKilled || run.cancelRequested) return 0;
      if (!run.provisioningComplete) return 0;

      const relayedIds = this.relayedLeadInboxMessageIds.get(teamName) ?? new Set<string>();
      const relayedFallback = this.relayedLeadInboxFallbackKeys.get(teamName) ?? new Set<string>();

      let config: Awaited<ReturnType<TeamConfigReader['getConfig']>> | null = null;
      try {
        config = await this.configReader.getConfig(teamName);
      } catch {
        return 0;
      }
      if (!config) return 0;

      const leadName =
        config.members?.find((m) => m?.agentType === 'team-lead')?.name?.trim() || 'team-lead';

      let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
      try {
        leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
      } catch {
        return 0;
      }

      const unread = leadInboxMessages
        .filter((m) => {
          if (m.read) return false;
          if (typeof m.text !== 'string' || m.text.trim().length === 0) return false;
          if (typeof m.messageId === 'string' && m.messageId.trim().length > 0) {
            return !relayedIds.has(m.messageId);
          }
          return !relayedFallback.has(`${m.timestamp}\0${m.from}\0${m.text}`);
        })
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

      if (unread.length === 0) return 0;

      const MAX_RELAY = 10;
      const batch = unread.slice(0, MAX_RELAY);

      const message = [
        `You have new inbox messages addressed to you (team lead "${leadName}").`,
        `Process them in order (oldest first).`,
        `If action is required, delegate via task creation or SendMessage, and keep responses minimal.`,
        `IMPORTANT: Your text response here is shown to the user. Always include a brief human-readable summary (e.g. "Delegated to carol." or "No action needed."). Do NOT respond with only an agent-only block.`,
        AGENT_BLOCK_OPEN,
        `Internal note: for task assignments, prefer teamctl.js task create --notify (avoid sending a separate SendMessage for the same assignment).`,
        AGENT_BLOCK_CLOSE,
        ``,
        `Messages:`,
        ...batch.flatMap((m, idx) => {
          const summaryLine = m.summary?.trim() ? `Summary: ${m.summary.trim()}` : null;
          return [
            `${idx + 1}) From: ${m.from || 'unknown'}`,
            `   Timestamp: ${m.timestamp}`,
            ...(summaryLine ? [`   ${summaryLine}`] : []),
            `   Text:`,
            ...m.text.split('\n').map((line) => `   ${line}`),
            ``,
          ];
        }),
      ].join('\n');

      const captureTimeoutMs = 15_000;
      const captureIdleMs = 800;
      const capturePromise = new Promise<string>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          reject(new Error('Timed out waiting for lead reply'));
        }, captureTimeoutMs);
        const capture = {
          leadName,
          startedAt: nowIso(),
          textParts: [] as string[],
          settled: false,
          idleHandle: null as NodeJS.Timeout | null,
          idleMs: captureIdleMs,
          timeoutHandle,
          resolveOnce: (text: string) => {
            if (capture.settled) return;
            capture.settled = true;
            if (capture.idleHandle) {
              clearTimeout(capture.idleHandle);
              capture.idleHandle = null;
            }
            clearTimeout(capture.timeoutHandle);
            resolve(text);
          },
          rejectOnce: (error: string) => {
            if (capture.settled) return;
            capture.settled = true;
            if (capture.idleHandle) {
              clearTimeout(capture.idleHandle);
              capture.idleHandle = null;
            }
            clearTimeout(capture.timeoutHandle);
            reject(new Error(error));
          },
        };
        run.leadRelayCapture = capture;
        // Clear any direct reply parts — relay capture takes priority
        run.directReplyParts = [];
      });

      try {
        await this.sendMessageToTeam(teamName, message);
      } catch {
        if (run.leadRelayCapture) {
          clearTimeout(run.leadRelayCapture.timeoutHandle);
          run.leadRelayCapture = null;
        }
        return 0;
      }

      for (const m of batch) {
        if (typeof m.messageId === 'string' && m.messageId.trim().length > 0) {
          relayedIds.add(m.messageId);
        } else {
          relayedFallback.add(`${m.timestamp}\0${m.from}\0${m.text}`);
        }
      }
      this.relayedLeadInboxMessageIds.set(teamName, this.trimRelayedSet(relayedIds));
      this.relayedLeadInboxFallbackKeys.set(teamName, this.trimRelayedSet(relayedFallback));

      try {
        await this.markInboxMessagesRead(teamName, leadName, batch);
      } catch {
        // Best-effort: relay succeeded; marking read failed.
      }

      let replyText: string | null = null;
      try {
        replyText = (await capturePromise).trim() || null;
      } catch {
        // Best-effort: if we captured some text but never got result.success, keep it.
        const partial = run.leadRelayCapture?.textParts?.join('')?.trim();
        replyText = partial && partial.length > 0 ? partial : null;
      } finally {
        if (run.leadRelayCapture) {
          if (run.leadRelayCapture.idleHandle) {
            clearTimeout(run.leadRelayCapture.idleHandle);
            run.leadRelayCapture.idleHandle = null;
          }
          clearTimeout(run.leadRelayCapture.timeoutHandle);
          run.leadRelayCapture = null;
        }
      }

      // Strip agent-only blocks — lead may respond with pure coordination content
      // that is not meant for the human user.
      const cleanReply = replyText ? stripAgentBlocks(replyText) : null;
      if (cleanReply) {
        this.pushLiveLeadProcessMessage(teamName, {
          from: leadName,
          to: 'user',
          text: cleanReply,
          timestamp: nowIso(),
          read: true,
          summary: cleanReply.length > 60 ? cleanReply.slice(0, 57) + '...' : cleanReply,
          messageId: `lead-process-${runId}-${Date.now()}`,
          source: 'lead_process',
        });
        this.teamChangeEmitter?.({
          type: 'inbox',
          teamName,
          detail: 'lead-process-reply',
        });
      }

      return batch.length;
    })();

    this.leadInboxRelayInFlight.set(teamName, work);
    try {
      return await work;
    } finally {
      if (this.leadInboxRelayInFlight.get(teamName) === work) {
        this.leadInboxRelayInFlight.delete(teamName);
      }
    }
  }

  /**
   * Check if a team has an active provisioning run (started but not yet finished).
   */
  hasProvisioningRun(teamName: string): boolean {
    return this.activeByTeam.has(teamName);
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

  private languageChangeInFlight: Promise<void> = Promise.resolve();

  /**
   * Notify alive teams when the agent language setting changes.
   * Compares each team's stored `config.language` with the new code and sends
   * a message to the team lead if they differ.
   *
   * Serialised: rapid language switches (e.g. ru → en → ru) are queued so that
   * only the latest value is applied to each team.
   */
  async notifyLanguageChange(newLangCode: string): Promise<void> {
    this.languageChangeInFlight = this.languageChangeInFlight.then(() =>
      this.doNotifyLanguageChange(newLangCode)
    );
    return this.languageChangeInFlight;
  }

  private async doNotifyLanguageChange(newLangCode: string): Promise<void> {
    const aliveTeams = this.getAliveTeams();
    if (aliveTeams.length === 0) return;

    const systemLocale = getSystemLocale();
    const newResolved = resolveLanguageName(newLangCode, systemLocale);

    for (const teamName of aliveTeams) {
      try {
        const config = await this.configReader.getConfig(teamName);
        if (!config) continue;

        const oldCode = config.language || 'system';
        if (oldCode === newLangCode) continue;

        // Compare resolved names to avoid spurious notifications
        // e.g. switching from 'ru' to 'system' when system locale is Russian
        const oldResolved = resolveLanguageName(oldCode, systemLocale);
        if (oldResolved === newResolved) {
          // Effective language unchanged — just update stored code silently
          await this.configReader.updateConfig(teamName, { language: newLangCode });
          continue;
        }

        const message =
          `The user has changed the preferred communication language from "${oldResolved}" to "${newResolved}". ` +
          `Please switch to ${newResolved} for all future responses and broadcast this change to all teammates ` +
          `so they also switch to ${newResolved}.`;

        await this.sendMessageToTeam(teamName, message);
        await this.configReader.updateConfig(teamName, { language: newLangCode });
        logger.info(`[${teamName}] Notified about language change: ${oldCode} → ${newLangCode}`);
      } catch (error) {
        logger.warn(
          `[${teamName}] Failed to notify language change: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  private async markInboxMessagesRead(
    teamName: string,
    member: string,
    messages: { messageId?: string; timestamp: string; from: string; text: string }[]
  ): Promise<void> {
    const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${member}.json`);

    await withInboxLock(inboxPath, async () => {
      let raw: string;
      try {
        raw = await fs.promises.readFile(inboxPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;

      const ids = new Set(messages.map((m) => m.messageId).filter((id): id is string => !!id));
      const fallbackKeys = new Set(
        messages.filter((m) => !m.messageId).map((m) => `${m.timestamp}\0${m.from}\0${m.text}`)
      );

      let changed = false;
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const msgId = typeof row.messageId === 'string' ? row.messageId : null;
        const timestamp = typeof row.timestamp === 'string' ? row.timestamp : null;
        const from = typeof row.from === 'string' ? row.from : null;
        const text = typeof row.text === 'string' ? row.text : null;

        const matchesId = msgId ? ids.has(msgId) : false;
        const matchesFallback =
          !msgId && timestamp && from && text
            ? fallbackKeys.has(`${timestamp}\0${from}\0${text}`)
            : false;

        if (!matchesId && !matchesFallback) continue;

        if (row.read !== true) {
          row.read = true;
          changed = true;
        }
      }

      if (!changed) return;
      await atomicWriteAsync(inboxPath, JSON.stringify(parsed, null, 2));
    });
  }

  private trimRelayedSet(set: Set<string>): Set<string> {
    const MAX_IDS = 2000;
    if (set.size <= MAX_IDS) return set;
    const next = new Set<string>();
    const tail = Array.from(set).slice(-MAX_IDS);
    for (const id of tail) next.add(id);
    return next;
  }

  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void {
    const MAX = 100;
    const list = this.liveLeadProcessMessages.get(teamName) ?? [];
    list.push(message);
    if (list.length > MAX) {
      list.splice(0, list.length - MAX);
    }
    this.liveLeadProcessMessages.set(teamName, list);
  }

  /**
   * Stop the running process for a team. No-op if team is not running.
   */
  stopTeam(teamName: string): void {
    const runId = this.activeByTeam.get(teamName);
    if (!runId) {
      return;
    }
    const run = this.runs.get(runId);
    if (!run) {
      this.activeByTeam.delete(teamName);
      return;
    }
    if (run.processKilled || run.cancelRequested) {
      return;
    }
    run.processKilled = true;
    run.cancelRequested = true;
    run.child?.stdin?.end();
    killProcessTree(run.child);
    const progress = updateProgress(run, 'disconnected', 'Team stopped by user');
    run.onProgress(progress);
    this.cleanupRun(run);
    logger.info(`[${teamName}] Process stopped by user`);
  }

  /**
   * Process a parsed stream-json message from stdout.
   * Extracts assistant text for progress reporting and detects turn completion.
   */
  private handleStreamJsonMessage(run: ProvisioningRun, msg: Record<string, unknown>): void {
    // stream-json output has various message types:
    // {"type":"assistant","content":[{"type":"text","text":"..."},...]}
    // {"type":"result","subtype":"success",...}
    if (msg.type === 'assistant') {
      const content = Array.isArray(msg.content)
        ? (msg.content as Record<string, unknown>[])
        : (() => {
            const message = msg.message;
            if (!message || typeof message !== 'object') return null;
            const inner = (message as Record<string, unknown>).content;
            return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : null;
          })();

      const textParts = (content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string);
      if (textParts.length > 0) {
        const text = textParts.join('');
        logger.debug(`[${run.teamName}] assistant: ${text.slice(0, 200)}`);
        // During provisioning (before provisioningComplete), accumulate for live UI preview.
        // Emission is handled by the throttled emitLogsProgress() in the stdout data handler.
        if (!run.provisioningComplete) {
          run.provisioningOutputParts.push(text);
        }

        if (run.leadRelayCapture) {
          const capture = run.leadRelayCapture;
          if (!capture.settled) {
            capture.textParts.push(text);
            if (capture.idleHandle) {
              clearTimeout(capture.idleHandle);
            }
            capture.idleHandle = setTimeout(() => {
              const combined = capture.textParts.join('').trim();
              capture.resolveOnce(combined);
            }, capture.idleMs);
          }
        } else if (run.provisioningComplete) {
          // Accumulate assistant text for direct user→lead messages (no relay capture).
          run.directReplyParts.push(text);
        }
      }
    }

    // Capture session_id from any message type (first occurrence wins)
    if (!run.detectedSessionId) {
      const sid = typeof msg.session_id === 'string' ? msg.session_id : undefined;
      if (sid && sid.trim().length > 0) {
        run.detectedSessionId = sid.trim();
        logger.info(
          `[${run.teamName}] Detected session ID from stream-json: ${run.detectedSessionId}`
        );
      }
    }

    if (msg.type === 'result') {
      const subtype =
        typeof msg.subtype === 'string'
          ? msg.subtype
          : (() => {
              const result = msg.result;
              if (!result || typeof result !== 'object') return undefined;
              const inner = (result as Record<string, unknown>).subtype;
              return typeof inner === 'string' ? inner : undefined;
            })();
      if (subtype === 'success') {
        logger.info(`[${run.teamName}] stream-json result: success — turn complete, process alive`);
        if (run.provisioningComplete) {
          this.setLeadActivity(run, 'idle');
        }
        if (run.leadRelayCapture) {
          const capture = run.leadRelayCapture;
          const combined = capture.textParts.join('').trim();
          capture.resolveOnce(combined);
        } else if (run.provisioningComplete && run.directReplyParts.length > 0) {
          // Flush accumulated assistant reply from direct user→lead message
          const rawReply = run.directReplyParts.join('').trim();
          run.directReplyParts = [];
          const leadName =
            run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
            'team-lead';
          // Strip agent-only blocks — lead may include coordination content not meant for the user
          const replyText = stripAgentBlocks(rawReply);
          if (replyText.length > 0) {
            const replyMsg: InboxMessage = {
              from: leadName,
              to: 'user',
              text: replyText,
              timestamp: nowIso(),
              read: true,
              summary: replyText.length > 60 ? replyText.slice(0, 57) + '...' : replyText,
              messageId: `lead-direct-${run.runId}-${Date.now()}`,
              source: 'lead_process',
            };
            this.pushLiveLeadProcessMessage(run.teamName, replyMsg);
            // Persist to disk so replies survive app restart
            void this.sentMessagesStore
              .appendMessage(run.teamName, replyMsg)
              .catch(() => undefined);
            this.teamChangeEmitter?.({
              type: 'inbox',
              teamName: run.teamName,
              detail: 'lead-direct-reply',
            });
          }
        }
        if (!run.provisioningComplete && !run.cancelRequested) {
          void this.handleProvisioningTurnComplete(run);
        }
      } else if (subtype === 'error') {
        const errorMsg =
          typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error ?? 'unknown');
        logger.warn(`[${run.teamName}] stream-json result: error — ${errorMsg}`);
        if (run.leadRelayCapture) {
          run.leadRelayCapture.rejectOnce(errorMsg);
        }
        if (!run.provisioningComplete && !run.cancelRequested) {
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
          killProcessTree(run.child);
          this.cleanupRun(run);
        } else if (run.provisioningComplete) {
          // Post-provisioning error: process alive, waiting for input
          this.setLeadActivity(run, 'idle');
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
    // Guard: must be set synchronously BEFORE any await to prevent
    // double-invocation from filesystem monitor + stream-json racing.
    if (run.provisioningComplete || run.cancelRequested) return;
    run.provisioningComplete = true;
    this.setLeadActivity(run, 'idle');

    // Clear provisioning timeout — no longer needed
    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
    this.stopFilesystemMonitor(run);

    if (run.isLaunch) {
      await this.updateConfigPostLaunch(run.teamName, run.request.cwd, run.detectedSessionId);
      await this.cleanupPrelaunchBackup(run.teamName);
      const readyMessage = 'Team launched — process alive and ready';
      const progress = updateProgress(run, 'ready', readyMessage, {
        cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
      });
      run.onProgress(progress);
      logger.info(`[${run.teamName}] Launch complete. Process alive for subsequent tasks.`);

      // Pick up any direct messages that arrived before/while reconnecting.
      void this.relayLeadInboxMessages(run.teamName).catch(() => undefined);
      return;
    }

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
      killProcessTree(run.child);
      this.cleanupRun(run);
      return;
    }

    // Persist teammates metadata separately from config.json.
    await this.persistMembersMeta(run.teamName, run.request);
    await this.updateConfigPostLaunch(run.teamName, run.request.cwd, run.detectedSessionId);

    const progress = updateProgress(run, 'ready', 'Team provisioned — process alive and ready', {
      cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
    });
    run.onProgress(progress);
    // NOTE: do NOT remove from activeByTeam — process stays alive
    logger.info(`[${run.teamName}] Provisioning complete. Process alive for subsequent tasks.`);

    // Pick up any direct messages that arrived during provisioning.
    void this.relayLeadInboxMessages(run.teamName).catch(() => undefined);
  }

  /**
   * Remove a run from tracking maps.
   */
  private cleanupRun(run: ProvisioningRun): void {
    this.setLeadActivity(run, 'offline');
    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
    this.stopFilesystemMonitor(run);
    // Remove stream listeners to prevent data handlers firing on a cleaned-up run
    if (run.child) {
      run.child.stdout?.removeAllListeners('data');
      run.child.stderr?.removeAllListeners('data');
    }
    this.activeByTeam.delete(run.teamName);
    this.leadInboxRelayInFlight.delete(run.teamName);
    this.relayedLeadInboxMessageIds.delete(run.teamName);
    this.relayedLeadInboxFallbackKeys.delete(run.teamName);
    this.liveLeadProcessMessages.delete(run.teamName);
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
            // Mark provisioning complete early — files are on disk,
            // no need to wait for stream-json result.success.
            // The process stays alive for subsequent tasks.
            if (!run.provisioningComplete) {
              void this.handleProvisioningTurnComplete(run);
            }
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
      if (!run.isLaunch) {
        await this.persistMembersMeta(run.teamName, run.request);
      }
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

    if (!run.isLaunch) {
      await this.persistMembersMeta(run.teamName, run.request);
    }
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
    // getHomeDir() uses Electron's app.getPath('home') which handles Unicode
    // correctly on Windows. Prefer it over process.env which may be garbled.
    const electronHome = getHomeDir();
    const home = shellEnv.HOME?.trim() || electronHome;
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
      USERPROFILE: home,
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
   * Single atomic read-mutate-write for post-launch config updates.
   * Combines session history append and projectPath update to avoid
   * race conditions with the CLI writing to the same file.
   */
  private async updateConfigPostLaunch(
    teamName: string,
    projectPath: string,
    detectedSessionId: string | null
  ): Promise<void> {
    const MAX_SESSION_HISTORY = 5000;
    const MAX_PROJECT_PATH_HISTORY = 500;
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      const config = JSON.parse(raw) as Record<string, unknown>;

      const sessionHistory = Array.isArray(config.sessionHistory)
        ? (config.sessionHistory as string[])
        : [];

      // Preserve old leadSessionId in history before overwriting
      const oldLeadSessionId = config.leadSessionId;
      if (typeof oldLeadSessionId === 'string' && oldLeadSessionId.trim().length > 0) {
        if (!sessionHistory.includes(oldLeadSessionId)) {
          sessionHistory.push(oldLeadSessionId);
        }
      }

      // Update leadSessionId to the new session detected from stream-json
      let newSessionId = detectedSessionId;

      // Fallback: if stream-json didn't provide session_id, scan project dir for newest JSONL
      if (!newSessionId && projectPath.trim()) {
        const scannedId = await this.scanForNewestSession(projectPath, sessionHistory);
        if (scannedId) {
          newSessionId = scannedId;
          logger.info(`[${teamName}] Detected new session via project dir scan: ${scannedId}`);
        }
      }

      if (newSessionId) {
        config.leadSessionId = newSessionId;
        if (!sessionHistory.includes(newSessionId)) {
          sessionHistory.push(newSessionId);
        }
        logger.info(`[${teamName}] Updated leadSessionId: ${newSessionId}`);
      }

      if (sessionHistory.length > MAX_SESSION_HISTORY) {
        config.sessionHistory = sessionHistory.slice(-MAX_SESSION_HISTORY);
      } else {
        config.sessionHistory = sessionHistory;
      }

      // Save current language setting
      const langCode = ConfigManager.getInstance().getConfig().general.agentLanguage || 'system';
      config.language = langCode;

      // Ensure projectPath
      if (projectPath.trim()) {
        config.projectPath = projectPath;
        const pathHistory = Array.isArray(config.projectPathHistory)
          ? (config.projectPathHistory as string[]).filter(
              (p) => typeof p === 'string' && p !== projectPath
            )
          : [];
        pathHistory.push(projectPath);
        config.projectPathHistory =
          pathHistory.length > MAX_PROJECT_PATH_HISTORY
            ? pathHistory.slice(-MAX_PROJECT_PATH_HISTORY)
            : pathHistory;
      }

      await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to update config post-launch: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Fallback: scan the project directory for the newest JSONL file
   * that isn't already in sessionHistory. Returns the session ID or null.
   */
  private async scanForNewestSession(
    projectPath: string,
    knownSessions: string[]
  ): Promise<string | null> {
    try {
      const projectId = encodePath(projectPath);
      const baseDir = extractBaseDir(projectId);
      const projectDir = path.join(getProjectsBasePath(), baseDir);
      const entries = await fs.promises.readdir(projectDir);

      const knownSet = new Set(knownSessions);
      let newest: { id: string; mtime: number } | null = null;

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const sessionId = entry.replace('.jsonl', '');
        if (knownSet.has(sessionId)) continue;

        const filePath = path.join(projectDir, entry);
        const stat = await fs.promises.stat(filePath);
        if (!newest || stat.mtimeMs > newest.mtime) {
          newest = { id: sessionId, mtime: stat.mtimeMs };
        }
      }

      return newest?.id ?? null;
    } catch {
      return null;
    }
  }

  private async normalizeTeamConfigForLaunch(teamName: string, configRaw: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const backupPath = `${configPath}.prelaunch.bak`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(configRaw) as unknown;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const config = parsed as Record<string, unknown>;
    const members = Array.isArray(config.members)
      ? (config.members as Record<string, unknown>[])
      : [];
    if (members.length === 0) {
      return;
    }

    // Keep only the lead entry.
    const leadMembers = members.filter((member) => {
      const agentType = member.agentType;
      if (typeof agentType === 'string' && agentType === 'team-lead') {
        return true;
      }
      const leadAgentId = config.leadAgentId;
      return (
        typeof leadAgentId === 'string' &&
        typeof member.agentId === 'string' &&
        member.agentId === leadAgentId
      );
    });

    // If already lead-only, no-op.
    if (leadMembers.length === members.length) {
      return;
    }

    // Try to determine base teammate names for inbox cleanup (prefer meta).
    const baseNames = new Set<string>();
    try {
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      for (const member of metaMembers) {
        const name = member.name.trim();
        if (name.length > 0) baseNames.add(name);
      }
    } catch {
      // ignore
    }
    if (baseNames.size === 0) {
      for (const member of members) {
        const name = typeof member.name === 'string' ? member.name.trim() : '';
        const agentType = typeof member.agentType === 'string' ? member.agentType : '';
        if (name && agentType && agentType !== 'team-lead' && !/-\d+$/.test(name)) {
          baseNames.add(name);
        }
      }
    }

    // Backup current config on disk for crash recovery / debugging.
    try {
      await atomicWriteAsync(backupPath, configRaw);
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to write config prelaunch backup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Write normalized config atomically.
    config.members = leadMembers;
    try {
      await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
      logger.info(
        `[${teamName}] Normalized config.json for launch: kept ${leadMembers.length} lead member(s)`
      );
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to normalize config.json for launch: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    // Best-effort: merge and remove suffixed inboxes like alice-2.json to avoid UI duplicates.
    await this.mergeAndRemoveDuplicateInboxes(teamName, baseNames);
  }

  /**
   * Restore config.json from prelaunch backup if launch fails after normalization.
   */
  private async restorePrelaunchConfig(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const backupPath = `${configPath}.prelaunch.bak`;
    try {
      const backupRaw = await fs.promises.readFile(backupPath, 'utf8');
      await atomicWriteAsync(configPath, backupRaw);
      logger.info(`[${teamName}] Restored config.json from prelaunch backup after launch failure`);
    } catch {
      logger.debug(`[${teamName}] No prelaunch backup to restore (or read failed)`);
    }
  }

  /**
   * Remove the prelaunch backup file after a successful launch.
   */
  async cleanupPrelaunchBackup(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const backupPath = `${configPath}.prelaunch.bak`;
    try {
      await fs.promises.unlink(backupPath);
    } catch {
      // Backup may not exist — that's fine
    }
  }

  private async mergeAndRemoveDuplicateInboxes(
    teamName: string,
    baseNames: Set<string>
  ): Promise<void> {
    if (baseNames.size === 0) return;

    const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');
    let entries: string[];
    try {
      entries = await fs.promises.readdir(inboxDir);
    } catch {
      return;
    }

    const existing = new Set(entries.filter((e) => e.endsWith('.json') && !e.startsWith('.')));

    for (const baseName of baseNames) {
      const canonicalFile = `${baseName}.json`;
      if (!existing.has(canonicalFile)) {
        continue;
      }

      const duplicates = Array.from(existing)
        .filter((file) => file.startsWith(`${baseName}-`) && file.endsWith('.json'))
        .filter((file) => /-\d+\.json$/.test(file));

      if (duplicates.length === 0) {
        continue;
      }

      const canonicalPath = path.join(inboxDir, canonicalFile);
      let canonicalRaw: string;
      try {
        canonicalRaw = await fs.promises.readFile(canonicalPath, 'utf8');
      } catch {
        // If cannot read, skip cleanup for this base.
        continue;
      }

      let canonicalParsed: unknown;
      try {
        canonicalParsed = JSON.parse(canonicalRaw) as unknown;
      } catch {
        canonicalParsed = [];
      }
      const canonicalList = Array.isArray(canonicalParsed) ? (canonicalParsed as unknown[]) : [];

      const merged = [...canonicalList];
      for (const dupFile of duplicates) {
        const dupPath = path.join(inboxDir, dupFile);
        let dupRaw: string;
        try {
          dupRaw = await fs.promises.readFile(dupPath, 'utf8');
        } catch {
          continue;
        }

        let dupParsed: unknown;
        try {
          dupParsed = JSON.parse(dupRaw) as unknown;
        } catch {
          dupParsed = [];
        }
        if (Array.isArray(dupParsed)) {
          const dupList = dupParsed as unknown[];
          merged.push(...dupList);
        }
      }

      // Dedup by messageId when available, then sort by timestamp desc.
      const dedupById = new Map<string, unknown>();
      const noId: unknown[] = [];
      for (const item of merged) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const msg = item as { messageId?: unknown };
        if (typeof msg.messageId === 'string' && msg.messageId.trim().length > 0) {
          dedupById.set(msg.messageId, item);
        } else {
          noId.push(item);
        }
      }
      const mergedDeduped = [...Array.from(dedupById.values()), ...noId];
      mergedDeduped.sort((a, b) => {
        const at =
          a && typeof a === 'object'
            ? Date.parse((a as { timestamp?: string }).timestamp ?? '')
            : NaN;
        const bt =
          b && typeof b === 'object'
            ? Date.parse((b as { timestamp?: string }).timestamp ?? '')
            : NaN;
        const atNaN = Number.isNaN(at);
        const btNaN = Number.isNaN(bt);
        if (atNaN && btNaN) return 0;
        if (atNaN) return 1;
        if (btNaN) return -1;
        return bt - at;
      });

      try {
        await atomicWriteAsync(canonicalPath, JSON.stringify(mergedDeduped, null, 2));
      } catch {
        continue;
      }

      for (const dupFile of duplicates) {
        try {
          await fs.promises.unlink(path.join(inboxDir, dupFile));
          existing.delete(dupFile);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  private async persistMembersMeta(teamName: string, request: TeamCreateRequest): Promise<void> {
    const teammateMembers = request.members.filter((member) => member.name.trim().length > 0);
    if (teammateMembers.length === 0) {
      return;
    }

    const joinedAt = Date.now();

    try {
      await this.membersMetaStore.writeMembers(
        teamName,
        teammateMembers.map((member, index) => ({
          name: member.name,
          role: member.role?.trim() || undefined,
          agentType: 'general-purpose',
          color: getMemberColor(index),
          joinedAt,
        }))
      );
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to persist members.meta.json: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async resolveLaunchExpectedMembers(
    teamName: string,
    configRaw: string
  ): Promise<{
    members: TeamCreateRequest['members'];
    source: 'members-meta' | 'inboxes' | 'config-fallback';
    warning?: string;
  }> {
    try {
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      const byName = new Map<string, TeamCreateRequest['members'][number]>();
      for (const member of metaMembers) {
        const name = member.name?.trim();
        if (!name) continue;
        const role = typeof member.role === 'string' ? member.role.trim() || undefined : undefined;
        const prev = byName.get(name);
        if (!prev) {
          byName.set(name, { name, role });
        } else if (!prev.role && role) {
          byName.set(name, { ...prev, role });
        }
      }
      const members = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
      if (members.length > 0) {
        return { members, source: 'members-meta' };
      }
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to read members.meta.json: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    try {
      const inboxNames = Array.from(
        new Set(
          (await this.inboxReader.listInboxNames(teamName))
            .map((name) => name.trim())
            .filter((name) => name.length > 0)
        )
      );
      if (inboxNames.length > 0) {
        const members = inboxNames.map((name) => ({ name }));
        return { members, source: 'inboxes' };
      }
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to read inbox member names: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const configMembers = this.extractTeammateSpecsFromConfig(teamName, configRaw);
    if (configMembers.length > 0) {
      return {
        members: configMembers,
        source: 'config-fallback',
        warning:
          'members.meta.json and inboxes are empty; launch fell back to config.json members. ' +
          'Run a fresh team bootstrap to persist stable member metadata.',
      };
    }

    return {
      members: [],
      source: 'config-fallback',
      warning:
        'No teammate roster found in members.meta.json, inboxes, or config.json. Launch will continue without explicit teammate names.',
    };
  }

  private extractTeammateSpecsFromConfig(
    teamName: string,
    configRaw: string
  ): TeamCreateRequest['members'] {
    try {
      const parsed = JSON.parse(configRaw) as { members?: { name?: string; agentType?: string }[] };
      if (!Array.isArray(parsed.members)) {
        return [];
      }
      const byName = new Map<string, TeamCreateRequest['members'][number]>();
      for (const member of parsed.members) {
        if (!member || member.agentType === 'team-lead') continue;
        const name = typeof member.name === 'string' ? member.name.trim() : '';
        if (!name) continue;
        byName.set(name, { name });
      }
      return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      logger.warn(`[${teamName}] Failed to parse config.json for launch fallback members`);
      return [];
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
    let pingProbe: { exitCode: number | null; stdout: string; stderr: string } | null = null;
    try {
      pingProbe = await this.spawnProbe(
        claudePath,
        ['-p', 'Reply with the single word PONG and nothing else', '--output-format', 'text'],
        cwd,
        env,
        PREFLIGHT_TIMEOUT_MS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        warning:
          'Preflight check for `claude -p` did not complete. ' +
          `Proceeding anyway. Details: ${message}`,
      };
    }

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
      const child = spawnCli(claudePath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timeoutHandle = setTimeout(() => {
        killProcessTree(child);
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
