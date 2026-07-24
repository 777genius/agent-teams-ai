import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandLedgerStatus,
  ApplicationCommandRunOutcome,
} from '@features/application-command-ledger/contracts';
import {
  createApplicationCommandLedgerFeature,
  NodeApplicationCommandHasher,
} from '@features/application-command-ledger/main';
import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import {
  TaskBoardCommandFacade,
  type TaskBoardCreateTaskDestination,
} from '@features/task-board-commands';
import { type AgentTeamsController, createController } from 'agent-teams-controller';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InProcessGateway } from '../internal-storage/helpers/InProcessGateway';

import type { TeamTask } from '@shared/types';

const TEAM_NAME = 'task-command-e2e';
const CREATE_TASK_OPERATION = 'task.create';

describe('task-board commands E2E', () => {
  let tmpDir: string | null = null;
  let core: InternalStorageWorkerCore | null = null;

  afterEach(async () => {
    core?.close();
    core = null;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('deduplicates one create intent across SQLite and the real controller taskBoard', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('11111111-1111-4111-8111-111111111111');
    const command = {
      teamName: TEAM_NAME,
      identity,
      payload: { subject: 'One durable task', createdBy: 'user' },
      destination: harness.destination,
    };

    const first = await harness.facade.createTask(command);
    const replay = await harness.facade.createTask(command);

    expect(first.outcome).toBe(ApplicationCommandRunOutcome.Executed);
    expect(first.createdInAttempt).toBe(true);
    expect(replay.outcome).toBe(ApplicationCommandRunOutcome.Replayed);
    expect(replay.createdInAttempt).toBe(false);
    expect(replay.task.id).toBe(identity.commandId);
    expect(replay.task).not.toHaveProperty('creationCommand');
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(1);
  });

  it('uses the legacy create path when the SQLite backend falls back after an ABI failure', async () => {
    const harness = await makeHarness();
    const destinationCreate = vi.spyOn(harness.destination, 'create');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const selector = new InternalStorageBackendSelector(() =>
      Promise.reject(new Error('native module ABI mismatch'))
    );
    const runner = { run: vi.fn() };
    const hasher = new NodeApplicationCommandHasher();
    const facade = new TaskBoardCommandFacade(runner as never, {
      isDurableStorageAvailable: () => selector.select(true, false),
      hashPayload: (payload) => hasher.hashJson(payload),
    });
    const command = {
      teamName: TEAM_NAME,
      identity: makeIdentity('12121212-1212-4212-8212-121212121212'),
      payload: { subject: 'Legacy fallback task', createdBy: 'user' },
      destination: harness.destination,
    };

    const first = await facade.createTask(command);
    const replay = await facade.createTask(command);

    expect(selector.getBackendKind()).toBe('json-fallback');
    expect(runner.run).not.toHaveBeenCalled();
    expect(first.outcome).toBe(ApplicationCommandRunOutcome.Executed);
    expect(first.createdInAttempt).toBe(true);
    expect(first.task.id).toBe(command.identity.commandId);
    expect(replay.outcome).toBe(ApplicationCommandRunOutcome.Replayed);
    expect(replay.createdInAttempt).toBe(false);
    expect(replay.task.id).toBe(command.identity.commandId);
    expect(destinationCreate).toHaveBeenCalledOnce();
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(1);
  });

  it('repairs relationship backlinks when reconciliation is available and safely falls back otherwise', async () => {
    const harness = await makeHarness();
    const dependency = harness.controller.taskBoard.createTask({
      subject: 'Dependency',
    }) as TeamTask;
    const identity = makeIdentity('66666666-6666-4666-8666-666666666666');
    const payload = {
      subject: 'Task with recoverable backlink',
      createdBy: 'user',
      blockedBy: [dependency.id],
    };
    const destination: TaskBoardCreateTaskDestination = {
      ...harness.destination,
      create: async (input) => {
        harness.controller.taskBoard.createTask(input);
        const dependencyPath = path.join(
          harness.claudeDir,
          'tasks',
          TEAM_NAME,
          `${dependency.id}.json`
        );
        const dependencyRow = JSON.parse(await fs.readFile(dependencyPath, 'utf8')) as {
          blocks?: string[];
        };
        dependencyRow.blocks = [];
        await fs.writeFile(dependencyPath, JSON.stringify(dependencyRow));
        throw new Error('Simulated failure after the task row was committed');
      },
    };

    const result = await harness.facade.createTask({
      teamName: TEAM_NAME,
      identity,
      payload,
      destination,
    });

    const dependencyAfterRecovery = harness.controller.taskBoard.getTask(dependency.id) as TeamTask;
    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Executed);
    expect(result.createdInAttempt).toBe(true);
    if (harness.destination.reconcile) {
      expect(dependencyAfterRecovery.blocks).toContain(identity.commandId);
    } else {
      expect(dependencyAfterRecovery.blocks ?? []).not.toContain(identity.commandId);
      expect(result.task.id).toBe(identity.commandId);
    }
  });

  it('reconciles a stale started command with an existing destination task', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('22222222-2222-4222-8222-222222222222');
    const payload = { subject: 'Already persisted task', createdBy: 'user' };
    await seedStaleStarted(harness, identity, payload);
    await harness.destination.create({
      ...payload,
      id: identity.commandId,
      creationCommand: makeCreationCommand(identity, payload),
    });

    const result = await harness.facade.createTask({
      teamName: TEAM_NAME,
      identity,
      payload,
      destination: harness.destination,
    });

    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Reconciled);
    expect(result.createdInAttempt).toBe(false);
    expect(result.task.id).toBe(identity.commandId);
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(1);
  });

  it('retries once when stale reconciliation proves the task was not created', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('33333333-3333-4333-8333-333333333333');
    const payload = { subject: 'Recovered missing task', createdBy: 'user' };
    await seedStaleStarted(harness, identity, payload);

    const result = await harness.facade.createTask({
      teamName: TEAM_NAME,
      identity,
      payload,
      destination: harness.destination,
    });

    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Retried);
    expect(result.createdInAttempt).toBe(true);
    expect(result.task.id).toBe(identity.commandId);
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(1);
  });

  it('uses the original ledger command id when the same idempotency key is retried', async () => {
    const harness = await makeHarness();
    const original = makeIdentity('44444444-4444-4444-8444-444444444444');
    const retried = {
      commandId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: original.idempotencyKey,
    };
    const payload = { subject: 'Original destination identity', createdBy: 'user' };
    await seedStaleStarted(harness, original, payload);
    await harness.destination.create({
      ...payload,
      id: original.commandId,
      creationCommand: makeCreationCommand(original, payload),
    });

    const result = await harness.facade.createTask({
      teamName: TEAM_NAME,
      identity: retried,
      payload,
      destination: harness.destination,
    });

    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Reconciled);
    expect(result.task.id).toBe(original.commandId);
    expect(harness.destination.findById(retried.commandId)).toBeNull();
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(1);
  });

  it('returns a matching known task after a destination provenance conflict', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('77777777-7777-4777-8777-777777777777');
    const payload = { subject: 'Conflicting destination', createdBy: 'user' };
    const conflictingProvenance = {
      ...makeCreationCommand(identity, payload),
      payloadHash: 'sha256:not-the-command-payload',
    };
    const conflictingTask = harness.controller.taskBoard.createTask({
      ...payload,
      id: identity.commandId,
      status: 'completed',
      creationCommand: conflictingProvenance,
    }) as TeamTask;
    const destination = harness.destination.reconcile
      ? harness.destination
      : {
          ...harness.destination,
          findById: () => ({ ...conflictingTask, creationCommand: conflictingProvenance }),
        };

    const result = await harness.facade.createTask({
      teamName: TEAM_NAME,
      identity,
      payload,
      destination,
    });

    const record = await harness.ledgerStore.getByCommandId({
      namespace: 'task-board',
      scopeKey: TEAM_NAME,
      commandId: identity.commandId,
    });
    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Executed);
    expect(result.createdInAttempt).toBe(false);
    expect(result.task.status).toBe('completed');
    expect(record?.status).toBe(ApplicationCommandLedgerStatus.Completed);
    expect(record?.attemptCount).toBe(1);
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(1);
  });

  it('reconciles a stale command with a matching known task after a provenance conflict', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('88888888-8888-4888-8888-888888888888');
    const payload = { subject: 'Stale conflicting destination', createdBy: 'user' };
    await seedStaleStarted(harness, identity, payload);
    const conflictingProvenance = {
      ...makeCreationCommand(identity, payload),
      payloadHash: 'sha256:not-the-command-payload',
    };
    const conflictingTask = harness.controller.taskBoard.createTask({
      ...payload,
      id: identity.commandId,
      status: 'completed',
      creationCommand: conflictingProvenance,
    }) as TeamTask;
    const destination = harness.destination.reconcile
      ? harness.destination
      : {
          ...harness.destination,
          findById: () => ({ ...conflictingTask, creationCommand: conflictingProvenance }),
        };

    const result = await harness.facade.createTask({
      teamName: TEAM_NAME,
      identity,
      payload,
      destination,
    });

    const record = await harness.ledgerStore.getByCommandId({
      namespace: 'task-board',
      scopeKey: TEAM_NAME,
      commandId: identity.commandId,
    });
    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Reconciled);
    expect(result.createdInAttempt).toBe(false);
    expect(result.task.status).toBe('completed');
    expect(record?.status).toBe(ApplicationCommandLedgerStatus.Completed);
    expect(record?.attemptCount).toBe(1);
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(1);
  });

  it('terminalizes a stale command after the created task subject was edited', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('99999999-9999-4999-8999-999999999999');
    const payload = { subject: 'Original subject', createdBy: 'user' };
    await seedStaleStarted(harness, identity, payload);
    harness.controller.taskBoard.createTask({
      ...payload,
      id: identity.commandId,
      creationCommand: makeCreationCommand(identity, payload),
    });
    const taskPath = path.join(harness.claudeDir, 'tasks', TEAM_NAME, `${identity.commandId}.json`);
    const taskRow = JSON.parse(await fs.readFile(taskPath, 'utf8')) as TeamTask;
    taskRow.subject = 'Edited subject';
    await fs.writeFile(taskPath, JSON.stringify(taskRow));
    const destination = harness.destination.reconcile
      ? harness.destination
      : {
          ...harness.destination,
          findById: () => ({
            ...taskRow,
            creationCommand: makeCreationCommand(identity, payload),
          }),
        };

    await expect(
      harness.facade.createTask({
        teamName: TEAM_NAME,
        identity,
        payload,
        destination,
      })
    ).rejects.toThrow('Task creation conflicts with an existing destination task');

    const record = await harness.ledgerStore.getByCommandId({
      namespace: 'task-board',
      scopeKey: TEAM_NAME,
      commandId: identity.commandId,
    });
    expect(record?.status).toBe(ApplicationCommandLedgerStatus.FailedTerminal);
    expect(record?.attemptCount).toBe(2);
  });

  it('records a destination scope mismatch as terminal before creating a task', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const scopeKey = 'another-team';
    const destination = harness.destination.reconcile
      ? harness.destination
      : {
          ...harness.destination,
          create: () => {
            throw new Error('Task creation command conflict: scope does not match team');
          },
        };

    await expect(
      harness.facade.createTask({
        teamName: scopeKey,
        identity,
        payload: { subject: 'Wrong destination scope', createdBy: 'user' },
        destination,
      })
    ).rejects.toThrow('Task creation command conflict: scope does not match team');

    const record = await harness.ledgerStore.getByCommandId({
      namespace: 'task-board',
      scopeKey,
      commandId: identity.commandId,
    });
    expect(record?.status).toBe(ApplicationCommandLedgerStatus.FailedTerminal);
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(0);
  });

  it('rejects an unrelated same-id task when reconciliation and provenance are unavailable', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const payload = { subject: 'Expected destination task', createdBy: 'user' };
    const unrelatedTask: TeamTask = {
      id: identity.commandId,
      subject: 'UNRELATED SUBJECT',
      status: 'pending',
    };
    const create = vi.fn(() => unrelatedTask);
    const destination: TaskBoardCreateTaskDestination = {
      findById: () => unrelatedTask,
      create,
    };

    await expect(
      harness.facade.createTask({
        teamName: TEAM_NAME,
        identity,
        payload,
        destination,
      })
    ).rejects.toThrow('Task creation conflicts with an existing destination task');

    const record = await harness.ledgerStore.getByCommandId({
      namespace: 'task-board',
      scopeKey: TEAM_NAME,
      commandId: identity.commandId,
    });
    expect(record?.status).toBe(ApplicationCommandLedgerStatus.FailedTerminal);
    expect(record?.attemptCount).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(destination).not.toHaveProperty('reconcile');
    expect(unrelatedTask).not.toHaveProperty('creationCommand');
  });

  async function makeHarness(): Promise<{
    claudeDir: string;
    controller: AgentTeamsController;
    destination: TaskBoardCreateTaskDestination;
    facade: TaskBoardCommandFacade;
    ledgerStore: ReturnType<typeof createApplicationCommandLedgerFeature>['ledgerStore'];
  }> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-board-command-e2e-'));
    const claudeDir = path.join(tmpDir, 'claude');
    await fs.mkdir(path.join(claudeDir, 'teams', TEAM_NAME), { recursive: true });
    await fs.mkdir(path.join(claudeDir, 'tasks', TEAM_NAME), { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'teams', TEAM_NAME, 'config.json'),
      JSON.stringify({
        name: TEAM_NAME,
        leadSessionId: 'test-lead-session',
        members: [{ name: 'lead', role: 'team-lead' }],
      })
    );

    core = new InternalStorageWorkerCore({
      databasePath: path.join(tmpDir, 'storage', 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    const feature = createApplicationCommandLedgerFeature({
      storageGateway: new InProcessGateway(core),
    });
    const controller = createController({ teamName: TEAM_NAME, claudeDir });
    const destination = makeDestination(controller);
    return {
      claudeDir,
      controller,
      destination,
      facade: new TaskBoardCommandFacade(feature.runner),
      ledgerStore: feature.ledgerStore,
    };
  }
});

function makeDestination(controller: AgentTeamsController): TaskBoardCreateTaskDestination {
  const taskBoard = controller.taskBoard;
  const destination: TaskBoardCreateTaskDestination = {
    findById: (taskId) => {
      try {
        return controller.taskBoard.getTask(taskId) as TeamTask;
      } catch (error) {
        if (error instanceof Error && error.message === `Task not found: ${taskId}`) {
          return null;
        }
        throw error;
      }
    },
    create: (input) => controller.taskBoard.createTask(input) as TeamTask,
  };
  return hasTaskCreationReconciliation(taskBoard)
    ? {
        ...destination,
        reconcile: (input) => taskBoard.reconcileTaskCreation(input) as TeamTask,
      }
    : destination;
}

type TaskBoardWithCreationReconciliation = AgentTeamsController['taskBoard'] & {
  reconcileTaskCreation(input: Record<string, unknown>): unknown;
};

function hasTaskCreationReconciliation(
  taskBoard: AgentTeamsController['taskBoard']
): taskBoard is TaskBoardWithCreationReconciliation {
  return (
    typeof (taskBoard as { reconcileTaskCreation?: unknown }).reconcileTaskCreation === 'function'
  );
}

function makeIdentity(commandId: string): { commandId: string; idempotencyKey: string } {
  return { commandId, idempotencyKey: commandId };
}

function makeCreationCommand(
  identity: { commandId: string; idempotencyKey: string },
  payload: Record<string, unknown>
): {
  namespace: string;
  scopeKey: string;
  operation: string;
  commandId: string;
  payloadHash: string;
} {
  return {
    namespace: 'task-board',
    scopeKey: TEAM_NAME,
    operation: CREATE_TASK_OPERATION,
    commandId: identity.commandId,
    payloadHash: new NodeApplicationCommandHasher().hashJson(payload),
  };
}

async function seedStaleStarted(
  harness: {
    ledgerStore: ReturnType<typeof createApplicationCommandLedgerFeature>['ledgerStore'];
  },
  identity: { commandId: string; idempotencyKey: string },
  payload: Record<string, unknown>
): Promise<void> {
  const begin = await harness.ledgerStore.begin({
    namespace: 'task-board',
    scopeKey: TEAM_NAME,
    ...identity,
    operation: CREATE_TASK_OPERATION,
    payloadHash: new NodeApplicationCommandHasher().hashJson(payload),
    metadataJson: null,
    nowIso: '2020-01-01T00:00:00.000Z',
    startedStaleAfterMs: 60_000,
  });
  expect(begin.outcome).toBe(ApplicationCommandBeginOutcome.Started);
}
