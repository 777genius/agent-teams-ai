// @vitest-environment node

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  type HostedLifecycleCurrentAuthority,
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
  closeHostedTaskBoardDirectories,
  openHostedTaskBoardDirectory,
} from '@main/composition/hosted/hostedTaskBoardDescriptorFs';
import {
  createHostedTaskBoardMutationFileAuthority,
  type DescriptorBoundHostedTaskBoardMutationFileAuthority,
  type HostedTaskBoardMutationFaultPoint,
  type HostedTaskBoardMutationFileAuthorityDependencies,
} from '@main/composition/hosted/hostedTaskBoardMutationFileAuthority';
import {
  HostedTaskBoardMutationFence,
  type HostedTaskBoardMutationLedgerEntry,
  hostedTaskBoardMutationStageName,
  serializeHostedTaskBoardMutationLedger,
  withHostedTaskBoardMutationLedgerEntry,
} from '@main/composition/hosted/hostedTaskBoardMutationLedger';
import {
  HOSTED_TASK_BOARD_MUTATION_FENCE_FILE,
  HOSTED_TASK_BOARD_MUTATION_WAL_FILE,
  readHostedTaskBoardMutationWal,
  recoverHostedTaskBoardMutationWal,
} from '@main/composition/hosted/hostedTaskBoardMutationTransaction';
import { DescriptorBoundHostedTaskBoardReadSource } from '@main/composition/hosted/hostedTaskBoardReadFileSource';
import { hostedTaskBoardRosterMemberId } from '@main/composition/hosted/hostedTaskBoardRosterAuthority';
import { hostedTaskBoardSelfWriteEffects } from '@main/composition/hosted/hostedTaskBoardSelfWrite';
import {
  ProductTaskCommittedTargets,
  ProductTaskMutationAuthority,
} from '@main/composition/hosted/productTaskMutationAuthority';
import { ProductTaskWriteCommitAuthority } from '@main/composition/hosted/productTaskWriteCommitAuthority';
import { ProductTaskWriteFileSerialization } from '@main/composition/hosted/productTaskWriteSerialization';
import { ensureProductTaskWriteLockDirectory } from '@main/utils/productTaskWriteAuthorityLock';
import {
  createQueryContext,
  parseBootId,
  parseDeploymentId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type {
  HostedTaskBoardProductCommitAuthority,
  ProductTaskRunPin,
} from '@main/composition/hosted/hostedTaskBoardMutationGrantAuthority';
import type { HostedTaskBoardWriterEpochAuthority } from '@main/composition/hosted/hostedTaskBoardMutationWalTakeover';

const NOW_MS = 1_800_000_000_000;
const BOOT_ID = parseBootId(`boot_${'a'.repeat(32)}`);
const DEPLOYMENT_ID = parseDeploymentId(`deployment_${'b'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
const TEAM_ID = parseTeamId(`team_${'d'.repeat(32)}`);
const LEGACY_TEAM_KEY = 'team-mutation-authority';
const PRODUCT_RUN_PIN: ProductTaskRunPin = Object.freeze({
  runId: `run_${'e'.repeat(32)}`,
  deploymentId: DEPLOYMENT_ID,
  bootId: BOOT_ID,
  ownerAuthority: 'owner-authority_test',
  ownerGeneration: 1,
  ownerSessionId: 'owner-session_test',
  restoreGeneration: 1,
  mountGeneration: 1,
});
/** A later owner generation of the same deployment: the epoch that supersedes PRODUCT_RUN_PIN. */
const SUCCESSOR_RUN_PIN: ProductTaskRunPin = Object.freeze({
  ...PRODUCT_RUN_PIN,
  runId: `run_${'f'.repeat(32)}`,
  ownerGeneration: 2,
  ownerSessionId: 'owner-session_successor',
});
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
  readonly setWorkspaceBinding: (
    workspaceId: ReturnType<typeof parseWorkspaceId> | null,
    generation?: number
  ) => void;
  readonly createAuthority: (
    onFaultPoint?: FaultHandler,
    productCommitAuthority?: HostedTaskBoardProductCommitAuthority,
    onCommittedTargets?: HostedTaskBoardMutationFileAuthorityDependencies['onCommittedTargets'],
    writerEpochAuthority?: HostedTaskBoardWriterEpochAuthority
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

function mountBinding(mountGeneration = 1): WorkspaceMountBinding {
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
    mountGeneration,
    previousMountGeneration: mountGeneration === 1 ? undefined : mountGeneration - 1,
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

async function createFixture(mountGeneration = 1): Promise<Fixture> {
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
  let currentIdentity = identity;
  const teamIdentities: TeamIdentityReadGateway = {
    listTeamIdentities: () => Promise.resolve([currentIdentity]),
    getTeamIdentity: () => Promise.resolve(currentIdentity),
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
  const binding = mountBinding(mountGeneration);
  const clock = { nowMs: NOW_MS };
  let onReadCheckpoint: ((point: 'before_final_wal_recheck') => void | Promise<void>) | undefined;
  const source = new DescriptorBoundHostedTaskBoardReadSource({
    runtimeInstance,
    mountBinding: binding,
    teamIdentities,
    nowMs: () => clock.nowMs,
    onReadCheckpoint: (point) => onReadCheckpoint?.(point),
  });
  const createAuthority = (
    onFaultPoint?: FaultHandler,
    productCommitAuthority?: HostedTaskBoardProductCommitAuthority,
    onCommittedTargets?: HostedTaskBoardMutationFileAuthorityDependencies['onCommittedTargets'],
    writerEpochAuthority?: HostedTaskBoardWriterEpochAuthority
  ) =>
    createHostedTaskBoardMutationFileAuthority({
      readSource: source,
      runtimeInstance,
      mountBinding: binding,
      teamIdentities,
      nowMs: () => clock.nowMs,
      onFaultPoint,
      productCommitAuthority,
      onCommittedTargets,
      writerEpochAuthority,
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
    setWorkspaceBinding: (
      workspaceId: ReturnType<typeof parseWorkspaceId> | null,
      generation = 1
    ) => {
      currentIdentity = parseTeamIdentityRecord({
        ...currentIdentity,
        workspaceBinding: workspaceId === null ? null : { workspaceId, generation },
      });
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

/** Product's deployment authority row as Writer (W) currency reads it; null when none is published. */
function writerEpochAuthority(
  pin: ProductTaskRunPin | null,
  state: HostedLifecycleCurrentAuthority['state'] = 'active'
): { readonly lookupAuthority: Mock<HostedTaskBoardWriterEpochAuthority['lookupAuthority']> } {
  const row: HostedLifecycleCurrentAuthority | null =
    pin === null
      ? null
      : Object.freeze({
          deploymentId: parseDeploymentId(pin.deploymentId),
          bootId: parseBootId(pin.bootId),
          ownerAuthority: pin.ownerAuthority,
          ownerGeneration: pin.ownerGeneration,
          ownerSessionId: pin.ownerSessionId,
          restoreGeneration: pin.restoreGeneration,
          mountGeneration: pin.mountGeneration,
          revision: pin.ownerGeneration,
          state,
        });
  return {
    lookupAuthority: vi.fn<HostedTaskBoardWriterEpochAuthority['lookupAuthority']>(() =>
      Promise.resolve(row)
    ),
  };
}

async function walPhase(fixture: Fixture): Promise<string> {
  return (
    JSON.parse(
      await fs.promises.readFile(
        path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
        'utf8'
      )
    ) as { phase: string }
  ).phase;
}

async function walTargetKinds(fixture: Fixture): Promise<readonly string[]> {
  return (
    JSON.parse(
      await fs.promises.readFile(
        path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
        'utf8'
      )
    ) as { targets: readonly { kind: string }[] }
  ).targets.map((target) => target.kind);
}

/** Every board file except the WAL and its fence, which recovery itself is expected to rewrite. */
async function boardFiles(fixture: Fixture): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [label, directory] of [
    ['team', fixture.teamRoot],
    ['tasks', fixture.tasksDirectory],
  ] as const) {
    const names = await fs.promises.readdir(directory);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (
        name === HOSTED_TASK_BOARD_MUTATION_WAL_FILE ||
        name === HOSTED_TASK_BOARD_MUTATION_FENCE_FILE
      )
        continue;
      files[`${label}/${name}`] = await fs.promises.readFile(path.join(directory, name), 'utf8');
    }
  }
  return files;
}

function productWriter(
  fixture: Fixture,
  pin: ProductTaskRunPin,
  options: {
    readonly writerEpochs?: HostedTaskBoardWriterEpochAuthority;
    readonly onFaultPoint?: FaultHandler;
    readonly assertCurrent?: HostedTaskBoardProductCommitAuthority['assertCurrent'];
    readonly onCommittedTargets?: HostedTaskBoardMutationFileAuthorityDependencies['onCommittedTargets'];
  } = {}
) {
  const authority = fixture.createAuthority(
    options.onFaultPoint,
    { assertCurrent: options.assertCurrent ?? (() => Promise.resolve(pin)) },
    options.onCommittedTargets,
    options.writerEpochs
  );
  return (command: HostedTaskMutationCommand, grantRevision = 'a'.repeat(64)) => {
    const query = context();
    authority.bindGrantFence(query, {
      ownerEffectFence: { grantRevision, identityChecksum: 'b'.repeat(64) },
      revalidate: () => Promise.resolve(true),
    });
    return authority.admitTaskMutation(
      { command, payloadFingerprint: fingerprint(command.commandId) },
      query
    );
  };
}

/** Leaves a prepared WAL behind, as a Product writer that crashed at `point` would. */
async function crashProductWriter(
  fixture: Fixture,
  command: HostedTaskMutationCommand,
  point: HostedTaskBoardMutationFaultPoint,
  pin: ProductTaskRunPin = PRODUCT_RUN_PIN
): Promise<void> {
  const crashed = productWriter(fixture, pin, {
    onFaultPoint: (reached) => (reached === point ? 'crash' : undefined),
  });
  await expect(crashed(command)).resolves.toMatchObject({ kind: 'unavailable' });
  expect(await walPhase(fixture)).toBe('prepared');
}

function ownerCommand(page: FoundPage, suffix: string, subject = 'Original task') {
  return {
    ...commandBase(page, suffix),
    kind: 'update_owner' as const,
    taskId: taskBySubject(page, subject).taskId,
    ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
  );
});

describeLinux('descriptor-bound hosted task-board mutation file authority', () => {
  it('writes no files when a grant is revoked during an async authority read', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const teamNames = await fs.promises.readdir(fixture.teamRoot);
    const taskNames = await fs.promises.readdir(fixture.tasksDirectory);
    let releaseRead!: () => void;
    let reachedRead!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedRead = resolve;
    });
    let granted = true;
    const authority = fixture.createAuthority(undefined, {
      assertCurrent: async () => {
        reachedRead();
        await waiting;
        return PRODUCT_RUN_PIN;
      },
    });
    const query = context();
    authority.bindGrantFence(query, {
      ownerEffectFence: { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => granted,
    });
    const command = {
      ...commandBase(page, 'revoked-during-read'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    const pending = authority.admitTaskMutation(
      { command, payloadFingerprint: fingerprint(command.commandId) },
      query
    );
    await reached;
    granted = false;
    releaseRead();
    await expect(pending).resolves.toMatchObject({ kind: 'unsafe_active' });
    expect(await fs.promises.readdir(fixture.teamRoot)).toEqual(teamNames);
    expect(await fs.promises.readdir(fixture.tasksDirectory)).toEqual(taskNames);
  });

  it('denies a revoked Product grant during an async publication wait without changing task or ledger', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const taskPath = path.join(fixture.tasksDirectory, '1.json');
    const before = await fs.promises.stat(taskPath, { bigint: true });
    const textBefore = await fs.promises.readFile(taskPath, 'utf8');
    let releaseWait!: () => void;
    let reachedWait!: () => void;
    const wait = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedWait = resolve;
    });
    let granted = true;
    const authority = fixture.createAuthority(
      async (point) => {
        if (point === 'existing_target_precommit_validated') {
          reachedWait();
          await wait;
        }
      },
      {
        assertCurrent: async () => {
          if (!granted) throw new Error('member-retired');
          return PRODUCT_RUN_PIN;
        },
      }
    );
    const query = context();
    authority.bindGrantFence(query, {
      ownerEffectFence: { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => granted,
    });
    const command = {
      ...commandBase(page, 'revoked-during-wait'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    const pending = authority.admitTaskMutation(
      { command, payloadFingerprint: fingerprint(command.commandId) },
      query
    );
    await reached;
    granted = false;
    releaseWait();
    await expect(pending).resolves.toMatchObject({ kind: 'unsafe_active' });
    const after = await fs.promises.stat(taskPath, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(await fs.promises.readFile(taskPath, 'utf8')).toBe(textBefore);
    expect(
      await exists(path.join(fixture.teamRoot, 'hosted-task-board-mutation-ledger.v2.json'))
    ).toBe(false);
    granted = true;
    const next = context();
    authority.bindGrantFence(next, {
      ownerEffectFence: { grantRevision: 'c'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => true,
    });
    const differentCommand = {
      ...command,
      commandId: parseHostedTaskCommandId('command_mutation-next'),
    };
    await expect(
      authority.admitTaskMutation(
        {
          command: differentCommand,
          payloadFingerprint: fingerprint(differentCommand.commandId),
        },
        next
      )
    ).resolves.toMatchObject({ kind: 'committed' });
    expect(taskBySubject(await readPage(fixture), 'Original task').ownerId).toBe(command.ownerId);
  });

  it('restores the preimage if Product grant is revoked after target detach', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const taskPath = path.join(fixture.tasksDirectory, '1.json');
    const original = await fs.promises.readFile(taskPath, 'utf8');
    let granted = true;
    const authority = fixture.createAuthority(
      (point) => {
        if (point === 'existing_target_preimage_detached') granted = false;
      },
      {
        assertCurrent: async () => {
          if (!granted) throw new Error('member-retired');
          return PRODUCT_RUN_PIN;
        },
      }
    );
    const query = context();
    authority.bindGrantFence(query, {
      ownerEffectFence: { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => granted,
    });
    const command = {
      ...commandBase(page, 'revoked-after-detach'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    await expect(
      authority.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        query
      )
    ).resolves.toMatchObject({ kind: 'unsafe_active' });
    expect(await fs.promises.readFile(taskPath, 'utf8')).toBe(original);
    expect(
      await exists(path.join(fixture.teamRoot, 'hosted-task-board-mutation-ledger.v2.json'))
    ).toBe(false);
    const aborted = JSON.parse(
      await fs.promises.readFile(
        path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
        'utf8'
      )
    ) as { phase: string };
    expect(aborted.phase).toBe('aborted');
    const current = await readPage(fixture);
    expect(taskBySubject(current, 'Original task').ownerId).toBeNull();
    const nextAuthority = fixture.createAuthority(undefined, {
      assertCurrent: async () => PRODUCT_RUN_PIN,
    });
    const next = context();
    nextAuthority.bindGrantFence(next, {
      ownerEffectFence: { grantRevision: 'c'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => true,
    });
    const nextCommand = {
      ...commandBase(current, 'after-aborted-detach'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: command.ownerId,
    };
    await expect(
      nextAuthority.admitTaskMutation(
        { command: nextCommand, payloadFingerprint: fingerprint(nextCommand.commandId) },
        next
      )
    ).resolves.toMatchObject({ kind: 'committed' });
  });

  it('does not replay or take over a prepared Product WAL under a different grant in the same writer epoch', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const command = {
      ...commandBase(page, 'cross-grant-replay'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    const first = fixture.createAuthority(
      (point) => (point === 'wal_fsynced' ? 'crash' : undefined),
      { assertCurrent: async () => PRODUCT_RUN_PIN }
    );
    const firstContext = context();
    first.bindGrantFence(firstContext, {
      ownerEffectFence: { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => true,
    });
    await expect(
      first.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        firstContext
      )
    ).resolves.toMatchObject({ kind: 'unavailable' });
    // The WAL writer's epoch is the current one: it may still be live, so it is never taken over.
    const writerEpochs = writerEpochAuthority(PRODUCT_RUN_PIN);
    const next = fixture.createAuthority(
      undefined,
      { assertCurrent: async () => PRODUCT_RUN_PIN },
      undefined,
      writerEpochs
    );
    const nextContext = context();
    next.bindGrantFence(nextContext, {
      ownerEffectFence: { grantRevision: 'c'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => true,
    });
    await expect(
      next.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        nextContext
      )
    ).resolves.toMatchObject({ kind: 'unsafe_active' });
    expect(writerEpochs.lookupAuthority).not.toHaveBeenCalled();
    expect(await walPhase(fixture)).toBe('prepared');
    expect(
      JSON.parse(await fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'), 'utf8'))
        .owner
    ).toBeUndefined();
  });

  it('does not replay a prepared Product WAL under a new run while its writer epoch stays current', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const command = {
      ...commandBase(page, 'cross-run-replay'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    const evidence = { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) };
    const first = fixture.createAuthority(
      (point) => (point === 'wal_fsynced' ? 'crash' : undefined),
      { assertCurrent: async () => PRODUCT_RUN_PIN }
    );
    const firstContext = context();
    first.bindGrantFence(firstContext, {
      ownerEffectFence: evidence,
      revalidate: async () => true,
    });
    await expect(
      first.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        firstContext
      )
    ).resolves.toMatchObject({ kind: 'unavailable' });
    const walPath = path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE);
    const wal = JSON.parse(await fs.promises.readFile(walPath, 'utf8')) as {
      productGrant: { runPin: typeof PRODUCT_RUN_PIN };
    };
    expect(wal.productGrant.runPin).toEqual(PRODUCT_RUN_PIN);

    // Product still names the WAL writer's epoch, so the new run cannot prove it superseded.
    const writerEpochs = writerEpochAuthority(PRODUCT_RUN_PIN);
    const retry = fixture.createAuthority(
      undefined,
      { assertCurrent: async () => SUCCESSOR_RUN_PIN },
      undefined,
      writerEpochs
    );
    const retryContext = context();
    retry.bindGrantFence(retryContext, {
      ownerEffectFence: evidence,
      revalidate: async () => true,
    });
    await expect(
      retry.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        retryContext
      )
    ).resolves.toEqual({ kind: 'unsafe_active' });
    expect(writerEpochs.lookupAuthority).toHaveBeenCalledTimes(1);
    expect(await walPhase(fixture)).toBe('prepared');
    expect(
      JSON.parse(await fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'), 'utf8'))
        .owner
    ).toBeUndefined();
  });

  it('fails closed on legacy prepared Product WAL without a run pin, even under a superseding epoch', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const command = {
      ...commandBase(page, 'legacy-unpinned-replay'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    const evidence = { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) };
    const first = fixture.createAuthority(
      (point) => (point === 'wal_fsynced' ? 'crash' : undefined),
      { assertCurrent: async () => PRODUCT_RUN_PIN }
    );
    const firstContext = context();
    first.bindGrantFence(firstContext, {
      ownerEffectFence: evidence,
      revalidate: async () => true,
    });
    await first.admitTaskMutation(
      { command, payloadFingerprint: fingerprint(command.commandId) },
      firstContext
    );
    const walPath = path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE);
    const wal = JSON.parse(await fs.promises.readFile(walPath, 'utf8')) as {
      productGrant: { runPin?: typeof PRODUCT_RUN_PIN };
    };
    delete wal.productGrant.runPin;
    await fs.promises.writeFile(walPath, JSON.stringify(wal), 'utf8');
    const writerEpochs = writerEpochAuthority(SUCCESSOR_RUN_PIN);
    const retry = fixture.createAuthority(
      undefined,
      { assertCurrent: async () => SUCCESSOR_RUN_PIN },
      undefined,
      writerEpochs
    );
    const retryContext = context();
    retry.bindGrantFence(retryContext, {
      ownerEffectFence: evidence,
      revalidate: async () => true,
    });
    await expect(
      retry.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        retryContext
      )
    ).resolves.toEqual({ kind: 'unsafe_active' });
    expect(writerEpochs.lookupAuthority).not.toHaveBeenCalled();
    expect(await walPhase(fixture)).toBe('prepared');
    expect(
      JSON.parse(await fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'), 'utf8'))
        .owner
    ).toBeUndefined();
  });

  it('does not abort a Product WAL after the task postimage was published', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const command = {
      ...commandBase(page, 'published-before-crash'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    const evidence = { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) };
    const first = fixture.createAuthority(
      (point) => (point === 'task_published' ? 'crash' : undefined),
      { assertCurrent: async () => PRODUCT_RUN_PIN }
    );
    const firstContext = context();
    first.bindGrantFence(firstContext, {
      ownerEffectFence: evidence,
      revalidate: async () => true,
    });
    await expect(
      first.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        firstContext
      )
    ).resolves.toMatchObject({ kind: 'unavailable' });
    const retry = fixture.createAuthority(undefined, {
      assertCurrent: async () => PRODUCT_RUN_PIN,
    });
    const retryContext = context();
    retry.bindGrantFence(retryContext, {
      ownerEffectFence: evidence,
      revalidate: async () => true,
    });
    await expect(
      retry.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        retryContext
      )
    ).resolves.toMatchObject({ kind: 'idempotent_replay' });
    expect(
      JSON.parse(
        await fs.promises.readFile(
          path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
          'utf8'
        )
      ).phase
    ).toBe('terminal');
    expect(taskBySubject(await readPage(fixture), 'Original task').ownerId).toBe(command.ownerId);
  });

  it('rechecks Product authority before recovery links a detached target', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const taskPath = path.join(fixture.tasksDirectory, '1.json');
    const original = await fs.promises.readFile(taskPath, 'utf8');
    const command = {
      ...commandBase(page, 'recovery-revoked'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    const first = fixture.createAuthority(
      (point) => (point === 'existing_target_preimage_detached' ? 'crash' : undefined),
      { assertCurrent: async () => PRODUCT_RUN_PIN }
    );
    const firstContext = context();
    const evidence = { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) };
    first.bindGrantFence(firstContext, {
      ownerEffectFence: evidence,
      revalidate: async () => true,
    });
    await expect(
      first.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        firstContext
      )
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(await exists(taskPath)).toBe(false);
    let granted = true;
    let currentChecks = 0;
    const retry = fixture.createAuthority(undefined, {
      assertCurrent: async () => {
        currentChecks += 1;
        if (currentChecks === 3) granted = false;
        return PRODUCT_RUN_PIN;
      },
    });
    const retryContext = context();
    retry.bindGrantFence(retryContext, {
      ownerEffectFence: evidence,
      revalidate: async () => granted,
    });
    await expect(
      retry.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        retryContext
      )
    ).resolves.toMatchObject({ kind: 'unsafe_active' });
    expect(currentChecks).toBeGreaterThanOrEqual(3);
    expect(await fs.promises.readFile(taskPath, 'utf8')).toBe(original);
    expect(taskBySubject(await readPage(fixture), 'Original task').ownerId).toBeNull();
  });

  it('uses the renewed WAL handle when direct recovery aborts after a revoked relink', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const taskPath = path.join(fixture.tasksDirectory, '1.json');
    const preimage = await fs.promises.readFile(taskPath, 'utf8');
    const command = {
      ...commandBase(page, 'direct-recovery-revoked'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    const first = fixture.createAuthority(
      (point) => (point === 'existing_target_preimage_detached' ? 'crash' : undefined),
      { assertCurrent: async () => PRODUCT_RUN_PIN }
    );
    const firstContext = context();
    first.bindGrantFence(firstContext, {
      ownerEffectFence: { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => true,
    });
    await expect(
      first.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        firstContext
      )
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(await exists(taskPath)).toBe(false);

    const teamDirectory = await openHostedTaskBoardDirectory(fixture.teamRoot, null, null);
    const tasksDirectory = await openHostedTaskBoardDirectory(fixture.tasksDirectory, null, null);
    let fence: HostedTaskBoardMutationFence | null = null;
    try {
      const handle = await readHostedTaskBoardMutationWal(teamDirectory);
      expect(handle?.wal.phase).toBe('prepared');
      if (handle === null) throw new Error('expected prepared WAL');
      fence = await HostedTaskBoardMutationFence.acquire({
        teamDirectory,
        nowMs: () => fixture.clock.nowMs,
        durationMs: 20_000,
      });
      if (fence === null) throw new Error('expected recovery fence');
      let authorityChecks = 0;
      await expect(
        recoverHostedTaskBoardMutationWal({
          handle,
          teamDirectory,
          tasksDirectory,
          fence,
          beforeCommitBoundary: async () => {
            authorityChecks += 1;
            throw new Error('Product grant revoked before relink');
          },
        })
      ).rejects.toThrow('Product grant revoked before relink');
      expect(authorityChecks).toBe(1);
      expect((await readHostedTaskBoardMutationWal(teamDirectory))?.wal.phase).toBe('aborted');
      expect(await fs.promises.readFile(taskPath, 'utf8')).toBe(preimage);
    } finally {
      await fence?.release();
      await closeHostedTaskBoardDirectories([teamDirectory, tasksDirectory]);
    }
    expect(taskBySubject(await readPage(fixture), 'Original task').ownerId).toBeNull();
  });

  it('keeps a max-size board blocked until failed aborted-stage cleanup can resume', async () => {
    const fixture = await createFixture();
    const task = taskBySubject(await readPage(fixture), 'Original task');
    await fillTaskDirectory(fixture, 512);
    const page = await readPage(fixture);
    const command = {
      ...commandBase(page, 'abort-stage-retry'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    const evidence = { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) };
    let granted = true;
    const unlink = fs.promises.unlink.bind(fs.promises);
    let failedStageCleanup = false;
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => {
      if (!failedStageCleanup && String(file).endsWith('.stage')) {
        failedStageCleanup = true;
        throw new Error('simulated-aborted-stage-delete-failure');
      }
      return unlink(file);
    });
    const first = fixture.createAuthority(
      (point) => {
        if (point === 'existing_target_precommit_validated') granted = false;
      },
      { assertCurrent: async () => PRODUCT_RUN_PIN }
    );
    const firstContext = context();
    first.bindGrantFence(firstContext, {
      ownerEffectFence: evidence,
      revalidate: async () => granted,
    });
    await expect(
      first.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        firstContext
      )
    ).resolves.toMatchObject({ kind: 'unsafe_active' });
    expect(failedStageCleanup).toBe(true);
    expect(
      JSON.parse(
        await fs.promises.readFile(
          path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
          'utf8'
        )
      ).phase
    ).toBe('prepared');
    expect((await fs.promises.readdir(fixture.tasksDirectory)).length).toBe(513);
    // Writes stay blocked, but the board remains readable at its committed state.
    await expect(fixture.source.readWindow(readRequest(), context())).resolves.toMatchObject({
      kind: 'found',
      revision: page.revision,
    });
    unlinkSpy.mockRestore();
    granted = true;
    const retry = fixture.createAuthority(undefined, {
      assertCurrent: async () => PRODUCT_RUN_PIN,
    });
    const retryContext = context();
    retry.bindGrantFence(retryContext, {
      ownerEffectFence: evidence,
      revalidate: async () => granted,
    });
    await expect(
      retry.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        retryContext
      )
    ).resolves.toMatchObject({ kind: 'committed' });
    expect((await fs.promises.readdir(fixture.tasksDirectory)).length).toBe(512);
    expect(
      JSON.parse(await fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'), 'utf8'))
        .owner
    ).toBe(command.ownerId);
  });

  it('denies a stale revision under a current Product grant', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const task = taskBySubject(page, 'Original task');
    const authority = fixture.createAuthority(undefined, {
      assertCurrent: async () => PRODUCT_RUN_PIN,
    });
    const query = context();
    authority.bindGrantFence(query, {
      ownerEffectFence: { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => true,
    });
    await fs.promises.writeFile(
      path.join(fixture.tasksDirectory, '2.json'),
      taskText('2', 'Changed'),
      'utf8'
    );
    const command = {
      ...commandBase(page, 'stale-product-revision'),
      kind: 'update_owner' as const,
      taskId: task.taskId,
      ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
    };
    await expect(
      authority.admitTaskMutation(
        { command, payloadFingerprint: fingerprint(command.commandId) },
        query
      )
    ).resolves.toMatchObject({ kind: 'stale_revision' });
    expect(taskBySubject(await readPage(fixture), 'Original task').ownerId).toBeNull();
  });
  it.each([
    ['generation 1 startup', 1],
    ['trusted generation 2 restart', 2],
  ] as const)(
    'mutates a stable generation-1 team after %s at mount generation %i',
    async (_phase, mountGeneration) => {
      const fixture = await createFixture(mountGeneration);
      const page = await readPage(fixture);
      const target = taskBySubject(page, 'Original task');

      await expect(
        admit(fixture.createAuthority(), {
          ...commandBase(page, `stable-binding-mount-${mountGeneration}`),
          kind: 'update_status',
          taskId: target.taskId,
          status: 'completed',
        })
      ).resolves.toMatchObject({ kind: 'committed' });
      expect(taskBySubject(await readPage(fixture), 'Original task').status).toBe('completed');
    }
  );

  it('rejects stable-binding rollback, same-generation workspace mismatch, and unbound mutation replay', async () => {
    const foreignWorkspaceId = parseWorkspaceId(`workspace_${'9'.repeat(32)}`);
    const fixture = await createFixture(2);
    fixture.setWorkspaceBinding(WORKSPACE_ID, 2);
    const page = await readPage(fixture);
    const target = taskBySubject(page, 'Original task');
    const command = {
      ...commandBase(page, 'stable-binding-replay'),
      kind: 'update_status' as const,
      taskId: target.taskId,
      status: 'completed' as const,
    };
    const authority = fixture.createAuthority();
    await expect(admit(authority, command)).resolves.toMatchObject({ kind: 'committed' });

    fixture.setWorkspaceBinding(WORKSPACE_ID, 1);
    await expect(admit(authority, command)).resolves.toEqual({
      kind: 'unavailable',
      retryAfterMs: 5_000,
    });

    fixture.setWorkspaceBinding(foreignWorkspaceId, 2);
    await expect(admit(authority, command)).resolves.toEqual({
      kind: 'unavailable',
      retryAfterMs: 5_000,
    });

    fixture.setWorkspaceBinding(null);
    await expect(admit(authority, command)).resolves.toEqual({ kind: 'not_found' });
  });

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

  it('resolves immutable zero-task roster identities and rejects removed identities', async () => {
    const fixture = await createFixture();
    const firstIdentity = hostedTaskBoardRosterMemberId(TEAM_ID, `zero-task\u0000${NOW_MS}`);
    const replacementIdentity = hostedTaskBoardRosterMemberId(
      TEAM_ID,
      `zero-task\u0000${NOW_MS + 1}`
    );
    const writeRoster = (members: readonly Record<string, unknown>[]) =>
      fs.promises.writeFile(
        path.join(fixture.teamRoot, 'members.meta.json'),
        `${JSON.stringify({ version: 1, members }, null, 2)}\n`,
        'utf8'
      );
    await writeRoster([
      { name: 'zero-task', agentType: 'worker', agentId: 'agent-zero-v1', joinedAt: NOW_MS },
    ]);

    let page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    expect(
      await admit(fixture.createAuthority(), {
        ...commandBase(page, 'immutable-owner-first'),
        kind: 'update_owner',
        taskId: original.taskId,
        ownerId: firstIdentity,
      })
    ).toMatchObject({ kind: 'committed' });
    await expect(
      fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'), 'utf8')
    ).resolves.toSatisfy(
      (serialized) =>
        (JSON.parse(serialized) as { readonly owner?: unknown }).owner === firstIdentity
    );

    await writeRoster([
      {
        name: 'zero-task',
        agentType: 'worker',
        agentId: 'agent-zero-v1',
        joinedAt: NOW_MS,
        removedAt: NOW_MS,
      },
      {
        name: 'zero-task',
        agentType: 'worker',
        agentId: 'agent-zero-v2',
        joinedAt: NOW_MS + 1,
      },
    ]);
    page = await readPage(fixture);
    expect(taskBySubject(page, 'Original task').ownerId).toBeNull();
    const second = taskBySubject(page, 'Second task');
    await expect(
      admit(fixture.createAuthority(), {
        ...commandBase(page, 'immutable-owner-removed'),
        kind: 'update_owner',
        taskId: second.taskId,
        ownerId: firstIdentity,
      })
    ).resolves.toEqual({
      kind: 'conflict',
      reason: 'state_conflict',
      currentSourceGeneration: page.sourceGeneration,
      currentRevision: page.revision,
    });
    await expect(
      admit(fixture.createAuthority(), {
        ...commandBase(page, 'immutable-owner-replacement'),
        kind: 'update_owner',
        taskId: second.taskId,
        ownerId: replacementIdentity,
      })
    ).resolves.toMatchObject({ kind: 'committed' });
    expect(taskBySubject(await readPage(fixture), 'Second task').ownerId).toBe(replacementIdentity);
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
        readonly schemaVersion: number;
        readonly fence: { readonly token: string; readonly generation: number };
        readonly phase: string;
        readonly finalReceipt: unknown;
      };
      expect(pending.schemaVersion).toBe(3);
      expect(pending.fence).toMatchObject({ generation: expect.any(Number) });
      expect(pending.fence.token).toMatch(/^[0-9a-f-]{36}$/i);
      expect(pending.phase).toBe('prepared');
      // However far publication got, a read serves the board as it was before the transaction.
      const committed = await readPage(fixture);
      expect(committed.revision).toBe(page.revision);
      expect(committed.items.some((item) => item.subject === `Crash ${faultPoint}`)).toBe(false);

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

  it('replays every durable task, kanban, and receipt-ledger mutation after restart', async () => {
    const mutationKinds = [
      'create_task',
      'update_status',
      'update_owner',
      'move_task',
      'reorder_column',
    ] as const;
    for (const kind of mutationKinds) {
      const fixture = await createFixture();
      const page = await readPage(fixture);
      const original = taskBySubject(page, 'Original task');
      const second = taskBySubject(page, 'Second task');
      const command: HostedTaskMutationCommand =
        kind === 'create_task'
          ? {
              ...commandBase(page, `restart-${kind}`),
              kind,
              subject: 'Restarted create',
              description: null,
              status: 'pending',
              ownerId: null,
              column: 'todo',
              order: 0,
            }
          : kind === 'update_status'
            ? {
                ...commandBase(page, `restart-${kind}`),
                kind,
                taskId: original.taskId,
                status: 'completed',
              }
            : kind === 'update_owner'
              ? {
                  ...commandBase(page, `restart-${kind}`),
                  kind,
                  taskId: second.taskId,
                  ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
                }
              : kind === 'move_task'
                ? {
                    ...commandBase(page, `restart-${kind}`),
                    kind,
                    taskId: original.taskId,
                    column: 'review',
                    order: 0,
                  }
                : {
                    ...commandBase(page, `restart-${kind}`),
                    kind,
                    column: 'todo',
                    orderedTaskIds: page.items
                      .filter((item) => item.column === 'todo')
                      .sort((left, right) => left.order - right.order)
                      .map((item) => item.taskId)
                      .reverse(),
                  };
      const crashed = await admit(
        fixture.createAuthority((point) => (point === 'ledger_published' ? 'crash' : undefined)),
        command
      );
      expect(crashed, kind).toEqual({ kind: 'unavailable', retryAfterMs: 5_000 });
      await expect(admit(fixture.createAuthority(), command)).resolves.toMatchObject({
        kind: 'idempotent_replay',
      });
      await expect(readPage(fixture)).resolves.toMatchObject({ kind: 'found' });
    }
  });

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

  it('does not overwrite a target replaced after descriptor-bound pre-write revalidation', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    const targetPath = path.join(fixture.tasksDirectory, '1.json');
    const externalReplacement = taskText('1', 'Replacement after final pre-write validation');
    const result = await admit(
      fixture.createAuthority(async (point) => {
        if (point === 'existing_target_precommit_validated') {
          await replaceFile(targetPath, externalReplacement);
        }
      }),
      {
        ...commandBase(page, 'post-precommit-race'),
        kind: 'update_details',
        taskId: original.taskId,
        subject: 'Must not overwrite after final pre-write validation',
      }
    );

    expect(result).toEqual({ kind: 'unsafe_active' });
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toBe(externalReplacement);
    await expect(fixture.source.readWindow(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('restores a provider write through an already-open descriptor after preimage detachment', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    const targetPath = path.join(fixture.tasksDirectory, '1.json');
    const providerText = taskText('1', 'Provider descriptor write wins', {
      providerRevision: 'provider-after-validation',
    });
    const providerHandle = await fs.promises.open(targetPath, 'r+');
    let providerWrote = false;
    let result: Awaited<ReturnType<typeof admit>>;
    try {
      result = await admit(
        fixture.createAuthority(async (point) => {
          if (point !== 'existing_target_preimage_detached') return;
          await providerHandle.truncate(0);
          await providerHandle.writeFile(providerText, 'utf8');
          await providerHandle.sync();
          providerWrote = true;
        }),
        {
          ...commandBase(page, 'open-provider-write'),
          kind: 'update_details',
          taskId: original.taskId,
          subject: 'Must not hide the provider descriptor write',
        }
      );
    } finally {
      await providerHandle.close();
    }

    expect(providerWrote).toBe(true);
    expect(result).toEqual({ kind: 'unsafe_active' });
    const taskNames = await fs.promises.readdir(fixture.tasksDirectory);
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toBe(providerText);
    await expect(fixture.source.readWindow(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(taskNames.filter((name) => name.startsWith('.hosted-task-board-'))).toEqual([]);
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
        if (point === 'existing_target_replaced') failTaskDirectorySync = true;
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
    'existing_target_precommit_validated',
    'existing_target_preimage_detached',
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
      const targetPath = path.join(fixture.tasksDirectory, '1.json');
      if (faultPoint === 'existing_target_preimage_detached') {
        expect(await exists(targetPath)).toBe(false);
      } else {
        const persisted = await fs.promises.readFile(targetPath, 'utf8');
        expect(JSON.parse(persisted)).toMatchObject({ id: '1' });
        if (faultPoint === 'existing_target_postimage_ready') {
          expect(persisted).toBe(taskText('1', 'Original task'));
        }
        if (faultPoint === 'existing_target_replaced') {
          expect(persisted).toContain('"status": "in_progress"');
        }
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
    await expect(fixture.source.readWindow(readRequest(), context())).resolves.toMatchObject({
      kind: 'found',
      revision: initial.revision,
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

  it('fences an in-flight stale writer immediately before target publication after a reclaimable lease takeover', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    const command: HostedTaskMutationCommand = {
      ...commandBase(page, 'stale-takeover'),
      kind: 'update_status',
      taskId: original.taskId,
      status: 'in_progress',
    };
    let entered!: () => void;
    let release!: () => void;
    const enteredWal = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseWal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const staleWriter = admit(
      fixture.createAuthority(async (point) => {
        if (point !== 'existing_target_preimage_detached') return;
        fixture.clock.nowMs += 5_001;
        entered();
        await releaseWal;
      }),
      command
    );
    await enteredWal;
    await expect(admit(fixture.createAuthority(), command)).resolves.toMatchObject({
      kind: 'idempotent_replay',
    });
    release();
    await expect(staleWriter).resolves.toEqual({ kind: 'unsafe_active' });
    expect(taskBySubject(await readPage(fixture), 'Original task')).toMatchObject({
      status: 'in_progress',
    });
  });

  it('fences a stale writer before it can detach a postimage recovered by a lease taker', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const original = taskBySubject(page, 'Original task');
    const command: HostedTaskMutationCommand = {
      ...commandBase(page, 'stale-detach-takeover'),
      kind: 'update_status',
      taskId: original.taskId,
      status: 'in_progress',
    };
    let entered!: () => void;
    let release!: () => void;
    const enteredPrecommit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePrecommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const staleWriter = admit(
      fixture.createAuthority(async (point) => {
        if (point !== 'existing_target_precommit_validated') return;
        fixture.clock.nowMs += 5_001;
        entered();
        await releasePrecommit;
      }),
      command
    );
    await enteredPrecommit;
    await expect(admit(fixture.createAuthority(), command)).resolves.toMatchObject({
      kind: 'idempotent_replay',
    });
    release();
    await expect(staleWriter).resolves.toEqual({ kind: 'unsafe_active' });
    expect(taskBySubject(await readPage(fixture), 'Original task')).toMatchObject({
      status: 'in_progress',
    });
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

  it('fails closed for malformed ledger and kanban state before a durable mutation', async () => {
    const malformedLedger = await createFixture();
    const ledgerPage = await readPage(malformedLedger);
    const ledgerTarget = taskBySubject(ledgerPage, 'Original task');
    await fs.promises.writeFile(
      path.join(malformedLedger.teamRoot, 'hosted-task-board-mutation-ledger.v2.json'),
      '{malformed-ledger',
      'utf8'
    );
    await expect(
      admit(malformedLedger.createAuthority(), {
        ...commandBase(ledgerPage, 'malformed-ledger'),
        kind: 'update_status',
        taskId: ledgerTarget.taskId,
        status: 'completed',
      })
    ).resolves.toEqual({ kind: 'unsafe_active' });

    const malformedKanban = await createFixture();
    const kanbanPage = await readPage(malformedKanban);
    const kanbanTarget = taskBySubject(kanbanPage, 'Original task');
    await fs.promises.writeFile(
      path.join(malformedKanban.teamRoot, 'kanban-state.json'),
      '{malformed-kanban',
      'utf8'
    );
    await expect(malformedKanban.source.readWindow(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(
      admit(malformedKanban.createAuthority(), {
        ...commandBase(kanbanPage, 'malformed-kanban'),
        kind: 'update_status',
        taskId: kanbanTarget.taskId,
        status: 'completed',
      })
    ).resolves.toEqual({ kind: 'unsafe_active' });
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

const PRODUCT_OWNER = Object.freeze({
  ownerAuthority: PRODUCT_RUN_PIN.ownerAuthority,
  ownerGeneration: PRODUCT_RUN_PIN.ownerGeneration,
  ownerSessionId: PRODUCT_RUN_PIN.ownerSessionId,
  socketIdentity: Object.freeze({ device: '1', inode: '1', uid: 1000, gid: 1000, mode: 0o600 }),
});
function coreV1Command(
  kind: 'create_task' | 'update_owner' | 'update_status' | 'reorder_column',
  page: FoundPage,
  suffix: string
): HostedTaskMutationCommand {
  const base = commandBase(page, `${kind}-${suffix}`);
  const original = taskBySubject(page, 'Original task');
  switch (kind) {
    case 'create_task':
      return {
        ...base,
        kind,
        subject: 'Product created task',
        description: null,
        status: 'pending',
        ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
        column: 'todo',
        order: 0,
      };
    case 'update_owner':
      return {
        ...base,
        kind,
        taskId: original.taskId,
        ownerId: hostedTaskBoardRosterMemberId(TEAM_ID, 'zero-task'),
      };
    case 'update_status':
      return { ...base, kind, taskId: original.taskId, status: 'completed' };
    case 'reorder_column':
      return {
        ...base,
        kind,
        column: 'todo',
        orderedTaskIds: page.items
          .filter((item) => item.column === 'todo')
          .sort((left, right) => left.order - right.order)
          .map((item) => item.taskId)
          .reverse(),
      };
  }
}

function productAuthority(fixture: Fixture, onFaultPoint?: FaultHandler) {
  let superseded = false;
  const resolveCurrent = vi.fn(async () =>
    superseded ? null : Object.freeze({ ...PRODUCT_RUN_PIN, runId: null })
  );
  const commitAuthority = new ProductTaskWriteCommitAuthority({
    current: () => ({ resolveCurrent }) as never,
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    expectedOwner: PRODUCT_OWNER,
    currentOwner: () => PRODUCT_OWNER,
    restoreGeneration: PRODUCT_RUN_PIN.restoreGeneration,
    mountGeneration: PRODUCT_RUN_PIN.mountGeneration,
  });
  const committed = new ProductTaskCommittedTargets();
  const onCommittedTargets = vi.fn(
    (
      query: Parameters<typeof committed.record>[0],
      targets: Parameters<typeof committed.record>[1]
    ) => committed.record(query, targets)
  );
  const selfWrites = {
    beginTaskSelfWrite: vi.fn(async (_operationId: string, _teamId: string) => undefined),
    completeTaskSelfWrite: vi.fn(
      async (
        _operationId: string,
        _effects: readonly { readonly fileKey: string; readonly expectedChecksum: string }[]
      ) => undefined
    ),
    abortTaskSelfWrite: vi.fn(async (_operationId: string) => undefined),
  };
  const authority = new ProductTaskMutationAuthority(
    fixture.createAuthority(onFaultPoint, commitAuthority, onCommittedTargets),
    new ProductTaskWriteFileSerialization(ensureProductTaskWriteLockDirectory(fixture.root)),
    commitAuthority,
    selfWrites,
    committed
  );
  const mutate = (command: HostedTaskMutationCommand, fingerprintValue?: string) => {
    const query = context();
    authority.bindGrantFence(query, {
      ownerEffectFence: { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) },
      revalidate: async () => true,
      requester: {
        publicWorkspaceId: `workspace_${'9'.repeat(32)}`,
        userId: `usr_${'8'.repeat(32)}`,
        sessionId: `session_${'7'.repeat(32)}`,
      },
    });
    return authority.admitTaskMutation(
      { command, payloadFingerprint: fingerprintValue ?? fingerprint(command.commandId) },
      query
    );
  };
  return {
    mutate,
    resolveCurrent,
    onCommittedTargets,
    selfWrites,
    supersede: () => {
      superseded = true;
    },
  };
}

describeLinux('Product task mutation authority over descriptor-bound task files', () => {
  // New file, replaced existing file, and kanban-only commands take different publication paths.
  it.each(['create_task', 'update_owner', 'reorder_column'] as const)(
    'publishes nothing for %s when a successor supersedes the writer before the commit boundary',
    async (kind) => {
      const fixture = await createFixture();
      let supersede = (): void => undefined;
      const product = productAuthority(fixture, (point) => {
        if (point === 'wal_fsynced') supersede();
      });
      supersede = product.supersede;
      const before = await boardFiles(fixture);

      await expect(
        product.mutate(coreV1Command(kind, await readPage(fixture), 'split-brain'))
      ).resolves.toMatchObject({ kind: 'unsafe_active' });
      expect(await boardFiles(fixture)).toEqual(before);
      expect(product.onCommittedTargets).not.toHaveBeenCalled();
      expect(product.selfWrites.completeTaskSelfWrite).not.toHaveBeenCalled();
      expect(product.selfWrites.abortTaskSelfWrite).toHaveBeenCalledOnce();
    }
  );

  it('reports exactly the published task bytes and never reports replay, conflict, or stale', async () => {
    const fixture = await createFixture();
    const product = productAuthority(fixture);
    const page = await readPage(fixture);
    const command = coreV1Command('create_task', page, 'effects');

    await expect(product.mutate(command)).resolves.toMatchObject({ kind: 'committed' });
    const wal = JSON.parse(
      await fs.promises.readFile(
        path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
        'utf8'
      )
    ) as { phase: string; productGrant: { runPin: { runId: string | null } } };
    expect(wal).toMatchObject({ phase: 'terminal', productGrant: { runPin: { runId: null } } });
    expect(product.selfWrites.beginTaskSelfWrite).toHaveBeenCalledWith(command.commandId, TEAM_ID);
    expect(product.onCommittedTargets).toHaveBeenCalledOnce();
    const targets = product.onCommittedTargets.mock.calls[0][1];
    expect(targets.map((target) => target.kind).sort()).toEqual(['kanban', 'ledger', 'task']);
    const effects = product.selfWrites.completeTaskSelfWrite.mock.calls[0][1];
    expect(effects).toHaveLength(1);
    const published = await fs.promises.readFile(
      path.join(fixture.tasksDirectory, `${effects[0].fileKey}.json`)
    );
    expect(effects[0].expectedChecksum).toBe(createHash('sha256').update(published).digest('hex'));

    await expect(product.mutate(command)).resolves.toMatchObject({ kind: 'idempotent_replay' });
    await expect(product.mutate(command, fingerprint('different-payload'))).resolves.toMatchObject({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await expect(
      product.mutate(coreV1Command('update_status', page, 'stale'))
    ).resolves.toMatchObject({ kind: 'stale_revision' });
    expect(product.onCommittedTargets).toHaveBeenCalledOnce();
    expect(product.selfWrites.completeTaskSelfWrite).toHaveBeenCalledOnce();
    expect(product.selfWrites.abortTaskSelfWrite).toHaveBeenCalledTimes(3);
  });

  it.each(['create_task', 'update_owner'] as const)(
    'rejects %s for a non-roster owner when the stopped team has no run',
    async (kind) => {
      const fixture = await createFixture();
      const product = productAuthority(fixture);
      const page = await readPage(fixture);
      const before = await boardFiles(fixture);
      const ownerId = hostedTaskBoardRosterMemberId(TEAM_ID, 'not-in-roster');
      const command = {
        ...coreV1Command(kind, page, 'non-roster'),
        ownerId,
      } as HostedTaskMutationCommand;

      await expect(product.mutate(command)).resolves.toEqual({
        kind: 'conflict',
        reason: 'state_conflict',
        currentSourceGeneration: page.sourceGeneration,
        currentRevision: page.revision,
      });
      expect(product.resolveCurrent).toHaveBeenCalledWith(
        expect.objectContaining({ target: { kind: 'member', memberId: ownerId } })
      );
      expect(await boardFiles(fixture)).toEqual(before);
    }
  );

  it('refuses update_relationship before any Product decision or file access', async () => {
    const fixture = await createFixture();
    const product = productAuthority(fixture);
    const page = await readPage(fixture);
    const before = await boardFiles(fixture);
    await expect(
      product.mutate({
        ...commandBase(page, 'relationship'),
        kind: 'update_relationship',
        action: 'add',
        taskId: taskBySubject(page, 'Original task').taskId,
        otherTaskId: taskBySubject(page, 'Second task').taskId,
        relationship: 'related',
      } as HostedTaskMutationCommand)
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(product.resolveCurrent).not.toHaveBeenCalled();
    expect(product.selfWrites.beginTaskSelfWrite).not.toHaveBeenCalled();
    expect(await boardFiles(fixture)).toEqual(before);
  });
});

describeLinux('prepared Product WAL takeover after a superseded writer epoch', () => {
  it('aborts an unpublished WAL without touching board files, then admits the next command', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const stale: HostedTaskMutationCommand = {
      ...commandBase(page, 'superseded-kanban-move'),
      kind: 'move_task',
      taskId: taskBySubject(page, 'Second task').taskId,
      column: 'review',
      order: 0,
    };
    const before = await boardFiles(fixture);
    await crashProductWriter(fixture, stale, 'wal_fsynced');
    expect(await walTargetKinds(fixture)).toEqual(['kanban', 'ledger']);

    const onCommittedTargets = vi.fn();
    const successor = productWriter(fixture, SUCCESSOR_RUN_PIN, {
      writerEpochs: writerEpochAuthority(SUCCESSOR_RUN_PIN),
      onCommittedTargets,
    });
    await expect(
      successor({
        ...ownerCommand(page, 'successor-after-kanban'),
        expectedRevision: 'x',
      } as HostedTaskMutationCommand)
    ).resolves.toMatchObject({ kind: 'stale_revision', currentRevision: page.revision });
    expect(await walPhase(fixture)).toBe('aborted');
    expect(await boardFiles(fixture)).toEqual(before);
    expect(onCommittedTargets).not.toHaveBeenCalled();

    const next = ownerCommand(await readPage(fixture), 'successor-next-after-kanban');
    await expect(successor(next)).resolves.toMatchObject({ kind: 'committed' });
    const after = await readPage(fixture);
    expect(taskBySubject(after, 'Second task').column).not.toBe('review');
    expect(taskBySubject(after, 'Original task').ownerId).toBe(next.ownerId);
  });

  it('rolls a WAL whose publication began forward to its own consistent commit', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const stale = ownerCommand(page, 'superseded-published');
    // The task preimage is detached but the postimage is not linked yet: neither state is visible.
    await crashProductWriter(fixture, stale, 'existing_target_preimage_detached');

    const onCommittedTargets =
      vi.fn<NonNullable<HostedTaskBoardMutationFileAuthorityDependencies['onCommittedTargets']>>();
    const successor = productWriter(fixture, SUCCESSOR_RUN_PIN, {
      writerEpochs: writerEpochAuthority(SUCCESSOR_RUN_PIN),
      onCommittedTargets,
    });
    const rolled = await successor(ownerCommand(page, 'successor-after-publish', 'Second task'));
    expect(await walPhase(fixture)).toBe('terminal');
    const current = await readPage(fixture);
    expect(rolled).toMatchObject({ kind: 'stale_revision', currentRevision: current.revision });
    expect(taskBySubject(current, 'Original task').ownerId).toBe(stale.ownerId);
    // Product wrote the rolled-forward task bytes, so the observer must see them as a self-write.
    expect(onCommittedTargets).toHaveBeenCalledOnce();
    const published = await fs.promises.readFile(path.join(fixture.tasksDirectory, '1.json'));
    expect(hostedTaskBoardSelfWriteEffects(onCommittedTargets.mock.calls[0][1])).toEqual([
      { fileKey: '1', expectedChecksum: createHash('sha256').update(published).digest('hex') },
    ]);
    // The rolled-forward receipt is durable: the superseded command now replays, not re-applies.
    await expect(successor(stale)).resolves.toMatchObject({ kind: 'idempotent_replay' });
    expect(onCommittedTargets).toHaveBeenCalledOnce();
    const taskNames = await fs.promises.readdir(fixture.tasksDirectory);
    taskNames.sort((left, right) => left.localeCompare(right));
    expect(taskNames).toEqual(['1.json', '2.json']);
  });

  it('serializes takeover behind the shared Product task-write lock', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    await crashProductWriter(fixture, ownerCommand(page, 'locked-crash'), 'wal_fsynced');
    const serialization = new ProductTaskWriteFileSerialization(
      ensureProductTaskWriteLockDirectory(fs.realpathSync.native(fixture.root))
    );
    const order: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const reachedLookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const row = await writerEpochAuthority(SUCCESSOR_RUN_PIN).lookupAuthority(DEPLOYMENT_ID);
    const takeover = productWriter(fixture, SUCCESSOR_RUN_PIN, {
      writerEpochs: {
        lookupAuthority: async () => {
          order.push('takeover-decides');
          entered();
          await held;
          return row;
        },
      },
    });
    const taking = serialization.withTaskWrite(TEAM_ID, async () => {
      const result = await takeover(ownerCommand(page, 'locked-takeover', 'Second task'));
      order.push('takeover-done');
      return result;
    });
    await reachedLookup;
    const waiting = serialization.withTaskWrite(TEAM_ID, () => {
      order.push('second-writer-entered');
      return Promise.resolve('entered');
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(['takeover-decides']);
    release();
    await expect(taking).resolves.toMatchObject({ kind: 'committed' });
    await expect(waiting).resolves.toBe('entered');
    expect(order).toEqual(['takeover-decides', 'takeover-done', 'second-writer-entered']);
  });

  it('is safe to repeat: an interrupted roll-forward resumes and a finished takeover is a no-op', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const stale = ownerCommand(page, 'interrupted-roll-forward');
    await crashProductWriter(fixture, stale, 'task_published');

    let revokeNextCheck = false;
    const interrupted = productWriter(fixture, SUCCESSOR_RUN_PIN, {
      writerEpochs: {
        lookupAuthority: async (deploymentId) => {
          revokeNextCheck = true;
          return writerEpochAuthority(SUCCESSOR_RUN_PIN).lookupAuthority(deploymentId);
        },
      },
      assertCurrent: () => {
        if (!revokeNextCheck) return Promise.resolve(SUCCESSOR_RUN_PIN);
        revokeNextCheck = false;
        return Promise.reject(new Error('grant-flapped-mid-takeover'));
      },
    });
    await expect(
      interrupted(ownerCommand(page, 'interrupted-next', 'Second task'))
    ).resolves.toEqual({ kind: 'unsafe_active' });
    expect(await walPhase(fixture)).toBe('prepared');
    expect(
      await exists(path.join(fixture.teamRoot, 'hosted-task-board-mutation-ledger.v2.json'))
    ).toBe(false);

    const writerEpochs = writerEpochAuthority(SUCCESSOR_RUN_PIN);
    const resumed = productWriter(fixture, SUCCESSOR_RUN_PIN, { writerEpochs });
    const probe = ownerCommand(page, 'resumed-probe', 'Second task');
    await expect(resumed(probe)).resolves.toMatchObject({ kind: 'stale_revision' });
    expect(await walPhase(fixture)).toBe('terminal');
    const settled = await boardFiles(fixture);
    await expect(resumed(probe)).resolves.toMatchObject({ kind: 'stale_revision' });
    expect(writerEpochs.lookupAuthority).toHaveBeenCalledTimes(1);
    expect(await boardFiles(fixture)).toEqual(settled);
    expect(taskBySubject(await readPage(fixture), 'Original task').ownerId).toBe(stale.ownerId);
  });
});

describeLinux('committed board reads over a prepared WAL', () => {
  it('serves the committed board over an unpublished WAL until the next mutation recovers it', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    await crashProductWriter(fixture, ownerCommand(page, 'snapshot-unpublished'), 'wal_fsynced');

    const committed = await readPage(fixture);
    expect(committed).toMatchObject({
      sourceGeneration: page.sourceGeneration,
      revision: page.revision,
    });
    expect(taskBySubject(committed, 'Original task').ownerId).toBeNull();

    const successor = productWriter(fixture, SUCCESSOR_RUN_PIN, {
      writerEpochs: writerEpochAuthority(SUCCESSOR_RUN_PIN),
    });
    const next = ownerCommand(committed, 'snapshot-next', 'Second task');
    await expect(successor(next)).resolves.toMatchObject({ kind: 'committed' });
    expect(await walPhase(fixture)).toBe('terminal');
    const after = await readPage(fixture);
    expect(taskBySubject(after, 'Original task').ownerId).toBeNull();
    expect(taskBySubject(after, 'Second task').ownerId).toBe(next.ownerId);
  });

  it('serves the pre-transaction board over a partly published WAL, then the rolled-forward one', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    const stale = ownerCommand(page, 'snapshot-published');
    // The task preimage is detached and its postimage not linked yet: 1.json is missing on disk.
    await crashProductWriter(fixture, stale, 'existing_target_preimage_detached');
    expect(await exists(path.join(fixture.tasksDirectory, '1.json'))).toBe(false);

    const committed = await readPage(fixture);
    expect(committed.revision).toBe(page.revision);
    expect(taskBySubject(committed, 'Original task').ownerId).toBeNull();

    const successor = productWriter(fixture, SUCCESSOR_RUN_PIN, {
      writerEpochs: writerEpochAuthority(SUCCESSOR_RUN_PIN),
    });
    await expect(
      successor(ownerCommand(committed, 'snapshot-after-publish', 'Second task'))
    ).resolves.toMatchObject({ kind: 'stale_revision' });
    expect(await walPhase(fixture)).toBe('terminal');
    const rolled = await readPage(fixture);
    expect(rolled.revision).not.toBe(page.revision);
    expect(taskBySubject(rolled, 'Original task').ownerId).toBe(stale.ownerId);
  });

  it('fails closed on a foreign edit of a WAL target and on a WAL that changes during the read', async () => {
    const fixture = await createFixture();
    const page = await readPage(fixture);
    await crashProductWriter(fixture, ownerCommand(page, 'snapshot-foreign'), 'wal_fsynced');
    const walPath = path.join(fixture.teamRoot, HOSTED_TASK_BOARD_MUTATION_WAL_FILE);
    const touched = new Date(Date.now() + 60_000);

    // Any change to the WAL between the first probe and the final recheck voids the read.
    fixture.setReadCheckpoint(() => fs.promises.utimes(walPath, touched, touched));
    await expect(fixture.source.readWindow(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    fixture.setReadCheckpoint(undefined);
    await expect(readPage(fixture)).resolves.toMatchObject({ revision: page.revision });

    await fs.promises.writeFile(
      path.join(fixture.tasksDirectory, '1.json'),
      taskText('1', 'Foreign edit under a prepared WAL'),
      'utf8'
    );
    await expect(fixture.source.readWindow(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});
