/**
 * Integration tests for teamctl.js — the CLI tool agents use to manage tasks,
 * kanban state, messages, reviews, and processes.
 *
 * Strategy:
 *   1. Use TeamAgentToolsInstaller.ensureInstalled() to write the real script.
 *   2. Create a temp directory with --claude-dir for full isolation.
 *   3. Use child_process.execFileSync (no shell) to run commands.
 *   4. Assert on stdout, stderr, exit codes, and written JSON files.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Temp root for all tests. Cleaned up in afterAll. */
let tmpRoot: string;

/** Path to the installed teamctl.js script. */
let scriptPath: string;

const TEAM = 'test-team';

/** Create a fresh claude-dir structure for a single test. */
function makeFreshClaudeDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'claude-'));
  const teamsDir = path.join(dir, 'teams', TEAM);
  const tasksDir = path.join(dir, 'tasks', TEAM);
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  // Minimal config.json
  const config = {
    name: TEAM,
    description: 'Test team',
    members: [
      { name: 'alice', role: 'team-lead' },
      { name: 'bob', role: 'developer' },
    ],
  };
  fs.writeFileSync(path.join(teamsDir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

/** Write a task fixture into the tasks dir. */
function writeTask(claudeDir: string, id: string, task: Record<string, unknown>): void {
  const tasksDir = path.join(claudeDir, 'tasks', TEAM);
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, `${id}.json`), JSON.stringify(task, null, 2));
}

/** Read a task from disk. */
function readTask(claudeDir: string, id: string): Record<string, unknown> {
  const filePath = path.join(claudeDir, 'tasks', TEAM, `${id}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Read kanban state from disk. */
function readKanban(claudeDir: string): Record<string, unknown> {
  const filePath = path.join(claudeDir, 'teams', TEAM, 'kanban-state.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/** Read inbox messages for a member. */
function readInbox(claudeDir: string, member: string): unknown[] {
  const filePath = path.join(claudeDir, 'teams', TEAM, 'inboxes', `${member}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run teamctl.js and return stdout, stderr, exitCode. */
function run(claudeDir: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath, // node binary
      [scriptPath, '--claude-dir', claudeDir, '--team', TEAM, ...args],
      { encoding: 'utf8', timeout: 10_000 }
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Suppress console.error/warn mocks from setup.ts — we use real child processes
  vi.restoreAllMocks();

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamctl-test-'));

  // Mock getToolsBasePath to use our temp directory (setup.ts stubs HOME to /home/testuser)
  const toolsDir = path.join(tmpRoot, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  vi.doMock('@main/utils/pathDecoder', async (importOriginal) => {
    const orig = await importOriginal<typeof import('@main/utils/pathDecoder')>();
    return { ...orig, getToolsBasePath: () => toolsDir };
  });

  // Install the real teamctl.js script using the installer class.
  const { TeamAgentToolsInstaller } = await import('@main/services/team/TeamAgentToolsInstaller');
  const installer = new TeamAgentToolsInstaller();
  scriptPath = await installer.ensureInstalled();
});

afterAll(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('teamctl.js', () => {
  let claudeDir: string;

  beforeEach(() => {
    // Suppress console spies from global setup
    vi.restoreAllMocks();
    claudeDir = makeFreshClaudeDir();
  });

  // ---- Help ----
  describe('help', () => {
    it('prints help with --help flag', () => {
      const { stdout, exitCode } = run(claudeDir, ['--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('teamctl.js v');
      expect(stdout).toContain('Usage:');
      expect(stdout).toContain('task set-status');
      expect(stdout).toContain('task set-clarification');
    });

    it('prints help with no arguments', () => {
      const { stdout, exitCode } = run(claudeDir, []);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage:');
    });
  });

  // ---- Task Create ----
  describe('task create', () => {
    it('creates a task with minimal fields', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'create', '--subject', 'My first task']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.id).toBe('1');
      expect(parsed.subject).toBe('My first task');
      expect(parsed.status).toBe('pending');
      expect(parsed.owner).toBeUndefined();

      // Verify file on disk
      const onDisk = readTask(claudeDir, '1');
      expect(onDisk.subject).toBe('My first task');
    });

    it('creates a task with owner → status defaults to in_progress', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Owned task',
        '--owner',
        'bob',
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.owner).toBe('bob');
      expect(parsed.status).toBe('in_progress');
    });

    it('respects explicit status even with owner', () => {
      const { stdout } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Pending owned',
        '--owner',
        'bob',
        '--status',
        'pending',
      ]);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe('pending');
      expect(parsed.owner).toBe('bob');
    });

    it('increments task IDs', () => {
      run(claudeDir, ['task', 'create', '--subject', 'Task 1']);
      const { stdout } = run(claudeDir, ['task', 'create', '--subject', 'Task 2']);
      const parsed = JSON.parse(stdout);
      expect(parsed.id).toBe('2');
    });

    it('creates task with description, activeForm, and from', () => {
      const { stdout } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Complex task',
        '--description',
        'Do something important',
        '--active-form',
        'Working on complex task',
        '--from',
        'alice',
      ]);
      const parsed = JSON.parse(stdout);
      expect(parsed.description).toBe('Do something important');
      expect(parsed.activeForm).toBe('Working on complex task');
      expect(parsed.createdBy).toBe('alice');
    });

    it('fails without --subject', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'create']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --subject');
    });

    it('sends inbox notification with --notify and --owner', () => {
      run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Assigned task',
        '--owner',
        'bob',
        '--notify',
        '--from',
        'alice',
      ]);
      const inbox = readInbox(claudeDir, 'bob');
      expect(inbox.length).toBe(1);
      const msg = inbox[0] as Record<string, unknown>;
      expect(msg.from).toBe('alice');
      expect(String(msg.text)).toContain('New task assigned');
    });
  });

  // ---- Task Set-Status ----
  describe('task set-status', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Test task',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      });
    });

    it('changes status to in_progress', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'set-status', '1', 'in_progress']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('status=in_progress');
      const task = readTask(claudeDir, '1');
      expect(task.status).toBe('in_progress');
    });

    it('changes status to completed', () => {
      const { stdout } = run(claudeDir, ['task', 'set-status', '1', 'completed']);
      expect(stdout).toContain('status=completed');
      expect(readTask(claudeDir, '1').status).toBe('completed');
    });

    it('changes status to deleted', () => {
      run(claudeDir, ['task', 'set-status', '1', 'deleted']);
      expect(readTask(claudeDir, '1').status).toBe('deleted');
    });

    it('fails on invalid status', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-status', '1', 'invalid']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Invalid status');
    });

    it('fails on missing task', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-status', '999', 'pending']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Task not found');
    });
  });

  // ---- Task Start / Complete shortcuts ----
  describe('task start / complete', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Task', status: 'pending' });
    });

    it('task start sets in_progress', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'start', '1']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('status=in_progress');
      expect(readTask(claudeDir, '1').status).toBe('in_progress');
    });

    it('task complete sets completed', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'complete', '1']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('status=completed');
      expect(readTask(claudeDir, '1').status).toBe('completed');
    });

    it('task done is alias for complete', () => {
      // Override the team flag resolution — run with minimal args
      const result = run(claudeDir, ['task', 'done', '1']);
      expect(result.exitCode).toBe(0);
      expect(readTask(claudeDir, '1').status).toBe('completed');
    });
  });

  // ---- Task Get / List ----
  describe('task get / list', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', { id: '1', subject: 'First', status: 'pending' });
      writeTask(claudeDir, '2', { id: '2', subject: 'Second', status: 'in_progress' });
    });

    it('gets a single task by ID', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'get', '1']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.subject).toBe('First');
      expect(parsed.id).toBe('1');
    });

    it('lists all tasks', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'list']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as Record<string, unknown>[];
      expect(parsed).toHaveLength(2);
      expect(parsed.map((t) => t.id)).toEqual(['1', '2']);
    });

    it('fails on task get with missing ID', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'get']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });
  });

  // ---- Task Comment ----
  describe('task comment', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Commentable task',
        status: 'in_progress',
        owner: 'bob',
        comments: [],
      });
    });

    it('adds a comment to a task', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'task',
        'comment',
        '1',
        '--text',
        'Hello world',
        '--from',
        'alice',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('comment added');
      const task = readTask(claudeDir, '1');
      const comments = task.comments as Record<string, unknown>[];
      expect(comments).toHaveLength(1);
      expect(comments[0].text).toBe('Hello world');
      expect(comments[0].author).toBe('alice');
    });

    it('defaults author to "agent" when --from is not specified', () => {
      run(claudeDir, ['task', 'comment', '1', '--text', 'No author']);
      const task = readTask(claudeDir, '1');
      const comments = task.comments as Record<string, unknown>[];
      expect(comments[0].author).toBe('agent');
    });

    it('sends inbox notification to owner (skip self-notification)', () => {
      // alice comments on bob's task → bob gets notified
      run(claudeDir, ['task', 'comment', '1', '--text', 'Review this', '--from', 'alice']);
      const inbox = readInbox(claudeDir, 'bob');
      expect(inbox.length).toBe(1);

      // bob comments on own task → no notification
      run(claudeDir, ['task', 'comment', '1', '--text', 'Self note', '--from', 'bob']);
      const inbox2 = readInbox(claudeDir, 'bob');
      expect(inbox2.length).toBe(1); // still 1
    });

    it('fails without --text', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'comment', '1']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --text');
    });
  });

  // ---- Comment Auto-Clear needsClarification ----
  describe('comment auto-clear needsClarification', () => {
    it('clears "lead" when non-owner comments', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Blocked task',
        status: 'in_progress',
        owner: 'bob',
        needsClarification: 'lead',
        comments: [],
      });

      // alice (not owner) comments → auto-clear
      run(claudeDir, ['task', 'comment', '1', '--text', 'Here is the answer', '--from', 'alice']);
      const task = readTask(claudeDir, '1');
      expect(task.needsClarification).toBeUndefined();
    });

    it('does NOT clear "lead" when owner comments', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Blocked task',
        status: 'in_progress',
        owner: 'bob',
        needsClarification: 'lead',
        comments: [],
      });

      // bob (owner) comments → no auto-clear
      run(claudeDir, ['task', 'comment', '1', '--text', 'Still waiting', '--from', 'bob']);
      const task = readTask(claudeDir, '1');
      expect(task.needsClarification).toBe('lead');
    });

    it('does NOT clear "user" via comment (only UI clears "user")', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Escalated task',
        status: 'in_progress',
        owner: 'bob',
        needsClarification: 'user',
        comments: [],
      });

      // alice comments → "user" should stay (only "lead" is auto-cleared by teamctl)
      run(claudeDir, ['task', 'comment', '1', '--text', 'Anything', '--from', 'alice']);
      const task = readTask(claudeDir, '1');
      expect(task.needsClarification).toBe('user');
    });
  });

  // ---- Task Set-Clarification ----
  describe('task set-clarification', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Task needing help',
        status: 'in_progress',
        owner: 'bob',
      });
    });

    it('sets needsClarification to "lead"', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'set-clarification', '1', 'lead']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('needsClarification=lead');
      const task = readTask(claudeDir, '1');
      expect(task.needsClarification).toBe('lead');
    });

    it('sets needsClarification to "user"', () => {
      const { exitCode } = run(claudeDir, ['task', 'set-clarification', '1', 'user']);
      expect(exitCode).toBe(0);
      const task = readTask(claudeDir, '1');
      expect(task.needsClarification).toBe('user');
    });

    it('clears needsClarification with "clear"', () => {
      // Set first, then clear
      run(claudeDir, ['task', 'set-clarification', '1', 'lead']);
      expect(readTask(claudeDir, '1').needsClarification).toBe('lead');

      const { stdout, exitCode } = run(claudeDir, ['task', 'set-clarification', '1', 'clear']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('needsClarification=cleared');
      const task = readTask(claudeDir, '1');
      expect(task.needsClarification).toBeUndefined();
    });

    it('fails on invalid value', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-clarification', '1', 'invalid']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Invalid value');
    });

    it('fails on missing arguments', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-clarification']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });
  });

  // ---- Task Briefing ----
  describe('task briefing', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Alice in-progress',
        status: 'in_progress',
        owner: 'alice',
      });
      writeTask(claudeDir, '2', {
        id: '2',
        subject: 'Bob todo',
        status: 'pending',
        owner: 'bob',
      });
      writeTask(claudeDir, '3', {
        id: '3',
        subject: 'Unassigned',
        status: 'pending',
      });
      writeTask(claudeDir, '4', {
        id: '4',
        subject: 'Blocked task',
        status: 'in_progress',
        owner: 'bob',
        needsClarification: 'lead',
      });
    });

    it('shows briefing for a specific member', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Task Briefing for bob');
      expect(stdout).toContain('YOUR TASKS');
      expect(stdout).toContain('Bob todo');
      expect(stdout).toContain('TEAM BOARD');
      expect(stdout).toContain('Alice in-progress');
    });

    it('shows needsClarification indicator in briefing', () => {
      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'alice']);
      expect(stdout).toContain('NEEDS CLARIFICATION');
      expect(stdout).toContain('LEAD');
    });

    it('fails without --for', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'briefing']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --for');
    });

    it('filters out _internal tasks', () => {
      writeTask(claudeDir, '_internal_1', {
        id: '_internal_1',
        subject: 'Internal',
        status: 'pending',
        metadata: { _internal: true },
      });
      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'alice']);
      expect(stdout).not.toContain('Internal');
    });
  });

  // ---- Kanban ----
  describe('kanban', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Review me', status: 'completed' });
    });

    it('sets kanban column to review', () => {
      const { stdout, exitCode } = run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('column=review');
      const kanban = readKanban(claudeDir);
      const tasks = kanban.tasks as Record<string, Record<string, unknown>>;
      expect(tasks['1'].column).toBe('review');
    });

    it('sets kanban column to approved', () => {
      run(claudeDir, ['kanban', 'set-column', '1', 'approved']);
      const kanban = readKanban(claudeDir);
      const tasks = kanban.tasks as Record<string, Record<string, unknown>>;
      expect(tasks['1'].column).toBe('approved');
    });

    it('clears kanban entry', () => {
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      const { stdout, exitCode } = run(claudeDir, ['kanban', 'clear', '1']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('cleared');
      const kanban = readKanban(claudeDir);
      const tasks = kanban.tasks as Record<string, Record<string, unknown>>;
      expect(tasks['1']).toBeUndefined();
    });

    it('fails on invalid column', () => {
      const { exitCode, stderr } = run(claudeDir, ['kanban', 'set-column', '1', 'invalid']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Invalid column');
    });
  });

  // ---- Kanban Reviewers ----
  describe('kanban reviewers', () => {
    it('lists empty reviewers', () => {
      const { stdout, exitCode } = run(claudeDir, ['kanban', 'reviewers', 'list']);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    });

    it('adds and removes reviewers', () => {
      run(claudeDir, ['kanban', 'reviewers', 'add', 'alice']);
      run(claudeDir, ['kanban', 'reviewers', 'add', 'bob']);
      const { stdout } = run(claudeDir, ['kanban', 'reviewers', 'list']);
      expect(JSON.parse(stdout)).toEqual(['alice', 'bob']);

      run(claudeDir, ['kanban', 'reviewers', 'remove', 'alice']);
      const { stdout: stdout2 } = run(claudeDir, ['kanban', 'reviewers', 'list']);
      expect(JSON.parse(stdout2)).toEqual(['bob']);
    });
  });

  // ---- Review ----
  describe('review', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Feature X',
        status: 'completed',
        owner: 'bob',
      });
      // Put task in review column
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
    });

    it('approves a task → moves to approved column', () => {
      const { stdout, exitCode } = run(claudeDir, ['review', 'approve', '1']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('approved');
      const kanban = readKanban(claudeDir);
      const tasks = kanban.tasks as Record<string, Record<string, unknown>>;
      expect(tasks['1'].column).toBe('approved');
    });

    it('approve with --notify-owner sends inbox message', () => {
      run(claudeDir, [
        'review',
        'approve',
        '1',
        '--notify-owner',
        '--from',
        'alice',
        '--note',
        'Looks great!',
      ]);
      const inbox = readInbox(claudeDir, 'bob');
      expect(inbox.length).toBe(1);
      const msg = inbox[0] as Record<string, unknown>;
      expect(String(msg.text)).toContain('approved');
      expect(String(msg.text)).toContain('Looks great!');
    });

    it('request-changes → clears kanban, sets in_progress, sends inbox', () => {
      const { exitCode } = run(claudeDir, [
        'review',
        'request-changes',
        '1',
        '--comment',
        'Fix the edge case',
        '--from',
        'alice',
      ]);
      expect(exitCode).toBe(0);

      // Kanban cleared
      const kanban = readKanban(claudeDir);
      const tasks = kanban.tasks as Record<string, Record<string, unknown>>;
      expect(tasks['1']).toBeUndefined();

      // Status back to in_progress
      const task = readTask(claudeDir, '1');
      expect(task.status).toBe('in_progress');

      // Inbox notification
      const inbox = readInbox(claudeDir, 'bob');
      expect(inbox.length).toBe(1);
      const msg = inbox[0] as Record<string, unknown>;
      expect(String(msg.text)).toContain('Fix the edge case');
    });
  });

  // ---- Message Send ----
  describe('message send', () => {
    it('sends a message to member inbox', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'message',
        'send',
        '--to',
        'bob',
        '--text',
        'Hello Bob!',
        '--summary',
        'Greeting',
        '--from',
        'alice',
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.deliveredToInbox).toBe(true);
      expect(parsed.messageId).toBeDefined();

      const inbox = readInbox(claudeDir, 'bob');
      expect(inbox.length).toBe(1);
      const msg = inbox[0] as Record<string, unknown>;
      expect(msg.from).toBe('alice');
      expect(msg.text).toBe('Hello Bob!');
      expect(msg.summary).toBe('Greeting');
    });

    it('infers lead name from config when --from is missing', () => {
      run(claudeDir, ['message', 'send', '--to', 'bob', '--text', 'Hi']);
      const inbox = readInbox(claudeDir, 'bob');
      const msg = inbox[0] as Record<string, unknown>;
      // alice is first member with "lead" role
      expect(msg.from).toBe('alice');
    });

    it('fails without --to', () => {
      const { exitCode, stderr } = run(claudeDir, ['message', 'send', '--text', 'No recipient']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --to');
    });

    it('fails without --text', () => {
      const { exitCode, stderr } = run(claudeDir, ['message', 'send', '--to', 'bob']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --text');
    });
  });

  // ---- Process Management ----
  describe('process management', () => {
    it('registers a process', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'dev-server',
        '--port',
        '3000',
        '--from',
        'bob',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('process registered');
      expect(stdout).toContain(`pid=${process.pid}`);
      expect(stdout).toContain('port=3000');
    });

    it('lists processes with alive status', () => {
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'dev-server',
      ]);
      const { stdout, exitCode } = run(claudeDir, ['process', 'list']);
      expect(exitCode).toBe(0);
      const list = JSON.parse(stdout) as Record<string, unknown>[];
      expect(list).toHaveLength(1);
      expect(list[0].pid).toBe(process.pid);
      expect(list[0].alive).toBe(true);
    });

    it('unregisters a process by pid', () => {
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'dev-server',
      ]);
      const { stdout, exitCode } = run(claudeDir, [
        'process',
        'unregister',
        '--pid',
        String(process.pid),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('unregistered');

      // List should be empty
      const { stdout: listOut } = run(claudeDir, ['process', 'list']);
      expect(JSON.parse(listOut)).toHaveLength(0);
    });

    it('fails register without --pid', () => {
      const { exitCode, stderr } = run(claudeDir, ['process', 'register', '--label', 'test']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Invalid --pid');
    });

    it('fails register without --label', () => {
      const { exitCode, stderr } = run(claudeDir, ['process', 'register', '--pid', '1234']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --label');
    });
  });

  // ---- Highwatermark ----
  describe('highwatermark', () => {
    it('respects highwatermark for task ID generation', () => {
      // Create task 1
      run(claudeDir, ['task', 'create', '--subject', 'Task 1']);
      expect(readTask(claudeDir, '1')).toBeDefined();

      // Create task 2
      run(claudeDir, ['task', 'create', '--subject', 'Task 2']);
      expect(readTask(claudeDir, '2')).toBeDefined();

      // Delete task 2 from disk (simulating agent deletion)
      fs.unlinkSync(path.join(claudeDir, 'tasks', TEAM, '2.json'));

      // Highwatermark should be 2, so next task should be 3
      const { stdout } = run(claudeDir, ['task', 'create', '--subject', 'Task 3']);
      const parsed = JSON.parse(stdout);
      expect(parsed.id).toBe('3');
    });
  });

  // ---- Error handling ----
  describe('error handling', () => {
    it('exits with error for unknown domain', () => {
      const { exitCode, stderr } = run(claudeDir, ['foobar', 'something']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown domain');
    });

    it('exits with error for unknown task action', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'foobar']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown task action');
    });

    it('exits with error for unknown kanban action', () => {
      const { exitCode, stderr } = run(claudeDir, ['kanban', 'foobar']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown kanban action');
    });

    it('exits with error for unknown review action', () => {
      const { exitCode, stderr } = run(claudeDir, ['review', 'foobar']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown review action');
    });

    it('exits with error for unknown message action', () => {
      const { exitCode, stderr } = run(claudeDir, ['message', 'foobar']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown message action');
    });

    it('exits with error for unknown process action', () => {
      const { exitCode, stderr } = run(claudeDir, ['process', 'foobar']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown process action');
    });
  });

  // ---- Edge cases ----
  describe('edge cases', () => {
    it('handles empty tasks directory gracefully for list', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'list']);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    });

    it('handles missing tasks directory gracefully for briefing', () => {
      // Remove tasks dir
      fs.rmSync(path.join(claudeDir, 'tasks', TEAM), { recursive: true });
      const { stdout, exitCode } = run(claudeDir, ['task', 'briefing', '--for', 'alice']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('no tasks assigned to you');
    });

    it('multiple comments accumulate', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Multi-comment',
        status: 'in_progress',
        owner: 'bob',
      });
      run(claudeDir, ['task', 'comment', '1', '--text', 'First', '--from', 'alice']);
      run(claudeDir, ['task', 'comment', '1', '--text', 'Second', '--from', 'bob']);
      run(claudeDir, ['task', 'comment', '1', '--text', 'Third', '--from', 'alice']);

      const task = readTask(claudeDir, '1');
      const comments = task.comments as Record<string, unknown>[];
      expect(comments).toHaveLength(3);
      expect(comments.map((c) => c.text)).toEqual(['First', 'Second', 'Third']);
    });

    it('set-clarification preserves other task fields', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Rich task',
        description: 'Detailed desc',
        status: 'in_progress',
        owner: 'bob',
        blocks: ['2'],
        blockedBy: [],
        comments: [{ id: 'c1', author: 'alice', text: 'Note', createdAt: '2025-01-01T00:00:00Z' }],
      });
      run(claudeDir, ['task', 'set-clarification', '1', 'lead']);
      const task = readTask(claudeDir, '1');
      expect(task.needsClarification).toBe('lead');
      expect(task.subject).toBe('Rich task');
      expect(task.description).toBe('Detailed desc');
      expect(task.owner).toBe('bob');
      expect(task.blocks).toEqual(['2']);
      const comments = task.comments as Record<string, unknown>[];
      expect(comments).toHaveLength(1);
    });

    it('briefing excludes approved tasks', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Approved task',
        status: 'completed',
        owner: 'bob',
      });
      run(claudeDir, ['kanban', 'set-column', '1', 'approved']);

      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(stdout).not.toContain('Approved task');
    });

    it('briefing excludes deleted tasks', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Deleted task',
        status: 'deleted',
        owner: 'bob',
      });

      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(stdout).not.toContain('Deleted task');
    });
  });
});
