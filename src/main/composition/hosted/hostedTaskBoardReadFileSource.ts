import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  parseLegacyTeamKey,
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  type HostedTaskBoardAuthorityPort,
  type HostedTaskBoardAuthorityReadWindowRequest,
  type HostedTaskBoardAuthorityReadWindowResult,
  type HostedTaskBoardItem,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
  type TaskId,
} from '@features/team-task-board/main';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import {
  parseMemberId,
  parseRevision,
  type QueryContext,
  type TeamId,
} from '@shared/contracts/hosted';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

const MAX_TASK_FILES = 512;
const MAX_TASK_FILE_BYTES = 256 * 1024;
const MAX_TASK_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 4 * 1024;
const MAX_RELATIONSHIPS = 100;
const NO_FOLLOW = fs.constants.O_NOFOLLOW;
const DIRECTORY = fs.constants.O_DIRECTORY;
const DESCRIPTOR_ROOT = '/proc/self/fd';
const TASK_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;

interface DirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface DirectoryDescriptor {
  readonly handle: fs.promises.FileHandle;
  readonly identity: DirectoryIdentity;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface TaskDescriptor {
  readonly fileName: string;
  readonly rawTaskId: string;
  readonly taskId: TaskId;
  readonly identity: FileIdentity;
}

interface RawTaskProjection {
  readonly descriptor: TaskDescriptor;
  readonly subject: string;
  readonly description: string | null;
  readonly status: HostedTaskBoardItem['status'] | 'deleted';
  readonly owner: string | null;
  readonly blockedBy: readonly string[];
  readonly blocks: readonly string[];
  readonly related: readonly string[];
}

export interface HostedTaskBoardReadFileSourceDependencies {
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly nowMs?: () => number;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function unavailable(): HostedTaskBoardAuthorityReadWindowResult {
  return Object.freeze({ kind: 'unavailable' });
}

function directoryIdentity(path: string, stat: fs.BigIntStats): DirectoryIdentity {
  return Object.freeze({ canonicalPath: path, device: stat.dev, inode: stat.ino });
}

function fileIdentity(stat: fs.BigIntStats): FileIdentity {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function noFollowReadFlags(): number {
  if (!Number.isSafeInteger(NO_FOLLOW) || NO_FOLLOW <= 0) {
    throw new Error('hosted-task-board-read-no-follow-unavailable');
  }
  return fs.constants.O_RDONLY | NO_FOLLOW;
}

function noFollowDirectoryFlags(): number {
  if (
    !Number.isSafeInteger(NO_FOLLOW) ||
    NO_FOLLOW <= 0 ||
    !Number.isSafeInteger(DIRECTORY) ||
    DIRECTORY <= 0
  ) {
    throw new Error('hosted-task-board-read-no-follow-unavailable');
  }
  return fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY;
}

function descriptorPath(handle: fs.promises.FileHandle): string {
  if (!Number.isSafeInteger(handle.fd) || handle.fd < 0) {
    throw new Error('hosted-task-board-read-directory-descriptor-invalid');
  }
  return join(DESCRIPTOR_ROOT, String(handle.fd));
}

function descriptorChildPath(parent: DirectoryDescriptor, name: string): string {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new Error('hosted-task-board-read-directory-child-invalid');
  }
  return join(descriptorPath(parent.handle), name);
}

async function closeDirectories(
  directories: readonly DirectoryDescriptor[],
  assertActive: () => void
): Promise<void> {
  let failure: unknown;
  for (const directory of [...directories].reverse()) {
    try {
      await directory.handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    assertActive();
  } catch (error) {
    failure ??= error;
  }
  if (failure === undefined) return;
  if (failure instanceof Error) throw failure;
  throw new Error('hosted-task-board-read-directory-close-failed', { cause: failure });
}

function taskId(teamId: string, rawTaskId: string): TaskId {
  return parseHostedTaskId(
    `task_${digest({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId }).slice(0, 32)}`
  );
}

function memberId(teamId: string, rawMemberName: string) {
  return parseMemberId(
    `member_${digest({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName }).slice(0, 32)}`
  );
}

function readStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) {
    throw new TypeError('hosted-task-board-read-relationship-invalid');
  }
  const result = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) {
      throw new TypeError('hosted-task-board-read-relationship-invalid');
    }
    return entry;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError('hosted-task-board-read-relationship-invalid');
  }
  return Object.freeze(result);
}

function parseTask(serialized: string, descriptor: TaskDescriptor): RawTaskProjection | null {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-task-board-read-task-invalid');
  }
  const record = value as Record<PropertyKey, unknown>;
  const metadata = record.metadata;
  if (
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as Record<PropertyKey, unknown>)._internal === true
  ) {
    return null;
  }
  const parsedId =
    typeof record.id === 'number' && Number.isSafeInteger(record.id)
      ? String(record.id)
      : record.id;
  const subject = record.subject;
  const description = record.description;
  const status = record.status;
  const owner = record.owner;
  if (
    parsedId !== descriptor.rawTaskId ||
    typeof subject !== 'string' ||
    subject.length < 1 ||
    subject.length > 200 ||
    subject.trim() !== subject ||
    (description !== undefined &&
      (typeof description !== 'string' || description.length > 20_000)) ||
    !['pending', 'in_progress', 'completed', 'deleted'].includes(status as string) ||
    (owner !== undefined && (typeof owner !== 'string' || owner.length < 1 || owner.length > 128))
  ) {
    throw new TypeError('hosted-task-board-read-task-invalid');
  }
  return Object.freeze({
    descriptor,
    subject,
    description: typeof description === 'string' ? description : null,
    status: status as RawTaskProjection['status'],
    owner: typeof owner === 'string' ? owner : null,
    blockedBy: readStringList(record.blockedBy ?? []),
    blocks: readStringList(record.blocks ?? []),
    related: readStringList(record.related ?? []),
  });
}

function assertRelationships(tasks: readonly RawTaskProjection[]): void {
  const byRawId = new Map(tasks.map((task) => [task.descriptor.rawTaskId, task]));
  for (const task of tasks) {
    const self = task.descriptor.rawTaskId;
    for (const blockedBy of task.blockedBy) {
      const other = byRawId.get(blockedBy);
      if (blockedBy === self || !other?.blocks.includes(self)) {
        throw new TypeError('hosted-task-board-read-relationship-asymmetric');
      }
    }
    for (const blocks of task.blocks) {
      const other = byRawId.get(blocks);
      if (blocks === self || !other?.blockedBy.includes(self)) {
        throw new TypeError('hosted-task-board-read-relationship-asymmetric');
      }
    }
    for (const related of task.related) {
      const other = byRawId.get(related);
      if (related === self || !other?.related.includes(self)) {
        throw new TypeError('hosted-task-board-read-relationship-asymmetric');
      }
    }
  }
}

function projectTasks(
  teamId: TeamId,
  tasks: readonly RawTaskProjection[]
): readonly HostedTaskBoardItem[] {
  assertRelationships(tasks);
  const active = tasks.filter((task) => task.status !== 'deleted');
  const activeIds = new Map(
    active.map((task) => [task.descriptor.rawTaskId, task.descriptor.taskId] as const)
  );
  return Object.freeze(
    active.map((task, order) => {
      const mapRelationships = (values: readonly string[]): readonly TaskId[] =>
        Object.freeze(
          values
            .map((value) => activeIds.get(value))
            .filter((value): value is TaskId => value !== undefined)
            .sort()
        );
      const column: HostedTaskBoardItem['column'] =
        task.status === 'pending' ? 'todo' : task.status === 'in_progress' ? 'in_progress' : 'done';
      return Object.freeze({
        teamId,
        taskId: task.descriptor.taskId,
        subject: task.subject,
        description: task.description,
        status: task.status as HostedTaskBoardItem['status'],
        ownerId: task.owner === null ? null : memberId(teamId, task.owner),
        column,
        order,
        blockedByTaskIds: mapRelationships(task.blockedBy),
        blocksTaskIds: mapRelationships(task.blocks),
        relatedTaskIds: mapRelationships(task.related),
      });
    })
  );
}

function canonicalIdentityFingerprint(path: string, directory: DirectoryIdentity): string {
  return digest({
    schemaVersion: 1,
    canonicalPath: path,
    device: directory.device.toString(),
    inode: directory.inode.toString(),
  });
}

function assertCanonicalIdentity(serialized: string, expected: TeamIdentityRecord): void {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-task-board-read-team-identity-invalid');
  }
  const record = value as Record<PropertyKey, unknown>;
  const expectedKeys =
    record.originDeploymentId === undefined
      ? ['createdAt', 'schemaVersion', 'teamId']
      : ['createdAt', 'originDeploymentId', 'schemaVersion', 'teamId'];
  const keys = Reflect.ownKeys(record).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    record.schemaVersion !== 1 ||
    record.teamId !== expected.teamId ||
    record.createdAt !== expected.createdAt ||
    expected.identityChecksum === null ||
    digestText(serialized) !== expected.identityChecksum
  ) {
    throw new TypeError('hosted-task-board-read-team-identity-invalid');
  }
  const canonical = {
    schemaVersion: 1,
    teamId: expected.teamId,
    createdAt: expected.createdAt,
    ...(record.originDeploymentId === undefined
      ? {}
      : { originDeploymentId: record.originDeploymentId }),
  };
  if (`${JSON.stringify(canonical, null, 2)}\n` !== serialized) {
    throw new TypeError('hosted-task-board-read-team-identity-invalid');
  }
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Descriptor-bound, no-follow task source rooted only in one admitted hosted mount. */
export class DescriptorBoundHostedTaskBoardReadSource implements HostedTaskBoardAuthorityPort {
  private readonly runtimeInstance: RuntimeInstanceContext;
  private readonly claudeRoot: string;
  private readonly nowMs: () => number;

  constructor(private readonly dependencies: HostedTaskBoardReadFileSourceDependencies) {
    this.runtimeInstance = createRuntimeInstanceContext(dependencies.runtimeInstance);
    if (!(dependencies.mountBinding instanceof WorkspaceMountBinding)) {
      throw new TypeError('hosted-task-board-read-mount-binding-invalid');
    }
    if (
      dependencies.mountBinding.health === 'unavailable' ||
      dependencies.mountBinding.bootId !== this.runtimeInstance.bootId
    ) {
      throw new TypeError('hosted-task-board-read-mount-binding-invalid');
    }
    this.claudeRoot = this.runtimeInstance.claudeRoot.reference as string;
    if (
      !isAbsolute(this.claudeRoot) ||
      resolve(this.claudeRoot) !== this.claudeRoot ||
      this.claudeRoot === resolve(this.claudeRoot, '/')
    ) {
      throw new TypeError('hosted-task-board-read-claude-root-invalid');
    }
    this.nowMs = dependencies.nowMs ?? Date.now;
  }

  async readWindow(
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityReadWindowResult> {
    try {
      this.assertActive(request, context);
      const identityValue = await this.dependencies.teamIdentities.getTeamIdentity(request.teamId);
      this.assertActive(request, context);
      if (identityValue === null) return Object.freeze({ kind: 'not_found' });
      const identity = parseTeamIdentityRecord(identityValue);
      const binding = identity.workspaceBinding;
      if (
        identity.state !== 'active' ||
        binding === null ||
        binding.workspaceId !== this.dependencies.mountBinding.workspaceId ||
        binding.generation !== this.dependencies.mountBinding.mountGeneration
      ) {
        return Object.freeze({ kind: 'not_found' });
      }
      return await this.readBoundWindow(identity, request, context);
    } catch {
      return unavailable();
    }
  }

  private assertActive(
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): void {
    const now = this.nowMs();
    if (
      context.deploymentId !== this.runtimeInstance.deploymentId ||
      context.bootId !== this.runtimeInstance.bootId ||
      context.signal.aborted ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now >= context.deadlineAtMs ||
      now >= request.deadlineAtMs
    ) {
      throw new Error('hosted-task-board-read-context-inactive');
    }
  }

  private async readDirectory(
    expectedPath: string,
    parent: DirectoryDescriptor | null,
    name: string | null,
    assertActive: () => void
  ): Promise<DirectoryDescriptor> {
    assertActive();
    let target: string;
    if (parent === null) {
      if (name !== null) throw new Error('hosted-task-board-read-directory-child-invalid');
      target = expectedPath;
    } else {
      if (name === null) throw new Error('hosted-task-board-read-directory-child-invalid');
      target = descriptorChildPath(parent, name);
    }
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(target, noFollowDirectoryFlags());
      assertActive();
      const stat = await handle.stat({ bigint: true });
      assertActive();
      // The proc descriptor view names the inode already opened by the kernel.  It is deliberately
      // used only to verify the initial canonical identity; all descendants are opened relative to
      // this descriptor so a later same-name directory swap cannot redirect this read.
      const canonicalPath = await fs.promises.realpath(descriptorPath(handle));
      assertActive();
      if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalPath !== expectedPath) {
        throw new Error('hosted-task-board-read-directory-invalid');
      }
      const descriptor = Object.freeze({
        handle,
        identity: directoryIdentity(canonicalPath, stat),
      });
      handle = null;
      return descriptor;
    } finally {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
        assertActive();
      }
    }
  }

  private async openFile(
    parent: DirectoryDescriptor,
    name: string,
    assertActive: () => void
  ): Promise<fs.promises.FileHandle> {
    assertActive();
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(descriptorChildPath(parent, name), noFollowReadFlags());
      assertActive();
      const result = handle;
      handle = null;
      return result;
    } finally {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
        assertActive();
      }
    }
  }

  private async fileIdentityAt(
    parent: DirectoryDescriptor,
    name: string,
    maximumBytes: number,
    assertActive: () => void
  ): Promise<FileIdentity> {
    const handle = await this.openFile(parent, name, assertActive);
    try {
      const stat = await handle.stat({ bigint: true });
      assertActive();
      const identity = fileIdentity(stat);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        identity.size < 1n ||
        identity.size > BigInt(maximumBytes)
      ) {
        throw new Error('hosted-task-board-read-task-file-invalid');
      }
      return identity;
    } finally {
      await handle.close();
      assertActive();
    }
  }

  private async stableFileText(
    parent: DirectoryDescriptor,
    name: string,
    maximumBytes: number,
    expected: FileIdentity | null,
    assertActive: () => void
  ): Promise<{ readonly text: string; readonly identity: FileIdentity }> {
    const handle = await this.openFile(parent, name, assertActive);
    try {
      const openedStat = await handle.stat({ bigint: true });
      assertActive();
      const opened = fileIdentity(openedStat);
      if (
        !openedStat.isFile() ||
        openedStat.isSymbolicLink() ||
        opened.size < 1n ||
        opened.size > BigInt(maximumBytes) ||
        (expected !== null && !sameFile(opened, expected))
      ) {
        throw new Error('hosted-task-board-read-file-invalid');
      }
      const buffer = Buffer.allocUnsafe(maximumBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        assertActive();
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        assertActive();
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = fileIdentity(await handle.stat({ bigint: true }));
      assertActive();
      if (offset > maximumBytes || BigInt(offset) !== after.size || !sameFile(opened, after)) {
        throw new Error('hosted-task-board-read-file-changed');
      }
      return Object.freeze({ text: buffer.subarray(0, offset).toString('utf8'), identity: after });
    } finally {
      await handle.close();
      assertActive();
    }
  }

  private async taskDescriptors(
    tasksDirectory: DirectoryDescriptor,
    teamId: string,
    assertActive: () => void
  ): Promise<readonly TaskDescriptor[]> {
    const directory = await fs.promises.opendir(descriptorPath(tasksDirectory.handle));
    const names: string[] = [];
    try {
      for await (const entry of directory) {
        assertActive();
        if (!TASK_FILE.test(entry.name)) continue;
        if (!entry.isFile()) throw new Error('hosted-task-board-read-task-entry-invalid');
        names.push(entry.name);
        if (names.length > MAX_TASK_FILES) {
          throw new Error('hosted-task-board-read-source-budget-exceeded');
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
      assertActive();
    }
    names.sort();
    const descriptors: TaskDescriptor[] = [];
    let totalBytes = 0;
    for (const fileName of names) {
      const match = TASK_FILE.exec(fileName);
      if (!match) throw new Error('hosted-task-board-read-task-name-invalid');
      const rawTaskId = match[1];
      const identity = await this.fileIdentityAt(
        tasksDirectory,
        fileName,
        MAX_TASK_FILE_BYTES,
        assertActive
      );
      totalBytes += Number(identity.size);
      if (totalBytes > MAX_TASK_SNAPSHOT_BYTES) {
        throw new Error('hosted-task-board-read-source-budget-exceeded');
      }
      descriptors.push(
        Object.freeze({ fileName, rawTaskId, taskId: taskId(teamId, rawTaskId), identity })
      );
    }
    if (new Set(descriptors.map((descriptor) => descriptor.taskId)).size !== descriptors.length) {
      throw new Error('hosted-task-board-read-task-id-collision');
    }
    return Object.freeze(
      descriptors.sort((left, right) => left.taskId.localeCompare(right.taskId))
    );
  }

  private async readBoundWindow(
    identity: TeamIdentityRecord,
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityReadWindowResult> {
    const assertActive = (): void => this.assertActive(request, context);
    const legacyTeamName = parseLegacyTeamKey(identity.legacyKey);
    const directories: DirectoryDescriptor[] = [];
    const bindDirectory = async (
      expectedPath: string,
      parent: DirectoryDescriptor | null,
      name: string | null
    ): Promise<DirectoryDescriptor> => {
      const descriptor = await this.readDirectory(expectedPath, parent, name, assertActive);
      directories.push(descriptor);
      return descriptor;
    };
    try {
      const claudeRoot = await bindDirectory(this.claudeRoot, null, null);
      const teamsRoot = await bindDirectory(
        join(claudeRoot.identity.canonicalPath, 'teams'),
        claudeRoot,
        'teams'
      );
      const teamRoot = await bindDirectory(
        join(teamsRoot.identity.canonicalPath, legacyTeamName),
        teamsRoot,
        legacyTeamName
      );
      if (
        canonicalIdentityFingerprint(teamRoot.identity.canonicalPath, teamRoot.identity) !==
        identity.directoryFingerprint
      ) {
        throw new Error('hosted-task-board-read-team-fingerprint-mismatch');
      }
      const identityRead = await this.stableFileText(
        teamRoot,
        'team.identity.json',
        MAX_IDENTITY_BYTES,
        null,
        assertActive
      );
      assertCanonicalIdentity(identityRead.text, identity);

      const tasksRoot = await bindDirectory(
        join(claudeRoot.identity.canonicalPath, 'tasks'),
        claudeRoot,
        'tasks'
      );
      const tasksDirectory = await bindDirectory(
        join(tasksRoot.identity.canonicalPath, legacyTeamName),
        tasksRoot,
        legacyTeamName
      );
      const descriptors = await this.taskDescriptors(tasksDirectory, request.teamId, assertActive);
      const sourceGeneration = parseHostedTaskBoardSourceGeneration(
        `generation_${digest({
          domain: 'hosted-task-board-source/v1',
          deploymentId: this.runtimeInstance.deploymentId,
          bootId: this.runtimeInstance.bootId,
          workspaceId: this.dependencies.mountBinding.workspaceId,
          mountGeneration: this.dependencies.mountBinding.mountGeneration,
          teamId: request.teamId,
          teamRoot: [teamRoot.identity.device.toString(), teamRoot.identity.inode.toString()],
          tasksDirectory: [
            tasksDirectory.identity.device.toString(),
            tasksDirectory.identity.inode.toString(),
          ],
          files: descriptors.map((descriptor) => [
            descriptor.fileName,
            descriptor.identity.device.toString(),
            descriptor.identity.inode.toString(),
            descriptor.identity.size.toString(),
            descriptor.identity.mtimeNs.toString(),
            descriptor.identity.ctimeNs.toString(),
          ]),
        })}`
      );
      if (
        request.expectedSourceGeneration !== null &&
        request.expectedSourceGeneration !== sourceGeneration
      ) {
        return Object.freeze({
          kind: 'stale_generation',
          currentSourceGeneration: sourceGeneration,
        });
      }

      const rawTasks: RawTaskProjection[] = [];
      for (const descriptor of descriptors) {
        const read = await this.stableFileText(
          tasksDirectory,
          descriptor.fileName,
          MAX_TASK_FILE_BYTES,
          descriptor.identity,
          assertActive
        );
        const task = parseTask(read.text, descriptor);
        if (task) rawTasks.push(task);
      }
      const items = [...projectTasks(request.teamId, rawTasks)].sort((left, right) =>
        left.taskId.localeCompare(right.taskId)
      );
      const afterIndex =
        request.afterTaskId === null
          ? -1
          : items.findIndex((item) => item.taskId === request.afterTaskId);
      if (request.afterTaskId !== null && afterIndex < 0) {
        throw new Error('hosted-task-board-read-cursor-not-found');
      }
      const window = items.slice(afterIndex + 1, afterIndex + 1 + request.itemLimit);
      const hasMore = afterIndex + 1 + window.length < items.length;
      return Object.freeze({
        kind: 'found',
        teamId: request.teamId,
        sourceGeneration,
        revision: parseRevision(`revision_${digest({ sourceGeneration })}`),
        items: Object.freeze(window),
        hasMore,
        truncatedBy: hasMore ? ('item_budget' as const) : null,
        degradedReasons: Object.freeze([]),
      });
    } finally {
      await closeDirectories(directories, assertActive);
    }
  }
}
