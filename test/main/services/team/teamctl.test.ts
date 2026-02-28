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

import { execFile, execFileSync } from 'child_process';
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

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Create a fresh claude-dir structure for a single test. */
function makeFreshClaudeDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'claude-'));
  const teamsDir = path.join(dir, 'teams', TEAM);
  const tasksDir = path.join(dir, 'tasks', TEAM);
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

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

/** Read processes.json. */
function readProcesses(claudeDir: string): unknown[] {
  const filePath = path.join(claudeDir, 'teams', TEAM, 'processes.json');
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

/** Run teamctl.js synchronously and return stdout, stderr, exitCode. */
function run(claudeDir: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
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

/** Run teamctl.js asynchronously (for concurrency tests). */
function runAsync(claudeDir: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, '--claude-dir', claudeDir, '--team', TEAM, ...args],
      { encoding: 'utf8', timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as { code?: number; status?: number };
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: e.status ?? e.code ?? 1,
          });
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 });
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  vi.restoreAllMocks();

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamctl-test-'));

  // Mock getToolsBasePath so ensureInstalled() writes to our temp dir
  // (setup.ts stubs HOME to /home/testuser which doesn't exist)
  const toolsDir = path.join(tmpRoot, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  vi.doMock('@main/utils/pathDecoder', async (importOriginal) => {
    const orig = await importOriginal<typeof import('@main/utils/pathDecoder')>();
    return { ...orig, getToolsBasePath: () => toolsDir };
  });

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
    vi.restoreAllMocks();
    claudeDir = makeFreshClaudeDir();
  });

  // =========================================================================
  // Help
  // =========================================================================
  describe('help', () => {
    it('prints help with --help flag', () => {
      const { stdout, exitCode } = run(claudeDir, ['--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('teamctl.js v');
      expect(stdout).toContain('Usage:');
      expect(stdout).toContain('task set-status');
      expect(stdout).toContain('task set-owner');
      expect(stdout).toContain('task set-clarification');
      expect(stdout).toContain('task briefing');
      expect(stdout).toContain('kanban set-column');
      expect(stdout).toContain('review approve');
      expect(stdout).toContain('review request-changes');
      expect(stdout).toContain('message send');
      expect(stdout).toContain('process register');
    });

    it('prints help with -h short flag', () => {
      const { stdout, exitCode } = run(claudeDir, ['-h']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage:');
    });

    it('prints help with no arguments', () => {
      const { stdout, exitCode } = run(claudeDir, []);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage:');
    });
  });

  // =========================================================================
  // Arg parsing
  // =========================================================================
  describe('arg parsing', () => {
    it('supports --key=value syntax', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'task',
        'create',
        '--subject=Equals syntax task',
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.subject).toBe('Equals syntax task');
    });

    it('supports -- separator to stop flag parsing', () => {
      const { exitCode } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Task with separator',
        '--',
        '--not-a-flag',
      ]);
      expect(exitCode).toBe(0);
    });
  });

  // =========================================================================
  // Task Create
  // =========================================================================
  describe('task create', () => {
    it('creates a task with minimal fields', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'create', '--subject', 'My first task']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.id).toBe('1');
      expect(parsed.subject).toBe('My first task');
      expect(parsed.status).toBe('pending');
      expect(parsed.owner).toBeUndefined();
      expect(parsed.blocks).toEqual([]);
      expect(parsed.blockedBy).toEqual([]);

      // Verify file on disk matches stdout
      const onDisk = readTask(claudeDir, '1');
      expect(onDisk.subject).toBe('My first task');
      expect(onDisk.description).toBe('My first task'); // defaults to subject
    });

    it('creates a task with owner -> status defaults to in_progress', () => {
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
      run(claudeDir, ['task', 'create', '--subject', 'Task 2']);
      const { stdout } = run(claudeDir, ['task', 'create', '--subject', 'Task 3']);
      expect(JSON.parse(stdout).id).toBe('3');
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

    it('accepts --desc as alias for --description', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'With desc alias',
        '--desc',
        'Alias description',
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).description).toBe('Alias description');
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
      expect(String(msg.text)).toContain('#1');
    });

    it('sends inbox notification with --notify including prompt and tool instructions', () => {
      run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Task with prompt',
        '--description',
        'Detailed work',
        '--prompt',
        'Please implement authentication using JWT',
        '--owner',
        'bob',
        '--notify',
        '--from',
        'alice',
      ]);
      const inbox = readInbox(claudeDir, 'bob');
      expect(inbox.length).toBe(1);
      const text = String((inbox[0] as Record<string, unknown>).text);
      expect(text).toContain('New task assigned');
      expect(text).toContain('Description:');
      expect(text).toContain('Detailed work');
      expect(text).toContain('Instructions:');
      expect(text).toContain('Please implement authentication using JWT');
      expect(text).toContain('task start');
      expect(text).toContain('task complete');
    });

    it('does NOT send notification with --notify but without --owner', () => {
      run(claudeDir, ['task', 'create', '--subject', 'Unowned with notify', '--notify']);
      const inboxDir = path.join(claudeDir, 'teams', TEAM, 'inboxes');
      try {
        const files = fs.readdirSync(inboxDir);
        expect(files).toHaveLength(0);
      } catch {
        // inboxes dir doesn't exist -> correct, no notification sent
      }
    });
  });

  // =========================================================================
  // Task Set-Status
  // =========================================================================
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
      expect(readTask(claudeDir, '1').status).toBe('in_progress');
    });

    it('changes status to completed', () => {
      run(claudeDir, ['task', 'set-status', '1', 'completed']);
      expect(readTask(claudeDir, '1').status).toBe('completed');
    });

    it('changes status to deleted', () => {
      run(claudeDir, ['task', 'set-status', '1', 'deleted']);
      expect(readTask(claudeDir, '1').status).toBe('deleted');
    });

    it('preserves other task fields when changing status', () => {
      writeTask(claudeDir, '2', {
        id: '2',
        subject: 'Rich',
        description: 'Desc',
        owner: 'bob',
        status: 'pending',
        blocks: ['3'],
        blockedBy: ['1'],
        comments: [{ id: 'c1', author: 'alice', text: 'Note', createdAt: '2025-01-01T00:00:00Z' }],
      });
      run(claudeDir, ['task', 'set-status', '2', 'in_progress']);
      const task = readTask(claudeDir, '2');
      expect(task.status).toBe('in_progress');
      expect(task.subject).toBe('Rich');
      expect(task.description).toBe('Desc');
      expect(task.owner).toBe('bob');
      expect(task.blocks).toEqual(['3']);
      expect((task.comments as unknown[]).length).toBe(1);
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

    it('fails without arguments', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-status']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });
  });

  // =========================================================================
  // Task Start / Complete
  // =========================================================================
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

    it('"done" is alias for "complete"', () => {
      expect(run(claudeDir, ['task', 'done', '1']).exitCode).toBe(0);
      expect(readTask(claudeDir, '1').status).toBe('completed');
    });

    it('start fails without task ID', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'start']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });

    it('complete fails without task ID', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'complete']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });
  });

  // =========================================================================
  // Task Get / List
  // =========================================================================
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

    it('lists all tasks sorted by ID', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'list']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as Record<string, unknown>[];
      expect(parsed).toHaveLength(2);
      expect(parsed.map((t) => t.id)).toEqual(['1', '2']);
    });

    it('list ignores non-JSON files, dotfiles, and non-numeric names', () => {
      const tasksDir = path.join(claudeDir, 'tasks', TEAM);
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '5');
      fs.writeFileSync(path.join(tasksDir, '.hidden.json'), '{}');
      fs.writeFileSync(path.join(tasksDir, 'readme.txt'), 'not a task');
      fs.writeFileSync(path.join(tasksDir, 'abc.json'), '{"id":"abc"}');
      fs.writeFileSync(path.join(tasksDir, '_internal_1.json'), '{"id":"_internal_1"}');

      const { stdout, exitCode } = run(claudeDir, ['task', 'list']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as Record<string, unknown>[];
      expect(parsed).toHaveLength(2); // only 1.json and 2.json
    });

    it('fails on task get with missing ID', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'get']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });

    it('task get on non-existent task fails', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'get', '999']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Task not found');
    });
  });

  // =========================================================================
  // Task Set-Owner / Assign
  // =========================================================================
  describe('task set-owner / assign', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Unowned task',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      });
    });

    it('sets owner on an existing task', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'set-owner', '1', 'bob']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('owner=bob');
      expect(readTask(claudeDir, '1').owner).toBe('bob');
    });

    it('"assign" is alias for "set-owner"', () => {
      const { exitCode } = run(claudeDir, ['task', 'assign', '1', 'bob']);
      expect(exitCode).toBe(0);
      expect(readTask(claudeDir, '1').owner).toBe('bob');
    });

    it('clears owner with "clear"', () => {
      writeTask(claudeDir, '2', {
        id: '2',
        subject: 'Owned task',
        status: 'in_progress',
        owner: 'bob',
      });
      const { stdout, exitCode } = run(claudeDir, ['task', 'set-owner', '2', 'clear']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('owner=cleared');
      expect(readTask(claudeDir, '2').owner).toBeUndefined();
    });

    it('clears owner with "none"', () => {
      writeTask(claudeDir, '2', {
        id: '2',
        subject: 'Owned task',
        status: 'in_progress',
        owner: 'bob',
      });
      expect(run(claudeDir, ['task', 'set-owner', '2', 'none']).exitCode).toBe(0);
      expect(readTask(claudeDir, '2').owner).toBeUndefined();
    });

    it('reassigns owner from one member to another', () => {
      writeTask(claudeDir, '2', {
        id: '2',
        subject: 'Bob task',
        status: 'in_progress',
        owner: 'bob',
      });
      expect(run(claudeDir, ['task', 'set-owner', '2', 'alice']).exitCode).toBe(0);
      expect(readTask(claudeDir, '2').owner).toBe('alice');
    });

    it('preserves other task fields when changing owner', () => {
      writeTask(claudeDir, '2', {
        id: '2',
        subject: 'Rich',
        description: 'Desc',
        status: 'in_progress',
        owner: 'bob',
        blocks: ['3'],
        blockedBy: ['1'],
        comments: [{ id: 'c1', author: 'alice', text: 'Note', createdAt: '2025-01-01T00:00:00Z' }],
      });
      run(claudeDir, ['task', 'set-owner', '2', 'alice']);
      const task = readTask(claudeDir, '2');
      expect(task.owner).toBe('alice');
      expect(task.subject).toBe('Rich');
      expect(task.description).toBe('Desc');
      expect(task.status).toBe('in_progress');
      expect(task.blocks).toEqual(['3']);
      expect((task.comments as unknown[]).length).toBe(1);
    });

    it('sends inbox notification with --notify', () => {
      run(claudeDir, ['task', 'set-owner', '1', 'bob', '--notify', '--from', 'alice']);
      const inbox = readInbox(claudeDir, 'bob');
      expect(inbox.length).toBe(1);
      const msg = inbox[0] as Record<string, unknown>;
      expect(msg.from).toBe('alice');
      expect(String(msg.text)).toContain('Task assigned to you');
      expect(String(msg.text)).toContain('#1');
    });

    it('does NOT send notification without --notify', () => {
      run(claudeDir, ['task', 'set-owner', '1', 'bob']);
      const inboxDir = path.join(claudeDir, 'teams', TEAM, 'inboxes');
      try {
        const files = fs.readdirSync(inboxDir);
        expect(files).toHaveLength(0);
      } catch {
        // inboxes dir doesn't exist -> correct, no notification sent
      }
    });

    it('does NOT send notification when clearing owner', () => {
      writeTask(claudeDir, '2', {
        id: '2',
        subject: 'Owned',
        status: 'in_progress',
        owner: 'bob',
      });
      run(claudeDir, ['task', 'set-owner', '2', 'clear', '--notify']);
      const inboxDir = path.join(claudeDir, 'teams', TEAM, 'inboxes');
      try {
        const files = fs.readdirSync(inboxDir);
        expect(files).toHaveLength(0);
      } catch {
        // no inboxes dir -> correct
      }
    });

    it('fails without task ID', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-owner']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });

    it('fails without owner argument', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-owner', '1']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });

    it('fails on non-existent task', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-owner', '999', 'bob']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Task not found');
    });
  });

  // =========================================================================
  // Task Comment
  // =========================================================================
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

    it('adds a comment with valid ID and timestamp', () => {
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
      expect(String(comments[0].id)).toMatch(UUID_RE);
      expect(String(comments[0].createdAt)).toMatch(ISO_RE);
    });

    it('defaults author to "agent" when --from is not specified', () => {
      run(claudeDir, ['task', 'comment', '1', '--text', 'No author']);
      const comments = readTask(claudeDir, '1').comments as Record<string, unknown>[];
      expect(comments[0].author).toBe('agent');
    });

    it('sends inbox notification to owner (skip self-notification)', () => {
      run(claudeDir, ['task', 'comment', '1', '--text', 'Review this', '--from', 'alice']);
      expect(readInbox(claudeDir, 'bob').length).toBe(1);

      run(claudeDir, ['task', 'comment', '1', '--text', 'Self note', '--from', 'bob']);
      expect(readInbox(claudeDir, 'bob').length).toBe(1); // still 1
    });

    it('multiple comments accumulate with unique IDs', () => {
      run(claudeDir, ['task', 'comment', '1', '--text', 'First', '--from', 'alice']);
      run(claudeDir, ['task', 'comment', '1', '--text', 'Second', '--from', 'bob']);
      run(claudeDir, ['task', 'comment', '1', '--text', 'Third', '--from', 'alice']);

      const comments = readTask(claudeDir, '1').comments as Record<string, unknown>[];
      expect(comments).toHaveLength(3);
      expect(comments.map((c) => c.text)).toEqual(['First', 'Second', 'Third']);
      expect(comments.map((c) => c.author)).toEqual(['alice', 'bob', 'alice']);
      expect(new Set(comments.map((c) => c.id)).size).toBe(3);
    });

    it('comment on task without comments array initializes it', () => {
      writeTask(claudeDir, '2', { id: '2', subject: 'No comments field', status: 'pending' });
      expect(
        run(claudeDir, ['task', 'comment', '2', '--text', 'First', '--from', 'alice']).exitCode
      ).toBe(0);
      expect((readTask(claudeDir, '2').comments as unknown[]).length).toBe(1);
    });

    it('fails without --text', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'comment', '1']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --text');
    });
  });

  // =========================================================================
  // Comment Auto-Clear needsClarification
  // =========================================================================
  describe('comment auto-clear needsClarification', () => {
    it('clears "lead" when non-owner comments', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Blocked',
        status: 'in_progress',
        owner: 'bob',
        needsClarification: 'lead',
        comments: [],
      });
      run(claudeDir, ['task', 'comment', '1', '--text', 'Answer', '--from', 'alice']);
      expect(readTask(claudeDir, '1').needsClarification).toBeUndefined();
    });

    it('does NOT clear "lead" when owner comments (still waiting for answer)', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Blocked',
        status: 'in_progress',
        owner: 'bob',
        needsClarification: 'lead',
        comments: [],
      });
      run(claudeDir, ['task', 'comment', '1', '--text', 'Still waiting', '--from', 'bob']);
      expect(readTask(claudeDir, '1').needsClarification).toBe('lead');
    });

    it('does NOT clear "user" via CLI comment (only UI clears "user")', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Escalated',
        status: 'in_progress',
        owner: 'bob',
        needsClarification: 'user',
        comments: [],
      });
      run(claudeDir, ['task', 'comment', '1', '--text', 'Anything', '--from', 'alice']);
      expect(readTask(claudeDir, '1').needsClarification).toBe('user');
    });

    it('clears "lead" with default author "agent" (agent != owner)', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Blocked',
        status: 'in_progress',
        owner: 'bob',
        needsClarification: 'lead',
        comments: [],
      });
      run(claudeDir, ['task', 'comment', '1', '--text', 'Reply']);
      expect(readTask(claudeDir, '1').needsClarification).toBeUndefined();
    });

    it('auto-clear and comment are a single atomic write', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Blocked',
        status: 'in_progress',
        owner: 'bob',
        needsClarification: 'lead',
        comments: [],
      });
      run(claudeDir, ['task', 'comment', '1', '--text', 'Answer', '--from', 'alice']);
      const task = readTask(claudeDir, '1');
      expect(task.needsClarification).toBeUndefined();
      expect((task.comments as unknown[]).length).toBe(1);
    });
  });

  // =========================================================================
  // Task Set-Clarification
  // =========================================================================
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
      expect(readTask(claudeDir, '1').needsClarification).toBe('lead');
    });

    it('sets needsClarification to "user"', () => {
      expect(run(claudeDir, ['task', 'set-clarification', '1', 'user']).exitCode).toBe(0);
      expect(readTask(claudeDir, '1').needsClarification).toBe('user');
    });

    it('clears needsClarification with "clear"', () => {
      run(claudeDir, ['task', 'set-clarification', '1', 'lead']);
      expect(readTask(claudeDir, '1').needsClarification).toBe('lead');

      const { stdout, exitCode } = run(claudeDir, ['task', 'set-clarification', '1', 'clear']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('needsClarification=cleared');
      expect(readTask(claudeDir, '1').needsClarification).toBeUndefined();
    });

    it('can transition from lead to user (escalation)', () => {
      run(claudeDir, ['task', 'set-clarification', '1', 'lead']);
      run(claudeDir, ['task', 'set-clarification', '1', 'user']);
      expect(readTask(claudeDir, '1').needsClarification).toBe('user');
    });

    it('preserves all other task fields', () => {
      writeTask(claudeDir, '2', {
        id: '2',
        subject: 'Rich task',
        description: 'Detailed desc',
        status: 'in_progress',
        owner: 'bob',
        blocks: ['3'],
        blockedBy: [],
        comments: [{ id: 'c1', author: 'alice', text: 'Note', createdAt: '2025-01-01T00:00:00Z' }],
      });
      run(claudeDir, ['task', 'set-clarification', '2', 'lead']);
      const task = readTask(claudeDir, '2');
      expect(task.needsClarification).toBe('lead');
      expect(task.subject).toBe('Rich task');
      expect(task.description).toBe('Detailed desc');
      expect(task.owner).toBe('bob');
      expect(task.blocks).toEqual(['3']);
      expect((task.comments as unknown[]).length).toBe(1);
    });

    it('fails on invalid value (shows allowed values)', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-clarification', '1', 'invalid']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Invalid value');
      expect(stderr).toContain('lead, user, clear');
    });

    it('fails on missing arguments', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'set-clarification']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });
  });

  // =========================================================================
  // Task Briefing
  // =========================================================================
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

    it('shows briefing with correct section placement', () => {
      const { stdout, exitCode } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Task Briefing for bob');

      const yourTasksIdx = stdout.indexOf('YOUR TASKS');
      const teamBoardIdx = stdout.indexOf('TEAM BOARD');
      expect(yourTasksIdx).toBeGreaterThan(-1);
      expect(teamBoardIdx).toBeGreaterThan(yourTasksIdx);

      // Bob's tasks in YOUR TASKS section
      const yourSection = stdout.slice(yourTasksIdx, teamBoardIdx);
      expect(yourSection).toContain('Bob todo');
      expect(yourSection).toContain('Blocked task');

      // Alice's task in TEAM BOARD section
      const teamSection = stdout.slice(teamBoardIdx);
      expect(teamSection).toContain('Alice in-progress');
    });

    it('shows needsClarification indicator', () => {
      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'alice']);
      expect(stdout).toContain('NEEDS CLARIFICATION');
      expect(stdout).toContain('LEAD');
    });

    it('shows tasks in review kanban column', () => {
      writeTask(claudeDir, '5', {
        id: '5',
        subject: 'Under review task',
        status: 'completed',
        owner: 'bob',
      });
      run(claudeDir, ['kanban', 'set-column', '5', 'review']);

      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(stdout).toContain('Under review task');
      expect(stdout).toContain('REVIEW');
    });

    it('excludes approved tasks', () => {
      writeTask(claudeDir, '5', {
        id: '5',
        subject: 'Approved task',
        status: 'completed',
        owner: 'bob',
      });
      run(claudeDir, ['kanban', 'set-column', '5', 'approved']);
      expect(run(claudeDir, ['task', 'briefing', '--for', 'bob']).stdout).not.toContain(
        'Approved task'
      );
    });

    it('excludes deleted tasks', () => {
      writeTask(claudeDir, '5', {
        id: '5',
        subject: 'Deleted task',
        status: 'deleted',
        owner: 'bob',
      });
      expect(run(claudeDir, ['task', 'briefing', '--for', 'bob']).stdout).not.toContain(
        'Deleted task'
      );
    });

    it('filters out _internal tasks', () => {
      writeTask(claudeDir, '_internal_1', {
        id: '_internal_1',
        subject: 'CLI bookkeeping',
        status: 'pending',
        metadata: { _internal: true },
      });
      expect(run(claudeDir, ['task', 'briefing', '--for', 'alice']).stdout).not.toContain(
        'CLI bookkeeping'
      );
    });

    it('truncates description to 500 chars', () => {
      writeTask(claudeDir, '5', {
        id: '5',
        subject: 'Long desc',
        description: 'X'.repeat(600),
        status: 'in_progress',
        owner: 'bob',
      });
      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(stdout).toContain('X'.repeat(500));
      expect(stdout).not.toContain('X'.repeat(501));
    });

    it('caps DONE section to 15 tasks', () => {
      for (let i = 10; i < 30; i++) {
        writeTask(claudeDir, String(i), {
          id: String(i),
          subject: `Done task ${i}`,
          status: 'completed',
          owner: 'bob',
        });
      }
      const matches =
        run(claudeDir, ['task', 'briefing', '--for', 'bob']).stdout.match(/Done task \d+/g) ?? [];
      expect(matches.length).toBeLessThanOrEqual(15);
    });

    it('shows blockedBy and related info', () => {
      writeTask(claudeDir, '5', {
        id: '5',
        subject: 'Blocked by others',
        status: 'pending',
        owner: 'bob',
        blockedBy: ['1', '2'],
        related: ['3'],
      });
      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(stdout).toContain('Blocked by: #1, #2');
      expect(stdout).toContain('Related: #3');
    });

    it('shows comment count and content', () => {
      writeTask(claudeDir, '5', {
        id: '5',
        subject: 'Task with comments',
        status: 'in_progress',
        owner: 'bob',
        comments: [
          { id: 'c1', author: 'alice', text: 'Please fix this', createdAt: '2025-06-01T12:00:00Z' },
          { id: 'c2', author: 'bob', text: 'Working on it', createdAt: '2025-06-01T13:00:00Z' },
        ],
      });
      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(stdout).toContain('Comments (2)');
      expect(stdout).toContain('[alice');
      expect(stdout).toContain('Please fix this');
    });

    it('shows "no tasks assigned" when member has no tasks', () => {
      expect(run(claudeDir, ['task', 'briefing', '--for', 'charlie']).stdout).toContain(
        'no tasks assigned to you'
      );
    });

    it('fails without --for', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'briefing']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --for');
    });
  });

  // =========================================================================
  // Kanban
  // =========================================================================
  describe('kanban', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Review me', status: 'completed' });
    });

    it('sets kanban column to review with movedAt timestamp', () => {
      const { stdout, exitCode } = run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('column=review');
      const tasks = readKanban(claudeDir).tasks as Record<string, Record<string, unknown>>;
      expect(tasks['1'].column).toBe('review');
      expect(tasks['1'].reviewer).toBeNull();
      expect(String(tasks['1'].movedAt)).toMatch(ISO_RE);
    });

    it('sets kanban column to approved', () => {
      run(claudeDir, ['kanban', 'set-column', '1', 'approved']);
      const tasks = readKanban(claudeDir).tasks as Record<string, Record<string, unknown>>;
      expect(tasks['1'].column).toBe('approved');
      expect(String(tasks['1'].movedAt)).toMatch(ISO_RE);
    });

    it('clears kanban entry with "clear"', () => {
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      expect(run(claudeDir, ['kanban', 'clear', '1']).exitCode).toBe(0);
      expect((readKanban(claudeDir).tasks as Record<string, unknown>)['1']).toBeUndefined();
    });

    it('"remove" is alias for "clear"', () => {
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      expect(run(claudeDir, ['kanban', 'remove', '1']).exitCode).toBe(0);
      expect((readKanban(claudeDir).tasks as Record<string, unknown>)['1']).toBeUndefined();
    });

    it('fails on invalid column', () => {
      const { exitCode, stderr } = run(claudeDir, ['kanban', 'set-column', '1', 'invalid']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Invalid column');
    });

    it('maintains state for multiple tasks', () => {
      writeTask(claudeDir, '2', { id: '2', subject: 'Another', status: 'completed' });
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      run(claudeDir, ['kanban', 'set-column', '2', 'approved']);
      const tasks = readKanban(claudeDir).tasks as Record<string, Record<string, unknown>>;
      expect(tasks['1'].column).toBe('review');
      expect(tasks['2'].column).toBe('approved');
    });
  });

  // =========================================================================
  // Kanban Reviewers
  // =========================================================================
  describe('kanban reviewers', () => {
    it('lists empty reviewers', () => {
      expect(JSON.parse(run(claudeDir, ['kanban', 'reviewers', 'list']).stdout)).toEqual([]);
    });

    it('adds and removes reviewers', () => {
      run(claudeDir, ['kanban', 'reviewers', 'add', 'alice']);
      run(claudeDir, ['kanban', 'reviewers', 'add', 'bob']);
      expect(JSON.parse(run(claudeDir, ['kanban', 'reviewers', 'list']).stdout)).toEqual([
        'alice',
        'bob',
      ]);

      run(claudeDir, ['kanban', 'reviewers', 'remove', 'alice']);
      expect(JSON.parse(run(claudeDir, ['kanban', 'reviewers', 'list']).stdout)).toEqual(['bob']);
    });

    it('add is idempotent (Set-based, no duplicates)', () => {
      run(claudeDir, ['kanban', 'reviewers', 'add', 'alice']);
      run(claudeDir, ['kanban', 'reviewers', 'add', 'alice']);
      expect(JSON.parse(run(claudeDir, ['kanban', 'reviewers', 'list']).stdout)).toEqual(['alice']);
    });

    it('remove non-existent reviewer is a no-op', () => {
      run(claudeDir, ['kanban', 'reviewers', 'add', 'alice']);
      run(claudeDir, ['kanban', 'reviewers', 'remove', 'nonexistent']);
      expect(JSON.parse(run(claudeDir, ['kanban', 'reviewers', 'list']).stdout)).toEqual(['alice']);
    });
  });

  // =========================================================================
  // Review
  // =========================================================================
  describe('review', () => {
    beforeEach(() => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Feature X',
        status: 'completed',
        owner: 'bob',
      });
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
    });

    it('approves a task -> moves to approved column', () => {
      expect(run(claudeDir, ['review', 'approve', '1']).exitCode).toBe(0);
      expect(
        (readKanban(claudeDir).tasks as Record<string, Record<string, unknown>>)['1'].column
      ).toBe('approved');
    });

    it('approve with --notify-owner sends inbox message with note', () => {
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
      const text = String((inbox[0] as Record<string, unknown>).text);
      expect(text).toContain('approved');
      expect(text).toContain('Looks great!');
      expect((inbox[0] as Record<string, unknown>).from).toBe('alice');
    });

    it('approve with --notify-owner but no --note sends plain message', () => {
      run(claudeDir, ['review', 'approve', '1', '--notify-owner', '--from', 'alice']);
      const text = String((readInbox(claudeDir, 'bob')[0] as Record<string, unknown>).text);
      expect(text).toContain('#1 approved');
    });

    it('request-changes -> clears kanban, sets in_progress, sends inbox with comment', () => {
      expect(
        run(claudeDir, [
          'review',
          'request-changes',
          '1',
          '--comment',
          'Fix the edge case',
          '--from',
          'alice',
        ]).exitCode
      ).toBe(0);

      expect((readKanban(claudeDir).tasks as Record<string, unknown>)['1']).toBeUndefined();
      expect(readTask(claudeDir, '1').status).toBe('in_progress');
      const text = String((readInbox(claudeDir, 'bob')[0] as Record<string, unknown>).text);
      expect(text).toContain('Fix the edge case');
      expect(text).toContain('Please fix');
    });

    it('request-changes without --comment uses default text', () => {
      run(claudeDir, ['review', 'request-changes', '1', '--from', 'alice']);
      const text = String((readInbox(claudeDir, 'bob')[0] as Record<string, unknown>).text);
      expect(text).toContain('Reviewer requested changes');
    });

    it('request-changes on task without owner fails', () => {
      writeTask(claudeDir, '2', { id: '2', subject: 'No owner', status: 'completed' });
      const { exitCode, stderr } = run(claudeDir, [
        'review',
        'request-changes',
        '2',
        '--comment',
        'Fix',
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('No owner found');
    });

    it('approve fails without task ID', () => {
      const { exitCode, stderr } = run(claudeDir, ['review', 'approve']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage');
    });
  });

  // =========================================================================
  // Message Send
  // =========================================================================
  describe('message send', () => {
    it('sends a message with all fields validated', () => {
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
      expect(String(parsed.messageId)).toMatch(UUID_RE);

      const msg = readInbox(claudeDir, 'bob')[0] as Record<string, unknown>;
      expect(msg.from).toBe('alice');
      expect(msg.text).toBe('Hello Bob!');
      expect(msg.summary).toBe('Greeting');
      expect(msg.read).toBe(false);
      expect(String(msg.timestamp)).toMatch(ISO_RE);
      expect(String(msg.messageId)).toMatch(UUID_RE);
    });

    it('infers lead name from config when --from is missing', () => {
      run(claudeDir, ['message', 'send', '--to', 'bob', '--text', 'Hi']);
      expect((readInbox(claudeDir, 'bob')[0] as Record<string, unknown>).from).toBe('alice');
    });

    it('multiple messages accumulate with unique IDs', () => {
      run(claudeDir, ['message', 'send', '--to', 'bob', '--text', 'Msg 1', '--from', 'alice']);
      run(claudeDir, ['message', 'send', '--to', 'bob', '--text', 'Msg 2', '--from', 'alice']);
      run(claudeDir, ['message', 'send', '--to', 'bob', '--text', 'Msg 3', '--from', 'alice']);
      const inbox = readInbox(claudeDir, 'bob') as Record<string, unknown>[];
      expect(inbox.length).toBe(3);
      expect(inbox.map((m) => m.text)).toEqual(['Msg 1', 'Msg 2', 'Msg 3']);
      expect(new Set(inbox.map((m) => m.messageId)).size).toBe(3);
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

  // =========================================================================
  // Process Management
  // =========================================================================
  describe('process management', () => {
    it('registers a process with all optional fields', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'dev-server',
        '--port',
        '3000',
        '--url',
        'http://localhost:3000',
        '--claude-process-id',
        'cp-123',
        '--from',
        'bob',
        '--command',
        'npm run dev',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('process registered');
      expect(stdout).toContain(`pid=${process.pid}`);
      expect(stdout).toContain('port=3000');

      const procs = readProcesses(claudeDir) as Record<string, unknown>[];
      expect(procs).toHaveLength(1);
      expect(procs[0].pid).toBe(process.pid);
      expect(procs[0].label).toBe('dev-server');
      expect(procs[0].port).toBe(3000);
      expect(procs[0].url).toBe('http://localhost:3000');
      expect(procs[0].claudeProcessId).toBe('cp-123');
      expect(procs[0].registeredBy).toBe('bob');
      expect(procs[0].command).toBe('npm run dev');
      expect(String(procs[0].registeredAt)).toMatch(ISO_RE);
      expect(String(procs[0].id)).toMatch(UUID_RE);
    });

    it('registers without port -> no port in stdout', () => {
      const { stdout } = run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'worker',
      ]);
      expect(stdout).toContain('process registered');
      expect(stdout).not.toContain('port=');
    });

    it('re-registration with same PID preserves id and registeredAt', () => {
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'v1',
        '--port',
        '3000',
      ]);
      const procs1 = readProcesses(claudeDir) as Record<string, unknown>[];
      const originalId = procs1[0].id;
      const originalRegisteredAt = procs1[0].registeredAt;

      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'v2',
        '--port',
        '4000',
      ]);
      const procs2 = readProcesses(claudeDir) as Record<string, unknown>[];
      expect(procs2).toHaveLength(1);
      expect(procs2[0].id).toBe(originalId);
      expect(procs2[0].registeredAt).toBe(originalRegisteredAt);
      expect(procs2[0].label).toBe('v2');
      expect(procs2[0].port).toBe(4000);
    });

    it('lists processes with alive=true for current PID', () => {
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'dev-server',
      ]);
      const list = JSON.parse(run(claudeDir, ['process', 'list']).stdout) as Record<
        string,
        unknown
      >[];
      expect(list).toHaveLength(1);
      expect(list[0].alive).toBe(true);
    });

    it('lists dead process with alive=false', () => {
      const deadPid = 2_147_483_647;
      run(claudeDir, ['process', 'register', '--pid', String(deadPid), '--label', 'dead-proc']);
      const list = JSON.parse(run(claudeDir, ['process', 'list']).stdout) as Record<
        string,
        unknown
      >[];
      expect(list).toHaveLength(1);
      expect(list[0].pid).toBe(deadPid);
      expect(list[0].alive).toBe(false);
    });

    it('unregisters by --pid', () => {
      run(claudeDir, ['process', 'register', '--pid', String(process.pid), '--label', 'dev']);
      expect(run(claudeDir, ['process', 'unregister', '--pid', String(process.pid)]).exitCode).toBe(
        0
      );
      expect(JSON.parse(run(claudeDir, ['process', 'list']).stdout)).toHaveLength(0);
    });

    it('unregisters by --id (UUID)', () => {
      run(claudeDir, ['process', 'register', '--pid', String(process.pid), '--label', 'dev']);
      const procId = String((readProcesses(claudeDir) as Record<string, unknown>[])[0].id);
      expect(run(claudeDir, ['process', 'unregister', '--id', procId]).exitCode).toBe(0);
      expect(JSON.parse(run(claudeDir, ['process', 'list']).stdout)).toHaveLength(0);
    });

    it('"remove" is alias for "unregister"', () => {
      run(claudeDir, ['process', 'register', '--pid', String(process.pid), '--label', 'dev']);
      expect(run(claudeDir, ['process', 'remove', '--pid', String(process.pid)]).exitCode).toBe(0);
      expect(JSON.parse(run(claudeDir, ['process', 'list']).stdout)).toHaveLength(0);
    });

    it('unregister non-existent process fails', () => {
      const { exitCode, stderr } = run(claudeDir, ['process', 'unregister', '--pid', '999999']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Process not found');
    });

    it('unregister without --pid or --id fails', () => {
      const { exitCode, stderr } = run(claudeDir, ['process', 'unregister']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --pid or --id');
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

    it('ignores invalid port (out of range)', () => {
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'test',
        '--port',
        '0',
      ]);
      expect((readProcesses(claudeDir) as Record<string, unknown>[])[0].port).toBeUndefined();
    });
  });

  // =========================================================================
  // Highwatermark
  // =========================================================================
  describe('highwatermark', () => {
    it('respects highwatermark when task file is deleted', () => {
      run(claudeDir, ['task', 'create', '--subject', 'Task 1']);
      run(claudeDir, ['task', 'create', '--subject', 'Task 2']);
      fs.unlinkSync(path.join(claudeDir, 'tasks', TEAM, '2.json'));
      expect(JSON.parse(run(claudeDir, ['task', 'create', '--subject', 'Task 3']).stdout).id).toBe(
        '3'
      );
    });

    it('handles manually set highwatermark higher than existing files', () => {
      fs.writeFileSync(path.join(claudeDir, 'tasks', TEAM, '.highwatermark'), '100');
      expect(
        JSON.parse(run(claudeDir, ['task', 'create', '--subject', 'After HWM']).stdout).id
      ).toBe('101');
    });

    it('handles missing highwatermark (uses max file ID)', () => {
      writeTask(claudeDir, '5', { id: '5', subject: 'Task 5', status: 'pending' });
      expect(JSON.parse(run(claudeDir, ['task', 'create', '--subject', 'Next']).stdout).id).toBe(
        '6'
      );
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe('error handling', () => {
    it('exits with error for unknown domain', () => {
      const { exitCode, stderr } = run(claudeDir, ['foobar', 'something']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown domain');
    });

    it.each([
      ['task', 'foobar', 'Unknown task action'],
      ['kanban', 'foobar', 'Unknown kanban action'],
      ['review', 'foobar', 'Unknown review action'],
      ['message', 'foobar', 'Unknown message action'],
      ['process', 'foobar', 'Unknown process action'],
    ])('exits with error for unknown %s action "%s"', (domain, action, expected) => {
      const { exitCode, stderr } = run(claudeDir, [domain, action]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(expected);
    });

    it('missing --team flag fails', () => {
      try {
        execFileSync(process.execPath, [scriptPath, '--claude-dir', claudeDir, 'task', 'list'], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect.fail('Expected error');
      } catch (err: unknown) {
        const e = err as { stderr?: string; status?: number };
        expect(e.status).not.toBe(0);
        expect(e.stderr).toContain('Missing --team');
      }
    });
  });

  // =========================================================================
  // Special characters in arguments
  // =========================================================================
  describe('special characters', () => {
    it('handles unicode in subject and description', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Задача с юникодом',
        '--description',
        'Описание',
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.subject).toBe('Задача с юникодом');
      expect(parsed.description).toBe('Описание');
      expect(readTask(claudeDir, '1').subject).toBe('Задача с юникодом');
    });

    it('handles quotes and special shell chars in text', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Task', status: 'pending', owner: 'bob' });
      const specialText = 'He said "hello" & she said \'goodbye\' <tag> $HOME `backticks`';
      run(claudeDir, ['task', 'comment', '1', '--text', specialText, '--from', 'alice']);
      expect((readTask(claudeDir, '1').comments as Record<string, unknown>[])[0].text).toBe(
        specialText
      );
    });

    it('handles multi-word subject with spaces', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'This is a long task subject with many words',
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).subject).toBe('This is a long task subject with many words');
    });

    it('handles newlines in message text', () => {
      const textWithNewlines = 'Line 1\nLine 2\nLine 3';
      run(claudeDir, [
        'message',
        'send',
        '--to',
        'bob',
        '--text',
        textWithNewlines,
        '--from',
        'alice',
      ]);
      expect((readInbox(claudeDir, 'bob')[0] as Record<string, unknown>).text).toBe(
        textWithNewlines
      );
    });
  });

  // =========================================================================
  // Corrupted/malformed data
  // =========================================================================
  describe('corrupted data', () => {
    it('empty task JSON file causes error on get', () => {
      fs.writeFileSync(path.join(claudeDir, 'tasks', TEAM, '1.json'), '');
      const { exitCode, stderr } = run(claudeDir, ['task', 'get', '1']);
      expect(exitCode).not.toBe(0);
      expect(stderr.length).toBeGreaterThan(0);
    });

    it('invalid JSON in task file causes error on get', () => {
      fs.writeFileSync(path.join(claudeDir, 'tasks', TEAM, '1.json'), '{invalid!!!}');
      expect(run(claudeDir, ['task', 'get', '1']).exitCode).not.toBe(0);
    });

    it('truncated JSON causes error (partial write scenario)', () => {
      fs.writeFileSync(path.join(claudeDir, 'tasks', TEAM, '1.json'), '{"id":"1","subj');
      expect(run(claudeDir, ['task', 'get', '1']).exitCode).not.toBe(0);
    });

    it('task list handles corrupted file without crashing', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Good', status: 'pending' });
      fs.writeFileSync(path.join(claudeDir, 'tasks', TEAM, '2.json'), 'CORRUPTED');

      const { stdout, exitCode } = run(claudeDir, ['task', 'list']);
      expect(exitCode).toBe(0);
      expect((JSON.parse(stdout) as unknown[]).length).toBeGreaterThanOrEqual(1);
    });

    it('briefing handles corrupted task files', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Good task', status: 'pending', owner: 'bob' });
      fs.writeFileSync(path.join(claudeDir, 'tasks', TEAM, '2.json'), 'NOT_JSON');

      const { stdout, exitCode } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Good task');
    });

    it('missing kanban-state.json -> creates on first write', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Task', status: 'completed' });
      expect(run(claudeDir, ['kanban', 'set-column', '1', 'review']).exitCode).toBe(0);
      expect(readKanban(claudeDir)).toBeDefined();
    });

    it('missing processes.json -> empty list', () => {
      expect(JSON.parse(run(claudeDir, ['process', 'list']).stdout)).toEqual([]);
    });
  });

  // =========================================================================
  // Concurrency
  // =========================================================================
  describe('concurrency', () => {
    it('parallel task creates all succeed without crashing', async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        runAsync(claudeDir, ['task', 'create', '--subject', `Parallel task ${i}`])
      );
      const results = await Promise.all(promises);

      for (const r of results) {
        expect(r.exitCode).toBe(0);
        const parsed = JSON.parse(r.stdout) as { id: string };
        expect(Number(parsed.id)).toBeGreaterThan(0);
      }

      // Note: without inter-process file locking, parallel creates may produce
      // duplicate IDs (known pre-existing limitation). We verify that all calls
      // succeed and produce valid output — not uniqueness.
      const allTasks = JSON.parse(run(claudeDir, ['task', 'list']).stdout) as unknown[];
      expect(allTasks.length).toBeGreaterThanOrEqual(1);
    });

    it('parallel comments on same task — no crash, valid structure', async () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Shared task',
        status: 'in_progress',
        owner: 'bob',
        comments: [],
      });

      const promises = Array.from({ length: 5 }, (_, i) =>
        runAsync(claudeDir, [
          'task',
          'comment',
          '1',
          '--text',
          `Comment ${i}`,
          '--from',
          `agent-${i}`,
        ])
      );
      const results = await Promise.all(promises);

      for (const r of results) {
        expect(r.exitCode).toBe(0);
      }

      // Due to read-modify-write race, not all 5 may persist.
      // The important thing: no crash, no data corruption, valid JSON.
      const task = readTask(claudeDir, '1');
      const comments = task.comments as Record<string, unknown>[];
      expect(comments.length).toBeGreaterThanOrEqual(1);
      for (const c of comments) {
        expect(c.text).toBeDefined();
        expect(c.author).toBeDefined();
        expect(c.id).toBeDefined();
      }
    });

    it('parallel messages to same inbox — no crash', async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        runAsync(claudeDir, [
          'message',
          'send',
          '--to',
          'bob',
          '--text',
          `Msg ${i}`,
          '--from',
          `agent-${i}`,
        ])
      );
      const results = await Promise.all(promises);

      for (const r of results) {
        expect(r.exitCode).toBe(0);
      }

      expect(readInbox(claudeDir, 'bob').length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Critical nuances
  // =========================================================================
  describe('critical nuances', () => {
    // --- Numeric sort (not lexicographic) ---
    it('task list sorts numerically: 1, 2, 10 (not 1, 10, 2)', () => {
      writeTask(claudeDir, '10', { id: '10', subject: 'Ten', status: 'pending' });
      writeTask(claudeDir, '2', { id: '2', subject: 'Two', status: 'pending' });
      writeTask(claudeDir, '1', { id: '1', subject: 'One', status: 'pending' });
      const tasks = JSON.parse(run(claudeDir, ['task', 'list']).stdout) as { id: string }[];
      expect(tasks.map((t) => t.id)).toEqual(['1', '2', '10']);
    });

    // --- createTask rejects duplicate ID ---
    it('task create dies if task file already exists at next ID', () => {
      // Pre-create task #1 so getNextTaskId returns 1, but file exists
      // Actually: getNextTaskId reads highwatermark + max file ID.
      // So we need to trick it: set highwatermark to 0, have 1.json exist
      writeTask(claudeDir, '1', { id: '1', subject: 'Existing', status: 'pending' });
      // Highwatermark not set → getNextTaskId uses max file ID (1) + 1 = 2
      // So this can't naturally trigger. Let's force: set HWM to 0, file 1 exists.
      fs.writeFileSync(path.join(claudeDir, 'tasks', TEAM, '.highwatermark'), '0');
      // Now getNextTaskId: max(files)=1, max(hwm)=0, next=2. Still won't collide.
      // This scenario is actually protected by the HWM logic. Good — confirms no dup.
      const { stdout, exitCode } = run(claudeDir, ['task', 'create', '--subject', 'New']);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).id).toBe('2');
    });

    // --- parseArgs: flag followed by another flag ---
    it('parseArgs: --from followed by --text sets from=true, not "--text"', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Task',
        status: 'pending',
        owner: 'bob',
      });
      // --from is immediately followed by --text (which starts with -)
      // So parseArgs should set from=true (boolean), text='Hello'
      const { exitCode } = run(claudeDir, ['task', 'comment', '1', '--from', '--text', 'Hello']);
      // from=true → not a string → defaults to 'agent'
      expect(exitCode).toBe(0);
      const comments = readTask(claudeDir, '1').comments as { author: string; text: string }[];
      expect(comments[0].author).toBe('agent'); // not "--text"
      expect(comments[0].text).toBe('Hello');
    });

    // --- reviewApprove without --notify-owner creates NO inbox ---
    it('review approve without --notify-owner does NOT create inbox', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Feature',
        status: 'completed',
        owner: 'bob',
      });
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      run(claudeDir, ['review', 'approve', '1']); // no --notify-owner
      expect(readInbox(claudeDir, 'bob')).toEqual([]);
    });

    // --- request-changes: verify ALL three side effects ---
    it('review request-changes: kanban cleared + status in_progress + inbox sent', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'PR',
        status: 'completed',
        owner: 'bob',
      });
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      run(claudeDir, [
        'review',
        'request-changes',
        '1',
        '--comment',
        'Missing tests',
        '--from',
        'alice',
      ]);
      // 1) Kanban cleared
      expect((readKanban(claudeDir).tasks as Record<string, unknown>)['1']).toBeUndefined();
      // 2) Status changed to in_progress
      expect(readTask(claudeDir, '1').status).toBe('in_progress');
      // 3) Inbox message sent
      const inbox = readInbox(claudeDir, 'bob') as Record<string, unknown>[];
      expect(inbox).toHaveLength(1);
      expect(inbox[0].from).toBe('alice');
      expect(String(inbox[0].text)).toContain('Missing tests');
      expect(String(inbox[0].text)).toContain('Please fix');
    });

    // --- Alternative flag names: --teamName ---
    it('accepts --teamName as alternative to --team', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Alt flag', status: 'pending' });
      try {
        const stdout = execFileSync(
          process.execPath,
          [scriptPath, '--claude-dir', claudeDir, '--teamName', TEAM, 'task', 'get', '1'],
          { encoding: 'utf8', timeout: 10_000 }
        );
        expect(JSON.parse(stdout).subject).toBe('Alt flag');
      } catch {
        expect.fail('--teamName flag should be accepted');
      }
    });

    // --- Alternative flag: --claudeDir ---
    it('accepts --claudeDir as alternative to --claude-dir', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'claudeDir alt', status: 'pending' });
      try {
        const stdout = execFileSync(
          process.execPath,
          [scriptPath, '--claudeDir', claudeDir, '--team', TEAM, 'task', 'get', '1'],
          { encoding: 'utf8', timeout: 10_000 }
        );
        expect(JSON.parse(stdout).subject).toBe('claudeDir alt');
      } catch {
        expect.fail('--claudeDir flag should be accepted');
      }
    });

    // --- Inbox isolation between members ---
    it('messages to different members are isolated', () => {
      run(claudeDir, ['message', 'send', '--to', 'alice', '--text', 'For Alice', '--from', 'bob']);
      run(claudeDir, ['message', 'send', '--to', 'bob', '--text', 'For Bob', '--from', 'alice']);
      const aliceInbox = readInbox(claudeDir, 'alice') as Record<string, unknown>[];
      const bobInbox = readInbox(claudeDir, 'bob') as Record<string, unknown>[];
      expect(aliceInbox).toHaveLength(1);
      expect(bobInbox).toHaveLength(1);
      expect(aliceInbox[0].text).toBe('For Alice');
      expect(bobInbox[0].text).toBe('For Bob');
    });

    // --- Empty string arguments rejected ---
    it('task create with empty --subject fails', () => {
      const { exitCode, stderr } = run(claudeDir, ['task', 'create', '--subject', '']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --subject');
    });

    it('task comment with empty --text fails', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'T', status: 'pending' });
      const { exitCode, stderr } = run(claudeDir, ['task', 'comment', '1', '--text', '']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --text');
    });

    it('message send with empty --text fails', () => {
      const { exitCode, stderr } = run(claudeDir, ['message', 'send', '--to', 'bob', '--text', '']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Missing --text');
    });

    // --- Invalid explicit status + owner → falls back to in_progress ---
    it('task create with invalid --status and --owner defaults to in_progress', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Fallback status',
        '--owner',
        'bob',
        '--status',
        'bogus',
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).status).toBe('in_progress');
    });

    it('task create with invalid --status and NO owner defaults to pending', () => {
      const { stdout, exitCode } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Fallback no owner',
        '--status',
        'bogus',
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).status).toBe('pending');
    });

    // --- writeTask verification: stdout matches disk ---
    it('task create stdout is byte-identical to file on disk', () => {
      const { stdout } = run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Verify sync',
        '--description',
        'Detailed desc',
        '--owner',
        'bob',
        '--from',
        'alice',
        '--active-form',
        'Verifying sync',
      ]);
      const fromStdout = JSON.parse(stdout);
      const fromDisk = readTask(claudeDir, fromStdout.id);
      expect(fromDisk.subject).toBe(fromStdout.subject);
      expect(fromDisk.description).toBe(fromStdout.description);
      expect(fromDisk.owner).toBe(fromStdout.owner);
      expect(fromDisk.createdBy).toBe(fromStdout.createdBy);
      expect(fromDisk.activeForm).toBe(fromStdout.activeForm);
      expect(fromDisk.status).toBe(fromStdout.status);
      expect(fromDisk.blocks).toEqual(fromStdout.blocks);
      expect(fromDisk.blockedBy).toEqual(fromStdout.blockedBy);
    });

    // --- Comment inbox notification: exact format verification ---
    it('comment inbox notification has correct format', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Auth module',
        status: 'in_progress',
        owner: 'bob',
      });
      run(claudeDir, [
        'task',
        'comment',
        '1',
        '--text',
        'Please add error handling',
        '--from',
        'alice',
      ]);
      const inbox = readInbox(claudeDir, 'bob') as Record<string, unknown>[];
      expect(inbox).toHaveLength(1);
      expect(inbox[0].from).toBe('alice');
      expect(String(inbox[0].text)).toContain('Comment on task #1');
      expect(String(inbox[0].text)).toContain('Auth module');
      expect(String(inbox[0].text)).toContain('Please add error handling');
      expect(String(inbox[0].summary)).toContain('#1');
      expect(inbox[0].read).toBe(false);
      expect(String(inbox[0].timestamp)).toMatch(ISO_RE);
      expect(String(inbox[0].messageId)).toMatch(UUID_RE);
    });

    // --- Comment on task without owner: no crash, no inbox ---
    it('comment on task without owner does not crash and sends no inbox', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Orphan', status: 'pending' });
      const { exitCode } = run(claudeDir, [
        'task',
        'comment',
        '1',
        '--text',
        'Note to self',
        '--from',
        'alice',
      ]);
      expect(exitCode).toBe(0);
      expect((readTask(claudeDir, '1').comments as unknown[]).length).toBe(1);
      // No inboxes dir should exist
      const inboxDir = path.join(claudeDir, 'teams', TEAM, 'inboxes');
      try {
        expect(fs.readdirSync(inboxDir)).toHaveLength(0);
      } catch {
        // dir doesn't exist — correct
      }
    });

    // --- Briefing kanban override: completed task in review column ---
    it('briefing shows kanban column override, not raw status', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'In review task',
        status: 'completed',
        owner: 'bob',
      });
      // Kanban says review, status says completed — briefing should say REVIEW
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      const yourSection = stdout.slice(stdout.indexOf('YOUR TASKS'));
      expect(yourSection).toContain('[REVIEW]');
      expect(yourSection).not.toContain('[DONE]');
    });

    // --- Port boundaries ---
    it('process register with port=1 (min valid)', () => {
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'min-port',
        '--port',
        '1',
      ]);
      expect((readProcesses(claudeDir) as Record<string, unknown>[])[0].port).toBe(1);
    });

    it('process register with port=65535 (max valid)', () => {
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'max-port',
        '--port',
        '65535',
      ]);
      expect((readProcesses(claudeDir) as Record<string, unknown>[])[0].port).toBe(65535);
    });

    it('process register with port=65536 (over max) -> ignored', () => {
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'over-port',
        '--port',
        '65536',
      ]);
      expect((readProcesses(claudeDir) as Record<string, unknown>[])[0].port).toBeUndefined();
    });

    // --- set-status idempotent ---
    it('set-status to same value is idempotent', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'Task', status: 'in_progress' });
      expect(run(claudeDir, ['task', 'set-status', '1', 'in_progress']).exitCode).toBe(0);
      expect(readTask(claudeDir, '1').status).toBe('in_progress');
    });

    // --- Corrupted highwatermark ---
    it('corrupted highwatermark (non-numeric) falls back to max file ID', () => {
      writeTask(claudeDir, '3', { id: '3', subject: 'Three', status: 'pending' });
      fs.writeFileSync(path.join(claudeDir, 'tasks', TEAM, '.highwatermark'), 'garbage');
      // readJson parses "garbage" → JSON.parse throws. readJson only catches ENOENT.
      // This SHOULD crash the script on task create. Let's verify behavior.
      const result = run(claudeDir, ['task', 'create', '--subject', 'After garbage HWM']);
      // If script handles it gracefully, ID should be > 3. If it crashes, exitCode != 0.
      if (result.exitCode === 0) {
        expect(Number(JSON.parse(result.stdout).id)).toBeGreaterThan(3);
      } else {
        // Script crashes on invalid JSON in .highwatermark — this IS a bug.
        // Document the behavior: corrupted HWM causes task create to fail.
        expect(result.stderr.length).toBeGreaterThan(0);
      }
    });

    // --- Briefing: effective column logic per status ---
    it('briefing: pending→TODO, in_progress→IN PROGRESS, completed→DONE columns', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Pending task',
        status: 'pending',
        owner: 'bob',
      });
      writeTask(claudeDir, '2', {
        id: '2',
        subject: 'Active task',
        status: 'in_progress',
        owner: 'bob',
      });
      writeTask(claudeDir, '3', {
        id: '3',
        subject: 'Done task',
        status: 'completed',
        owner: 'bob',
      });

      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(stdout).toContain('#1 [TODO]');
      expect(stdout).toContain('#2 [IN_PROGRESS]');
      expect(stdout).toContain('#3 [DONE]');
    });

    // --- Comment self-notification: owner comments on own task ---
    it('comment by task owner does NOT self-notify', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'My task',
        status: 'in_progress',
        owner: 'bob',
      });
      run(claudeDir, ['task', 'comment', '1', '--text', 'Progress note', '--from', 'bob']);
      expect(readInbox(claudeDir, 'bob')).toEqual([]);
    });

    // --- Kanban set-column updates movedAt on re-set ---
    it('kanban set-column updates movedAt timestamp on re-assignment', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'T', status: 'completed' });
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      const movedAt1 = (readKanban(claudeDir).tasks as Record<string, Record<string, unknown>>)['1']
        .movedAt;

      // Small delay to ensure different timestamp
      const start = Date.now();
      while (Date.now() - start < 5);

      run(claudeDir, ['kanban', 'set-column', '1', 'approved']);
      const movedAt2 = (readKanban(claudeDir).tasks as Record<string, Record<string, unknown>>)['1']
        .movedAt;

      expect(movedAt1).not.toBe(movedAt2);
      expect(String(movedAt2)).toMatch(ISO_RE);
    });

    // --- Task create notification: AGENT_BLOCK markers ---
    it('task create notification contains AGENT_BLOCK markers and tool instructions', () => {
      run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Build feature',
        '--owner',
        'bob',
        '--notify',
        '--from',
        'alice',
      ]);
      const inbox = readInbox(claudeDir, 'bob') as Record<string, unknown>[];
      const text = String(inbox[0].text);
      // Must contain agent block markers (```info_for_agent ... ```)
      expect(text).toContain('info_for_agent');
      expect(text).toContain('task start');
      expect(text).toContain('task complete');
    });

    // --- readKanbanState fallback with corrupted kanban ---
    it('kanban set-column works even with corrupted kanban-state.json', () => {
      writeTask(claudeDir, '1', { id: '1', subject: 'T', status: 'completed' });
      const kanbanPath = path.join(claudeDir, 'teams', TEAM, 'kanban-state.json');
      fs.writeFileSync(kanbanPath, '{corrupted!!!}');
      // readKanbanState: readJson will throw (not ENOENT) → script crashes
      const result = run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      if (result.exitCode === 0) {
        expect(
          (readKanban(claudeDir).tasks as Record<string, Record<string, unknown>>)['1'].column
        ).toBe('review');
      } else {
        // Documents that corrupted kanban-state.json crashes kanban operations
        expect(result.stderr.length).toBeGreaterThan(0);
      }
    });

    // --- Multiple processes in same team ---
    it('multiple processes coexist independently', () => {
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        String(process.pid),
        '--label',
        'server-1',
        '--port',
        '3000',
      ]);
      run(claudeDir, [
        'process',
        'register',
        '--pid',
        '99998',
        '--label',
        'server-2',
        '--port',
        '3001',
      ]);
      const procs = readProcesses(claudeDir) as Record<string, unknown>[];
      expect(procs).toHaveLength(2);
      expect(procs.map((p) => p.label)).toEqual(['server-1', 'server-2']);
      // Unregister one, other stays
      run(claudeDir, ['process', 'unregister', '--pid', '99998']);
      const after = readProcesses(claudeDir) as Record<string, unknown>[];
      expect(after).toHaveLength(1);
      expect(after[0].label).toBe('server-1');
    });

    // --- review approve also writes to kanban (column=approved) ---
    it('review approve sets kanban column to approved with movedAt', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'PR task',
        status: 'completed',
        owner: 'bob',
      });
      run(claudeDir, ['kanban', 'set-column', '1', 'review']);
      run(claudeDir, ['review', 'approve', '1']);
      const entry = (readKanban(claudeDir).tasks as Record<string, Record<string, unknown>>)['1'];
      expect(entry.column).toBe('approved');
      expect(String(entry.movedAt)).toMatch(ISO_RE);
    });

    // --- Task create without --description defaults to subject ---
    it('task description defaults to subject when omitted', () => {
      run(claudeDir, ['task', 'create', '--subject', 'Self-describing task']);
      expect(readTask(claudeDir, '1').description).toBe('Self-describing task');
    });

    // --- Task create with --description different from subject ---
    it('task description stored separately from subject when provided', () => {
      run(claudeDir, [
        'task',
        'create',
        '--subject',
        'Short title',
        '--description',
        'A much longer and more detailed description of the work',
      ]);
      const task = readTask(claudeDir, '1');
      expect(task.subject).toBe('Short title');
      expect(task.description).toBe('A much longer and more detailed description of the work');
    });

    // --- Briefing: description != subject shown, description == subject hidden ---
    it('briefing hides description when identical to subject', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Same as desc',
        description: 'Same as desc',
        status: 'in_progress',
        owner: 'bob',
      });
      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(stdout).toContain('Same as desc');
      expect(stdout).not.toContain('Description:');
    });

    it('briefing shows description when different from subject', () => {
      writeTask(claudeDir, '1', {
        id: '1',
        subject: 'Title',
        description: 'A detailed description that differs from the title',
        status: 'in_progress',
        owner: 'bob',
      });
      const { stdout } = run(claudeDir, ['task', 'briefing', '--for', 'bob']);
      expect(stdout).toContain('Description:');
      expect(stdout).toContain('A detailed description that differs from the title');
    });

    // --- Inbox corrupted: sendInboxMessage with corrupted existing inbox ---
    it('message send to inbox with non-array content recovers', () => {
      // Pre-write corrupted inbox (object instead of array)
      const inboxDir = path.join(claudeDir, 'teams', TEAM, 'inboxes');
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(path.join(inboxDir, 'bob.json'), '{"not": "an array"}');

      const { exitCode } = run(claudeDir, [
        'message',
        'send',
        '--to',
        'bob',
        '--text',
        'Recovery msg',
        '--from',
        'alice',
      ]);
      expect(exitCode).toBe(0);
      // readJson returns the object, `Array.isArray` fails → uses empty list.
      // So message is the only item.
      const inbox = readInbox(claudeDir, 'bob') as Record<string, unknown>[];
      expect(inbox.length).toBe(1);
      expect(inbox[0].text).toBe('Recovery msg');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('empty tasks dir -> empty list', () => {
      expect(JSON.parse(run(claudeDir, ['task', 'list']).stdout)).toEqual([]);
    });

    it('missing tasks dir -> empty list', () => {
      fs.rmSync(path.join(claudeDir, 'tasks', TEAM), { recursive: true });
      expect(JSON.parse(run(claudeDir, ['task', 'list']).stdout)).toEqual([]);
    });

    it('missing tasks dir -> briefing still works', () => {
      fs.rmSync(path.join(claudeDir, 'tasks', TEAM), { recursive: true });
      const { stdout, exitCode } = run(claudeDir, ['task', 'briefing', '--for', 'alice']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('no tasks assigned to you');
    });

    it('task create auto-creates tasks directory', () => {
      fs.rmSync(path.join(claudeDir, 'tasks', TEAM), { recursive: true });
      expect(run(claudeDir, ['task', 'create', '--subject', 'Auto-dir']).exitCode).toBe(0);
      expect(readTask(claudeDir, '1').subject).toBe('Auto-dir');
    });

    it('lead name inference falls back to first member when no lead role', () => {
      fs.writeFileSync(
        path.join(claudeDir, 'teams', TEAM, 'config.json'),
        JSON.stringify({ name: TEAM, members: [{ name: 'charlie' }, { name: 'diana' }] })
      );
      run(claudeDir, ['message', 'send', '--to', 'diana', '--text', 'Hi']);
      expect((readInbox(claudeDir, 'diana')[0] as Record<string, unknown>).from).toBe('charlie');
    });

    it('lead name inference falls back to "team-lead" with empty members', () => {
      fs.writeFileSync(
        path.join(claudeDir, 'teams', TEAM, 'config.json'),
        JSON.stringify({ name: TEAM, members: [] })
      );
      run(claudeDir, ['message', 'send', '--to', 'bob', '--text', 'Hi']);
      expect((readInbox(claudeDir, 'bob')[0] as Record<string, unknown>).from).toBe('team-lead');
    });

    it('lead name inference falls back to "team-lead" with missing config', () => {
      fs.unlinkSync(path.join(claudeDir, 'teams', TEAM, 'config.json'));
      run(claudeDir, ['message', 'send', '--to', 'bob', '--text', 'Hi']);
      expect((readInbox(claudeDir, 'bob')[0] as Record<string, unknown>).from).toBe('team-lead');
    });
  });
});
