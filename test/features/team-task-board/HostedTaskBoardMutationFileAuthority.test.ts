// @vitest-environment node

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  type HostedTaskBoardAuthorityReadWindowResult,
  type HostedTaskMutationCommand,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskIdempotencyKey,
} from '@features/team-task-board/main/hosted';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import {
  createHostedTaskBoardMutationFileAuthority,
  type DescriptorBoundHostedTaskBoardMutationFileAuthority,
  type HostedTaskBoardMutationFaultPoint,
} from '@main/composition/hosted/hostedTaskBoardMutationFileAuthority';
import {
  type HostedTaskBoardMutationLedgerEntry,
  hostedTaskBoardMutationStageName,
  serializeHostedTaskBoardMutationLedger,
  withHostedTaskBoardMutationLedgerEntry,
} from '@main/composition/hosted/hostedTaskBoardMutationLedger';
import { HOSTED_TASK_BOARD_MUTATION_WAL_FILE } from '@main/composition/hosted/hostedTaskBoardMutationTransaction';
import { DescriptorBoundHostedTaskBoardReadSource } from '@main/composition/hosted/hostedTaskBoardReadFileSource';
import { hostedTaskBoardRosterMemberId } from '@main/composition/hosted/hostedTaskBoardRosterAuthority';
import {
  createQueryContext,
  parseBootId,
  parseDeploymentId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

const NOW_MS = 1_800_000_000_000;
const BOOT_ID = parseBootId(`boot_${'a'.repeat(32)}`);
const DEPLOYMENT_ID = parseDeploymentId(`deployment_${'b'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
const TEAM_ID = parseTeamId(`team_${'d'.repeat(32)}`);
const LEGACY_TEAM_KEY = 'team-mutation-authority';
const roots: string[] = [];
const describeLinux = describe.runIf(process.platform === 'linux');

type FaultHandler = (
  point: HostedTaskBoardMutationFaultPoint
) => void | 'crash' | Promise<void | 'crash'>;
type FoundPage = Extract<HostedTaskBoardAuthorityReadWindowResult, { readonly kind: 'found' }>;

interface Fixture {
  readonly root: string;
  readonly claudeRoot: string;
  readonly teamRoot: string;
  readonly tasksDirectory: string;
  readonly clock: { nowMs: number };
  readonly source: DescriptorBoundHostedTaskBoardReadSource;
  readonly setReadCheckpoint: (
    handler: ((point: 'before_final_wal_recheck') => void | Promise<void>) | undefined
  ) => void;
  readonly createAuthority: (
    onFaultPoint?: FaultHandler
  ) => DescriptorBoundHostedTaskBoardMutationFileAuthority;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function context() {
  return createQueryContext({
    actorId: 'actor_task-board-mutation-authority',
    sessionId: 'session_task-board-mutation-authority',
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    requestId: 'request_task-board-mutation-authority',
    authorizedScope: 'scope_task-board-mutation-authority',
    deadlineAtMs: NOW_MS + 60_000,
    signal: new AbortController().signal,
  });
}

function readRequest() {
  return {
    teamId: TEAM_ID,
    afterTaskId: null,
    expectedSourceGeneration: null,
    itemLimit: 100,
    byteLimit: 512 * 1024,
    deadlineAtMs: NOW_MS + 60_000,
  } as const;
}

function mountBinding(): WorkspaceMountBinding {
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'registration-task-board-mutation-authority',
    workspaceId: WORKSPACE_ID,
    displayName: 'Task board mutation authority',
    registrationRevision: 1,
    declaredRootHash: 'e'.repeat(64),
    enabled: true,
  });
  return new WorkspaceMountBinding({
    registration,
    bootId: BOOT_ID,
    mountGeneration: 1,
    declaredRootHash: registration.declaredRootHash,
    observedAt: NOW_MS,
    health: 'healthy',
    allowedOperations: [],
  });
}

function taskText(
  id: string,
  subject: string,
  extra: Readonly<Record<string, unknown>> = {}
): string {
  return `${JSON.stringify(
    {
      id,
      subject,
      status: 'pending',
      blockedBy: [],
      blocks: [],
      related: [],
      ...extra,
    },
    null,
    2
  )}\n`;
}

async function createFixture(): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hosted-task-board-mutation-'));
  roots.push(root);
  const claudeRoot = path.join(root, 'claude');
  const teamRoot = path.join(claudeRoot, 'teams', LEGACY_TEAM_KEY);
  const tasksDirectory = path.join(claudeRoot, 'tasks', LEGACY_TEAM_KEY);
  const createdAt = '2027-01-01T00:00:00.000Z';
  const identityText = `${JSON.stringify(
    { schemaVersion: 1, teamId: TEAM_ID, createdAt },
    null,
    2
  )}\n`;
  const rosterText = `${JSON.stringify(
    {
      members: [
        { name: 'zero-task', agentType: 'worker' },
        { name: 'another-active', agentType: 'worker' },
      ],
    },
    null,
    2
  )}\n`;

  await fs.promises.mkdir(teamRoot, { recursive: true });
  await fs.promises.mkdir(tasksDirectory, { recursive: true });
  await Promise.all([
    fs.promises.writeFile(path.join(teamRoot, 'team.identity.json'), identityText, 'utf8'),
    fs.promises.writeFile(path.join(teamRoot, 'config.json'), rosterText, 'utf8'),
    fs.promises.writeFile(
      path.join(tasksDirectory, '1.json'),
      taskText('1', 'Original task'),
      'utf8'
    ),
    fs.promises.writeFile(
      path.join(tasksDirectory, '2.json'),
      taskText('2', 'Second task'),
      'utf8'
    ),
  ]);

  const teamDirectoryStat = await fs.promises.stat(teamRoot, { bigint: true });
  const identity = parseTeamIdentityRecord({
    teamId: TEAM_ID,
    state: 'active',
    legacyKey: LEGACY_TEAM_KEY,
    directoryFingerprint: sha256(
      JSON.stringify({
        schemaVersion: 1,
        canonicalPath: teamRoot,
        device: teamDirectoryStat.dev.toString(),
        inode: teamDirectoryStat.ino.toString(),
      })
    ),
    workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 1 },
    adoptionIntentId: `adoption_${'f'.repeat(32)}`,
    identityChecksum: sha256(identityText),
    createdAt,
    activatedAt: '2027-01-01T00:00:01.000Z',
    tombstonedAt: null,
  });
  const teamIdentities: TeamIdentityReadGateway = {
    listTeamIdentities: () => Promise.resolve([identity]),
    getTeamIdentity: () => Promise.resolve(identity),
  };
  const runtimeInstance = createRuntimeInstanceContext({
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    claudeRoot: { kind: 'claude', reference: claudeRoot },
    appDataRoot: { kind: 'app-data', reference: path.join(root, 'app-data') },
    workspaceRoots: [{ kind: 'workspace', reference: path.join(root, 'workspace') }],
    tempRoot: { kind: 'temp', reference: path.join(root, 'temp') },
    logsRoot: { kind: 'logs', reference: path.join(root, 'logs') },
  });
  const binding = mountBinding();
  const clock = { nowMs: NOW_MS };
  let onReadCheckpoint: ((point: 'before_final_wal_recheck') => void | Promise<void>) | undefined;
  const source = new DescriptorBoundHostedTaskBoardReadSource({
    runtimeInstance,
    mountBinding: binding,
    teamIdentities,
    nowMs: () => clock.nowMs,
    onReadCheckpoint: (point) => onReadCheckpoint?.(point),
  });
  const createAuthority = (onFaultPoint?: FaultHandler) =>
    createHostedTaskBoardMutationFileAuthority({
      readSource: source,
      runtimeInstance,
      mountBinding: binding,
      teamIdentities,
      nowMs: () => clock.nowMs,
      onFaultPoint,
    });

  return Object.freeze({
    root,
    claudeRoot,
    teamRoot,
    tasksDirectory,
    clock,
    source,
    setReadCheckpoint: (
      handler: ((point: 'before_final_wal_recheck') => void | Promise<void>) | undefined
    ) => {
      onReadCheckpoint = handler;
    },
    createAuthority,
  });
}

async function readPage(fixture: Fixture, itemLimit = 100): Promise<FoundPage> {
  const result = await fixture.source.readWindow({ ...readRequest(), itemLimit }, context());
  if (result.kind !== 'found') throw new Error(`expected task board page, got ${result.kind}`);
  return result;
}

function taskBySubject(page: FoundPage, subject: string) {
  const task = page.items.find((item) => item.subject === subject);
  if (task === undefined) throw new Error(`task not found: ${subject}`);
  return task;
}

function commandBase(page: FoundPage, suffix: string) {
  return {
    schemaVersion: 1 as const,
    commandId: parseHostedTaskCommandId(`command_mutation-${suffix}`),
    idempotencyKey: parseHostedTaskIdempotencyKey(`mutation-${suffix}`),
    teamId: TEAM_ID,
    expectedSourceGeneration: page.sourceGeneration,
    expectedRevision: page.revision,
  };
}

async function admit(
  authority: DescriptorBoundHostedTaskBoardMutationFileAuthority,
  command: HostedTaskMutationCommand,
  fingerprintValue = fingerprint(command.commandId)
) {
  return authority.admitTaskMutation(
    Object.freeze({ command, payloadFingerprint: fingerprintValue }),
    context()
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function replaceFile(filePath: string, contents: string): Promise<void> {
  const parked = `${filePath}.parked`;
  await fs.promises.rename(filePath, parked);
  await fs.promises.writeFile(filePath, contents, 'utf8');
}

async function replaceDirectory(directoryPath: string): Promise<void> {
  await fs.promises.rename(directoryPath, `${directoryPath}.parked`);
  await fs.promises.mkdir(directoryPath);
}

async function fillTaskDirectory(fixture: Fixture, entryCount: number): Promise<void> {
  await Promise.all(
    Array.from({ length: entryCount - 2 }, (_, index) => {
      const id = String(index + 3);
      return fs.promises.writeFile(
        path.join(fixture.tasksDirectory, `${id}.json`),
        taskText(id, `Filler ${id}`),
        'utf8'
      );
    })
  );
}

async function stagedTaskPath(fixture: Fixture, taskName: string): Promise<string> {
  const wal = JSON.parse(
    await fs.promises.readFile(
      path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
      'utf8'
    )
  ) as {
    readonly transactionId: string;
    readonly targets: readonly { parent: string; name: string }[];
  };
  const targetIndex = wal.targets.findIndex(
    (target) => target.parent === 'tasks' && target.name === taskName
  );
  if (targetIndex < 0) throw new Error('task target was not recorded in the WAL');
  return path.join(
    fixture.tasksDirectory,
    hostedTaskBoardMutationStageName(wal.transactionId, targetIndex)
  );
}

function ledgerEntry(
  sourceGeneration: ReturnType<typeof parseHostedTaskBoardSourceGeneration>,
  suffix: string,
  revision: FoundPage['revision'],
  taskId: FoundPage['items'][number]['taskId']
): HostedTaskBoardMutationLedgerEntry {
  const commandId = parseHostedTaskCommandId(`command_ledger-${suffix}`);
  return Object.freeze({
    fingerprint: fingerprint(`ledger-${suffix}`),
    commandId,
    sourceGeneration,
    expectedRevision: revision,
    receipt: Object.freeze({
      schemaVersion: 1,
      outcome: 'committed',
      commandId,
      teamId: TEAM_ID,
      sourceGeneration,
      revision,
      affectedTaskIds: Object.freeze([taskId]),
    }),
    committedAtMs: NOW_MS,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
  );
});

describeLinux('descriptor-bound hosted task-board mutation file authority', () => {
  it('commits create, status, owner, move, and reorder commands with readable postimages', async () => {
    const fixture = await createFixture();
    const authority = fixture.createAuthority();
    const zeroTaskMember = hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task');
    let page = await readPage(fixture);

    expect(page.items.some((item) => item.ownerId === zeroTaskMember)).toBe(false);
    const created = await admit(authority, {
      ...commandBase(page, 'create'),
      kind: 'create_task',
      subject: 'Created task',
      description: 'Written through the descriptor authority',
      status: 'pending',
      ownerId: zeroTaskMember,
      column: 'todo',
      order: 0,
    });
    expect(created.kind).toBe('committed');

    page = await readPage(fixture);
    expect(taskBySubject(page, 'Created task')).toMatchObject({ ownerId: zeroTaskMember });
    const secondTask = taskBySubject(page, 'Second task');
    const ownerUpdated = await admit(authority, {
      ...commandBase(page, 'owner'),
      kind: 'update_owner',
      taskId: secondTask.taskId,
      ownerId: zeroTaskMember,
    });
    expect(ownerUpdated.kind).toBe('committed');

    page = await readPage(fixture);
    const movedTask = taskBySubject(page, 'Second task');
    const moved = await admit(authority, {
      ...commandBase(page, 'move'),
      kind: 'move_task',
      taskId: movedTask.taskId,
      column: 'review',
      order: 0,
    });
    expect(moved.kind).toBe('committed');

    page = await readPage(fixture);
    expect(taskBySubject(page, 'Second task')).toMatchObject({
      ownerId: zeroTaskMember,
      column: 'review',
      order: 0,
    });
    const todoTaskIds = page.items
      .filter((item) => item.column === 'todo')
      .sort((left, right) => left.order - right.order)
      .map((item) => item.taskId);
    expect(todoTaskIds).toHaveLength(2);
    const reordered = await admit(authority, {
      ...commandBase(page, 'reorder'),
      kind: 'reorder_column',
      column: 'todo',
      orderedTaskIds: [...todoTaskIds].reverse(),
    });
    expect(reordered.kind).toBe('committed');

    page = await readPage(fixture);
    expect(
      page.items
        .filter((item) => item.column === 'todo')
        .sort((left, right) => left.order - right.order)
        .map((item) => item.taskId)
    ).toEqual([...todoTaskIds].reverse());
    const originalTask = taskBySubject(page, 'Original task');
    const statusUpdated = await admit(authority, {
      ...commandBase(page, 'status'),
      kind: 'update_status',
      taskId: originalTask.taskId,
      status: 'completed',
    });
    expect(statusUpdated.kind).toBe('committed');

    page = await readPage(fixture);
    expect(taskBySubject(page, 'Original task')).toMatchObject({
      status: 'completed',
      column: 'todo',
    });
  });

  it('returns the public state-conflict shape for a task-only owner', async () => {
    const fixture = await createFixture();
    await fs.promises.writeFile(
      path.join(fixture.tasksDirectory, '1.json'),
      taskText('1', 'Original task', { owner: 'task-only' }),
      'utf8'
    );
    const page = await readPage(fixture);
    const target = taskBySubject(page, 'Second task');
    const taskOnlyOwner = hostedTaskBoardRosterMemberId(TEAM_ID, 'task-only');
    const result = await admit(fixture.createAuthority(), {
      ...commandBase(page, 'task-only-owner'),
      kind: 'update_owner',
      taskId: target.taskId,
      ownerId: taskOnlyOwner,
    });

    expect(result).toEqual({
      kind: 'conflict',
      reason: 'state_conflict',
      currentSourceGeneration: page.sourceGeneration,
      currentRevision: page.revision,
    });
    expect(
      await fs.promises.readFile(path.join(fixture.tasksDirectory, '2.json'), 'utf8')
    ).not.toContain('task-only');
  });

  it('uses members.meta as the authoritative roster and rechecks a WAL that arrives mid-read', async () => {
    const fixture = await createFixture();
    await Promise.all([
      fs.promises.writeFile(
        path.join(fixture.tasksDirectory, '1.json'),
        taskText('1', 'Original task', { owner: 'zero-task' }),
        'utf8'
      ),
      fs.promises.writeFile(
        path.join(fixture.teamRoot, 'members.meta.json'),
        `${JSON.stringify(
          { version: 1, members: [{ name: 'zero-task', agentType: 'worker', removedAt: NOW_MS }] },
          null,
          2
        )}\n`,
        'utf8'
      ),
    ]);

    expect(taskBySubject(await readPage(fixture), 'Original task').ownerId).toBeNull();
    fixture.setReadCheckpoint(async () => {
      await fs.promises.writeFile(
        path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
        '{"appeared":"after-read"}\n',
        'utf8'
      );
    });
    await expect(fixture.source.readWindow(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('rejects a parent-directory substitution before a prepared transaction can publish', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    const result = await admit(
      fixture.createAuthority(async (point) => {
        if (point === 'before_target_publish') {
          await replaceDirectory(path.join(fixture.claudeRoot, 'tasks'));
        }
      }),
      {
        ...commandBase(page, 'parent-rename'),
        kind: 'update_details',
        taskId: original.taskId,
        subject: 'Must not reach a replacement parent',
      }
    );

    expect(result).toEqual({ kind: 'unsafe_active' });
    expect(
      await exists(path.join(fixture.teamRoot, 'hosted-task-board-mutation-ledger.v2.json'))
    ).toBe(false);
  });

  it.each([
    {
      name: 'task document',
      replace: (fixture: Fixture) =>
        replaceFile(path.join(fixture.tasksDirectory, '1.json'), taskText('1', 'External task')),
    },
    {
      name: 'team identity',
      replace: (fixture: Fixture) =>
        replaceFile(path.join(fixture.teamRoot, 'team.identity.json'), '{"external":true}\n'),
    },
    {
      name: 'roster document',
      replace: (fixture: Fixture) =>
        replaceFile(path.join(fixture.teamRoot, 'config.json'), '{"members":[]}\n'),
    },
  ] as const)(
    'fails closed with zero business publication if the $name is replaced before commit',
    async ({ replace }) => {
      const fixture = await createFixture();
      const page = await readPage(fixture);
      const original = taskBySubject(page, 'Original task');
      const authority = fixture.createAuthority(async (point) => {
        if (point === 'wal_fsynced') await replace(fixture);
      });
      const result = await admit(authority, {
        ...commandBase(page, 'descriptor-race'),
        kind: 'update_details',
        taskId: original.taskId,
        subject: 'Authority postimage',
      });

      expect(result).toEqual({ kind: 'unsafe_active' });
      expect(
        await exists(path.join(fixture.teamRoot, 'hosted-task-board-mutation-ledger.v2.json'))
      ).toBe(false);
      expect(await exists(path.join(fixture.teamRoot, 'kanban-state.json'))).toBe(false);
      expect(await exists(path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE))).toBe(
        true
      );
      expect(
        await fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'), 'utf8')
      ).not.toContain('Authority postimage');
    }
  );

  it.each(['wal_fsynced', 'task_published', 'kanban_published', 'ledger_published'] as const)(
    'recovers exactly one durable create after a crash at %s and returns the identical replay receipt',
    async (faultPoint) => {
      const fixture = await createFixture();
      const page = await readPage(fixture);
      const command: HostedTaskMutationCommand = {
        ...commandBase(page, `crash-${faultPoint}`),
        kind: 'create_task',
        subject: `Crash ${faultPoint}`,
        description: null,
        status: 'pending',
        ownerId: null,
        column: 'todo',
        order: 0,
      };
      const crashed = await admit(
        fixture.createAuthority((point) => (point === faultPoint ? 'crash' : undefined)),
        command
      );
      const walPath = path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE);

      expect(crashed).toEqual({ kind: 'unavailable', retryAfterMs: 5_000 });
      const pending = JSON.parse(await fs.promises.readFile(walPath, 'utf8')) as {
        readonly phase: string;
        readonly finalReceipt: unknown;
      };
      expect(pending.phase).toBe('prepared');
      await expect(fixture.source.readWindow(readRequest(), context())).resolves.toEqual({
        kind: 'unavailable',
      });

      const replayed = await admit(fixture.createAuthority(), command);
      expect(replayed.kind).toBe('idempotent_replay');
      if (replayed.kind !== 'idempotent_replay') throw new Error('expected replay receipt');
      expect({ ...replayed.receipt, outcome: 'committed' }).toEqual(pending.finalReceipt);
      await expect(fs.promises.readFile(walPath, 'utf8')).resolves.toSatisfy((serialized) => {
        return (JSON.parse(serialized) as { readonly phase: string }).phase === 'terminal';
      });

      const recovered = await readPage(fixture);
      expect(recovered.items.filter((item) => item.subject === `Crash ${faultPoint}`)).toHaveLength(
        1
      );
      const taskNames = await fs.promises.readdir(fixture.tasksDirectory);
      await Promise.all(
        taskNames
          .filter((name) => name.endsWith('.json'))
          .map(async (name) =>
            JSON.parse(await fs.promises.readFile(path.join(fixture.tasksDirectory, name), 'utf8'))
          )
      );
      expect(taskNames.filter((name) => name.startsWith('hosted-'))).toHaveLength(1);
      await expect(
        fs.promises.readFile(path.join(fixture.teamRoot, 'kanban-state.json'), 'utf8')
      ).resolves.toSatisfy((serialized) => {
        JSON.parse(serialized);
        return true;
      });
      await expect(
        fs.promises.readFile(
          path.join(fixture.teamRoot, 'hosted-task-board-mutation-ledger.v2.json'),
          'utf8'
        )
      ).resolves.toSatisfy((serialized) => {
        JSON.parse(serialized);
        return true;
      });
      await expect(admit(fixture.createAuthority(), command)).resolves.toEqual(replayed);
    }
  );

  it('refuses an incomplete deterministic stage without publishing it over the target', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    const command: HostedTaskMutationCommand = {
      ...commandBase(page, 'incomplete-stage'),
      kind: 'update_details',
      taskId: original.taskId,
      subject: 'Must not publish incomplete stage bytes',
    };
    await expect(
      admit(
        fixture.createAuthority((point) => (point === 'wal_fsynced' ? 'crash' : undefined)),
        command
      )
    ).resolves.toEqual({ kind: 'unavailable', retryAfterMs: 5_000 });
    await fs.promises.writeFile(await stagedTaskPath(fixture, '1.json'), '{', 'utf8');

    await expect(admit(fixture.createAuthority(), command)).resolves.toEqual({
      kind: 'unsafe_active',
    });
    await expect(
      fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'), 'utf8')
    ).resolves.toBe(taskText('1', 'Original task'));
  });

  it('rejects a replacement after stage validation before it can reach the public target', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    const command: HostedTaskMutationCommand = {
      ...commandBase(page, 'stage-substitution'),
      kind: 'update_details',
      taskId: original.taskId,
      subject: 'Authority stage postimage',
    };
    const result = await admit(
      fixture.createAuthority(async (point) => {
        if (point !== 'before_target_publish') return;
        const stagePath = await stagedTaskPath(fixture, '1.json');
        const replacementPath = `${stagePath}.replacement`;
        await fs.promises.writeFile(
          replacementPath,
          taskText('1', 'Substituted stage bytes'),
          'utf8'
        );
        await fs.promises.rename(replacementPath, stagePath);
      }),
      command
    );

    expect(result).toEqual({ kind: 'unsafe_active' });
    await expect(
      fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'), 'utf8')
    ).resolves.toBe(taskText('1', 'Original task'));
  });

  it('fails closed when final identity revalidation sees a concurrent target replacement', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    const targetPath = path.join(fixture.tasksDirectory, '1.json');
    const externalReplacement = taskText('1', 'Concurrent replacement wins');
    const result = await admit(
      fixture.createAuthority(async (point) => {
        if (point === 'before_target_publish') {
          const replacementPath = `${targetPath}.concurrent`;
          await fs.promises.writeFile(replacementPath, externalReplacement, 'utf8');
          await fs.promises.rename(replacementPath, targetPath);
        }
      }),
      {
        ...commandBase(page, 'final-publication-replacement'),
        kind: 'update_details',
        taskId: original.taskId,
        subject: 'Must not overwrite concurrent replacement',
      }
    );

    expect(result).toEqual({ kind: 'unsafe_active' });
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toBe(externalReplacement);
  });

  it('keeps a task WAL prepared when the post-publication directory fsync fails, then recovers', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    const targetPath = path.join(fixture.tasksDirectory, '1.json');
    const command: HostedTaskMutationCommand = {
      ...commandBase(page, 'task-directory-fsync'),
      kind: 'update_details',
      taskId: original.taskId,
      subject: 'Durability must precede success',
    };
    const open = fs.promises.open.bind(fs.promises);
    let failTaskDirectorySync = false;
    let syncFailed = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(
      async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await open(...args);
        const canonicalPath = await fs.promises.realpath(`/proc/self/fd/${handle.fd}`);
        if (canonicalPath === fixture.tasksDirectory) {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, 'sync').mockImplementation(async () => {
            if (failTaskDirectorySync && !syncFailed) {
              syncFailed = true;
              failTaskDirectorySync = false;
              throw new Error('simulated task-directory fsync failure');
            }
            return sync();
          });
        }
        return handle;
      }
    );

    const first = await admit(
      fixture.createAuthority((point) => {
        if (point === 'before_target_publish') failTaskDirectorySync = true;
      }),
      command
    );
    const walPath = path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE);

    expect(syncFailed).toBe(true);
    expect(first).toEqual({ kind: 'unsafe_active' });
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toContain(
      'Durability must precede success'
    );
    await expect(fs.promises.readFile(walPath, 'utf8')).resolves.toSatisfy((serialized) => {
      return (JSON.parse(serialized) as { phase: string }).phase === 'prepared';
    });

    await expect(admit(fixture.createAuthority(), command)).resolves.toMatchObject({
      kind: 'idempotent_replay',
    });
    await expect(fs.promises.readFile(walPath, 'utf8')).resolves.toSatisfy((serialized) => {
      return (JSON.parse(serialized) as { phase: string }).phase === 'terminal';
    });
  });

  it('recovers a 512-entry existing stage and a crash after publishing the 512th create', async () => {
    const existingFixture = await createFixture();
    await fillTaskDirectory(existingFixture, 512);
    const existingPage = await readPage(existingFixture, 512);
    const existingTask = taskBySubject(existingPage, 'Original task');
    const existingCommand: HostedTaskMutationCommand = {
      ...commandBase(existingPage, 'boundary-existing'),
      kind: 'update_status',
      taskId: existingTask.taskId,
      status: 'in_progress',
    };
    await expect(
      admit(
        existingFixture.createAuthority((point) =>
          point === 'before_target_publish' ? 'crash' : undefined
        ),
        existingCommand
      )
    ).resolves.toEqual({ kind: 'unavailable', retryAfterMs: 5_000 });
    expect(await fs.promises.readdir(existingFixture.tasksDirectory)).toHaveLength(513);
    await expect(admit(existingFixture.createAuthority(), existingCommand)).resolves.toMatchObject({
      kind: 'idempotent_replay',
    });
    expect(await fs.promises.readdir(existingFixture.tasksDirectory)).toHaveLength(512);
    expect(taskBySubject(await readPage(existingFixture, 512), 'Original task')).toMatchObject({
      status: 'in_progress',
    });

    const createFixtureAtBoundary = await createFixture();
    await fillTaskDirectory(createFixtureAtBoundary, 511);
    const createPage = await readPage(createFixtureAtBoundary, 512);
    const createCommand: HostedTaskMutationCommand = {
      ...commandBase(createPage, 'boundary-create'),
      kind: 'create_task',
      subject: '512th task',
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
    };
    await expect(
      admit(
        createFixtureAtBoundary.createAuthority((point) =>
          point === 'task_published' ? 'crash' : undefined
        ),
        createCommand
      )
    ).resolves.toEqual({ kind: 'unavailable', retryAfterMs: 5_000 });
    expect(await fs.promises.readdir(createFixtureAtBoundary.tasksDirectory)).toHaveLength(512);
    await expect(
      admit(createFixtureAtBoundary.createAuthority(), createCommand)
    ).resolves.toMatchObject({ kind: 'idempotent_replay' });
    expect(await fs.promises.readdir(createFixtureAtBoundary.tasksDirectory)).toHaveLength(512);
    expect(taskBySubject(await readPage(createFixtureAtBoundary, 512), '512th task')).toBeDefined();
  }, 90_000);

  it.each([
    'wal_fsynced',
    'before_target_publish',
    'existing_target_postimage_ready',
    'existing_target_replaced',
    'task_published',
    'kanban_published',
    'ledger_published',
  ] as const)(
    'recovers an existing target through every publication checkpoint without a detach-to-relink gap (%s)',
    async (faultPoint) => {
      const fixture = await createFixture();
      const page = await readPage(fixture);
      const original = taskBySubject(page, 'Original task');
      const command: HostedTaskMutationCommand = {
        ...commandBase(page, `existing-${faultPoint}`),
        kind: 'update_status',
        taskId: original.taskId,
        status: 'in_progress',
      };
      const crashed = await admit(
        fixture.createAuthority((point) => (point === faultPoint ? 'crash' : undefined)),
        command
      );

      expect(crashed).toEqual({ kind: 'unavailable', retryAfterMs: 5_000 });
      const walPath = path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE);
      await expect(fs.promises.readFile(walPath, 'utf8')).resolves.toSatisfy((serialized) => {
        return (JSON.parse(serialized) as { readonly phase: string }).phase === 'prepared';
      });
      const persisted = await fs.promises.readFile(
        path.join(fixture.tasksDirectory, '1.json'),
        'utf8'
      );
      expect(JSON.parse(persisted)).toMatchObject({ id: '1' });
      if (faultPoint === 'existing_target_postimage_ready') {
        expect(persisted).toBe(taskText('1', 'Original task'));
      }
      if (faultPoint === 'existing_target_replaced') {
        expect(persisted).toContain('"status": "in_progress"');
      }
      const replayed = await admit(fixture.createAuthority(), command);
      expect(replayed.kind).toBe('idempotent_replay');
      expect(taskBySubject(await readPage(fixture), 'Original task')).toMatchObject({
        status: 'in_progress',
        column: 'todo',
      });
      await expect(fs.promises.readFile(walPath, 'utf8')).resolves.toSatisfy((serialized) => {
        return (JSON.parse(serialized) as { readonly phase: string }).phase === 'terminal';
      });
    }
  );

  it('fences an expired writer, keeps terminal WALs non-authoritative, and replays after later writes', async () => {
    const fixture = await createFixture();
    const initial = await readPage(fixture);
    const original = taskBySubject(initial, 'Original task');
    const firstCommand: HostedTaskMutationCommand = {
      ...commandBase(initial, 'expired-writer'),
      kind: 'update_details',
      taskId: original.taskId,
      subject: 'First durable mutation',
    };
    const expired = await admit(
      fixture.createAuthority((point) => {
        if (point === 'wal_fsynced') fixture.clock.nowMs += 5_001;
      }),
      firstCommand
    );

    expect(expired).toEqual({ kind: 'unsafe_active' });
    await expect(fixture.source.readWindow(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    const replayed = await admit(fixture.createAuthority(), firstCommand);
    expect(replayed.kind).toBe('idempotent_replay');

    const afterFirst = await readPage(fixture);
    const later = await admit(fixture.createAuthority(), {
      ...commandBase(afterFirst, 'later-mutation'),
      kind: 'update_owner',
      taskId: taskBySubject(afterFirst, 'Second task').taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    });
    expect(later.kind).toBe('committed');
    await expect(admit(fixture.createAuthority(), firstCommand)).resolves.toMatchObject({
      kind: 'idempotent_replay',
    });
    await expect(
      fs.promises.readFile(path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE), 'utf8')
    ).resolves.toSatisfy(
      (serialized) => (JSON.parse(serialized) as { phase: string }).phase === 'terminal'
    );
  });

  it('compacts only expired-source receipts and never evicts a current-generation replay', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const oldGeneration = parseHostedTaskBoardSourceGeneration(`generation_${'e'.repeat(32)}`);
    const oldEntries = new Map(
      Array.from({ length: 256 }, (_, index) => {
        const key = sha256(`old-ledger-${index}`);
        return [
          key,
          ledgerEntry(oldGeneration, `old-${index}`, page.revision, page.items[0].taskId),
        ] as const;
      })
    );
    const currentEntry = ledgerEntry(
      page.sourceGeneration,
      'current',
      page.revision,
      page.items[0].taskId
    );
    const compacted = withHostedTaskBoardMutationLedgerEntry(
      Object.freeze({ entries: oldEntries, snapshot: null }),
      sha256('current-ledger'),
      currentEntry
    );
    expect(compacted.size).toBe(1);
    expect(serializeHostedTaskBoardMutationLedger(compacted)).toContain(currentEntry.commandId);

    const currentEntries = new Map(
      Array.from({ length: 256 }, (_, index) => [
        sha256(`current-ledger-${index}`),
        ledgerEntry(page.sourceGeneration, `current-${index}`, page.revision, page.items[0].taskId),
      ])
    );
    expect(() =>
      withHostedTaskBoardMutationLedgerEntry(
        Object.freeze({ entries: currentEntries, snapshot: null }),
        sha256('current-ledger-overflow'),
        currentEntry
      )
    ).toThrow('hosted-task-board-mutation-ledger-entry-budget-exceeded');
  });

  it('keeps one live lease during a concurrent admission and revalidates the task CAS before publishing', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const command: HostedTaskMutationCommand = {
      ...commandBase(page, 'concurrent'),
      kind: 'create_task',
      subject: 'Concurrent task',
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
    };
    let entered!: () => void;
    let release!: () => void;
    const enteredWal = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseWal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = admit(
      fixture.createAuthority(async (point) => {
        if (point !== 'wal_fsynced') return;
        entered();
        await releaseWal;
      }),
      command
    );
    await enteredWal;
    const second = await admit(fixture.createAuthority(), command);
    expect(second).toEqual({ kind: 'unavailable', retryAfterMs: 5_000 });
    release();
    expect((await first).kind).toBe('committed');

    const afterLease = await readPage(fixture);
    const original = taskBySubject(afterLease, 'Original task');
    const race = await admit(
      fixture.createAuthority(async (point) => {
        if (point === 'wal_fsynced') {
          await replaceFile(
            path.join(fixture.tasksDirectory, '1.json'),
            taskText('1', 'CAS external replacement')
          );
        }
      }),
      {
        ...commandBase(afterLease, 'cas'),
        kind: 'update_details',
        taskId: original.taskId,
        subject: 'CAS authority replacement',
      }
    );
    expect(race).toEqual({ kind: 'unsafe_active' });
    expect(
      await fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'), 'utf8')
    ).toContain('CAS external replacement');
  });

  it('fails closed for fingerprint mismatch, corrupt WAL, and unknown recovery content', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const command: HostedTaskMutationCommand = {
      ...commandBase(page, 'fingerprint'),
      kind: 'create_task',
      subject: 'Fingerprint task',
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
    };
    expect((await admit(fixture.createAuthority(), command)).kind).toBe('committed');
    await expect(
      admit(fixture.createAuthority(), command, fingerprint('different-command'))
    ).resolves.toMatchObject({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });

    const corruptFixture = await createFixture();
    const corruptPage = await readPage(corruptFixture);
    const corruptCommand: HostedTaskMutationCommand = {
      ...commandBase(corruptPage, 'corrupt-wal'),
      kind: 'create_task',
      subject: 'Corrupt WAL task',
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
    };
    await admit(
      corruptFixture.createAuthority((point) => (point === 'wal_fsynced' ? 'crash' : undefined)),
      corruptCommand
    );
    await fs.promises.writeFile(
      path.join(corruptFixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
      '{not-json',
      'utf8'
    );
    await expect(admit(corruptFixture.createAuthority(), corruptCommand)).resolves.toEqual({
      kind: 'unsafe_active',
    });
    await expect(corruptFixture.source.readWindow(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });

    const unknownFixture = await createFixture();
    const unknownPage = await readPage(unknownFixture);
    const unknownCommand: HostedTaskMutationCommand = {
      ...commandBase(unknownPage, 'unknown-content'),
      kind: 'create_task',
      subject: 'Unknown recovery task',
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
    };
    await admit(
      unknownFixture.createAuthority((point) => (point === 'task_published' ? 'crash' : undefined)),
      unknownCommand
    );
    const createdName = (await fs.promises.readdir(unknownFixture.tasksDirectory)).find((name) =>
      name.startsWith('hosted-')
    );
    if (createdName === undefined) throw new Error('crash did not publish its task target');
    await fs.promises.writeFile(
      path.join(unknownFixture.tasksDirectory, createdName),
      taskText('external', 'Unknown external content'),
      'utf8'
    );
    await expect(admit(unknownFixture.createAuthority(), unknownCommand)).resolves.toEqual({
      kind: 'unsafe_active',
    });
    expect(
      await exists(path.join(unknownFixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE))
    ).toBe(true);
  });
});
