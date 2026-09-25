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
  type HostedTaskBoardAuthorityReadWindowRequest,
  type HostedTaskBoardAuthorityReadWindowResult,
} from '@features/team-task-board/main/hosted';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import { DescriptorBoundHostedTaskBoardReadSource } from '@main/composition/hosted/hostedTaskBoardReadFileSource';
import {
  createQueryContext,
  parseBootId,
  parseDeploymentId,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

const NOW_MS = 1_800_000_000_000;
const BOOT_ID = parseBootId(`boot_${'a'.repeat(32)}`);
const DEPLOYMENT_ID = parseDeploymentId(`deployment_${'b'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
const TEAM_ID = parseTeamId(`team_${'d'.repeat(32)}`);
const LEGACY_TEAM_KEY = 'team-alpha';
const roots: string[] = [];
const describeLinux = describe.runIf(process.platform === 'linux');

interface TaskBoardReadFixture {
  readonly claudeRoot: string;
  readonly teamsRoot: string;
  readonly teamRoot: string;
  readonly tasksRoot: string;
  readonly tasksDirectory: string;
  readonly taskFile: string;
  readonly source: DescriptorBoundHostedTaskBoardReadSource;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function request(): HostedTaskBoardAuthorityReadWindowRequest {
  return Object.freeze({
    teamId: TEAM_ID,
    afterTaskId: null,
    expectedSourceGeneration: null,
    itemLimit: 25,
    byteLimit: 256 * 1024,
    deadlineAtMs: NOW_MS + 1_000,
  });
}

function context(signal = new AbortController().signal): QueryContext {
  return createQueryContext({
    actorId: 'actor_task-board-read-source',
    sessionId: 'session_task-board-read-source',
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    requestId: 'request_task-board-read-source',
    authorizedScope: 'scope_task-board-read-source',
    deadlineAtMs: NOW_MS + 1_000,
    signal,
  });
}

function mountBinding(): WorkspaceMountBinding {
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'registration-task-board-read-source',
    workspaceId: WORKSPACE_ID,
    displayName: 'Task board read source',
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
    health: 'read-only',
    allowedOperations: [],
  });
}

async function createFixture(
  options: {
    readonly identityError?: Error;
    readonly beforeFinalWalRecheck?: () => Promise<void>;
  } = {}
): Promise<TaskBoardReadFixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hosted-task-board-read-'));
  roots.push(root);
  const claudeRoot = path.join(root, 'claude');
  const teamsRoot = path.join(claudeRoot, 'teams');
  const teamRoot = path.join(teamsRoot, LEGACY_TEAM_KEY);
  const tasksRoot = path.join(claudeRoot, 'tasks');
  const tasksDirectory = path.join(tasksRoot, LEGACY_TEAM_KEY);
  const taskFile = path.join(tasksDirectory, '1.json');
  const createdAt = '2027-01-01T00:00:00.000Z';
  const identityFile = `${JSON.stringify(
    { schemaVersion: 1, teamId: TEAM_ID, createdAt },
    null,
    2
  )}\n`;

  await fs.promises.mkdir(teamRoot, { recursive: true });
  await fs.promises.mkdir(tasksDirectory, { recursive: true });
  await fs.promises.writeFile(path.join(teamRoot, 'team.identity.json'), identityFile, 'utf8');
  await fs.promises.writeFile(
    taskFile,
    JSON.stringify({
      id: '1',
      subject: 'Original task',
      status: 'pending',
      blockedBy: [],
      blocks: [],
      related: [],
    }),
    'utf8'
  );

  const teamDirectoryStat = await fs.promises.stat(teamRoot, { bigint: true });
  const identity = parseTeamIdentityRecord({
    teamId: TEAM_ID,
    state: 'active',
    legacyKey: LEGACY_TEAM_KEY,
    directoryFingerprint: digest({
      schemaVersion: 1,
      canonicalPath: teamRoot,
      device: teamDirectoryStat.dev.toString(),
      inode: teamDirectoryStat.ino.toString(),
    }),
    workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 1 },
    adoptionIntentId: `adoption_${'f'.repeat(32)}`,
    identityChecksum: sha256(identityFile),
    createdAt,
    activatedAt: '2027-01-01T00:00:01.000Z',
    tombstonedAt: null,
  });
  const teamIdentities: TeamIdentityReadGateway = {
    listTeamIdentities: () => Promise.resolve([identity]),
    getTeamIdentity: () =>
      options.identityError === undefined
        ? Promise.resolve(identity)
        : Promise.reject(options.identityError),
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

  return Object.freeze({
    claudeRoot,
    teamsRoot,
    teamRoot,
    tasksRoot,
    tasksDirectory,
    taskFile,
    source: new DescriptorBoundHostedTaskBoardReadSource({
      runtimeInstance,
      mountBinding: mountBinding(),
      teamIdentities,
      nowMs: () => NOW_MS,
      ...(options.beforeFinalWalRecheck === undefined
        ? {}
        : { onReadCheckpoint: options.beforeFinalWalRecheck }),
    }),
  });
}

async function read(
  fixture: TaskBoardReadFixture
): Promise<HostedTaskBoardAuthorityReadWindowResult> {
  return fixture.source.readWindow(request(), context());
}

function openAfterDirectoryDescriptor(sequence: number, afterOpen: () => Promise<void>): void {
  const originalOpen = fs.promises.open.bind(fs.promises);
  let openedDirectories = 0;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
    const handle = await originalOpen(target, flags, mode);
    if (typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY) !== 0) {
      openedDirectories += 1;
      if (openedDirectories === sequence) await afterOpen();
    }
    return handle;
  });
}

async function replaceDirectoryWithSymlink(
  directory: string,
  outside: string
): Promise<() => Promise<void>> {
  const parked = `${directory}.parked`;
  await fs.promises.rename(directory, parked);
  await fs.promises.symlink(outside, directory, 'dir');
  return async () => {
    await fs.promises.rm(directory, { force: true });
    await fs.promises.rename(parked, directory);
  };
}

async function replaceTaskFile(
  fixture: TaskBoardReadFixture,
  replacement: 'file' | 'symlink',
  outside: string
): Promise<() => Promise<void>> {
  const parked = `${fixture.taskFile}.parked`;
  await fs.promises.rename(fixture.taskFile, parked);
  if (replacement === 'symlink') {
    const target = path.join(outside, 'outside-task.json');
    await fs.promises.writeFile(target, '{"private":"outside"}', 'utf8');
    await fs.promises.symlink(target, fixture.taskFile, 'file');
  } else {
    await fs.promises.writeFile(
      fixture.taskFile,
      '{"id":"1","subject":"Replacement task","status":"pending"}',
      'utf8'
    );
  }
  return async () => {
    await fs.promises.rm(fixture.taskFile, { force: true });
    await fs.promises.rename(parked, fixture.taskFile);
  };
}

const OWNER_TASK_MUTATION_WAL_FILE = 'hosted-task-board-owner-mutation.wal.v1.json';

/** Real Owner output for one create_task commit on this fixture's team (see the fixture's source). */
async function writeOwnerTaskBoardCommit(fixture: TaskBoardReadFixture): Promise<{
  readonly teamFiles: Readonly<Record<string, string>>;
  readonly taskFiles: Readonly<Record<string, string>>;
}> {
  const commit = JSON.parse(
    await fs.promises.readFile(
      path.resolve('test/fixtures/hosted-web/owner-task-board-commit.json'),
      'utf8'
    )
  ) as {
    readonly teamFiles: Readonly<Record<string, string>>;
    readonly taskFiles: Readonly<Record<string, string>>;
  };
  for (const [name, text] of Object.entries(commit.teamFiles)) {
    await fs.promises.writeFile(path.join(fixture.teamRoot, name), text, { mode: 0o600 });
  }
  for (const [name, text] of Object.entries(commit.taskFiles)) {
    await fs.promises.writeFile(path.join(fixture.tasksDirectory, name), text, { mode: 0o600 });
  }
  return commit;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
  );
});

describeLinux('descriptor-bound hosted task-board file source', () => {
  it('reads the admitted task snapshot without ambient path reads', async () => {
    const fixture = await createFixture();
    const result = await read(fixture);

    expect(result).toMatchObject({
      kind: 'found',
      teamId: TEAM_ID,
      items: [expect.objectContaining({ subject: 'Original task' })],
    });
  });

  it('opens task entries with nonblocking read flags before validating their type', async () => {
    const fixture = await createFixture();
    const originalOpen = fs.promises.open.bind(fs.promises);
    let taskFlags: number | undefined;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
      if (typeof target === 'string' && target.endsWith('/1.json') && typeof flags === 'number') {
        taskFlags = flags;
      }
      return originalOpen(target, flags, mode);
    });

    await read(fixture);

    expect(taskFlags).toBeDefined();
    expect(taskFlags! & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
  });

  it.each([
    ['claude root parent', 1, (fixture: TaskBoardReadFixture) => fixture.claudeRoot],
    ['teams parent', 2, (fixture: TaskBoardReadFixture) => fixture.teamsRoot],
    ['team identity leaf', 3, (fixture: TaskBoardReadFixture) => fixture.teamRoot],
    ['tasks parent', 4, (fixture: TaskBoardReadFixture) => fixture.tasksRoot],
    ['tasks leaf', 5, (fixture: TaskBoardReadFixture) => fixture.tasksDirectory],
  ] as const)('fails closed for a %s descriptor race', async (_name, sequence, targetFor) => {
    const fixture = await createFixture();
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hosted-task-board-outside-'));
    roots.push(outside);
    const restoration: { restore: (() => Promise<void>) | null } = { restore: null };
    openAfterDirectoryDescriptor(sequence, async () => {
      restoration.restore = await replaceDirectoryWithSymlink(targetFor(fixture), outside);
    });

    try {
      await expect(read(fixture)).resolves.toEqual({ kind: 'unavailable' });
    } finally {
      const restore = restoration.restore;
      if (restore !== null) await restore();
    }
  });

  it.each([
    ['claude root parent', 1, (fixture: TaskBoardReadFixture) => fixture.claudeRoot],
    ['teams parent', 2, (fixture: TaskBoardReadFixture) => fixture.teamsRoot],
    ['team identity leaf', 3, (fixture: TaskBoardReadFixture) => fixture.teamRoot],
    ['tasks parent', 4, (fixture: TaskBoardReadFixture) => fixture.tasksRoot],
    ['tasks leaf', 5, (fixture: TaskBoardReadFixture) => fixture.tasksDirectory],
  ] as const)(
    'does not follow a temporary replacement when the %s descriptor is swapped and restored',
    async (_name, sequence, targetFor) => {
      const fixture = await createFixture();
      openAfterDirectoryDescriptor(sequence, async () => {
        const directory = targetFor(fixture);
        const parked = `${directory}.parked`;
        await fs.promises.rename(directory, parked);
        await fs.promises.mkdir(directory);
        await fs.promises.writeFile(path.join(directory, 'attacker-marker'), 'outside', 'utf8');
        await fs.promises.rm(directory, { recursive: true, force: true });
        await fs.promises.rename(parked, directory);
      });

      const result = await read(fixture);

      expect(result).toMatchObject({
        kind: 'found',
        items: [expect.objectContaining({ subject: 'Original task' })],
      });
      expect(JSON.stringify(result)).not.toContain('attacker-marker');
    }
  );

  it.each(['file', 'symlink'] as const)(
    'fails closed when a task leaf is replaced by a %s after descriptor capture',
    async (replacement) => {
      const fixture = await createFixture();
      const outside = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'hosted-task-board-file-outside-')
      );
      roots.push(outside);
      const originalOpen = fs.promises.open.bind(fs.promises);
      let taskOpens = 0;
      const restoration: { restore: (() => Promise<void>) | null } = { restore: null };
      vi.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
        const handle = await originalOpen(target, flags, mode);
        if (typeof target === 'string' && target.endsWith('/1.json')) {
          taskOpens += 1;
          if (taskOpens === 1) {
            restoration.restore = await replaceTaskFile(fixture, replacement, outside);
          }
        }
        return handle;
      });

      try {
        await expect(read(fixture)).resolves.toEqual({ kind: 'unavailable' });
      } finally {
        const restore = restoration.restore;
        if (restore !== null) await restore();
      }
    }
  );

  it('reads the committed board an Owner task writer left behind', async () => {
    const fixture = await createFixture();
    const commit = await writeOwnerTaskBoardCommit(fixture);

    expect(await read(fixture)).toMatchObject({
      kind: 'found',
      items: expect.arrayContaining([
        expect.objectContaining({ subject: 'Original task' }),
        expect.objectContaining({ subject: 'Created by the Owner writer' }),
      ]),
    });

    // Product owns hosted-task-board-mutation.wal.v1.json; an Owner WAL under that name is unreadable.
    await fs.promises.rename(
      path.join(fixture.teamRoot, OWNER_TASK_MUTATION_WAL_FILE),
      path.join(fixture.teamRoot, 'hosted-task-board-mutation.wal.v1.json')
    );
    expect(await read(fixture)).toEqual({ kind: 'unavailable' });
    expect(Object.keys(commit.teamFiles)).toContain(OWNER_TASK_MUTATION_WAL_FILE);
  });

  it('resolves a task owner written as a member name or member ID to the active member', async () => {
    const fixture = await createFixture();
    const workerId = `member_${'1'.repeat(32)}`;
    const reviewerId = `member_${'2'.repeat(32)}`;
    await fs.promises.writeFile(
      path.join(fixture.teamRoot, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [
          { name: 'team-lead', agentType: 'team-lead', memberId: `member_${'3'.repeat(32)}` },
          { name: 'worker', agentType: 'general-purpose', memberId: workerId },
          { name: 'reviewer', agentType: 'general-purpose', memberId: reviewerId },
          { name: 'retired', agentType: 'general-purpose', removedAt: 1 },
        ],
      }),
      'utf8'
    );
    const task = (id: string, owner: string) =>
      fs.promises.writeFile(
        path.join(fixture.tasksDirectory, `${id}.json`),
        JSON.stringify({ id, subject: `Owned by ${owner}`, status: 'pending', owner }),
        'utf8'
      );
    await task('1', 'worker'); // agent task tools and desktop write the member name
    await task('2', reviewerId); // the hosted writer persists the member ID
    await task('3', 'retired');

    const result = await read(fixture);
    if (result.kind !== 'found') throw new Error(`expected a board, got ${result.kind}`);
    const owners = Object.fromEntries(result.items.map((item) => [item.subject, item.ownerId]));
    expect(owners).toEqual({
      'Owned by worker': workerId,
      [`Owned by ${reviewerId}`]: reviewerId,
      'Owned by retired': null,
    });
  });

  it('retries instead of reading a board while an Owner task commit is prepared', async () => {
    const fixture = await createFixture();
    await writeOwnerTaskBoardCommit(fixture);
    const ownerWal = path.join(fixture.teamRoot, OWNER_TASK_MUTATION_WAL_FILE);
    const terminal = JSON.parse(await fs.promises.readFile(ownerWal, 'utf8')) as Record<
      string,
      unknown
    >;
    const writeOwnerWal = (value: unknown) =>
      fs.promises.writeFile(ownerWal, JSON.stringify(value), { mode: 0o600 });

    await writeOwnerWal({ schemaVersion: terminal.schemaVersion, phase: 'prepared', intent: {} });
    expect(await read(fixture)).toEqual({ kind: 'unavailable', retryAfterMs: 250 });

    for (const invalid of [{ ...terminal, phase: 'committed' }, [], 'prepared']) {
      await writeOwnerWal(invalid);
      expect(await read(fixture)).toEqual({ kind: 'unavailable' });
    }

    await writeOwnerWal(terminal);
    expect(await read(fixture)).toMatchObject({ kind: 'found' });
  });

  it('does not return a board an Owner commit started preparing during the read', async () => {
    const created: { fixture?: TaskBoardReadFixture } = {};
    const fixture = await createFixture({
      beforeFinalWalRecheck: async () => {
        await fs.promises.writeFile(
          path.join(created.fixture!.teamRoot, OWNER_TASK_MUTATION_WAL_FILE),
          JSON.stringify({ schemaVersion: 3, phase: 'prepared', intent: {} }),
          { mode: 0o600 }
        );
      },
    });
    created.fixture = fixture;

    expect(await read(fixture)).toMatchObject({ kind: 'unavailable' });
  });

  it('converts an opaque identity-source failure into an uninformative unavailable result', async () => {
    const privateFailure = new Error('provider token from /private/workspace');
    const fixture = await createFixture({ identityError: privateFailure });
    const result = await read(fixture);

    expect(result).toEqual({ kind: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('provider');
    expect(JSON.stringify(result)).not.toContain('/private');
  });
});
