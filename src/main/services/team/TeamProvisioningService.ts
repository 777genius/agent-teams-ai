/* eslint-disable no-param-reassign -- ProvisioningRun object is intentionally mutated as a state tracker throughout the provisioning lifecycle */
import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { killProcessTree, spawnCli } from '@main/utils/childProcess';
import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
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
import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';
import { createLogger } from '@shared/utils/logger';
import { createCliAutoSuffixNameGuard } from '@shared/utils/teamMemberName';
import { extractToolPreview, formatToolSummaryFromCalls } from '@shared/utils/toolSummary';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  LeadContextUsage,
  TeamChangeEvent,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamProvisioningState,
  TeamTask,
  ToolApprovalEvent,
  ToolApprovalRequest,
  ToolCallMeta,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const RUN_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_POLL_MS = 500;
const STDERR_RING_LIMIT = 64 * 1024;
const STDOUT_RING_LIMIT = 64 * 1024;
const LOG_PROGRESS_THROTTLE_MS = 300;
const UI_LOGS_TAIL_LIMIT = 128 * 1024;
const PROBE_CACHE_TTL_MS = 36 * 60 * 60 * 1000;
const PREFLIGHT_TIMEOUT_MS = 60000;
const PREFLIGHT_AUTH_RETRY_DELAY_MS = 2000;
const PREFLIGHT_AUTH_MAX_RETRIES = 2;
const FS_MONITOR_POLL_MS = 2000;
const TASK_WAIT_FALLBACK_MS = 15_000;
const TEAM_JSON_READ_TIMEOUT_MS = 5_000;
const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;
const TEAM_INBOX_MAX_BYTES = 2 * 1024 * 1024;
const PREFLIGHT_PING_PROMPT = 'Output only the single word PONG.';
const PREFLIGHT_PING_ARGS = [
  '-p',
  PREFLIGHT_PING_PROMPT,
  '--output-format',
  'text',
  '--model',
  'haiku',
  '--max-turns',
  '1',
  '--no-session-persistence',
] as const;
const PREFLIGHT_EXPECTED = 'PONG';

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
  /** Rolling buffer of CLI log lines (oldest -> newest). */
  claudeLogLines: string[];
  /** Last stream used for claudeLogLines markers. */
  lastClaudeLogStream: 'stdout' | 'stderr' | null;
  /** Carry buffer for stdout line splitting (CLI output). */
  stdoutLogLineBuf: string;
  /** Carry buffer for stderr line splitting (CLI output). */
  stderrLogLineBuf: string;
  /** ISO timestamp when the last CLI line was recorded. */
  claudeLogsUpdatedAt?: string;
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
  /** Monotonic counter for individual lead assistant messages. */
  leadMsgSeq: number;
  /** Accumulated tool_use details between text messages. */
  pendingToolCalls: ToolCallMeta[];
  /** Throttle timestamp for emitting inbox refresh events for lead text. */
  lastLeadTextEmitMs: number;
  /**
   * When set, the current stdin-injected turn is an internal "forward user DM to teammate"
   * request triggered by the UI. We suppress any lead→user echo for that turn.
   */
  silentUserDmForward: { target: string; startedAt: string } | null;
  /** Safety valve: clears silentUserDmForward if turn never completes. */
  silentUserDmForwardClearHandle: NodeJS.Timeout | null;
  /** Accumulates assistant text during provisioning phase for live UI preview. */
  provisioningOutputParts: string[];
  /** Session ID detected from stream-json output (result.session_id or message.session_id). */
  detectedSessionId: string | null;
  /** Lead process activity: 'active' during turn processing, 'idle' waiting for input, 'offline' after exit. */
  leadActivityState: LeadActivityState;
  /** Whether an auth failure retry was already attempted for this run. */
  authFailureRetried: boolean;
  /** Set to true while auth-failure respawn is in progress to prevent duplicate handling. */
  authRetryInProgress: boolean;
  /** Tracks lead process context window usage from stream-json usage data. */
  leadContextUsage: {
    currentTokens: number;
    contextWindow: number;
    lastUsageMessageId: string | null;
    lastEmittedAt: number;
  } | null;
  /** Saved spawn context for auth-failure respawn. */
  spawnContext: {
    claudePath: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    prompt: string;
  } | null;
  /** Pending tool approval requests awaiting user response (control_request protocol). */
  pendingApprovals: Map<string, ToolApprovalRequest>;
  /**
   * Post-compact context reinjection lifecycle.
   * - pendingPostCompactReminder: compact_boundary was received; waiting for idle to inject.
   * - postCompactReminderInFlight: the reminder turn has been injected via stdin, waiting for result.
   * - suppressPostCompactReminderOutput: true while processing a reminder turn — suppress
   *   low-value acknowledgement text so the user doesn't see "OK, I'll remember that."
   */
  pendingPostCompactReminder: boolean;
  postCompactReminderInFlight: boolean;
  suppressPostCompactReminderOutput: boolean;
}

type LeadActivityState = 'active' | 'idle' | 'offline';

type ProvisioningAuthSource = 'anthropic_api_key' | 'anthropic_auth_token' | 'none';

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

async function tryReadRegularFileUtf8(
  filePath: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }

  if (!stat.isFile() || stat.size > opts.maxBytes) {
    return null;
  }

  try {
    return await readFileUtf8WithTimeout(filePath, opts.timeoutMs);
  } catch (error) {
    if (error instanceof FileReadTimeoutError) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
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

function indentMultiline(text: string, indent: string): string {
  return text
    .split(/\r?\n/g)
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function formatWorkflowBlock(workflow: string, indent: string): string {
  const trimmed = workflow.trim();
  if (trimmed.length === 0) return '';
  const body = indentMultiline(trimmed, indent);
  return `\n${indent}---BEGIN WORKFLOW---\n${body}\n${indent}---END WORKFLOW---`;
}

function buildMembersPrompt(members: TeamCreateRequest['members']): string {
  return members
    .map((member) => {
      const rolePart = member.role?.trim() ? ` (role: ${member.role.trim()})` : '';
      const workflowPart = member.workflow?.trim()
        ? `\n     Workflow/instructions:${formatWorkflowBlock(member.workflow, '       ')}`
        : '';
      return `- ${member.name}${rolePart}${workflowPart}`;
    })
    .join('\n');
}

/** Compact roster: name + role only, no workflow details. Used for post-compact reminders. */
function buildCompactMembersRoster(members: TeamCreateRequest['members']): string {
  return members
    .map((member) => {
      const rolePart = member.role?.trim() ? ` (${member.role.trim()})` : '';
      return `- ${member.name}${rolePart}`;
    })
    .join('\n');
}

function buildMemberSpawnPrompt(
  member: TeamCreateRequest['members'][number],
  displayName: string,
  teamName: string,
  taskProtocol: string,
  processRegistration: string
): string {
  const role = member.role?.trim() || 'team member';
  const workflowBlock = member.workflow?.trim()
    ? `\n\nYour workflow and how you should behave:${formatWorkflowBlock(member.workflow, '')}`
    : '';
  return `You are ${member.name}, a ${role} on team "${displayName}" (${teamName}).${workflowBlock}

${getAgentLanguageInstruction()}
Introduce yourself briefly (name and role) and confirm you are ready.
Then wait for task assignments.
Include the following agent-only instructions verbatim in the prompt:

${taskProtocol}

${processRegistration}`;
}

function buildTaskStatusProtocol(teamName: string): string {
  return wrapInAgentBlock(`MANDATORY TASK STATUS PROTOCOL — you MUST follow this for EVERY task:
1. Use this command to mark task started:
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task start <taskId>
   - Start the task ONLY when you are actually beginning work on it.
   - Do NOT start multiple tasks at once unless the team lead explicitly directs parallel work.
2. Use this command to mark task completed BEFORE sending your final reply:
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task complete <taskId>
3. If you are asked to review and task is accepted, move it to APPROVED (not DONE):
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" review approve <taskId>
4. If review fails and changes are needed:
   node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" review request-changes <taskId> --comment "<what to fix>"
5. NEVER skip status updates. A task is NOT done until completed status is written.
   - Never "bulk-complete" a batch of tasks at the end. Update status incrementally as you work.
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
11. DEPENDENCY AWARENESS:
    When your task has blockedBy dependencies, check if they are completed before starting.
    When you complete a task that blocks others, mention this in your completion message so blocked teammates can proceed.
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
      `Execution discipline (CRITICAL — prevents misleading task boards):`,
      `- Start a task (move to in_progress) ONLY when you are actually beginning work on it.`,
      `- Complete a task ONLY when it is truly finished (and any required verification is done).`,
      `- Never bulk-move many tasks at the end of a session — update status incrementally as you work.`,
      `- Record meaningful progress, decisions, and blockers as task comments so context is preserved on the board.`,
      ``,
      `Parallelization guideline (IMPORTANT):`,
      `- If a task is genuinely parallelizable, split it into multiple smaller tasks owned by different members.`,
      `  - Prefer splitting by independent deliverables (e.g. frontend/backend, API/UI, parsing/rendering, tests/docs) rather than arbitrary slices.`,
      `  - Use --blocked-by only when one piece truly cannot start without another; otherwise link with --related.`,
      `  - Do NOT split when work is inherently sequential, requires one person to keep consistent context, or the overhead would exceed the benefit.`,
      `  - When splitting, make each task have a clear completion criterion and a single accountable owner.`,
      ``,
      `IMPORTANT: teamctl.js only supports these domains: task, kanban, review, message, process. There is NO "member" domain — team members are managed by spawning teammates via the Task tool, not via teamctl.`,
      ``,
      `Task board operations — use teamctl.js via Bash:`,
      `- Create task: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task create --subject "..." --description "..." --owner "<actual-member-name>" --notify --from "${leadName}"`,
      `- Assign/reassign owner: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-owner <id> <member-name> --notify --from "${leadName}"`,
      `- Clear owner: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-owner <id> clear`,
      `- Start task (preferred over set-status): node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task start <id>`,
      `- Complete task (preferred over set-status): node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task complete <id>`,
      `- Update status: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task set-status <id> <pending|in_progress|completed|deleted>`,
      `- Add comment: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task comment <id> --text "..." --from "${leadName}"`,
      `- Attach file to task: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task attach <id> --file "<path>" [--mode copy|link] [--filename "<name>"] [--mime-type "<type>"]`,
      `- Attach file to a specific comment:`,
      `  1) Find commentId: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task get <id>`,
      `  2) Attach: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task comment-attach <id> <commentId> --file "<path>" [--mode copy|link] [--filename "<name>"] [--mime-type "<type>"]`,
      `- Create with deps (blocked work MUST be pending): node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task create --subject "..." --blocked-by 1,2 --related 3 --status pending --owner "<member>" --notify --from "${leadName}"`,
      `- Link dependency: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task link <id> --blocked-by <targetId>`,
      `- Link related: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task link <id> --related <targetId>`,
      `- Unlink: node "$HOME/.claude/tools/teamctl.js" --team "${teamName}" task unlink <id> --blocked-by <targetId>`,
      ``,
      `Attachment storage modes (IMPORTANT):`,
      `- Default is copy (safe, robust).`,
      `- Use --mode link to try a hardlink (no duplication). It may fall back to copy unless you add --no-fallback.`,
      ``,
      `Dependency guidelines:`,
      `- Use --blocked-by when a task cannot start until another is done.`,
      `- If you set --blocked-by, create the task in pending (use --status pending). Do NOT put blocked tasks into in_progress.`,
      `- Use --related to link related work (e.g. frontend + backend) without blocking.`,
      `- Review tasks: Prefer NOT creating a separate "review task". Reviews apply to the work task (#X) via: review approve/request-changes #X.`,
      `  - If you must create a separate review reminder/assignment task, keep it pending and link it to #X with --related (and optionally --blocked-by #X if it truly cannot start yet).`,
      `  - Dependencies do not auto-start tasks; the owner must explicitly start it when ready.`,
      `- Avoid over-specifying. Only add dependencies when execution order matters.`,
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

/**
 * Builds the durable lead context — constraints, communication protocol, teamctl ops,
 * and agent block policy — that must survive context compaction.
 *
 * Used by: buildProvisioningPrompt, buildLaunchPrompt, and post-compact reinjection.
 */
function buildPersistentLeadContext(opts: {
  teamName: string;
  leadName: string;
  isSolo: boolean;
  members: TeamCreateRequest['members'];
  /** When true, emit a compact roster (name + role only, no workflows). Used for post-compact reminders. */
  compact?: boolean;
}): string {
  const { teamName, leadName, isSolo, members, compact } = opts;
  const languageInstruction = getAgentLanguageInstruction();
  const agentBlockPolicy = buildAgentBlockUsagePolicy();
  const teamCtlOps = buildTeamCtlOpsInstructions(teamName, leadName);

  const soloConstraint = isSolo
    ? `\n- SOLO MODE: This team CURRENTLY has ZERO teammates.` +
      `\n  - FORBIDDEN (until teammates exist): Do NOT spawn teammates via the Task tool with a team_name parameter — there are no teammates to spawn yet.` +
      `\n  - FORBIDDEN (until teammates exist): Do NOT call SendMessage to any teammate name — no teammates exist yet.` +
      `\n  - ALLOWED: You may message "user" (the human operator) via SendMessage.` +
      `\n  - ALLOWED: You may use the Task tool for regular subagents WITHOUT team_name — these are normal Claude Code helpers, not teammates.` +
      `\n  - If teammates are added later (e.g. via UI), you may then spawn them using the Task tool with team_name + name.` +
      `\n  - Work on tasks directly yourself. Use subagents for research and parallel work as needed.` +
      `\n  - PROGRESS REPORTING (MANDATORY): Since you have no teammates, "user" is your only communication channel.` +
      `\n    - SendMessage "user" at minimum: when you start a task (after marking it in_progress), when you complete a task, and when you hit a meaningful milestone/blocker/decision.` +
      `\n    - Avoid long silent stretches. If something is taking longer than expected, send a brief update and the next step.` +
      `\n  - TASK STATUS DISCIPLINE (MANDATORY):` +
      `\n    - Only move a task to in_progress when you are actively starting work on it.` +
      `\n    - Only move a task to completed when it is truly finished.` +
      `\n    - Never bulk-move many tasks at the end — update status incrementally as you work.` +
      `\n    - Default to working ONE task at a time (keep at most one task in_progress in solo mode), unless you explicitly need parallel background work (in that case explain why to "user").` +
      `\n    - Record meaningful progress/decisions as task comments so the task board stays accurate and high-signal.`
    : '';

  const membersBlock = compact ? buildCompactMembersRoster(members) : buildMembersPrompt(members);
  const membersFooter = membersBlock
    ? `Members:\n${membersBlock}`
    : 'Members: (none — solo team lead)';

  return `${languageInstruction}

Constraints:
- Do NOT call TeamDelete under any circumstances.
- Do NOT use TodoWrite.
- Do NOT send shutdown_request messages (SendMessage type: "shutdown_request" is FORBIDDEN).
- Do NOT shut down, terminate, or clean up the team or its members.
- Do NOT spawn or create a member named "user". "user" is a reserved system name for the human operator — it is NOT a teammate.
- Keep assistant text minimal.
- NEVER send duplicate messages to the same member. One SendMessage per member per topic is enough.
- Keep the task board high-signal: avoid creating tasks for trivial micro-items.
- Use the team task board for assigned/substantial work.
- DELEGATION-FIRST (behavior rule for ALL future turns): When "user" gives you work, your top priority is to (a) decompose into tasks, (b) create tasks on the team board, (c) assign them to teammates, and (d) SendMessage "user" a short confirmation (task IDs + owners). Do NOT start implementing yourself unless the team is truly in SOLO MODE (no teammates).
- TaskCreate is optional for private planning only; do NOT use it for team-board tasks.
- When messaging "user" (the human): NEVER mention teamctl.js, internal scripts, CLI commands, or file paths under ~/.claude/. The user sees messages in the UI — write plain human language. If a task needs a status update, do it yourself via Bash; never ask the user to run a command.${soloConstraint}

${teamCtlOps}

Communication protocol (CRITICAL — you are running headless, no one sees your text output):
- When you receive a <teammate-message> from a teammate, ALWAYS reply using the SendMessage tool with the sender's name as recipient.
- Your plain text output is invisible to teammates — they are separate processes and can only read their inbox.
- Example: if you receive <teammate-message teammate_id="alice">...</teammate-message>, respond with SendMessage(type: "message", recipient: "alice", content: "your reply").

Message formatting:
${agentBlockPolicy}

${membersFooter}`;
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
- CRITICAL: Messages to "user" must NEVER mention internal tooling, scripts, or CLI commands — not even in plain text. The user interacts through the UI, NOT the terminal. Specifically, NEVER include in user-facing messages:
  - teamctl.js commands or references
  - any node/bash commands (e.g. node "$HOME/.claude/tools/...")
  - internal file paths (~/.claude/tools/, ~/.claude/teams/, etc.)
  - instructions to run commands in terminal
  Instead, describe the action in human-friendly language (e.g. "Task #6 is complete." instead of showing a command to mark it complete). If you need to update task status, do it YOURSELF — never ask the user to run a command.
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
    const deps = t.blockedBy?.length
      ? ` [blocked by: ${t.blockedBy.map((id) => '#' + id).join(', ')}]`
      : '';
    return `  - #${t.id} [${t.status}] ${t.subject}${deps}${desc}`;
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
    const deps = t.blockedBy?.length
      ? ` [blocked by: ${t.blockedBy.map((id) => '#' + id).join(', ')}]`
      : '';
    return `  - #${t.id} [${t.status}]${owner} ${t.subject}${deps}${desc}`;
  });
  return `\nCurrent task board (pending/in_progress):\n${lines.join('\n')}\n`;
}

function buildProvisioningPrompt(request: TeamCreateRequest): string {
  const displayName = request.displayName?.trim() || request.teamName;
  const description = request.description?.trim() || 'No description';
  const taskProtocol = buildTaskStatusProtocol(request.teamName);
  const processRegistration = buildProcessRegistrationProtocol(request.teamName);
  const userPromptBlock = request.prompt?.trim()
    ? `\nAdditional instructions from the user:\n${request.prompt.trim()}\n`
    : '';

  const leadName =
    request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
  const projectName = path.basename(request.cwd);

  const isSolo = request.members.length === 0;

  const step3Block = isSolo
    ? `3) If user instructions describe work to be done — create tasks on the team board and assign each task to yourself (“${leadName}”) as owner.\n` +
      `   - Prefer fewer, broader tasks over many micro-tasks.\n` +
      `   - CRITICAL: Do NOT start working on the tasks now. Provisioning is ONLY for setting up the team structure.\n` +
      `   - The tasks will be executed after the team is launched separately.`
    : `3) If user instructions explicitly ask to create tasks OR describe substantial/assigned work that should be tracked — create tasks on the team board.
   - PRIORITY (delegation-first): your default behavior is to translate user requests into a task plan, create the tasks, and delegate them to teammates.
     - Do NOT start executing/implementing tasks yourself in this turn.
     - Do NOT “block” on doing the work before creating/assigning tasks — keep this turn fast so the user can send more instructions.
     - Exception: only if the team is truly SOLO (no teammates) may you execute tasks yourself. This is NOT the case here.
   - Decompose the request into a small set of clear, outcome-based tasks (prefer fewer, broader tasks over many micro-tasks).
   - Assign each created task to an appropriate teammate as owner (NOT to yourself), based on role/workflow and current load.
     - If ownership is unclear, pick the best default owner and note assumptions in the task description or a task comment.
   - Avoid duplicate notifications for the same assignment (one message per member per topic is enough).
   - When tasks have natural ordering (e.g. setup → implementation → testing), use --blocked-by.
   - If a task is blocked (uses --blocked-by), it MUST be created as pending (use --status pending). Do NOT mark blocked tasks in_progress.
     - Review guidance:
       - Prefer NOT creating a separate “review task”. Our workflow reviews the work task itself: run review approve/request-changes on the implementation task #X.
       - If you MUST create a separate review reminder/assignment task, create it as pending and link it to the work task:
         - Use --related to connect it to #X (non-blocking link).
         - If the review truly cannot start until #X is done, ALSO add --blocked-by #X.
       - There is no automatic status transition when dependencies resolve — the owner must explicitly start it (task start / set-status in_progress) when ready.
   - Use --related to connect tasks working on the same feature without blocking.`;

  const step2Block = isSolo
    ? '2) Skip — this is a solo team with no teammates to spawn.'
    : `2) Spawn each member as a live teammate using the Task tool. For each member below, use the exact prompt shown:

// NOTE: taskProtocol & processRegistration are deliberately inlined into EACH member's spawn prompt
// below, even though the text is identical across members. This duplicates ~4K chars per member
// in the lead's context, but ensures the lead passes the EXACT protocol verbatim via Task tool.
// Extracting them once and telling the lead to “insert the protocol block” risks hallucination
// or omission — the lead may rephrase rules, skip items, or forget to include them.
// Cost: ~1K tokens per extra member. At 200K context window this is negligible.
${request.members
  .map(
    (m) => `   For “${m.name}”:
   - prompt:
${buildMemberSpawnPrompt(m, displayName, request.teamName, taskProtocol, processRegistration)
  .split('\n')
  .map((line) => `     ${line}`)
  .join('\n')}`
  )
  .join('\n\n')}`;

  const persistentContext = buildPersistentLeadContext({
    teamName: request.teamName,
    leadName,
    isSolo,
    members: request.members,
  });

  return `Team Start [Agent Team: “${request.teamName}” | Project: “${projectName}” | Lead: “${leadName}”]

You are running in a non-interactive CLI session. Do not ask questions. Do everything in a single turn.
You are “${leadName}”, the team lead.

Goal: Provision a Claude Code agent team${request.members.length === 0 ? ' (solo — lead only)' : ' with live teammates'}.
${userPromptBlock}
${persistentContext}

Steps (execute in this exact order):

1) TeamCreate — create team “${request.teamName}”:
   - description: “${description}”

${step2Block}

${step3Block}

4) After all steps, output a short summary.
`;
}

function buildLaunchPrompt(
  request: TeamLaunchRequest,
  members: TeamCreateRequest['members'],
  tasks: TeamTask[],
  isResume: boolean
): string {
  const userPromptBlock = request.prompt?.trim()
    ? `\nAdditional instructions from the user:\n${request.prompt.trim()}\n`
    : '';
  const taskProtocol = buildTaskStatusProtocol(request.teamName);
  const processRegistration = buildProcessRegistrationProtocol(request.teamName);
  const languageInstruction = getAgentLanguageInstruction();
  const taskBoardSnapshot = buildTaskBoardSnapshot(tasks);

  const leadName = members.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
  const projectName = path.basename(request.cwd);

  const isSolo = members.length === 0;

  let step2And3Block: string;
  if (isSolo) {
    step2And3Block = `2) Skip — solo team, no teammates to spawn.

3) SOLO TASK EXECUTION (IMPORTANT — timing matters):
   - Do NOT start executing tasks in THIS reconnect turn.
   - This turn is ONLY to reconnect and confirm you are ready.
   - After the reconnect is marked ready, you will receive a follow-up message telling you to begin work.

   When you receive that follow-up message:
   - Execute tasks sequentially and keep the board + user updated:
   - Identify the next READY task (pending, not blocked by incomplete dependencies).
   - If the task is unassigned, set yourself ("${leadName}") as owner.
   - BEFORE doing any work on a task: mark it started (in_progress).
   - Immediately SendMessage "user" that you started task #<id> (what you're doing + next step).
   - While working: after each meaningful milestone/decision/blocker, add a task comment on #<id>. If the milestone is user-relevant, also SendMessage "user".
   - On completion: add a final task comment (what changed + how to verify), mark the task completed, then SendMessage "user" that task #<id> is complete and what you will do next.
   - Do NOT start the next task until the current task is completed (default: one task in_progress at a time).

   For this reconnect turn: review the task board snapshot above and output a short summary (1–2 sentences) confirming reconnect is complete and you are ready.`;
  } else {
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
        const workflowBlock = m.workflow?.trim()
          ? `\n\nYour workflow and how you should behave:${formatWorkflowBlock(m.workflow, '     ')}`
          : '';

        return `   For "${m.name}":
   - prompt:
     You are ${m.name}, a ${m.role || 'team member'} on team "${request.teamName}".${workflowBlock}

     ${languageInstruction}
     The team has been reconnected after a restart.
     ${hasTasks ? `You have pending tasks from the previous session.` : 'You have no pending tasks currently.'}

     Your FIRST action: run this command to get your full task briefing with descriptions and comments:
     node "$HOME/.claude/tools/teamctl.js" --team "${request.teamName}" task briefing --for "${m.name}"
     Then resume in_progress tasks first, then pending tasks.
     If you have no tasks, wait for new assignments.`;
      })
      .join('\n\n');

    step2And3Block = `2) Spawn each existing member as a live teammate using the Task tool:
   - team_name: "${request.teamName}"
   - name: the member's name
   - subagent_type: "general-purpose"
   - IMPORTANT: Include each member's pending tasks in their spawn prompt so they resume work immediately.
     Include the following agent-only instructions verbatim in each teammate's prompt:

${taskProtocol}

${processRegistration}

   Per-member spawn instructions:
${memberSpawnInstructions}

3) After spawning all members, check the task board. If any pending tasks are unassigned, assign them to appropriate members using teamctl.`;
  }

  const persistentContext = buildPersistentLeadContext({
    teamName: request.teamName,
    leadName,
    isSolo,
    members,
  });

  const startLabel = isResume ? 'Team Start (resume)' : 'Team Start';

  return `${startLabel} [Agent Team: "${request.teamName}" | Project: "${projectName}" | Lead: "${leadName}"]

You are running in a non-interactive CLI session. Do not ask questions. Do everything in a single turn.
You are "${leadName}", the team lead.

Goal: Reconnect with existing team "${request.teamName}" and resume pending work.
${userPromptBlock}
${taskBoardSnapshot}
${persistentContext}

Steps (execute in this exact order):

1) Read team config at ~/.claude/teams/${request.teamName}/config.json — understand current team state.

${step2And3Block}

4) After all steps, output a short summary of reconnected members and what happens next.
`;
}

/**
 * Unconditionally clears all post-compact reminder state on a run.
 * Called from cleanupRun, cancel, and error paths.
 */
function clearPostCompactReminderState(run: ProvisioningRun): void {
  run.pendingPostCompactReminder = false;
  run.postCompactReminderInFlight = false;
  run.suppressPostCompactReminderOutput = false;
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
      return (
        'Claude CLI reports it is not authenticated ("Please run /login"). ' +
        'Run `claude auth login` (or start `claude` and run `/login`) to authenticate, then retry. ' +
        'For automation/headless use, set `ANTHROPIC_API_KEY` for `-p` mode.'
      );
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
  authSource: ProvisioningAuthSource;
  warning?: string;
  cachedAtMs: number;
}

let cachedProbeResult: CachedProbeResult | null = null;
let probeInFlight: Promise<{
  claudePath: string;
  authSource: ProvisioningAuthSource;
  warning?: string;
} | null> | null = null;

function isTransientProbeWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return (
    lower.includes('timeout running:') ||
    lower.includes('did not complete') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('eai_again')
  );
}

export class TeamProvisioningService {
  private static readonly CLAUDE_LOG_LINES_LIMIT = 50_000;

  private readonly runs = new Map<string, ProvisioningRun>();
  private readonly activeByTeam = new Map<string, string>();
  private readonly teamOpLocks = new Map<string, Promise<void>>();
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

  getClaudeLogs(
    teamName: string,
    query?: { offset?: number; limit?: number }
  ): { lines: string[]; total: number; hasMore: boolean; updatedAt?: string } {
    const runId = this.activeByTeam.get(teamName);
    if (!runId) {
      return { lines: [], total: 0, hasMore: false };
    }
    const run = this.runs.get(runId);
    if (!run) {
      return { lines: [], total: 0, hasMore: false };
    }

    const offsetRaw = query?.offset ?? 0;
    const limitRaw = query?.limit ?? 100;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(1000, Math.floor(limitRaw)))
      : 100;

    const total = run.claudeLogLines.length;
    if (total === 0) {
      return { lines: [], total: 0, hasMore: false, updatedAt: run.claudeLogsUpdatedAt };
    }

    const newestExclusive = Math.max(0, total - offset);
    const oldestInclusive = Math.max(0, newestExclusive - limit);
    const normalizeLine = (line: string): string => {
      // Back-compat: older builds prefixed every line with "[stdout] " / "[stderr] "
      if (line.startsWith('[stdout] ') && line !== '[stdout]')
        return line.slice('[stdout] '.length);
      if (line.startsWith('[stderr] ') && line !== '[stderr]')
        return line.slice('[stderr] '.length);
      return line;
    };

    const lines = run.claudeLogLines
      .slice(oldestInclusive, newestExclusive)
      .map(normalizeLine)
      .toReversed();
    return {
      lines,
      total,
      hasMore: oldestInclusive > 0,
      updatedAt: run.claudeLogsUpdatedAt,
    };
  }

  private appendCliLogs(run: ProvisioningRun, stream: 'stdout' | 'stderr', text: string): void {
    const nowMs = Date.now();
    run.claudeLogsUpdatedAt = new Date(nowMs).toISOString();

    const marker = stream === 'stdout' ? '[stdout]' : '[stderr]';
    if (run.lastClaudeLogStream !== stream) {
      run.lastClaudeLogStream = stream;
      run.claudeLogLines.push(marker);
    }

    if (stream === 'stdout') {
      run.stdoutLogLineBuf += text;
      const parts = run.stdoutLogLineBuf.split('\n');
      run.stdoutLogLineBuf = parts.pop() ?? '';
      for (const part of parts) {
        const normalized = part.endsWith('\r') ? part.slice(0, -1) : part;
        run.claudeLogLines.push(normalized);
      }
    } else {
      run.stderrLogLineBuf += text;
      const parts = run.stderrLogLineBuf.split('\n');
      run.stderrLogLineBuf = parts.pop() ?? '';
      for (const part of parts) {
        const normalized = part.endsWith('\r') ? part.slice(0, -1) : part;
        run.claudeLogLines.push(normalized);
      }
    }
    if (run.claudeLogLines.length > TeamProvisioningService.CLAUDE_LOG_LINES_LIMIT) {
      run.claudeLogLines.splice(
        0,
        run.claudeLogLines.length - TeamProvisioningService.CLAUDE_LOG_LINES_LIMIT
      );
    }
  }

  /**
   * Serializes operations per team name using promise-chaining.
   * Same pattern as withInboxLock / withTaskLock.
   * Prevents TOCTOU races between concurrent createTeam/launchTeam calls.
   */
  private async withTeamLock<T>(teamName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.teamOpLocks.get(teamName) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.teamOpLocks.set(teamName, mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.teamOpLocks.get(teamName) === mine) {
        this.teamOpLocks.delete(teamName);
      }
    }
  }

  setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void {
    this.teamChangeEmitter = emitter;
  }

  private toolApprovalEventEmitter: ((event: ToolApprovalEvent) => void) | null = null;

  setToolApprovalEventEmitter(emitter: (event: ToolApprovalEvent) => void): void {
    this.toolApprovalEventEmitter = emitter;
  }

  private emitToolApprovalEvent(event: ToolApprovalEvent): void {
    this.toolApprovalEventEmitter?.(event);
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

  getLeadContextUsage(teamName: string): LeadContextUsage | null {
    const runId = this.activeByTeam.get(teamName);
    if (!runId) return null;
    const run = this.runs.get(runId);
    if (!run?.leadContextUsage || run.processKilled || run.cancelRequested) return null;
    const { currentTokens, contextWindow } = run.leadContextUsage;
    const percentRaw = contextWindow > 0 ? Math.round((currentTokens / contextWindow) * 100) : 0;
    const percent = Math.max(0, Math.min(100, percentRaw));
    return { currentTokens, contextWindow, percent, updatedAt: new Date().toISOString() };
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

  private static readonly CONTEXT_EMIT_THROTTLE_MS = 2000;
  private static readonly LEAD_TEXT_EMIT_THROTTLE_MS = 2000;
  private static readonly LEAD_TEXT_MIN_LENGTH = 30;

  private emitLeadContextUsage(run: ProvisioningRun): void {
    if (!run.leadContextUsage || !run.provisioningComplete) return;
    const now = Date.now();
    if (
      now - run.leadContextUsage.lastEmittedAt <
      TeamProvisioningService.CONTEXT_EMIT_THROTTLE_MS
    ) {
      return;
    }
    run.leadContextUsage.lastEmittedAt = now;
    const { currentTokens, contextWindow } = run.leadContextUsage;
    const percentRaw = contextWindow > 0 ? Math.round((currentTokens / contextWindow) * 100) : 0;
    const percent = Math.max(0, Math.min(100, percentRaw));
    const payload: LeadContextUsage = {
      currentTokens,
      contextWindow,
      percent,
      updatedAt: new Date().toISOString(),
    };
    this.teamChangeEmitter?.({
      type: 'lead-context',
      teamName: run.teamName,
      detail: JSON.stringify(payload),
    });
  }

  async warmup(): Promise<void> {
    try {
      if (cachedProbeResult && Date.now() - cachedProbeResult.cachedAtMs < PROBE_CACHE_TTL_MS)
        return;
      const result = await this.getCachedOrProbeResult(process.cwd());
      if (!result) return;
      logger.info('CLI warmup completed');
    } catch (error) {
      logger.warn(`CLI warmup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async prepareForProvisioning(
    cwd?: string,
    opts?: { forceFresh?: boolean }
  ): Promise<TeamProvisioningPrepareResult> {
    // Always validate cwd even when cache is available
    const targetCwdForValidation = cwd?.trim() || process.cwd();
    if (targetCwdForValidation && path.isAbsolute(targetCwdForValidation)) {
      await ensureCwdExists(targetCwdForValidation);
    }

    // Allow callers (e.g. scheduler warm-up) to bypass the 36h probe cache
    if (opts?.forceFresh) {
      cachedProbeResult = null;
    }

    const cached = this.getFreshCachedProbeResult();
    if (cached) {
      const { warning, authSource } = cached;
      const warnings: string[] = [];
      if (warning) warnings.push(warning);
      const isAuthFailure = warning ? this.isAuthFailureWarning(warning) : false;
      const ready = !warning || authSource !== 'none' || !isAuthFailure;
      return {
        ready,
        message: ready
          ? warnings.length > 0
            ? 'CLI is ready to launch (see notes)'
            : 'CLI is warmed up and ready to launch'
          : warning || 'CLI is not ready',
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    const targetCwd = cwd?.trim() || process.cwd();
    if (!path.isAbsolute(targetCwd)) {
      throw new Error('cwd must be an absolute path');
    }
    await ensureCwdExists(targetCwd);

    const warnings: string[] = [];

    const probeResult = await this.getCachedOrProbeResult(targetCwd);
    if (!probeResult?.claudePath) {
      throw new Error('Claude CLI not found; install it or provide a valid path');
    }

    const { authSource } = probeResult;
    if (authSource === 'anthropic_api_key') {
      logger.info('Auth: using explicit ANTHROPIC_API_KEY');
    } else if (authSource === 'anthropic_auth_token') {
      logger.info('Auth: using ANTHROPIC_AUTH_TOKEN mapped to ANTHROPIC_API_KEY');
    }

    if (probeResult.warning) {
      const isAuthFailure = this.isAuthFailureWarning(probeResult.warning);
      if (authSource === 'none' && isAuthFailure) {
        // No auth source + preflight indicates auth failure — block to avoid a confusing hang later.
        return {
          ready: false,
          message: probeResult.warning,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
      // Preflight warnings (including timeouts) should not block provisioning.
      warnings.push(probeResult.warning);
    }

    return {
      ready: true,
      message:
        warnings.length > 0
          ? 'CLI is ready to launch (see notes)'
          : 'CLI is warmed up and ready to launch',
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private getFreshCachedProbeResult(): CachedProbeResult | null {
    if (!cachedProbeResult) return null;
    const ageMs = Date.now() - cachedProbeResult.cachedAtMs;
    if (ageMs >= PROBE_CACHE_TTL_MS) {
      cachedProbeResult = null;
      return null;
    }
    return cachedProbeResult;
  }

  private async getCachedOrProbeResult(
    cwd: string
  ): Promise<{ claudePath: string; authSource: ProvisioningAuthSource; warning?: string } | null> {
    const cached = this.getFreshCachedProbeResult();
    if (cached) {
      return {
        claudePath: cached.claudePath,
        authSource: cached.authSource,
        warning: cached.warning,
      };
    }

    if (probeInFlight) {
      return await probeInFlight;
    }

    probeInFlight = (async () => {
      const claudePath = await ClaudeBinaryResolver.resolve();
      if (!claudePath) return null;

      const { env, authSource } = await this.buildProvisioningEnv();
      const probe = await this.probeClaudeRuntime(claudePath, cwd, env);
      const result = {
        claudePath,
        authSource,
        ...(probe.warning ? { warning: probe.warning } : {}),
      };

      const shouldCache =
        !probe.warning ||
        (!this.isAuthFailureWarning(probe.warning) && !isTransientProbeWarning(probe.warning));

      if (shouldCache) {
        cachedProbeResult = { ...result, cachedAtMs: Date.now() };
      } else {
        // Don't pin auth failures / transient failures in cache — user may fix and retry.
        cachedProbeResult = null;
      }

      return result;
    })();

    try {
      return await probeInFlight;
    } finally {
      probeInFlight = null;
    }
  }

  private isAuthFailureWarning(text: string): boolean {
    const lower = text.toLowerCase();
    const has401 = /(^|\D)401(\D|$)/.test(lower);
    return (
      lower.includes('not authenticated') ||
      lower.includes('not logged in') ||
      lower.includes('please run /login') ||
      lower.includes('missing api key') ||
      lower.includes('invalid api key') ||
      lower.includes('unauthorized') ||
      has401
    );
  }

  private hasApiError(text: string): boolean {
    return /api error:\s*\d{3}\b/i.test(text) || /invalid_request_error/i.test(text);
  }

  private sanitizeCliSnippet(text: string): string {
    // Remove control characters that often show up as binary noise in CLI error payloads.
    // Preserve newlines/tabs for readability.
    // eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- intentionally stripping control chars
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  private extractApiErrorSnippet(text: string): string | null {
    const match = /api error:\s*\d{3}\b/i.exec(text) ?? /invalid_request_error/i.exec(text);
    if (match?.index === undefined) return null;
    const start = Math.max(0, match.index - 200);
    const end = Math.min(text.length, match.index + 4000);
    const raw = text.slice(start, end).trim();
    if (!raw) return null;
    // Avoid breaking markdown fences if the payload contains ``` accidentally.
    return this.sanitizeCliSnippet(raw).replace(/```/g, '``\\`');
  }

  private failProvisioningWithApiError(run: ProvisioningRun, source: string): void {
    if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
    if (run.progress.state === 'failed' || run.cancelRequested) return;

    const combined = [
      buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer),
      run.provisioningOutputParts.length > 0 ? run.provisioningOutputParts.join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    const snippet =
      this.extractApiErrorSnippet(combined) ?? this.extractApiErrorSnippet(source) ?? null;
    const status =
      /api error:\s*(\d{3})\b/i.exec(combined)?.[1] ?? /api error:\s*(\d{3})\b/i.exec(source)?.[1];

    const hint = run.isLaunch ? 'Launch' : 'Provisioning';
    const statusLabel = status ? `API Error ${status}` : 'API Error';
    if (snippet) {
      run.provisioningOutputParts.push(
        `**${hint} failed: ${statusLabel} detected**\n\n\`\`\`\n${snippet}\n\`\`\``
      );
    } else {
      run.provisioningOutputParts.push(`**${hint} failed: ${statusLabel} detected**`);
    }

    const progress = updateProgress(run, 'failed', `${hint} failed — ${statusLabel}`, {
      error: `Claude CLI reported ${statusLabel} during startup. The team was not started.`,
      cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
    });
    run.onProgress(progress);

    run.processKilled = true;
    run.cancelRequested = true;
    run.child?.stdin?.end();
    killProcessTree(run.child);
    this.cleanupRun(run);
  }

  /**
   * Detects auth failure keywords in stderr/stdout during provisioning.
   * On first detection: kills process, waits, and respawns automatically.
   * On second detection (after retry): fails fast with a clear error.
   */
  private handleAuthFailureInOutput(run: ProvisioningRun, text: string, source: string): void {
    if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
    if (!this.isAuthFailureWarning(text)) return;

    if (!run.authFailureRetried) {
      logger.warn(
        `[${run.teamName}] Auth failure detected in ${source} during provisioning — ` +
          `will kill process and retry after ${PREFLIGHT_AUTH_RETRY_DELAY_MS}ms`
      );
      run.authRetryInProgress = true;
      void this.respawnAfterAuthFailure(run);
    } else {
      logger.error(`[${run.teamName}] Auth failure detected in ${source} after retry — giving up`);
      run.processKilled = true;
      killProcessTree(run.child);
      const progress = updateProgress(run, 'failed', 'Authentication failed — CLI requires login', {
        error:
          'Claude CLI is not authenticated. Run `claude auth login` (or start `claude` and run `/login`) ' +
          'to authenticate, or set ANTHROPIC_API_KEY and try again.',
        cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
    }
  }

  /**
   * Kills the current process, waits for lock release, and respawns with saved context.
   * Reattaches all stream listeners and resends the prompt.
   */
  private async respawnAfterAuthFailure(run: ProvisioningRun): Promise<void> {
    const ctx = run.spawnContext;
    if (!ctx) {
      logger.error(`[${run.teamName}] Cannot respawn — no spawn context saved`);
      run.authRetryInProgress = false;
      return;
    }

    // Tear down current process without full cleanupRun (keep run alive)
    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
    this.stopFilesystemMonitor(run);
    if (run.child) {
      run.child.stdout?.removeAllListeners('data');
      run.child.stderr?.removeAllListeners('data');
      run.child.removeAllListeners('error');
      run.child.removeAllListeners('exit');
      killProcessTree(run.child);
      run.child = null;
    }

    // Reset buffers for fresh attempt
    run.stdoutBuffer = '';
    run.stderrBuffer = '';
    run.claudeLogLines = [];
    run.lastClaudeLogStream = null;
    run.stdoutLogLineBuf = '';
    run.stderrLogLineBuf = '';
    run.claudeLogsUpdatedAt = undefined;
    run.authFailureRetried = true;

    updateProgress(run, 'spawning', 'Auth failed — retrying after short delay');
    run.onProgress(run.progress);

    await sleep(PREFLIGHT_AUTH_RETRY_DELAY_MS);

    if (run.cancelRequested) {
      run.authRetryInProgress = false;
      return;
    }

    // Respawn with saved context — CLI handles its own auth refresh.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnCli(ctx.claudePath, ctx.args, {
        cwd: ctx.cwd,
        env: { ...ctx.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      run.authRetryInProgress = false;
      const progress = updateProgress(run, 'failed', 'Failed to respawn Claude CLI', {
        error: error instanceof Error ? error.message : String(error),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    logger.info(
      `[${run.teamName}] Respawned CLI process after auth failure (pid=${child.pid ?? '?'})`
    );
    run.child = child;
    run.authRetryInProgress = false;

    updateProgress(run, 'spawning', 'CLI respawned — sending prompt', {
      pid: child.pid ?? undefined,
    });
    run.onProgress(run.progress);

    // Resend prompt
    if (child.stdin?.writable) {
      const message = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: ctx.prompt }],
        },
      });
      child.stdin.write(message + '\n');
    }

    // Reattach stdout handler
    this.attachStdoutHandler(run);

    // Reattach stderr handler
    this.attachStderrHandler(run);

    // Restart filesystem monitor for createTeam (launch skips it)
    if (!run.isLaunch) {
      this.startFilesystemMonitor(run, run.request);
    } else {
      updateProgress(run, 'monitoring', 'CLI running — reconnecting with teammates');
      run.onProgress(run.progress);
    }

    // Restart timeout
    run.timeoutHandle = setTimeout(() => {
      if (!run.processKilled && !run.provisioningComplete) {
        run.processKilled = true;
        run.finalizingByTimeout = true;
        void (async () => {
          const readyOnTimeout = await this.tryCompleteAfterTimeout(run);
          run.child?.stdin?.end();
          killProcessTree(run.child);
          if (readyOnTimeout) return;

          const hint = run.isLaunch ? ' (launch)' : '';
          const progress = updateProgress(run, 'failed', `Timed out waiting for CLI${hint}`, {
            error: `Timed out waiting for CLI${hint}.`,
            cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
          });
          run.onProgress(progress);
          this.cleanupRun(run);
        })();
      }
    }, RUN_TIMEOUT_MS);

    child.once('error', (error) => {
      const hint = run.isLaunch ? ' (launch)' : '';
      const progress = updateProgress(run, 'failed', `Failed to start Claude CLI${hint}`, {
        error: error.message,
        cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
    });

    child.once('exit', (code) => {
      void this.handleProcessExit(run, code);
    });
  }

  /** Attaches the stdout stream-json parser to the current child process. */
  private attachStdoutHandler(run: ProvisioningRun): void {
    const child = run.child;
    if (!child?.stdout) return;

    let stdoutLineBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.appendCliLogs(run, 'stdout', text);
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
          // Not valid JSON — check for auth failure in raw text output
          this.handleAuthFailureInOutput(run, trimmed, 'stdout');
          if (this.hasApiError(trimmed) && !this.isAuthFailureWarning(trimmed)) {
            this.failProvisioningWithApiError(run, trimmed);
          }
        }
      }

      const currentTs = Date.now();
      if (currentTs - run.lastLogProgressAt >= LOG_PROGRESS_THROTTLE_MS) {
        run.lastLogProgressAt = currentTs;
        emitLogsProgress(run);
      }
    });
  }

  /** Attaches the stderr handler with auth failure detection. */
  private attachStderrHandler(run: ProvisioningRun): void {
    const child = run.child;
    if (!child?.stderr) return;

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.appendCliLogs(run, 'stderr', text);
      run.stderrBuffer += text;
      if (run.stderrBuffer.length > STDERR_RING_LIMIT) {
        run.stderrBuffer = run.stderrBuffer.slice(run.stderrBuffer.length - STDERR_RING_LIMIT);
      }

      // Detect auth failure early instead of waiting for 5-minute timeout
      this.handleAuthFailureInOutput(run, text, 'stderr');
      if (this.hasApiError(text) && !this.isAuthFailureWarning(text)) {
        this.failProvisioningWithApiError(run, text);
      }

      const currentTs = Date.now();
      if (currentTs - run.lastLogProgressAt >= LOG_PROGRESS_THROTTLE_MS) {
        run.lastLogProgressAt = currentTs;
        emitLogsProgress(run);
      }
    });
  }

  async createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    return this.withTeamLock(request.teamName, async () => {
      return this._createTeamInner(request, onProgress);
    });
  }

  private async _createTeamInner(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    if (this.activeByTeam.has(request.teamName)) {
      throw new Error('Provisioning already running');
    }

    // Set immediately to prevent TOCTOU (defense in depth alongside withTeamLock)
    const pendingKey = `pending-${randomUUID()}`;
    this.activeByTeam.set(request.teamName, pendingKey);

    try {
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
        claudeLogLines: [],
        lastClaudeLogStream: null,
        stdoutLogLineBuf: '',
        stderrLogLineBuf: '',
        claudeLogsUpdatedAt: undefined,
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
        leadMsgSeq: 0,
        pendingToolCalls: [],
        lastLeadTextEmitMs: 0,
        silentUserDmForward: null,
        silentUserDmForwardClearHandle: null,
        provisioningOutputParts: [],
        detectedSessionId: null,
        leadActivityState: 'active',
        leadContextUsage: null,
        authFailureRetried: false,
        authRetryInProgress: false,
        spawnContext: null,
        pendingApprovals: new Map(),
        pendingPostCompactReminder: false,
        postCompactReminderInFlight: false,
        suppressPostCompactReminderOutput: false,
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
      const { env: shellEnv } = await this.buildProvisioningEnv();
      const spawnArgs = [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--setting-sources',
        'user,project,local',
        '--disallowedTools',
        'TeamDelete,TodoWrite',
        ...(request.skipPermissions !== false ? ['--dangerously-skip-permissions'] : []),
        ...(request.model ? ['--model', request.model] : []),
        ...(request.effort ? ['--effort', request.effort] : []),
      ];
      try {
        child = spawnCli(claudePath, spawnArgs, {
          cwd: request.cwd,
          env: { ...shellEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        this.runs.delete(runId);
        this.activeByTeam.delete(request.teamName);
        throw error;
      }

      updateProgress(run, 'spawning', 'Starting Claude CLI process', {
        pid: child.pid ?? undefined,
      });
      run.onProgress(run.progress);
      run.child = child;
      run.spawnContext = {
        claudePath,
        args: spawnArgs,
        cwd: request.cwd,
        env: { ...shellEnv },
        prompt,
      };

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

      this.attachStdoutHandler(run);
      this.attachStderrHandler(run);

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
    } catch (error) {
      // Ensure the per-team lock doesn't get stuck on failures.
      if (this.activeByTeam.get(request.teamName) === pendingKey) {
        this.activeByTeam.delete(request.teamName);
      }
      throw error;
    }
  }

  async launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    return this.withTeamLock(request.teamName, async () => {
      return this._launchTeamInner(request, onProgress);
    });
  }

  private async _launchTeamInner(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    if (this.activeByTeam.has(request.teamName)) {
      throw new Error('Team is already running');
    }

    // Set immediately to prevent TOCTOU (defense in depth alongside withTeamLock)
    const pendingKey = `pending-${randomUUID()}`;
    this.activeByTeam.set(request.teamName, pendingKey);

    try {
      // Verify config.json exists — team must already be provisioned
      const configPath = path.join(getTeamsBasePath(), request.teamName, 'config.json');
      const configRaw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!configRaw) {
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
            const storedProjectPath =
              typeof configParsed.projectPath === 'string' &&
              configParsed.projectPath.trim().length > 0
                ? configParsed.projectPath.trim()
                : null;

            // Sessions are stored per-project (~/.claude/projects/{encodePath(cwd)}/).
            // If the project path changed, the old session JSONL won't be found by the CLI
            // at the new project directory. Skip resume to avoid passing an invalid --resume arg.
            if (
              storedProjectPath &&
              path.resolve(storedProjectPath) !== path.resolve(request.cwd)
            ) {
              logger.info(
                `[${request.teamName}] Project path changed: ${storedProjectPath} → ${request.cwd}. ` +
                  `Skipping session resume — sessions are per-project.`
              );
            } else {
              const resumeProjectPath = storedProjectPath ?? request.cwd;
              const projectId = encodePath(resumeProjectPath);
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
          }
        } catch {
          logger.debug(
            `[${request.teamName}] Failed to extract leadSessionId from config for resume`
          );
        }
      }

      // IMPORTANT: The CLI auto-suffixes teammate names when they already exist in config.json.
      // Normalize config.json to keep only the team-lead before spawning the CLI, so we get stable names.
      try {
        await this.normalizeTeamConfigForLaunch(request.teamName, configRaw);
        await this.assertConfigLeadOnlyForLaunch(request.teamName);

        // Update projectPath in config IMMEDIATELY so TeamDetailView shows the correct path
        // even if provisioning is interrupted or the user stops the team early.
        // If launch fails, restorePrelaunchConfig() will revert to the backup (old projectPath).
        await this.updateConfigProjectPath(request.teamName, request.cwd);
      } catch (error) {
        // Restore pre-launch backup so config.json is not left in normalized (lead-only) state.
        await this.restorePrelaunchConfig(request.teamName);
        throw error;
      }

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
        skipPermissions: request.skipPermissions,
      };

      const run: ProvisioningRun = {
        runId,
        teamName: request.teamName,
        startedAt,
        stdoutBuffer: '',
        stderrBuffer: '',
        claudeLogLines: [],
        lastClaudeLogStream: null,
        stdoutLogLineBuf: '',
        stderrLogLineBuf: '',
        claudeLogsUpdatedAt: undefined,
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
        leadMsgSeq: 0,
        pendingToolCalls: [],
        lastLeadTextEmitMs: 0,
        silentUserDmForward: null,
        silentUserDmForwardClearHandle: null,
        provisioningOutputParts: [],
        detectedSessionId: null,
        leadActivityState: 'active',
        leadContextUsage: null,
        authFailureRetried: false,
        authRetryInProgress: false,
        spawnContext: null,
        pendingApprovals: new Map(),
        pendingPostCompactReminder: false,
        postCompactReminderInFlight: false,
        suppressPostCompactReminderOutput: false,
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
        logger.warn(
          `[${request.teamName}] Failed to read tasks for launch prompt: ${String(error)}`
        );
      }

      const prompt = buildLaunchPrompt(
        request,
        expectedMemberSpecs,
        existingTasks,
        Boolean(previousSessionId)
      );
      let child: ReturnType<typeof spawn>;
      const { env: shellEnv } = await this.buildProvisioningEnv();
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
        ...(request.skipPermissions !== false ? ['--dangerously-skip-permissions'] : []),
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
      if (request.effort) {
        launchArgs.push('--effort', request.effort);
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
      run.spawnContext = {
        claudePath,
        args: launchArgs,
        cwd: request.cwd,
        env: { ...shellEnv },
        prompt,
      };

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

      this.attachStdoutHandler(run);
      this.attachStderrHandler(run);

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
    } catch (error) {
      // Clean up pending key if failure occurred before runId was set
      if (this.activeByTeam.get(request.teamName) === pendingKey) {
        this.activeByTeam.delete(request.teamName);
      }
      throw error;
    }
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
    const stdin = run.child.stdin;
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.setLeadActivity(run, 'active');
  }

  /**
   * Best-effort: forward a user-written DM to a teammate via the live lead process.
   * This covers cases where teammates don't automatically respond to inbox JSON,
   * and only react to Claude Code internal SendMessage routing.
   *
   * Note: We suppress the lead's textual output for this injected turn to avoid
   * confusing lead responses like "No action needed."
   */
  async forwardUserDmToTeammate(
    teamName: string,
    teammateName: string,
    userText: string,
    userSummary?: string
  ): Promise<void> {
    const runId = this.activeByTeam.get(teamName);
    if (!runId) {
      throw new Error(`No active process for team "${teamName}"`);
    }
    const run = this.runs.get(runId);
    if (!run?.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }
    if (!run.provisioningComplete) {
      // Don't inject extra turns during provisioning/bootstrap.
      return;
    }

    run.silentUserDmForward = { target: teammateName, startedAt: nowIso() };
    if (run.silentUserDmForwardClearHandle) {
      clearTimeout(run.silentUserDmForwardClearHandle);
      run.silentUserDmForwardClearHandle = null;
    }
    // Safety valve: if the CLI never emits a result message, don't stay in "silent" mode forever.
    run.silentUserDmForwardClearHandle = setTimeout(() => {
      run.silentUserDmForward = null;
      run.silentUserDmForwardClearHandle = null;
    }, 60_000);
    run.silentUserDmForwardClearHandle.unref();

    const summaryLine = userSummary?.trim() ? `Summary: ${userSummary.trim()}` : null;
    const internal = wrapInAgentBlock(
      [
        `UI relay request — forward a direct message to teammate "${teammateName}".`,
        `MUST: use the SendMessage tool with recipient="${teammateName}".`,
        `MUST: ask the teammate to reply back to recipient "user" (short answer).`,
        `CRITICAL: Do NOT send any message to recipient "user" for this turn.`,
      ].join('\n')
    );
    const message = [
      `User DM relay (internal).`,
      internal,
      ``,
      `Message to forward:`,
      ...(summaryLine ? [summaryLine] : []),
      userText,
    ].join('\n');

    await this.sendMessageToTeam(teamName, message);
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

      // Ignore (and auto-mark read) internal coordination noise like idle/shutdown messages.
      // These frequently appear when teammates are idle/available and should not prompt
      // the lead to respond with "No action needed."
      const noiseUnread = unread.filter((m) => isInboxNoiseMessage(m.text));
      if (noiseUnread.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, leadName, noiseUnread);
        } catch {
          // best-effort
        }
      }

      const actionableUnread = unread.filter((m) => !isInboxNoiseMessage(m.text));
      if (actionableUnread.length === 0) return 0;

      const MAX_RELAY = 10;
      const batch = actionableUnread.slice(0, MAX_RELAY);

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
        const relayMsg: InboxMessage = {
          from: leadName,
          to: 'user',
          text: cleanReply,
          timestamp: nowIso(),
          read: true,
          summary: cleanReply.length > 60 ? cleanReply.slice(0, 57) + '...' : cleanReply,
          messageId: `lead-process-${runId}-${Date.now()}`,
          source: 'lead_process',
        };
        this.pushLiveLeadProcessMessage(teamName, relayMsg);
        // Persist to disk so relayed replies survive app restart and trigger FileWatcher
        void this.sentMessagesStore
          .appendMessage(teamName, relayMsg)
          .catch((e: unknown) =>
            logger.warn(`[${teamName}] sentMessagesStore persist failed: ${String(e)}`)
          );
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
      const raw = await tryReadRegularFileUtf8(inboxPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_INBOX_MAX_BYTES,
      });
      if (!raw) {
        return;
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

  /**
   * Intercept SendMessage(to: "user") tool_use blocks from the lead's stream-json output.
   *
   * Claude Code's internal teamContext may be lost after session resume (--resume), causing
   * SendMessage to route messages to ~/.claude/teams/default/ instead of the real team.
   * By capturing tool_use calls directly from stdout, we persist them to sentMessages.json
   * under the correct team name — ensuring the UI and OS notifications work correctly
   * regardless of the internal teamContext state.
   */
  private captureSendMessageToUser(run: ProvisioningRun, content: Record<string, unknown>[]): void {
    for (const part of content) {
      if (part.type !== 'tool_use' || part.name !== 'SendMessage') continue;
      const input = part.input;
      if (!input || typeof input !== 'object') continue;
      const inp = input as Record<string, unknown>;

      // Only capture messages addressed to the human user
      const recipient = typeof inp.recipient === 'string' ? inp.recipient : '';
      if (recipient !== 'user') continue;

      const msgContent = typeof inp.content === 'string' ? inp.content : '';
      if (msgContent.trim().length === 0) continue;

      const summary = typeof inp.summary === 'string' ? inp.summary : '';
      const leadName =
        run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
        'team-lead';

      const cleanContent = stripAgentBlocks(msgContent);
      if (cleanContent.trim().length === 0) continue;

      const msg: InboxMessage = {
        from: leadName,
        to: 'user',
        text: cleanContent,
        timestamp: nowIso(),
        read: false,
        summary:
          (summary || cleanContent).length > 60
            ? (summary || cleanContent).slice(0, 57) + '...'
            : summary || cleanContent,
        messageId: `lead-sendmsg-${run.runId}-${Date.now()}`,
        source: 'lead_process',
      };

      this.pushLiveLeadProcessMessage(run.teamName, msg);
      void this.sentMessagesStore
        .appendMessage(run.teamName, msg)
        .catch((e: unknown) =>
          logger.warn(
            `[${run.teamName}] sentMessagesStore persist (SendMessage capture) failed: ${String(e)}`
          )
        );
      this.teamChangeEmitter?.({
        type: 'inbox',
        teamName: run.teamName,
        detail: 'sentMessages.json',
      });

      logger.debug(
        `[${run.teamName}] Captured SendMessage→user from stdout: ${cleanContent.slice(0, 100)}`
      );
    }
  }

  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void {
    // Enrich with leadSessionId if missing — needed for session boundary separators
    if (!message.leadSessionId) {
      const runId = this.activeByTeam.get(teamName);
      if (runId) {
        const run = this.runs.get(runId);
        if (run?.detectedSessionId) {
          message.leadSessionId = run.detectedSessionId;
        }
      }
    }
    const MAX = 100;
    const list = this.liveLeadProcessMessages.get(teamName) ?? [];
    const id = typeof message.messageId === 'string' ? message.messageId.trim() : '';
    if (id) {
      const existingIdx = list.findIndex((m) => (m.messageId ?? '').trim() === id);
      if (existingIdx >= 0) {
        list[existingIdx] = message;
      } else {
        list.push(message);
      }
    } else {
      list.push(message);
    }
    if (list.length > MAX) {
      list.splice(0, list.length - MAX);
    }
    this.liveLeadProcessMessages.set(teamName, list);
  }

  private removeLiveLeadProcessMessage(teamName: string, messageId: string): void {
    const id = messageId.trim();
    if (!id) return;
    const list = this.liveLeadProcessMessages.get(teamName);
    if (!list || list.length === 0) return;
    const next = list.filter((m) => (m.messageId ?? '').trim() !== id);
    if (next.length === 0) {
      this.liveLeadProcessMessages.delete(teamName);
    } else {
      this.liveLeadProcessMessages.set(teamName, next);
    }
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

      const hasSendMessageToUser = (content ?? []).some((part) => {
        if (!part || typeof part !== 'object') return false;
        if (part.type !== 'tool_use' || part.name !== 'SendMessage') return false;
        const input = part.input;
        if (!input || typeof input !== 'object') return false;
        return (input as Record<string, unknown>).recipient === 'user';
      });

      const textParts = (content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string);
      if (textParts.length > 0) {
        const text = textParts.join('\n');
        // Auth failures sometimes show up as assistant text (e.g. "401", "Please run /login")
        // rather than stderr or a result.subtype=error. Detect early to avoid false "ready".
        this.handleAuthFailureInOutput(run, text, 'assistant');
        if (this.hasApiError(text) && !this.isAuthFailureWarning(text)) {
          this.failProvisioningWithApiError(run, text);
          return;
        }
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
              const combined = capture.textParts.join('\n').trim();
              capture.resolveOnce(combined);
            }, capture.idleMs);
          }
        } else if (run.provisioningComplete) {
          // Push each assistant text block as a separate live message (per-message pattern).
          // When the same assistant message includes SendMessage(to:"user"), skip text —
          // captureSendMessageToUser() handles it separately.
          if (
            !run.silentUserDmForward &&
            !run.suppressPostCompactReminderOutput &&
            !hasSendMessageToUser
          ) {
            const cleanText = stripAgentBlocks(text).trim();
            if (cleanText.length > 0) {
              run.leadMsgSeq += 1;
              const leadName =
                run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
                'team-lead';
              const messageId = `lead-turn-${run.runId}-${run.leadMsgSeq}`;
              // Attach accumulated tool call details from preceding tool_use messages, then reset.
              const toolCalls =
                run.pendingToolCalls.length > 0 ? [...run.pendingToolCalls] : undefined;
              const toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
              run.pendingToolCalls = [];
              const leadMsg: InboxMessage = {
                from: leadName,
                text: cleanText,
                timestamp: nowIso(),
                read: true,
                summary: cleanText.length > 60 ? cleanText.slice(0, 57) + '...' : cleanText,
                messageId,
                source: 'lead_process',
                toolSummary,
                toolCalls,
              };
              this.pushLiveLeadProcessMessage(run.teamName, leadMsg);

              const now = Date.now();
              if (
                now - run.lastLeadTextEmitMs >=
                TeamProvisioningService.LEAD_TEXT_EMIT_THROTTLE_MS
              ) {
                run.lastLeadTextEmitMs = now;
                this.teamChangeEmitter?.({
                  type: 'inbox',
                  teamName: run.teamName,
                  detail: 'lead-text',
                });
              }
            }
          }
        }
      }

      // Accumulate tool_use details from tool-only messages (text + tool_use are separate in stream-json).
      // These details will be attached to the next text message as toolCalls/toolSummary.
      if (run.provisioningComplete) {
        for (const block of content ?? []) {
          if (
            block?.type === 'tool_use' &&
            typeof block.name === 'string' &&
            block.name !== 'SendMessage'
          ) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            run.pendingToolCalls.push({
              name: block.name,
              preview: extractToolPreview(block.name, input),
            });
          }
        }
      }

      // Capture SendMessage(to: "user") tool_use blocks from assistant output.
      // Claude Code's internal teamContext may route to "default" instead of the real team
      // (e.g., after session resume when teamContext is lost). We intercept the tool calls
      // from stdout and persist them to sentMessages.json under the correct team name,
      // ensuring the UI and notifications show the right team.
      if (run.provisioningComplete && !run.silentUserDmForward) {
        this.captureSendMessageToUser(run, content ?? []);
      }

      // Extract context window usage from message.usage for real-time tracking.
      // SDKAssistantMessage wraps BetaMessage which contains usage stats.
      const messageObj = (msg.message ?? msg) as Record<string, unknown>;
      if (messageObj && typeof messageObj === 'object') {
        const msgId = typeof messageObj.id === 'string' ? messageObj.id : null;
        const usage = messageObj.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === 'object') {
          // Dedup: skip if same message.id (SDK bug: multi-block = same usage repeated)
          if (!msgId || run.leadContextUsage?.lastUsageMessageId !== msgId) {
            const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
            const cacheCreation =
              typeof usage.cache_creation_input_tokens === 'number'
                ? usage.cache_creation_input_tokens
                : 0;
            const cacheRead =
              typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
            const currentTokens = inputTokens + cacheCreation + cacheRead;

            if (!run.leadContextUsage) {
              run.leadContextUsage = {
                currentTokens,
                contextWindow: 200_000,
                lastUsageMessageId: msgId,
                lastEmittedAt: 0,
              };
            } else {
              run.leadContextUsage.currentTokens = currentTokens;
              run.leadContextUsage.lastUsageMessageId = msgId;
            }
            this.emitLeadContextUsage(run);
          }
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

    // Handle control_request — tool approval protocol (only when --dangerously-skip-permissions is NOT set)
    if (msg.type === 'control_request') {
      this.handleControlRequest(run, msg);
      return;
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

        // Extract contextWindow from modelUsage if available (SDKResultSuccess.modelUsage)
        const modelUsageObj = (msg.modelUsage ??
          (msg.result as Record<string, unknown> | undefined)?.modelUsage) as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (modelUsageObj && typeof modelUsageObj === 'object') {
          for (const modelData of Object.values(modelUsageObj)) {
            if (
              modelData &&
              typeof modelData === 'object' &&
              typeof modelData.contextWindow === 'number' &&
              modelData.contextWindow > 0
            ) {
              if (!run.leadContextUsage) {
                run.leadContextUsage = {
                  currentTokens: 0,
                  contextWindow: modelData.contextWindow,
                  lastUsageMessageId: null,
                  lastEmittedAt: 0,
                };
              } else {
                run.leadContextUsage.contextWindow = modelData.contextWindow;
                run.leadContextUsage.lastEmittedAt = 0; // force re-emit
              }
              this.emitLeadContextUsage(run);
              break;
            }
          }
        }

        // Extract usage from result message itself (final turn usage)
        const resultUsage = (msg.usage ??
          (msg.result as Record<string, unknown> | undefined)?.usage) as
          | Record<string, unknown>
          | undefined;
        if (resultUsage && typeof resultUsage === 'object') {
          const inp = typeof resultUsage.input_tokens === 'number' ? resultUsage.input_tokens : 0;
          const cc =
            typeof resultUsage.cache_creation_input_tokens === 'number'
              ? resultUsage.cache_creation_input_tokens
              : 0;
          const cr =
            typeof resultUsage.cache_read_input_tokens === 'number'
              ? resultUsage.cache_read_input_tokens
              : 0;
          const total = inp + cc + cr;
          if (total > 0) {
            if (!run.leadContextUsage) {
              run.leadContextUsage = {
                currentTokens: total,
                contextWindow: 0,
                lastUsageMessageId: null,
                lastEmittedAt: 0,
              };
            } else {
              run.leadContextUsage.currentTokens = total;
              run.leadContextUsage.lastEmittedAt = 0;
            }
            this.emitLeadContextUsage(run);
          }
        }

        if (run.provisioningComplete) {
          // If this was a post-compact reminder turn completing, clear in-flight and suppress flags.
          // Preserve pendingPostCompactReminder if re-armed by a compact_boundary during this turn.
          if (run.postCompactReminderInFlight) {
            const hadPendingRearm = run.pendingPostCompactReminder;
            run.postCompactReminderInFlight = false;
            run.suppressPostCompactReminderOutput = false;
            logger.info(
              `[${run.teamName}] post-compact reminder turn completed${
                hadPendingRearm ? ' (follow-up reminder pending from re-compact)' : ''
              }`
            );
          }

          this.setLeadActivity(run, 'idle');
        }
        if (run.leadRelayCapture) {
          const capture = run.leadRelayCapture;
          const combined = capture.textParts.join('\n').trim();
          capture.resolveOnce(combined);
        }
        // Clear silent relay flag after any successful turn.
        run.silentUserDmForward = null;
        if (run.silentUserDmForwardClearHandle) {
          clearTimeout(run.silentUserDmForwardClearHandle);
          run.silentUserDmForwardClearHandle = null;
        }

        // Deferred post-compact context reinjection: inject durable rules on first idle after compact.
        // Placed AFTER leadRelayCapture/silentUserDmForward cleanup so a previously-deferred
        // reminder can proceed now that the blocking conditions are cleared.
        if (
          run.provisioningComplete &&
          run.pendingPostCompactReminder &&
          !run.postCompactReminderInFlight
        ) {
          void this.injectPostCompactReminder(run);
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
        // Clear silent relay flag after any errored turn.
        run.silentUserDmForward = null;
        if (run.silentUserDmForwardClearHandle) {
          clearTimeout(run.silentUserDmForwardClearHandle);
          run.silentUserDmForwardClearHandle = null;
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
          // Post-provisioning error: process alive, waiting for input.
          // Always clear all post-compact reminder state on error — prevents a stale pending
          // reminder from firing on the next unrelated successful turn.
          if (run.pendingPostCompactReminder || run.postCompactReminderInFlight) {
            const wasInFlight = run.postCompactReminderInFlight;
            clearPostCompactReminderState(run);
            logger.warn(
              `[${run.teamName}] post-compact reminder ${wasInFlight ? 'turn errored' : 'pending dropped'} — clearing (strict policy)`
            );
          }
          this.setLeadActivity(run, 'idle');
        }
      }
    }

    // Handle compact_boundary — context was compacted, next assistant message will carry fresh usage
    if (msg.type === 'system') {
      const sub = typeof msg.subtype === 'string' ? msg.subtype : undefined;
      if (sub === 'compact_boundary') {
        if (run.leadContextUsage) {
          run.leadContextUsage.lastUsageMessageId = null;
        }

        // Extract compact metadata for the system message
        const meta = msg.compact_metadata as Record<string, unknown> | undefined;
        const trigger = typeof meta?.trigger === 'string' ? meta.trigger : 'auto';
        const preTokens = typeof meta?.pre_tokens === 'number' ? meta.pre_tokens : null;
        const tokenInfo = preTokens ? ` (was ~${(preTokens / 1000).toFixed(0)}k tokens)` : '';

        const compactMsg: InboxMessage = {
          from: 'system',
          text: `Context compacted${tokenInfo}, trigger: ${trigger}`,
          timestamp: nowIso(),
          read: true,
          summary: `Context compacted (${trigger})`,
          messageId: `compact-${run.runId}-${Date.now()}`,
          source: 'lead_process',
        };
        this.pushLiveLeadProcessMessage(run.teamName, compactMsg);
        this.teamChangeEmitter?.({
          type: 'inbox',
          teamName: run.teamName,
          detail: 'compact_boundary',
        });
        logger.info(
          `[${run.teamName}] compact_boundary — context will refresh on next turn${tokenInfo}`
        );

        // Schedule post-compact context reinjection on next idle.
        // If a reminder is already in-flight, re-arm pending so a follow-up fires after it completes.
        // This handles the case where the reminder prompt itself triggers another compaction.
        if (run.provisioningComplete && !run.pendingPostCompactReminder) {
          run.pendingPostCompactReminder = true;
          logger.info(
            `[${run.teamName}] post-compact reminder scheduled for next idle${
              run.postCompactReminderInFlight ? ' (re-armed during in-flight reminder)' : ''
            }`
          );
        }
      }
    }
  }

  /**
   * Injects a post-compact context reminder into the lead process via stdin.
   * Reinjects durable lead rules (constraints, communication protocol, teamctl ops)
   * plus a fresh task board snapshot so the lead recovers full operational context
   * after context compaction.
   *
   * Policy: strict drop-after-attempt — one compact cycle gives at most one reminder turn.
   * If the injection fails (stdin not writable, process killed), we do not retry.
   */
  private async injectPostCompactReminder(run: ProvisioningRun): Promise<void> {
    // Consume the pending flag immediately — strict one-shot policy.
    run.pendingPostCompactReminder = false;

    // Guard: process must be alive and writable.
    if (!run.child?.stdin?.writable || run.processKilled || run.cancelRequested) {
      logger.warn(
        `[${run.teamName}] post-compact reminder skipped — process not writable or killed`
      );
      return;
    }

    // Guard: don't inject if another turn is actively processing (race with user send / inbox relay).
    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] post-compact reminder deferred — lead is ${run.leadActivityState}, not idle`
      );
      // Re-arm so it triggers on next idle.
      run.pendingPostCompactReminder = true;
      return;
    }

    // Guard: don't inject while a relay capture is in-flight.
    if (run.leadRelayCapture) {
      logger.info(`[${run.teamName}] post-compact reminder deferred — relay capture in-flight`);
      run.pendingPostCompactReminder = true;
      return;
    }

    // Guard: don't inject while a silent DM forward is in progress.
    if (run.silentUserDmForward) {
      logger.info(
        `[${run.teamName}] post-compact reminder deferred — silent DM forward in progress`
      );
      run.pendingPostCompactReminder = true;
      return;
    }

    // Read current team config for up-to-date members (may have changed since launch).
    let currentMembers: TeamCreateRequest['members'] = run.request.members;
    let leadName = 'team-lead';
    try {
      const config = await this.configReader.getConfig(run.teamName);
      if (config?.members) {
        const configLead = config.members.find((m) => m?.agentType === 'team-lead');
        leadName = configLead?.name?.trim() || 'team-lead';
        // Convert config members (excluding lead) to TeamCreateRequest member format.
        currentMembers = config.members
          .filter((m) => m?.agentType !== 'team-lead' && m?.name)
          .map((m) => ({
            name: m.name,
            role: m.role ?? undefined,
          }));
      } else {
        leadName =
          run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
          'team-lead';
      }
    } catch {
      // Fallback to launch-time members if config is unavailable.
      leadName =
        run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
        'team-lead';
      logger.warn(
        `[${run.teamName}] post-compact reminder: config unavailable, using launch-time members`
      );
    }
    const isSolo = currentMembers.length === 0;

    // Build persistent lead context.
    const persistentContext = buildPersistentLeadContext({
      teamName: run.teamName,
      leadName,
      isSolo,
      members: currentMembers,
      compact: true,
    });

    // Best-effort: fetch fresh task board snapshot.
    let taskBoardBlock = '';
    try {
      const taskReader = new TeamTaskReader();
      const tasks = await taskReader.getTasks(run.teamName);
      taskBoardBlock = buildTaskBoardSnapshot(tasks);
    } catch {
      // If tasks can't be read, inject without the snapshot.
      logger.warn(`[${run.teamName}] post-compact reminder: task board snapshot unavailable`);
    }

    // Re-check guards after async work.
    if (!run.child?.stdin?.writable || run.processKilled || run.cancelRequested) {
      logger.warn(
        `[${run.teamName}] post-compact reminder aborted — process state changed during preparation`
      );
      return;
    }
    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] post-compact reminder aborted — lead activity changed to ${run.leadActivityState as string}`
      );
      return;
    }

    const message = [
      `Context reminder (post-compaction) — your context was compacted. Here are your standing rules and current state:`,
      ``,
      `You are "${leadName}", the team lead of team "${run.teamName}".`,
      `You are running in a non-interactive CLI session. Do not ask questions.`,
      ``,
      persistentContext,
      taskBoardBlock.trim() ? `\n${taskBoardBlock}` : '',
      ``,
      `This is a context-only reminder. Do NOT start new work or execute tasks in this turn. Reply with a single word: "OK".`,
    ]
      .filter(Boolean)
      .join('\n');

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
    });

    run.postCompactReminderInFlight = true;
    run.suppressPostCompactReminderOutput = true;
    this.setLeadActivity(run, 'active');

    try {
      const stdin = run.child.stdin;
      await new Promise<void>((resolve, reject) => {
        stdin.write(payload + '\n', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info(`[${run.teamName}] post-compact reminder injected`);
    } catch (error) {
      // Strict drop-after-attempt — do not re-arm.
      clearPostCompactReminderState(run);
      this.setLeadActivity(run, 'idle');
      logger.warn(
        `[${run.teamName}] post-compact reminder injection failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Handles a control_request message from CLI stream-json output.
   * `can_use_tool` → emits to renderer for manual approval.
   * All other subtypes (hook_callback, etc.) → auto-allowed to prevent deadlock.
   */
  private handleControlRequest(run: ProvisioningRun, msg: Record<string, unknown>): void {
    const requestId = typeof msg.request_id === 'string' ? msg.request_id : null;
    if (!requestId) {
      logger.warn(`[${run.teamName}] control_request missing request_id, ignoring`);
      return;
    }

    const request = msg.request as Record<string, unknown> | undefined;
    const subtype = request?.subtype;

    // Non-`can_use_tool` subtypes (hook_callback, etc.) are auto-allowed to prevent
    // CLI deadlock — hooks are user-configured and should not block on manual approval.
    if (subtype !== 'can_use_tool') {
      logger.debug(
        `[${run.teamName}] control_request subtype=${String(subtype)}, auto-allowing to prevent deadlock`
      );
      this.autoAllowControlRequest(run, requestId);
      return;
    }

    const toolName = typeof request?.tool_name === 'string' ? request.tool_name : 'Unknown';
    const toolInput = (request?.input ?? {}) as Record<string, unknown>;

    const approval: ToolApprovalRequest = {
      requestId,
      runId: run.runId,
      teamName: run.teamName,
      source: 'lead',
      toolName,
      toolInput,
      receivedAt: new Date().toISOString(),
    };

    run.pendingApprovals.set(requestId, approval);
    this.emitToolApprovalEvent(approval);
  }

  /**
   * Immediately sends an "allow" control_response for a non-tool control_request.
   * Prevents CLI deadlock for hook_callback and other non-`can_use_tool` subtypes.
   */
  private autoAllowControlRequest(run: ProvisioningRun, requestId: string): void {
    if (!run.child?.stdin?.writable) {
      logger.warn(`[${run.teamName}] Cannot auto-allow control_request: stdin not writable`);
      return;
    }

    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow' },
      },
    };

    run.child.stdin.write(JSON.stringify(response) + '\n', (err) => {
      if (err) {
        logger.error(
          `[${run.teamName}] Failed to auto-allow control_request ${requestId}: ${err.message}`
        );
      }
    });
  }

  /**
   * Respond to a pending tool approval — sends control_response to CLI stdin.
   * Validates runId match and requestId existence before writing.
   */
  async respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void> {
    const currentRunId = this.activeByTeam.get(teamName);
    if (!currentRunId) throw new Error(`No active process for team "${teamName}"`);
    const run = this.runs.get(currentRunId);
    if (!run) throw new Error(`Run not found for team "${teamName}"`);

    if (run.runId !== runId) {
      throw new Error(`Stale approval: runId mismatch (expected ${run.runId}, got ${runId})`);
    }

    if (!run.pendingApprovals.has(requestId)) {
      throw new Error(`No pending approval with requestId "${requestId}"`);
    }

    if (!run.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }

    // IMPORTANT: request_id is NESTED inside response, NOT top-level
    // (asymmetry with control_request — confirmed by Python SDK, Elixir SDK and issue #29991)
    const response = allow
      ? {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: { behavior: 'allow' },
          },
        }
      : {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: { behavior: 'deny', message: message ?? 'User denied' },
          },
        };

    const stdin = run.child.stdin;
    await new Promise<void>((resolve, reject) => {
      stdin.write(JSON.stringify(response) + '\n', (err) => {
        if (err) {
          logger.error(`[${teamName}] Failed to write control_response: ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Only delete AFTER successful write
    run.pendingApprovals.delete(requestId);
  }

  /**
   * Called when the first stream-json turn completes successfully.
   * Verifies provisioning files exist and marks as ready.
   * Process stays alive for subsequent tasks.
   */
  private async handleProvisioningTurnComplete(run: ProvisioningRun): Promise<void> {
    // Guard: must be set synchronously BEFORE any await to prevent
    // double-invocation from filesystem monitor + stream-json racing.
    if (
      run.provisioningComplete ||
      run.cancelRequested ||
      run.processKilled ||
      run.progress.state === 'failed'
    )
      return;

    // Prevent false "ready" when auth failure was printed as assistant text or logs
    // but the filesystem monitor observed files on disk.
    const preCompleteText = [
      buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer),
      run.provisioningOutputParts.length > 0 ? run.provisioningOutputParts.join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (
      preCompleteText &&
      this.hasApiError(preCompleteText) &&
      !this.isAuthFailureWarning(preCompleteText)
    ) {
      this.failProvisioningWithApiError(run, preCompleteText);
      return;
    }
    if (preCompleteText && this.isAuthFailureWarning(preCompleteText)) {
      this.handleAuthFailureInOutput(run, preCompleteText, 'pre-complete');
      return;
    }

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

      // Defense in depth: if the CLI (or a stale config) produced auto-suffixed members (alice-2),
      // clean them up so they don't persist and reappear in the UI.
      await this.cleanupCliAutoSuffixedMembers(run.teamName);

      // Best-effort: detect CLI-suffixed member names (alice-2, bob-2) that indicate
      // a stale config.json was present during launch (double-launch race).
      try {
        const postLaunchConfigPath = path.join(getTeamsBasePath(), run.teamName, 'config.json');
        const raw = await tryReadRegularFileUtf8(postLaunchConfigPath, {
          timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
          maxBytes: TEAM_CONFIG_MAX_BYTES,
        });
        if (raw) {
          const config = JSON.parse(raw) as {
            members?: { name?: string; agentType?: string }[];
          };
          const suffixed = (config.members ?? []).filter(
            (m) => typeof m.name === 'string' && /-\d+$/.test(m.name) && m.agentType !== 'team-lead'
          );
          if (suffixed.length > 0) {
            logger.warn(
              `[${run.teamName}] Post-launch: detected suffixed members: ` +
                `${suffixed.map((m) => m.name).join(', ')}. ` +
                'This usually means the team was launched with stale config.json.'
            );
          }
        }
      } catch {
        /* best-effort */
      }

      const readyMessage = 'Team launched — process alive and ready';
      const progress = updateProgress(run, 'ready', readyMessage, {
        cliLogsTail: extractLogsTail(run.stdoutBuffer, run.stderrBuffer),
      });
      run.onProgress(progress);
      logger.info(`[${run.teamName}] Launch complete. Process alive for subsequent tasks.`);

      // Pick up any direct messages that arrived before/while reconnecting.
      void this.relayLeadInboxMessages(run.teamName).catch((e: unknown) =>
        logger.warn(`[${run.teamName}] post-reconnect relay failed: ${String(e)}`)
      );

      // Solo teams have no teammate processes to resume work; kick off task execution
      // as a separate turn AFTER the launch is marked ready so the UI doesn't mix
      // long-running task output into the "Launching team" live output stream.
      if (run.request.members.length === 0) {
        void (async () => {
          try {
            const taskReader = new TeamTaskReader();
            const tasks = await taskReader.getTasks(run.teamName);
            const active = tasks.filter(
              (t) =>
                (t.status === 'pending' || t.status === 'in_progress') &&
                !t.id.startsWith('_internal')
            );
            if (active.length === 0) return;

            const board = buildTaskBoardSnapshot(tasks);
            const message = [
              `Reconnected and ready. Begin executing tasks now.`,
              `Execute tasks sequentially and keep the board + user updated:`,
              `- Identify the next READY task (pending, not blocked by incomplete dependencies).`,
              `- If the task is unassigned, set yourself as owner.`,
              `- BEFORE doing any work on a task: mark it started (in_progress).`,
              `- Immediately SendMessage "user" that you started task #<id> (what you're doing + next step).`,
              `- While working: after each meaningful milestone/decision/blocker, add a task comment on #<id>. If user-relevant, also SendMessage "user".`,
              `- On completion: add a final task comment (what changed + how to verify), mark the task completed, then SendMessage "user" that task #<id> is complete and what you will do next.`,
              `- Do NOT start the next task until the current task is completed (default: one task in_progress at a time).`,
              board.trim(),
            ]
              .filter(Boolean)
              .join('\n\n');

            await this.sendMessageToTeam(run.teamName, message);
          } catch (error) {
            logger.warn(
              `[${run.teamName}] Failed to kick off solo task resumption: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        })();
      }
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
    void this.relayLeadInboxMessages(run.teamName).catch((e: unknown) =>
      logger.warn(`[${run.teamName}] post-provisioning relay failed: ${String(e)}`)
    );
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
    if (run.silentUserDmForwardClearHandle) {
      clearTimeout(run.silentUserDmForwardClearHandle);
      run.silentUserDmForwardClearHandle = null;
    }
    clearPostCompactReminderState(run);
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
    // Dismiss any pending tool approvals for this run
    if (run.pendingApprovals.size > 0) {
      this.emitToolApprovalEvent({ dismissed: true, teamName: run.teamName, runId: run.runId });
      run.pendingApprovals.clear();
    }
    // Remove from runs Map to free memory (stdoutBuffer, stderrBuffer, claudeLogLines)
    this.runs.delete(run.runId);
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
          if (request.members.length === 0) {
            run.fsPhase = 'waiting_tasks';
            const progress = updateProgress(
              run,
              'monitoring',
              'Solo team, skipping member inbox wait'
            );
            run.onProgress(progress);
          } else {
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
    // Best-effort monitor; should not keep the process alive.
    run.fsMonitorHandle.unref();

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
    // Skip if respawn after auth failure is in progress — the old process is being replaced
    if (run.authRetryInProgress) {
      logger.info(
        `[${run.teamName}] Process exited (code ${code ?? '?'}) during auth-failure respawn — ignoring`
      );
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
          const raw = await tryReadRegularFileUtf8(probe.configPath, {
            timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
            maxBytes: TEAM_CONFIG_MAX_BYTES,
          });
          if (!raw) {
            continue;
          }
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
    const isWindows = process.platform === 'win32';
    const home = shellEnv.HOME?.trim() || electronHome;
    let osUsername = '';
    try {
      osUsername = os.userInfo().username;
    } catch {
      // os.userInfo() can throw SystemError in restricted environments (no passwd entry, Docker, etc.)
    }
    const user =
      shellEnv.USER?.trim() ||
      process.env.USER?.trim() ||
      process.env.USERNAME?.trim() ||
      osUsername ||
      'unknown';

    // Shell: on Windows there is no SHELL env var; use COMSPEC (cmd.exe / powershell).
    // On Unix, prefer the user's login shell from env or fall back to /bin/zsh.
    const shell = isWindows
      ? (process.env.COMSPEC ?? 'powershell.exe')
      : shellEnv.SHELL?.trim() || process.env.SHELL?.trim() || '/bin/zsh';

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...shellEnv,
      HOME: home,
      USERPROFILE: home,
      USER: user,
      LOGNAME: shellEnv.LOGNAME?.trim() || process.env.LOGNAME?.trim() || user,
      TERM: shellEnv.TERM?.trim() || process.env.TERM?.trim() || 'xterm-256color',
      // Ensure CLI reads/writes from the same Claude root as the app.
      // This aligns teams/tasks locations when the app overrides claudeRootPath.
      CLAUDE_CONFIG_DIR: getClaudeBasePath(),
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    };

    // SHELL is a Unix concept — only set it on non-Windows platforms.
    if (!isWindows) {
      env.SHELL = shell;
    }

    // XDG directories are a freedesktop.org (Linux/macOS) convention.
    // On Windows, these are unused by most tools and can cause confusion.
    if (!isWindows) {
      const xdgConfigHome =
        shellEnv.XDG_CONFIG_HOME?.trim() ||
        process.env.XDG_CONFIG_HOME?.trim() ||
        `${home}/.config`;
      const xdgStateHome =
        shellEnv.XDG_STATE_HOME?.trim() ||
        process.env.XDG_STATE_HOME?.trim() ||
        `${home}/.local/state`;
      env.XDG_CONFIG_HOME = xdgConfigHome;
      env.XDG_STATE_HOME = xdgStateHome;
    }

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

    // 3. No explicit API key — let the CLI handle its own OAuth auth.
    //    Claude CLI reads credentials from its own storage and refreshes
    //    tokens in-memory. Injecting CLAUDE_CODE_OAUTH_TOKEN from the
    //    credentials file causes 401 errors because the stored token is
    //    often stale (CLI refreshes in-memory but rarely writes back).
    return { env, authSource: 'none' };
  }

  /**
   * Immediately update projectPath in config.json at launch start, before CLI spawn.
   * Ensures TeamDetailView shows the correct project path even if provisioning
   * is interrupted. On failure, restorePrelaunchConfig() reverts to the backup.
   */
  private async updateConfigProjectPath(teamName: string, cwd: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!raw) {
        throw new Error('config.json unreadable');
      }
      const config = JSON.parse(raw) as Record<string, unknown>;

      config.projectPath = cwd;

      const pathHistory = Array.isArray(config.projectPathHistory)
        ? (config.projectPathHistory as string[]).filter((p) => typeof p === 'string' && p !== cwd)
        : [];
      pathHistory.push(cwd);
      config.projectPathHistory = pathHistory.slice(-500);

      await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
      logger.info(`[${teamName}] Updated config.projectPath immediately: ${cwd}`);
    } catch (error) {
      // Non-fatal: updateConfigPostLaunch will update it later if provisioning succeeds.
      logger.warn(
        `[${teamName}] Failed to update projectPath early: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!raw) {
        throw new Error('config.json unreadable');
      }
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

  private async cleanupCliAutoSuffixedMembers(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');

    const removedFromConfig: string[] = [];
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const membersRaw = Array.isArray(parsed.members)
          ? (parsed.members as Record<string, unknown>[])
          : [];
        if (membersRaw.length > 0) {
          const teammateNames = membersRaw
            .map((m) => (typeof m.name === 'string' ? m.name.trim() : ''))
            .filter(
              (n) => n.length > 0 && n.toLowerCase() !== 'team-lead' && n.toLowerCase() !== 'user'
            );

          const keepName = createCliAutoSuffixNameGuard(teammateNames);
          const nextMembers: Record<string, unknown>[] = [];
          for (const m of membersRaw) {
            const name = typeof m.name === 'string' ? m.name.trim() : '';
            const agentType = typeof m.agentType === 'string' ? m.agentType : '';
            if (!name) continue;
            if (agentType === 'team-lead' || name === 'team-lead' || name === 'user') {
              nextMembers.push(m);
              continue;
            }
            if (!keepName(name)) {
              removedFromConfig.push(name);
              continue;
            }
            nextMembers.push(m);
          }

          if (removedFromConfig.length > 0) {
            parsed.members = nextMembers;
            await atomicWriteAsync(configPath, JSON.stringify(parsed, null, 2));
            logger.warn(
              `[${teamName}] Removed CLI auto-suffixed members from config.json: ${removedFromConfig.join(', ')}`
            );
          }
        }
      }
    } catch {
      // best-effort
    }

    let activeNamesForInboxCleanup = new Set<string>();
    try {
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      if (metaMembers.length > 0) {
        const activeNames = metaMembers
          .filter((m) => !m.removedAt)
          .map((m) => m.name.trim())
          .filter(
            (n) => n.length > 0 && n.toLowerCase() !== 'team-lead' && n.toLowerCase() !== 'user'
          );

        const keepName = createCliAutoSuffixNameGuard(activeNames);
        const removedFromMeta: string[] = [];
        const nextMeta = metaMembers.filter((m) => {
          const name = m.name?.trim() ?? '';
          if (!name) return false;
          const lower = name.toLowerCase();
          if (lower === 'team-lead' || lower === 'user' || m.agentType === 'team-lead') return true;
          if (!m.removedAt && !keepName(name)) {
            removedFromMeta.push(name);
            return false;
          }
          return true;
        });

        if (removedFromMeta.length > 0) {
          await this.membersMetaStore.writeMembers(teamName, nextMeta);
          logger.warn(
            `[${teamName}] Removed CLI auto-suffixed members from members.meta.json: ${removedFromMeta.join(', ')}`
          );
        }

        activeNamesForInboxCleanup = new Set(
          nextMeta
            .filter((m) => !m.removedAt)
            .map((m) => m.name.trim())
            .filter(
              (n) => n.length > 0 && n.toLowerCase() !== 'team-lead' && n.toLowerCase() !== 'user'
            )
        );
      }
    } catch {
      // best-effort
    }

    // Also attempt inbox cleanup (merge alice-2.json into alice.json).
    if (activeNamesForInboxCleanup.size > 0) {
      try {
        await this.mergeAndRemoveDuplicateInboxes(teamName, activeNamesForInboxCleanup);
      } catch {
        // best-effort
      }
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

  private async assertConfigLeadOnlyForLaunch(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const raw = await tryReadRegularFileUtf8(configPath, {
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_CONFIG_MAX_BYTES,
    });
    if (!raw) {
      throw new Error('config.json unreadable');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('config.json could not be parsed');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('config.json has invalid shape');
    }

    const config = parsed as Record<string, unknown>;
    const members = Array.isArray(config.members)
      ? (config.members as Record<string, unknown>[])
      : [];
    if (members.length === 0) return;

    for (const member of members) {
      const name = typeof member.name === 'string' ? member.name.trim() : '';
      if (!name) continue;
      const lower = name.toLowerCase();
      const agentType = typeof member.agentType === 'string' ? member.agentType : '';

      if (agentType === 'team-lead' || lower === 'team-lead' || lower === 'user') continue;

      const leadAgentId = config.leadAgentId;
      if (
        typeof leadAgentId === 'string' &&
        typeof member.agentId === 'string' &&
        member.agentId === leadAgentId
      ) {
        continue;
      }

      throw new Error(
        `Refusing to launch: config.json still contains teammates (e.g. "${name}"), which can trigger CLI auto-suffixes like "${name}-2".`
      );
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
        const lower = name.toLowerCase();
        if (name.length > 0 && !member.removedAt && lower !== 'team-lead' && lower !== 'user') {
          baseNames.add(name);
        }
      }
    } catch {
      // ignore
    }
    if (baseNames.size === 0) {
      const allConfigNames = new Set<string>();
      for (const member of members) {
        const name = typeof member.name === 'string' ? member.name.trim() : '';
        const agentType = typeof member.agentType === 'string' ? member.agentType : '';
        if (
          name &&
          agentType &&
          agentType !== 'team-lead' &&
          name !== 'team-lead' &&
          name !== 'user'
        ) {
          allConfigNames.add(name);
        }
      }
      const allConfigNamesLower = new Set(Array.from(allConfigNames).map((n) => n.toLowerCase()));
      for (const name of allConfigNames) {
        const match = /^(.+)-(\d+)$/.exec(name);
        if (!match?.[1] || !match[2]) {
          baseNames.add(name);
          continue;
        }
        const suffix = Number(match[2]);
        // Only exclude CLI-suffixed names (alice-2) when the base name (alice) also exists
        // (and only for -2+ to avoid excluding legitimate "dev-1"-style names).
        if (!Number.isFinite(suffix) || suffix < 2) {
          baseNames.add(name);
          continue;
        }
        if (!allConfigNamesLower.has(match[1].toLowerCase())) {
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
      const backupRaw = await tryReadRegularFileUtf8(backupPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!backupRaw) {
        return;
      }
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
        const raw = await tryReadRegularFileUtf8(canonicalPath, {
          timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
          maxBytes: TEAM_INBOX_MAX_BYTES,
        });
        if (!raw) {
          continue;
        }
        canonicalRaw = raw;
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
          const raw = await tryReadRegularFileUtf8(dupPath, {
            timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
            maxBytes: TEAM_INBOX_MAX_BYTES,
          });
          if (!raw) {
            continue;
          }
          dupRaw = raw;
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
    const teammateMembers = request.members.filter((member) => {
      const trimmed = member.name.trim();
      const lower = trimmed.toLowerCase();
      return trimmed.length > 0 && lower !== 'team-lead' && lower !== 'user';
    });
    if (teammateMembers.length === 0) {
      return;
    }

    const joinedAt = Date.now();

    try {
      await this.membersMetaStore.writeMembers(
        teamName,
        teammateMembers.map((member, index) => ({
          name: member.name.trim(),
          role: member.role?.trim() || undefined,
          workflow: member.workflow?.trim() || undefined,
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
        const rawName = member.name?.trim() ?? '';
        const lower = rawName.toLowerCase();
        if (member.agentType === 'team-lead' || lower === 'team-lead' || lower === 'user') {
          continue;
        }
        const name = rawName;
        if (!name) continue;
        if (member.removedAt) continue;
        const role = typeof member.role === 'string' ? member.role.trim() || undefined : undefined;
        const workflow =
          typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined;
        const prev = byName.get(name);
        if (!prev) {
          byName.set(name, { name, role, workflow });
        } else {
          byName.set(name, {
            ...prev,
            role: prev.role || role,
            workflow: prev.workflow || workflow,
          });
        }
      }
      // Defense: ignore CLI auto-suffixed duplicates (alice-2) when base name exists.
      const allNames = Array.from(byName.keys());
      const keepName = createCliAutoSuffixNameGuard(allNames);
      for (const name of allNames) {
        if (!keepName(name)) {
          byName.delete(name);
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
      const allInboxNames = Array.from(
        new Set(
          (await this.inboxReader.listInboxNames(teamName))
            .map((name) => name.trim())
            .filter((name) => name.length > 0)
        )
      );
      const inboxNameSetLower = new Set(allInboxNames.map((n) => n.toLowerCase()));
      const inboxNames = allInboxNames
        .filter((name) => name !== 'team-lead' && name !== 'user')
        .filter((name) => {
          const match = /^(.+)-(\d+)$/.exec(name);
          if (!match?.[1] || !match[2]) return true;
          const suffix = Number(match[2]);
          // Only filter CLI-suffixed names (alice-2) when the base name (alice) also exists.
          // Important: do NOT filter names like dev-1 (common intentional naming). Only consider -2+ as auto-suffix.
          if (!Number.isFinite(suffix) || suffix < 2) return true;
          return !inboxNameSetLower.has(match[1].toLowerCase());
        });
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

    let configParseFailed = false;
    try {
      JSON.parse(configRaw);
    } catch {
      configParseFailed = true;
    }

    return {
      members: [],
      source: 'config-fallback',
      ...(configParseFailed
        ? {
            warning:
              'Config could not be parsed during launch roster discovery. ' +
              'Launch will continue without explicit teammate names.',
          }
        : {}),
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
        const rawName = typeof member?.name === 'string' ? member.name.trim() : '';
        const lower = rawName.toLowerCase();
        if (
          !member ||
          member.agentType === 'team-lead' ||
          lower === 'team-lead' ||
          lower === 'user'
        )
          continue;
        const name = rawName;
        if (!name) continue;
        byName.set(name, { name });
      }
      // Defense: ignore CLI auto-suffixed duplicates (alice-2) when base name exists.
      const allNames = Array.from(byName.keys());
      const keepName = createCliAutoSuffixNameGuard(allNames);
      for (const name of allNames) {
        if (!keepName(name)) {
          byName.delete(name);
        }
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
   *    (currently disabled for speed; keep commented for debugging)
   * 2. `claude -p "ping"` — verifies that `-p` mode is actually authenticated.
   *    This catches the common case where interactive `claude` works (OAuth/keychain)
   *    but `-p` mode fails with "Not logged in" due to missing env vars.
   */
  private async probeClaudeRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ warning?: string }> {
    // Stage 1: verify binary works (awaited first for clearer errors)
    // Important: keep this sequential with Stage 2 to avoid auth/credential-store races
    // when multiple `claude` processes start simultaneously (most visible on Windows).
    // const versionProbe = await this.spawnProbe(
    //   claudePath,
    //   ['--version'],
    //   cwd,
    //   env,
    //   CLI_PREPARE_TIMEOUT_MS
    // );
    // if (versionProbe.exitCode !== 0) {
    //   const errorText =
    //     buildCombinedLogs(versionProbe.stdout, versionProbe.stderr) ||
    //     `Claude CLI exited with code ${versionProbe.exitCode ?? 'unknown'} during warm-up`;
    //   throw new Error(`Failed to warm up Claude CLI: ${errorText}`);
    // }

    // Stage 2: verify `-p` mode auth actually works (with retry for stale locks after Ctrl+C)
    for (let attempt = 1; attempt <= PREFLIGHT_AUTH_MAX_RETRIES; attempt++) {
      let pingProbe: { exitCode: number | null; stdout: string; stderr: string } | null = null;
      try {
        pingProbe = await this.spawnProbe(
          claudePath,
          [...PREFLIGHT_PING_ARGS],
          cwd,
          env,
          PREFLIGHT_TIMEOUT_MS,
          {
            resolveOnOutputMatch: ({ stdout, stderr }) => {
              const combined = `${stdout}\n${stderr}`.trim();
              return /\bPONG\b/i.test(combined);
            },
          }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < PREFLIGHT_AUTH_MAX_RETRIES) {
          logger.warn(
            `Preflight ping failed (attempt ${attempt}/${PREFLIGHT_AUTH_MAX_RETRIES}), ` +
              `retrying in ${PREFLIGHT_AUTH_RETRY_DELAY_MS}ms: ${message}`
          );
          await new Promise((resolve) => setTimeout(resolve, PREFLIGHT_AUTH_RETRY_DELAY_MS));
          continue;
        }
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

      if (isAuthFailure && attempt < PREFLIGHT_AUTH_MAX_RETRIES) {
        logger.warn(
          `Preflight auth failure detected (attempt ${attempt}/${PREFLIGHT_AUTH_MAX_RETRIES}), ` +
            `retrying in ${PREFLIGHT_AUTH_RETRY_DELAY_MS}ms — likely stale locks from interrupted process`
        );
        await new Promise((resolve) => setTimeout(resolve, PREFLIGHT_AUTH_RETRY_DELAY_MS));
        continue;
      }

      if (isAuthFailure || pingProbe.exitCode !== 0) {
        const hint = isAuthFailure
          ? 'Claude CLI `-p` mode is not authenticated. ' +
            'Run `claude auth login` (or start `claude` and run `/login`) to authenticate. ' +
            'For automation/headless use, set ANTHROPIC_API_KEY.' +
            (attempt > 1 ? ` (failed after ${attempt} attempts)` : '')
          : `Claude CLI preflight check failed (exit code ${pingProbe.exitCode ?? 'unknown'}).`;
        return { warning: hint };
      }

      const pongCandidate = pingProbe.stdout.trim() || pingProbe.stderr.trim();
      const isPong = new RegExp(`\\b${PREFLIGHT_EXPECTED}\\b`, 'i').test(pongCandidate);
      if (!isPong) {
        return {
          warning:
            'Preflight ping completed but did not return the expected PONG. ' +
            `Output: ${combinedOutput || '(empty)'}`,
        };
      }

      if (attempt > 1) {
        logger.info(
          `Preflight auth succeeded on attempt ${attempt} (previous attempt had auth failure)`
        );
      }
      return {};
    }

    return {};
  }

  private async spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    options?: {
      /**
       * Optional early success predicate. If this returns true based on
       * buffered stdout/stderr, the probe resolves immediately (and the process
       * is best-effort terminated) instead of waiting for `close`.
       */
      resolveOnOutputMatch?: (ctx: { stdout: string; stderr: string }) => boolean;
    }
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawnCli(claudePath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdoutText = '';
      let stderrText = '';
      let settled = false;

      const timeoutHandle = setTimeout(() => {
        settled = true;
        killProcessTree(child);
        reject(new Error(`Timeout running: claude ${args.join(' ')}`));
      }, timeoutMs);

      const maybeResolveEarly = (): void => {
        if (settled) return;
        if (!options?.resolveOnOutputMatch) return;
        const ctx = { stdout: stdoutText.trim(), stderr: stderrText.trim() };
        if (!options.resolveOnOutputMatch(ctx)) return;

        settled = true;
        clearTimeout(timeoutHandle);
        // If the process printed the match but hangs during teardown, don't
        // block the UI; terminate best-effort and resolve.
        killProcessTree(child);
        resolve({ exitCode: 0, stdout: ctx.stdout, stderr: ctx.stderr });
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutText += chunk.toString('utf8');
        maybeResolveEarly();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8');
        maybeResolveEarly();
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });
      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({
          exitCode,
          stdout: stdoutText.trim(),
          stderr: stderrText.trim(),
        });
      });
    });
  }
}
/* eslint-enable no-param-reassign -- Re-enable after TeamProvisioningService class */
