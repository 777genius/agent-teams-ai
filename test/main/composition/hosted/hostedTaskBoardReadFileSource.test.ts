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
  options: { readonly identityError?: Error } = {}
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

  it('converts an opaque identity-source failure into an uninformative unavailable result', async () => {
    const privateFailure = new Error('provider token from /private/workspace');
    const fixture = await createFixture({ identityError: privateFailure });
    const result = await read(fixture);

    expect(result).toEqual({ kind: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('provider');
    expect(JSON.stringify(result)).not.toContain('/private');
  });
});
