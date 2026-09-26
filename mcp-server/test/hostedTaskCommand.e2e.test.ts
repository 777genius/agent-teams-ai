import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverEntry = path.join(repoRoot, 'mcp-server', 'dist', 'index.js');
const goldenPath = path.join(repoRoot, 'docs', 'hosted-task-command-golden.json');
const controllerRequire = createRequire(path.join(repoRoot, 'agent-teams-controller', 'package.json'));
const identity = controllerRequire('./src/internal/hostedBoardIdentity.js') as {
  hostedTaskBoardSourceGeneration(input: Record<string, unknown>): string;
  hostedTaskBoardRevision(input: Record<string, unknown>): string;
  hostedTaskBoardTaskId(teamId: string, rawTaskId: string): string;
  hostedTaskIdForCommand(teamId: string, commandId: string): string;
};

const TEAM = 'golden-team';
const TEAM_ID = `team_${'c'.repeat(32)}`;
const BOARD = { deploymentId: 'deployment_golden', bootId: 'boot_golden', workspaceId: 'workspace_golden', mountGeneration: 1, teamId: TEAM_ID };
const FINGERPRINT = 'F'.repeat(43);
const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';
const TASK_C = '33333333-3333-4333-8333-333333333333';
const BOB = 'member_b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const publicId = (rawId: string) => identity.hostedTaskBoardTaskId(TEAM_ID, rawId);

type Json = Record<string, unknown>;
interface GoldenCase {
  name: string;
  input: Json;
  exitCode: number;
  output: Json;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function task(id: string, subject: string, extra: Json = {}): string {
  return `${JSON.stringify({ id, displayId: id.slice(0, 8), subject, description: subject, status: 'pending', blocks: [], blockedBy: [], reviewState: 'none', ...extra }, null, 2)}\n`;
}

/** One small board: bob owns A, B is completed, C is blocked by A. */
function makeBoard(): string {
  const claudeDir = mkdtempSync(path.join(os.tmpdir(), 'hosted-task-command-golden-'));
  tempDirs.push(claudeDir);
  const teamDir = path.join(claudeDir, 'teams', TEAM);
  const tasksDir = path.join(claudeDir, 'tasks', TEAM);
  mkdirSync(teamDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify({ name: TEAM, members: [{ name: 'team-lead', agentType: 'team-lead' }, { name: 'bob', memberId: BOB }] }, null, 2));
  writeFileSync(path.join(tasksDir, `${TASK_A}.json`), task(TASK_A, 'Alpha', { owner: 'bob', blocks: [TASK_C] }));
  writeFileSync(path.join(tasksDir, `${TASK_B}.json`), task(TASK_B, 'Beta', { status: 'completed' }));
  writeFileSync(path.join(tasksDir, `${TASK_C}.json`), task(TASK_C, 'Gamma', { blockedBy: [TASK_A] }));
  return claudeDir;
}

function boardIdentity(claudeDir: string): { sourceGeneration: string; revision: string } {
  const directory = (dir: string) => {
    const stat = lstatSync(dir, { bigint: true });
    return [stat.dev.toString(), stat.ino.toString()];
  };
  const teamDir = path.join(claudeDir, 'teams', TEAM);
  const tasksDir = path.join(claudeDir, 'tasks', TEAM);
  const read = (file: string) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const sourceGeneration = identity.hostedTaskBoardSourceGeneration({ ...BOARD, teamDirectory: directory(teamDir), tasksDirectory: directory(tasksDir) });
  return {
    sourceGeneration,
    revision: identity.hostedTaskBoardRevision({
      sourceGeneration,
      taskFiles: readdirSync(tasksDir).filter((name) => name.endsWith('.json')).map((name) => ({ name, text: read(path.join(tasksDir, name)) })),
      kanbanText: read(path.join(teamDir, 'kanban-state.json')),
      rosterFiles: ['config.json', 'members.meta.json'].map((name) => ({ name, text: read(path.join(teamDir, name)) })),
    }),
  };
}

/** Live identities replaced by stable tokens so the golden is machine-independent. */
function normalize(value: unknown, tokens: Map<string, string>): unknown {
  if (typeof value === 'string') {
    if (tokens.has(value)) return tokens.get(value);
    if (/^generation_[0-9a-f]{64}$/.test(value)) return 'generation_golden';
    if (/^revision_[0-9a-f]{64}$/.test(value)) {
      const token = `revision_golden-${tokens.size}`;
      tokens.set(value, token);
      return token;
    }
    if (/^[0-9a-f]{64}$/.test(value)) return '0'.repeat(64);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, tokens));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, tokens)]));
  }
  return value;
}

function runChild(claudeDir: string, input: string): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverEntry, '--hosted-task-command'], {
      cwd: claudeDir,
      env: { AGENT_TEAMS_MCP_CLAUDE_DIR: claudeDir, PATH: '/usr/bin:/bin', HOME: os.homedir() },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ exitCode, stdout }));
    child.stdin.end(input);
  });
}

function request(claudeDir: string, command: Json, overrides: { expectedRevision?: string; expectedSourceGeneration?: string; payloadFingerprint?: string } = {}): Json {
  const live = boardIdentity(claudeDir);
  return {
    schemaVersion: 1,
    kind: 'hosted_task_command',
    teamName: TEAM,
    board: BOARD,
    lead: { name: 'team-lead', sessionId: null },
    lockTimeoutMs: 500,
    payloadFingerprint: overrides.payloadFingerprint ?? FINGERPRINT,
    command: {
      schemaVersion: 1,
      commandId: 'command_golden-1',
      idempotencyKey: 'golden-1',
      teamId: TEAM_ID,
      expectedSourceGeneration: overrides.expectedSourceGeneration ?? live.sourceGeneration,
      expectedRevision: overrides.expectedRevision ?? live.revision,
      ...command,
    },
  };
}

const create = { kind: 'create_task', subject: 'Golden task', description: null, status: 'pending', ownerId: BOB, column: 'todo', order: 0 };

/** Each case runs on a fresh board; `before` prepares it with earlier child calls. */
const CASES: Array<{ name: string; before?: Json[]; command: Json; overrides?: Parameters<typeof request>[2]; holdLock?: boolean; raw?: string }> = [
  { name: 'create_task committed', command: create },
  { name: 'create_task idempotent_replay', before: [create], command: create },
  { name: 'create_task idempotency_mismatch', before: [create], command: create, overrides: { payloadFingerprint: 'G'.repeat(43) } },
  { name: 'create_task state_conflict for a review column', command: { ...create, status: 'completed', column: 'review' } },
  { name: 'update_details committed', command: { kind: 'update_details', taskId: publicId(TASK_A), subject: 'Alpha 2', description: null } },
  { name: 'update_owner committed', command: { kind: 'update_owner', taskId: publicId(TASK_B), ownerId: BOB } },
  { name: 'update_status committed', command: { kind: 'update_status', taskId: publicId(TASK_A), status: 'in_progress' } },
  { name: 'update_status noop committed', command: { kind: 'update_status', taskId: publicId(TASK_A), status: 'pending' }, overrides: { expectedRevision: `revision_${'9'.repeat(64)}` } },
  { name: 'move_task done committed', command: { kind: 'move_task', taskId: publicId(TASK_A), column: 'done', order: 0 } },
  { name: 'move_task review committed', command: { kind: 'move_task', taskId: publicId(TASK_B), column: 'review', order: 0 } },
  { name: 'move_task approved committed', command: { kind: 'move_task', taskId: publicId(TASK_B), column: 'approved', order: 0 } },
  { name: 'move_task review state_conflict for an open task', command: { kind: 'move_task', taskId: publicId(TASK_A), column: 'review', order: 0 } },
  { name: 'move_task relationship_conflict', command: { kind: 'move_task', taskId: publicId(TASK_C), column: 'in_progress', order: 0 } },
  { name: 'reorder_column committed', command: { kind: 'reorder_column', column: 'todo', orderedTaskIds: [publicId(TASK_C), publicId(TASK_A)] } },
  { name: 'reorder_column state_conflict', command: { kind: 'reorder_column', column: 'todo', orderedTaskIds: [publicId(TASK_A)] } },
  { name: 'not_found', command: { kind: 'update_status', taskId: `task_${'0'.repeat(32)}`, status: 'completed' } },
  { name: 'stale_generation', command: create, overrides: { expectedSourceGeneration: `generation_${'1'.repeat(64)}` } },
  { name: 'stale_revision', command: { kind: 'update_status', taskId: publicId(TASK_A), status: 'completed' }, overrides: { expectedRevision: `revision_${'1'.repeat(64)}` } },
  { name: 'unavailable while the board lock is held', command: create, holdLock: true },
  { name: 'invalid_request', command: create, raw: '{"schemaVersion":1}' },
];

async function runCase(entry: (typeof CASES)[number]): Promise<GoldenCase> {
  const claudeDir = makeBoard();
  for (const command of entry.before ?? []) await runChild(claudeDir, JSON.stringify(request(claudeDir, command)));
  const input = request(claudeDir, entry.command, entry.overrides);
  const text = entry.raw ?? JSON.stringify(input);
  let result;
  if (entry.holdLock) {
    const lockScope = path.join(claudeDir, 'teams', TEAM, 'board-state');
    const holder = spawn(
      process.execPath,
      ['-e', `require(${JSON.stringify(controllerRequire.resolve('./src/internal/fileLock.js'))}).withFileLockSync(${JSON.stringify(lockScope)}, () => { process.stdout.write('held\\n'); const end = Date.now() + 3000; while (Date.now() < end) {} })`],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    try {
      result = await runChild(claudeDir, text);
    } finally {
      holder.kill();
    }
  } else {
    result = await runChild(claudeDir, text);
  }
  const tokens = new Map<string, string>();
  const normalizedInput = normalize(entry.raw ? JSON.parse(entry.raw) : input, tokens) as Json;
  return { name: entry.name, input: normalizedInput, exitCode: result.exitCode ?? -1, output: normalize(JSON.parse(result.stdout), tokens) as Json };
}

describe('--hosted-task-command golden', () => {
  it('matches docs/hosted-task-command-golden.json for every kind and result code', async () => {
    const cases: GoldenCase[] = [];
    for (const entry of CASES) cases.push(await runCase(entry));
    if (process.env.UPDATE_HOSTED_TASK_COMMAND_GOLDEN === '1') {
      const existing = JSON.parse(readFileSync(goldenPath, 'utf8')) as Json;
      writeFileSync(goldenPath, `${JSON.stringify({ ...existing, cases }, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { cases: GoldenCase[] };
    expect(cases).toEqual(golden.cases);
  }, 60_000);
});
