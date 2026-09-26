const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createController, hostedTaskCommand } = require('../src/index.js');
const {
  hostedTaskBoardRevision,
  hostedTaskBoardSourceGeneration,
  hostedTaskBoardTaskId,
  hostedTaskIdForCommand,
} = require('../src/internal/hostedBoardIdentity.js');

const TEAM = 'hosted-team';
const TEAM_ID = `team_${'a'.repeat(32)}`;
const BOARD = { deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: 'workspace_test', mountGeneration: 1, teamId: TEAM_ID };

describe('hosted task command', () => {
  const tempDirs = [];
  let claudeDir;

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-task-command-'));
    tempDirs.push(claudeDir);
    fs.mkdirSync(path.join(claudeDir, 'teams', TEAM), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, 'tasks', TEAM), { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'teams', TEAM, 'config.json'),
      JSON.stringify({ name: TEAM, members: [{ name: 'team-lead', agentType: 'team-lead' }, { name: 'bob', role: 'developer' }] })
    );
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function board() {
    const identity = (dir) => {
      const stat = fs.lstatSync(dir, { bigint: true });
      return [stat.dev.toString(), stat.ino.toString()];
    };
    const sourceGeneration = hostedTaskBoardSourceGeneration({
      ...BOARD,
      teamDirectory: identity(path.join(claudeDir, 'teams', TEAM)),
      tasksDirectory: identity(path.join(claudeDir, 'tasks', TEAM)),
    });
    const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
    const tasksDir = path.join(claudeDir, 'tasks', TEAM);
    const revision = hostedTaskBoardRevision({
      sourceGeneration,
      taskFiles: fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json')).map((name) => ({ name, text: read(path.join(tasksDir, name)) })),
      kanbanText: read(path.join(claudeDir, 'teams', TEAM, 'kanban-state.json')),
      rosterFiles: ['config.json', 'members.meta.json'].map((name) => ({ name, text: read(path.join(claudeDir, 'teams', TEAM, name)) })),
    });
    return { sourceGeneration, revision };
  }

  function run(command, overrides = {}) {
    const { sourceGeneration, revision } = board();
    return hostedTaskCommand.executeHostedTaskCommand(
      {
        schemaVersion: 1,
        kind: 'hosted_task_command',
        teamName: TEAM,
        board: BOARD,
        lead: { name: 'team-lead', sessionId: null },
        lockTimeoutMs: 1000,
        payloadFingerprint: overrides.payloadFingerprint ?? 'f'.repeat(43),
        command: {
          schemaVersion: 1,
          commandId: 'command_1',
          idempotencyKey: 'key-1',
          teamId: TEAM_ID,
          expectedSourceGeneration: sourceGeneration,
          expectedRevision: overrides.expectedRevision ?? revision,
          ...command,
        },
      },
      { claudeDir }
    );
  }

  const create = { kind: 'create_task', subject: 'Ship it', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 };
  const taskFiles = () => fs.readdirSync(path.join(claudeDir, 'tasks', TEAM)).filter((name) => name.endsWith('.json'));
  const rawId = () => hostedTaskIdForCommand(TEAM_ID, 'command_1');
  const publicId = () => hostedTaskBoardTaskId(TEAM_ID, rawId());

  it('creates once per command and rejects a different payload for the same command', () => {
    const first = run(create);
    expect(first.result).toMatchObject({ kind: 'committed', receipt: { outcome: 'committed', affectedTaskIds: [publicId()] } });
    expect(first.selfWriteEffects).toEqual([{ fileKey: rawId(), expectedChecksum: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(run(create).result).toMatchObject({ kind: 'idempotent_replay', receipt: { outcome: 'idempotent_replay' } });
    expect(run(create, { payloadFingerprint: 'g'.repeat(43) }).result).toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });
    expect(taskFiles()).toEqual([`${rawId()}.json`]);
  });

  it('moves by status so an agent clearing the kanban keeps the task in its column', () => {
    run(create);
    const controller = createController({ teamName: TEAM, claudeDir });
    const move = (column) => run({ commandId: `command_move_${column}`, idempotencyKey: `move-${column}`, kind: 'move_task', taskId: publicId(), column, order: 0 });

    expect(move('in_progress').result.kind).toBe('committed');
    expect(controller.tasks.getTask(rawId()).status).toBe('in_progress');
    expect(move('done').result.kind).toBe('committed');
    expect(controller.tasks.getTask(rawId()).status).toBe('completed');

    // Agent-side board writes rewrite the kanban and drop column-only placements.
    controller.kanban.clearKanban(rawId(), { transition: 'status_reset' });
    expect(controller.tasks.getTask(rawId()).status).toBe('completed');
    expect(controller.kanban.getKanbanState().tasks[rawId()]).toBeUndefined();
  });

  it('moves a task listed next to a vanished task id in another column', () => {
    run(create);
    // An agent or a crash left an order entry whose task file is gone.
    fs.writeFileSync(
      path.join(claudeDir, 'teams', TEAM, 'kanban-state.json'),
      JSON.stringify({ teamName: TEAM, reviewers: [], tasks: {}, columnOrder: { todo: ['gone-task', rawId()] } })
    );
    const outcome = run({ commandId: 'command_move', idempotencyKey: 'move', kind: 'move_task', taskId: publicId(), column: 'in_progress', order: 0 });

    expect(outcome.result.kind).toBe('committed');
    const state = JSON.parse(fs.readFileSync(path.join(claudeDir, 'teams', TEAM, 'kanban-state.json'), 'utf8'));
    expect(state.columnOrder.todo ?? []).not.toContain(rawId());
    expect(state.columnOrder.in_progress).toEqual([rawId()]);
  });

  it('refuses review for a task that is not completed without writing, like desktop', () => {
    run(create);
    const before = board().revision;
    const outcome = run({ commandId: 'command_review', idempotencyKey: 'review', kind: 'move_task', taskId: publicId(), column: 'review', order: 0 });

    expect(outcome.result).toMatchObject({ kind: 'conflict', reason: 'state_conflict' });
    expect(board().revision).toBe(before);
  });

  it('maps unresolved dependencies to relationship_conflict', () => {
    const controller = createController({ teamName: TEAM, claudeDir });
    const blocker = controller.tasks.createTask({ subject: 'Blocker', from: 'user' });
    const blocked = controller.tasks.createTask({ subject: 'Blocked', blockedBy: [blocker.id], from: 'user' });
    const outcome = run({ kind: 'move_task', taskId: hostedTaskBoardTaskId(TEAM_ID, blocked.id), column: 'in_progress', order: 0 });
    expect(outcome.result).toMatchObject({ kind: 'conflict', reason: 'relationship_conflict', currentRevision: board().revision });
    expect(controller.tasks.getTask(blocked.id).status).toBe('pending');
  });

  it('answers stale_revision for an outdated expected revision without writing', () => {
    run(create);
    const before = fs.readFileSync(path.join(claudeDir, 'tasks', TEAM, `${rawId()}.json`), 'utf8');
    const stale = run(
      { commandId: 'command_2', idempotencyKey: 'key-2', kind: 'update_status', taskId: publicId(), status: 'in_progress' },
      { expectedRevision: `revision_${'0'.repeat(64)}` }
    );
    expect(stale.result).toEqual({ kind: 'stale_revision', currentSourceGeneration: board().sourceGeneration, currentRevision: board().revision });
    expect(stale.selfWriteEffects).toEqual([]);
    expect(fs.readFileSync(path.join(claudeDir, 'tasks', TEAM, `${rawId()}.json`), 'utf8')).toBe(before);
  });

  it('answers unavailable without any write while another process holds the board lock', async () => {
    const holder = spawn(
      process.execPath,
      ['-e', `require(${JSON.stringify(path.join(__dirname, '../src/internal/fileLock.js'))}).withFileLockSync(${JSON.stringify(path.join(claudeDir, 'teams', TEAM, 'board-state'))}, () => { process.stdout.write('held\\n'); const end = Date.now() + 3000; while (Date.now() < end) {} })`],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    try {
      const outcome = run(create);
      expect(outcome).toEqual({ schemaVersion: 1, result: { kind: 'unavailable', retryAfterMs: 1000 }, selfWriteEffects: [] });
      expect(taskFiles()).toEqual([]);
      expect(fs.existsSync(path.join(claudeDir, 'teams', TEAM, 'kanban-state.json'))).toBe(false);
    } finally {
      holder.kill();
    }
  });
});
