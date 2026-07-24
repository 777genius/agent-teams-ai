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
    expect(
      (
        harness.controller.taskBoard.getTask(identity.commandId) as TeamTask & {
          creationCommand?: { idempotencyKey?: string };
        }
      ).creationCommand?.idempotencyKey
    ).toBe(identity.idempotencyKey);
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

  it('keeps one logical create while switching between SQLite and JSON fallback', async () => {
    const harness = await makeHarness();
    const destinationCreate = vi.spyOn(harness.destination, 'create');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const selector = new InternalStorageBackendSelector(() =>
      Promise.reject(new Error('native module ABI mismatch'))
    );
    const hasher = new NodeApplicationCommandHasher();
    const fallbackFacade = new TaskBoardCommandFacade({ run: vi.fn() } as never, {
      isDurableStorageAvailable: () => selector.select(true, false),
      hashPayload: (payload) => hasher.hashJson(payload),
    });

    const sqliteFirst = {
      commandId: '15151515-1515-4515-8515-151515151515',
      idempotencyKey: 'sqlite-then-json-intent',
    };
    const sqliteRetry = {
      commandId: '16161616-1616-4616-8616-161616161616',
      idempotencyKey: sqliteFirst.idempotencyKey,
    };
    const sqlitePayload = { subject: 'SQLite then fallback', createdBy: 'user' };
    await harness.facade.createTask({
      teamName: TEAM_NAME,
      identity: sqliteFirst,
      payload: sqlitePayload,
      destination: harness.destination,
    });
    const fallbackReplay = await fallbackFacade.createTask({
      teamName: TEAM_NAME,
      identity: sqliteRetry,
      payload: sqlitePayload,
      destination: harness.destination,
    });

    const fallbackFirst = {
      commandId: '17171717-1717-4717-8717-171717171717',
      idempotencyKey: 'json-then-sqlite-intent',
    };
    const fallbackRetry = {
      commandId: '18181818-1818-4818-8818-181818181818',
      idempotencyKey: fallbackFirst.idempotencyKey,
    };
    const fallbackPayload = { subject: 'Fallback then SQLite', createdBy: 'user' };
    await fallbackFacade.createTask({
      teamName: TEAM_NAME,
      identity: fallbackFirst,
      payload: fallbackPayload,
      destination: harness.destination,
    });
    const sqliteReplay = await harness.facade.createTask({
      teamName: TEAM_NAME,
      identity: fallbackRetry,
      payload: fallbackPayload,
      destination: harness.destination,
    });

    expect(fallbackReplay).toMatchObject({
      outcome: ApplicationCommandRunOutcome.Replayed,
      createdInAttempt: false,
      task: { id: sqliteFirst.commandId },
    });
    expect(sqliteReplay).toMatchObject({
      outcome: ApplicationCommandRunOutcome.Executed,
      createdInAttempt: false,
      task: { id: fallbackFirst.commandId },
    });
    expect(harness.destination.findById(sqliteRetry.commandId)).toBeNull();
    expect(harness.destination.findById(fallbackRetry.commandId)).toBeNull();
    expect(destinationCreate).toHaveBeenCalledTimes(2);
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(2);
  });

  it('serializes and deduplicates concurrent JSON fallback retries by logical intent', async () => {
    const harness = await makeHarness();
    const destinationCreate = vi.spyOn(harness.destination, 'create');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const selector = new InternalStorageBackendSelector(() =>
      Promise.reject(new Error('native module ABI mismatch'))
    );
    const hasher = new NodeApplicationCommandHasher();
    const facade = new TaskBoardCommandFacade({ run: vi.fn() } as never, {
      isDurableStorageAvailable: () => selector.select(true, false),
      hashPayload: (payload) => hasher.hashJson(payload),
    });
    const payload = { subject: 'One fallback intent', createdBy: 'user' };
    const idempotencyKey = 'one-logical-create-intent';
    const original = {
      commandId: '13131313-1313-4313-8313-131313131313',
      idempotencyKey,
    };
    const retried = {
      commandId: '14141414-1414-4414-8414-141414141414',
      idempotencyKey,
    };
    let releaseCreate!: () => void;
    const createRelease = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let announceCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      announceCreate = resolve;
    });
    const delayedCreate = vi.fn(async (input: Record<string, unknown>) => {
      announceCreate();
      await createRelease;
      return harness.destination.create(input);
    });
    const destination: TaskBoardCreateTaskDestination = {
      ...harness.destination,
      create: delayedCreate,
    };

    const firstPromise = facade.createTask({
      teamName: TEAM_NAME,
      identity: original,
      payload,
      destination,
    });
    await createStarted;
    const replayPromise = facade.createTask({
      teamName: TEAM_NAME,
      identity: retried,
      payload,
      destination,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delayedCreate).toHaveBeenCalledOnce();

    releaseCreate();
    const [first, replay] = await Promise.all([firstPromise, replayPromise]);

    expect(first.outcome).toBe(ApplicationCommandRunOutcome.Executed);
    expect(replay.outcome).toBe(ApplicationCommandRunOutcome.Replayed);
    expect(replay.createdInAttempt).toBe(false);
    expect(replay.task.id).toBe(original.commandId);
    expect(harness.destination.findById(retried.commandId)).toBeNull();
    expect(destinationCreate).toHaveBeenCalledOnce();
    expect(harness.controller.taskBoard.listTasks()).toHaveLength(1);
  });

  it('repairs relationship backlinks before completing a recovered create attempt', async () => {
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

    const repairedDependency = harness.controller.taskBoard.getTask(dependency.id) as TeamTask;
    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Executed);
    expect(result.createdInAttempt).toBe(true);
    expect(repairedDependency.blocks).toContain(identity.commandId);
  });

  it('reconciles a stale started command with an existing destination task', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('22222222-2222-4222-8222-222222222222');
    const payload = { subject: 'Already persisted task', createdBy: 'user' };
    await seedStaleStarted(harness, identity, payload);
    harness.destination.create({ ...payload, id: identity.commandId });

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
    harness.destination.create({ ...payload, id: original.commandId });

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

  it('records a destination provenance conflict as terminal instead of retrying forever', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('77777777-7777-4777-8777-777777777777');
    const payload = { subject: 'Conflicting destination', createdBy: 'user' };
    harness.controller.taskBoard.createTask({
      ...payload,
      id: identity.commandId,
      creationCommand: {
        namespace: 'task-board',
        scopeKey: TEAM_NAME,
        operation: CREATE_TASK_OPERATION,
        commandId: identity.commandId,
        payloadHash: 'sha256:not-the-command-payload',
      },
    });

    await expect(
      harness.facade.createTask({
        teamName: TEAM_NAME,
        identity,
        payload,
        destination: harness.destination,
      })
    ).rejects.toThrow('Task creation conflicts with an existing destination task');

    const record = await harness.ledgerStore.getByCommandId({
      namespace: 'task-board',
      scopeKey: TEAM_NAME,
      commandId: identity.commandId,
    });
    expect(record?.status).toBe(ApplicationCommandLedgerStatus.FailedTerminal);
    expect(record?.attemptCount).toBe(1);
  });

  it('terminalizes a stale command when reconciliation finds conflicting provenance', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('88888888-8888-4888-8888-888888888888');
    const payload = { subject: 'Stale conflicting destination', createdBy: 'user' };
    await seedStaleStarted(harness, identity, payload);
    harness.controller.taskBoard.createTask({
      ...payload,
      id: identity.commandId,
      creationCommand: {
        namespace: 'task-board',
        scopeKey: TEAM_NAME,
        operation: CREATE_TASK_OPERATION,
        commandId: identity.commandId,
        payloadHash: 'sha256:not-the-command-payload',
      },
    });

    await expect(
      harness.facade.createTask({
        teamName: TEAM_NAME,
        identity,
        payload,
        destination: harness.destination,
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

  it('reconciles a stale command after the created task subject was edited', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('99999999-9999-4999-8999-999999999999');
    const payload = { subject: 'Original subject', createdBy: 'user' };
    const payloadHash = new NodeApplicationCommandHasher().hashJson(payload);
    await seedStaleStarted(harness, identity, payload);
    harness.controller.taskBoard.createTask({
      ...payload,
      id: identity.commandId,
      creationCommand: {
        namespace: 'task-board',
        scopeKey: TEAM_NAME,
        operation: CREATE_TASK_OPERATION,
        commandId: identity.commandId,
        payloadHash,
      },
    });
    const taskPath = path.join(harness.claudeDir, 'tasks', TEAM_NAME, `${identity.commandId}.json`);
    const taskRow = JSON.parse(await fs.readFile(taskPath, 'utf8')) as TeamTask;
    taskRow.subject = 'Edited subject';
    await fs.writeFile(taskPath, JSON.stringify(taskRow));

    const result = await harness.facade.createTask({
      teamName: TEAM_NAME,
      identity,
      payload,
      destination: harness.destination,
    });

    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Reconciled);
    expect(result.task.subject).toBe('Edited subject');
  });

  it('records a destination scope mismatch as terminal before creating a task', async () => {
    const harness = await makeHarness();
    const identity = makeIdentity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const scopeKey = 'another-team';

    await expect(
      harness.facade.createTask({
        teamName: scopeKey,
        identity,
        payload: { subject: 'Wrong destination scope', createdBy: 'user' },
        destination: harness.destination,
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
  return {
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
    findByIdempotencyKey: (idempotencyKey) =>
      (
        [
          ...controller.taskBoard.listTasks(),
          ...controller.taskBoard.listDeletedTasks(),
        ] as TeamTask[]
      ).filter(
        (task) =>
          (
            task as TeamTask & {
              creationCommand?: { idempotencyKey?: unknown };
            }
          ).creationCommand?.idempotencyKey === idempotencyKey
      ),
    create: (input) => controller.taskBoard.createTask(input) as TeamTask,
    reconcile: (input) => controller.taskBoard.reconcileTaskCreation(input) as TeamTask,
  };
}

function makeIdentity(commandId: string): { commandId: string; idempotencyKey: string } {
  return { commandId, idempotencyKey: commandId };
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
