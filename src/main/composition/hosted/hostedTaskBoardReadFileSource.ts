import { isAbsolute, join, resolve } from 'node:path';

import {
  parseLegacyTeamKey,
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
// eslint-disable-next-line no-restricted-imports -- Task-board hosted exports are main-process-only.
import {
  type HostedTaskBoardAuthorityPort,
  type HostedTaskBoardAuthorityReadWindowRequest,
  type HostedTaskBoardAuthorityReadWindowResult,
  type HostedTaskBoardItem,
  type TaskId,
} from '@features/team-task-board/main/hosted';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import { type QueryContext, type TeamId } from '@shared/contracts/hosted';

import {
  closeHostedTaskBoardDirectories,
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  listHostedTaskBoardDirectoryNames,
  openHostedTaskBoardDirectory,
  readHostedTaskBoardFile,
  revalidateHostedTaskBoardDirectoryMembership,
  revalidateHostedTaskBoardSnapshots,
} from './hostedTaskBoardDescriptorFs';
import {
  hostedTaskBoardColumnFor,
  hostedTaskBoardDirectoryFingerprint,
  hostedTaskBoardOrderFor,
  hostedTaskBoardRevision,
  hostedTaskBoardSourceGeneration,
  hostedTaskBoardTaskId,
  parseHostedTaskBoardKanbanState,
} from './hostedTaskBoardKanbanState';
import { observeHostedTaskBoardMutationWal } from './hostedTaskBoardMutationTransaction';
import {
  assertHostedTaskBoardTeamIdentity,
  HostedTaskBoardRosterAuthority,
} from './hostedTaskBoardRosterAuthority';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

const MAX_TASK_FILES = 512;
const MAX_TASK_FILE_BYTES = 256 * 1024;
const MAX_TASK_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_KANBAN_STATE_BYTES = 512 * 1024;
const MAX_RELATIONSHIPS = 100;
const TASK_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;

interface TaskDescriptor {
  readonly fileName: string;
  readonly rawTaskId: string;
  readonly taskId: TaskId;
  readonly snapshot: HostedTaskBoardFileSnapshot;
}

interface RawTaskProjection extends TaskDescriptor {
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
  /** Narrow deterministic test seam for a WAL that appears after the initial read probe. */
  readonly onReadCheckpoint?: (point: 'before_final_wal_recheck') => void | Promise<void>;
  readonly reportReadDiagnostic?: (stage: string, code: string) => void;
}

function unavailable(): HostedTaskBoardAuthorityReadWindowResult {
  return Object.freeze({ kind: 'unavailable' });
}

function diagnosticCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const errno = Reflect.get(error, 'code');
    if (typeof errno === 'string' && /^[A-Z0-9_]{1,32}$/u.test(errno)) {
      return `errno-${errno.toLowerCase().replaceAll('_', '-')}`;
    }
  }
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9][a-z0-9-]{0,127}$/u.test(message) ? message : 'unknown';
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) {
    throw new TypeError('hosted-task-board-read-relationship-invalid');
  }
  const values = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) {
      throw new TypeError('hosted-task-board-read-relationship-invalid');
    }
    return entry;
  });
  if (new Set(values).size !== values.length) {
    throw new TypeError('hosted-task-board-read-relationship-invalid');
  }
  return Object.freeze(values);
}

function parseTask(
  snapshot: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>,
  descriptor: Omit<TaskDescriptor, 'snapshot'>
): RawTaskProjection | null {
  const value: unknown = JSON.parse(snapshot.text);
  if (!isRecord(value)) throw new TypeError('hosted-task-board-read-task-invalid');
  const metadata = value.metadata;
  if (isRecord(metadata) && metadata._internal === true) return null;
  const parsedId =
    typeof value.id === 'number' && Number.isSafeInteger(value.id) ? String(value.id) : value.id;
  if (
    parsedId !== descriptor.rawTaskId ||
    typeof value.subject !== 'string' ||
    value.subject.length < 1 ||
    value.subject.length > 200 ||
    value.subject.trim() !== value.subject ||
    (value.description !== undefined &&
      (typeof value.description !== 'string' || value.description.length > 20_000)) ||
    !['pending', 'in_progress', 'completed', 'deleted'].includes(value.status as string) ||
    (value.owner !== undefined &&
      (typeof value.owner !== 'string' || value.owner.length < 1 || value.owner.length > 128))
  ) {
    throw new TypeError('hosted-task-board-read-task-invalid');
  }
  return Object.freeze({
    ...descriptor,
    snapshot,
    subject: value.subject,
    description: typeof value.description === 'string' ? value.description : null,
    status: value.status as RawTaskProjection['status'],
    owner: typeof value.owner === 'string' ? value.owner : null,
    blockedBy: readStringList(value.blockedBy ?? []),
    blocks: readStringList(value.blocks ?? []),
    related: readStringList(value.related ?? []),
  });
}

function assertRelationships(tasks: readonly RawTaskProjection[]): void {
  const byRawId = new Map(tasks.map((task) => [task.rawTaskId, task]));
  for (const task of tasks) {
    for (const blockedBy of task.blockedBy) {
      const other = byRawId.get(blockedBy);
      if (blockedBy === task.rawTaskId || !other?.blocks.includes(task.rawTaskId)) {
        throw new TypeError('hosted-task-board-read-relationship-asymmetric');
      }
    }
    for (const blocks of task.blocks) {
      const other = byRawId.get(blocks);
      if (blocks === task.rawTaskId || !other?.blockedBy.includes(task.rawTaskId)) {
        throw new TypeError('hosted-task-board-read-relationship-asymmetric');
      }
    }
    for (const related of task.related) {
      const other = byRawId.get(related);
      if (related === task.rawTaskId || !other?.related.includes(task.rawTaskId)) {
        throw new TypeError('hosted-task-board-read-relationship-asymmetric');
      }
    }
  }
}

function projectTasks(
  teamId: TeamId,
  tasks: readonly RawTaskProjection[],
  kanban: ReturnType<typeof parseHostedTaskBoardKanbanState>,
  resolveOwner: (rawOwner: string) => HostedTaskBoardItem['ownerId']
): readonly HostedTaskBoardItem[] {
  assertRelationships(tasks);
  const active = tasks.filter((task) => task.status !== 'deleted');
  const activeIds = new Map(active.map((task) => [task.rawTaskId, task.taskId] as const));
  const fallbacks = new Map(
    [...active]
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map((task, index) => [task.rawTaskId, index] as const)
  );
  const items = active.map((task) => {
    const column = hostedTaskBoardColumnFor(
      kanban,
      task.rawTaskId,
      task.status as HostedTaskBoardItem['status']
    );
    const mapRelationships = (values: readonly string[]): readonly TaskId[] =>
      Object.freeze(
        values
          .map((rawTaskId) => activeIds.get(rawTaskId))
          .filter((taskId): taskId is TaskId => taskId !== undefined)
          .sort((left, right) => left.localeCompare(right))
      );
    return Object.freeze({
      teamId,
      taskId: task.taskId,
      subject: task.subject,
      description: task.description,
      status: task.status as HostedTaskBoardItem['status'],
      ownerId: task.owner === null ? null : resolveOwner(task.owner),
      column,
      order: hostedTaskBoardOrderFor(
        kanban,
        column,
        task.rawTaskId,
        fallbacks.get(task.rawTaskId) ?? 0
      ),
      blockedByTaskIds: mapRelationships(task.blockedBy),
      blocksTaskIds: mapRelationships(task.blocks),
      relatedTaskIds: mapRelationships(task.related),
    });
  });
  return Object.freeze(
    [...items].sort((left, right) => {
      const leftColumn = ['todo', 'in_progress', 'review', 'approved', 'done'].indexOf(left.column);
      const rightColumn = ['todo', 'in_progress', 'review', 'approved', 'done'].indexOf(
        right.column
      );
      if (leftColumn !== rightColumn) return leftColumn - rightColumn;
      if (left.order !== right.order) return left.order - right.order;
      return left.taskId.localeCompare(right.taskId);
    })
  );
}

/** Descriptor-bound, no-follow task source rooted only in one admitted hosted mount. */
export class DescriptorBoundHostedTaskBoardReadSource implements HostedTaskBoardAuthorityPort {
  private readonly runtimeInstance: RuntimeInstanceContext;
  private readonly claudeRoot: string;
  private readonly nowMs: () => number;
  private readonly rosterAuthority = new HostedTaskBoardRosterAuthority();
  private readonly observedBindings = new Map<
    TeamIdentityRecord['teamId'],
    NonNullable<TeamIdentityRecord['workspaceBinding']>
  >();

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
        !this.isCurrentWorkspaceBinding(identity)
      ) {
        return Object.freeze({ kind: 'not_found' });
      }
      return await this.readBoundWindow(identity, request, context);
    } catch (error) {
      this.dependencies.reportReadDiagnostic?.('source-read-exception', diagnosticCode(error));
      return unavailable();
    }
  }

  private isCurrentWorkspaceBinding(identity: TeamIdentityRecord): boolean {
    const binding = identity.workspaceBinding;
    if (binding === null) return false;
    const observed = this.observedBindings.get(identity.teamId);
    if (
      observed &&
      (binding.generation < observed.generation ||
        (binding.generation === observed.generation &&
          binding.workspaceId !== observed.workspaceId))
    ) {
      throw new TypeError('hosted-task-board-read-identity-binding-replayed');
    }
    this.observedBindings.set(identity.teamId, binding);
    // The identity generation versions the stable team-to-workspace binding. Mount generation is
    // a boot-scoped fence and legitimately advances when a trusted controller restarts.
    return binding.workspaceId === this.dependencies.mountBinding.workspaceId;
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

  private async readBoundWindow(
    identity: TeamIdentityRecord,
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityReadWindowResult> {
    const assertStillActive = (): void => this.assertActive(request, context);
    const legacyTeamName = parseLegacyTeamKey(identity.legacyKey);
    const directories: HostedTaskBoardDirectoryDescriptor[] = [];
    const bind = async (
      expectedPath: string,
      parent: HostedTaskBoardDirectoryDescriptor | null,
      name: string | null
    ): Promise<HostedTaskBoardDirectoryDescriptor> => {
      const directory = await openHostedTaskBoardDirectory(
        expectedPath,
        parent,
        name,
        assertStillActive
      );
      directories.push(directory);
      return directory;
    };
    try {
      const claudeRoot = await bind(this.claudeRoot, null, null);
      const teamsRoot = await bind(
        join(claudeRoot.identity.canonicalPath, 'teams'),
        claudeRoot,
        'teams'
      );
      const teamDirectory = await bind(
        join(teamsRoot.identity.canonicalPath, legacyTeamName),
        teamsRoot,
        legacyTeamName
      );
      if (
        hostedTaskBoardDirectoryFingerprint(teamDirectory.identity) !==
        identity.directoryFingerprint
      ) {
        throw new Error('hosted-task-board-read-team-fingerprint-mismatch');
      }
      const identityFile = await readHostedTaskBoardFile(
        teamDirectory,
        'team.identity.json',
        4 * 1024,
        {
          assertStillActive,
        }
      );
      if (!identityFile.exists) throw new Error('hosted-task-board-read-team-identity-missing');
      assertHostedTaskBoardTeamIdentity(identityFile.text, identity);

      const wal = await observeHostedTaskBoardMutationWal(teamDirectory, assertStillActive);
      if (wal.handle !== null && wal.handle.wal.phase !== 'terminal') return unavailable();

      const tasksRoot = await bind(
        join(claudeRoot.identity.canonicalPath, 'tasks'),
        claudeRoot,
        'tasks'
      );
      const tasksDirectory = await bind(
        join(tasksRoot.identity.canonicalPath, legacyTeamName),
        tasksRoot,
        legacyTeamName
      );
      const sourceGeneration = hostedTaskBoardSourceGeneration({
        deploymentId: this.runtimeInstance.deploymentId,
        bootId: this.runtimeInstance.bootId,
        workspaceId: this.dependencies.mountBinding.workspaceId,
        mountGeneration: this.dependencies.mountBinding.mountGeneration,
        teamId: request.teamId,
        teamDirectory,
        tasksDirectory,
      });
      if (
        request.expectedSourceGeneration !== null &&
        request.expectedSourceGeneration !== sourceGeneration
      ) {
        return Object.freeze({
          kind: 'stale_generation',
          currentSourceGeneration: sourceGeneration,
        });
      }

      const names = await listHostedTaskBoardDirectoryNames(
        tasksDirectory,
        MAX_TASK_FILES,
        assertStillActive
      );
      const descriptors: TaskDescriptor[] = [];
      let totalBytes = 0;
      for (const fileName of names) {
        const matched = TASK_FILE.exec(fileName);
        if (matched === null) continue;
        const snapshot = await readHostedTaskBoardFile(
          tasksDirectory,
          fileName,
          MAX_TASK_FILE_BYTES,
          {
            assertStillActive,
          }
        );
        if (!snapshot.exists) throw new Error('hosted-task-board-read-task-raced');
        totalBytes += Number(snapshot.stamp.size);
        if (totalBytes > MAX_TASK_SNAPSHOT_BYTES) {
          throw new Error('hosted-task-board-read-source-budget-exceeded');
        }
        descriptors.push(
          Object.freeze({
            fileName,
            rawTaskId: matched[1],
            taskId: hostedTaskBoardTaskId(request.teamId, matched[1]),
            snapshot,
          })
        );
      }
      if (new Set(descriptors.map((descriptor) => descriptor.taskId)).size !== descriptors.length) {
        throw new Error('hosted-task-board-read-task-id-collision');
      }
      const kanbanFile = await readHostedTaskBoardFile(
        teamDirectory,
        'kanban-state.json',
        MAX_KANBAN_STATE_BYTES,
        { optional: true, assertStillActive }
      );
      const rawTasks = descriptors
        .map((descriptor) =>
          parseTask(
            descriptor.snapshot as Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>,
            descriptor
          )
        )
        .filter((task): task is RawTaskProjection => task !== null);
      const kanban = parseHostedTaskBoardKanbanState(
        kanbanFile.exists ? kanbanFile.text : null,
        new Set(rawTasks.map((task) => task.rawTaskId))
      );
      const roster = await this.rosterAuthority.readActiveRoster(
        teamDirectory,
        identity,
        assertStillActive
      );
      const activeOwnerIds = new Map(
        [...roster.activeMembers.entries()].map(
          ([memberId, rawName]) => [rawName, memberId] as const
        )
      );
      const allSnapshots = [
        identityFile,
        ...descriptors.map((descriptor) => descriptor.snapshot),
        kanbanFile,
        ...roster.files,
        wal.snapshot,
      ];
      const items = projectTasks(
        request.teamId,
        rawTasks,
        kanban,
        (rawOwner) => activeOwnerIds.get(rawOwner) ?? null
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
      const revision = hostedTaskBoardRevision({
        sourceGeneration,
        taskFiles: descriptors.map((descriptor) => ({
          name: descriptor.fileName,
          snapshot: descriptor.snapshot,
        })),
        kanban: kanbanFile,
        roster: roster.files.filter((file) => file.name !== 'team.identity.json'),
      });
      await revalidateHostedTaskBoardDirectoryMembership(
        tasksDirectory,
        names,
        MAX_TASK_FILES,
        assertStillActive
      );
      // This final revalidation includes an absent WAL snapshot. A WAL that appears after the
      // first probe cannot therefore race a complete read into serving a partial transaction.
      await this.dependencies.onReadCheckpoint?.('before_final_wal_recheck');
      await revalidateHostedTaskBoardSnapshots(directories, allSnapshots, assertStillActive);
      return Object.freeze({
        kind: 'found',
        teamId: request.teamId,
        sourceGeneration,
        revision,
        items: Object.freeze(window),
        hasMore,
        truncatedBy: hasMore ? ('item_budget' as const) : null,
        degradedReasons: Object.freeze([]),
      });
    } finally {
      await closeHostedTaskBoardDirectories(directories).catch(() => undefined);
    }
  }
}
