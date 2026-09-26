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
  type HostedTaskBoardColumn,
  type HostedTaskBoardItem,
  parseHostedTaskId,
  type TaskId,
} from '@features/team-task-board/main/hosted';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import { type QueryContext, type TeamId } from '@shared/contracts/hosted';
import * as agentTeamsControllerModule from 'agent-teams-controller';

import { readHostedTaskBoardFiles } from './hostedTaskBoardFiles';
import {
  closeHostedTaskBoardDirectories,
  type HostedTaskBoardDirectoryDescriptor,
  openHostedTaskBoardDirectory,
  readHostedTaskBoardFile,
  revalidateHostedTaskBoardDirectoryMembership,
  revalidateHostedTaskBoardSnapshots,
} from './hostedTaskBoardDescriptorFs';
import {
  hostedTaskBoardDirectoryFingerprint,
  hostedTaskBoardRevisionForContents,
  hostedTaskBoardSourceGeneration,
  hostedTaskBoardTaskId,
  parseHostedTaskBoardKanbanRecord,
} from './hostedTaskBoardKanbanState';
import {
  assertHostedTaskBoardTeamIdentity,
  HostedTaskBoardRosterAuthority,
} from './hostedTaskBoardRosterAuthority';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

const MAX_TASK_FILES = 512;
const MAX_TASK_FILE_BYTES = 256 * 1024;
const MAX_TASK_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_KANBAN_STATE_BYTES = 512 * 1024;
// The hosted task command snapshots the same task and roster files for the revision it checks.
const { HOSTED_REVISION_ROSTER_FILES, HOSTED_TASK_FILE_PATTERN: TASK_FILE } =
  agentTeamsControllerModule.hostedBoardIdentity;
const { HOSTED_BOARD_COLUMNS, hostedBoardColumnFor, hostedBoardColumnOrder, hostedBoardTasks } =
  agentTeamsControllerModule.hostedBoardProjection;

interface TaskDescriptor {
  readonly fileName: string;
  readonly rawTaskId: string;
  readonly taskId: TaskId;
  readonly text: string;
}

export interface HostedTaskBoardReadFileSourceDependencies {
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly nowMs?: () => number;
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

/**
 * The board as desktop shows it: the controller projection decides visibility, relationships,
 * column and in-column order, so the browser reads what the hosted task command writes against.
 */
function projectTasks(
  teamId: TeamId,
  taskFiles: readonly TaskDescriptor[],
  kanban: Record<string, unknown>,
  resolveOwner: (rawOwner: string) => HostedTaskBoardItem['ownerId']
): readonly HostedTaskBoardItem[] {
  const tasks = [
    ...hostedBoardTasks(
      teamId,
      taskFiles.map((file) => ({ name: file.fileName, text: file.text }))
    ).values(),
  ];
  const visibleIds = new Map(tasks.map((task) => [task.rawId, parseHostedTaskId(task.publicId)]));
  const orders = new Map<string, number>();
  for (const column of HOSTED_BOARD_COLUMNS) {
    hostedBoardColumnOrder(kanban, column, tasks).forEach((rawId, index) =>
      orders.set(rawId, index)
    );
  }
  const mapRelationships = (values: readonly string[]): readonly TaskId[] =>
    Object.freeze(
      values
        .map((rawTaskId) => visibleIds.get(rawTaskId))
        .filter((taskId): taskId is TaskId => taskId !== undefined)
        .sort((left, right) => left.localeCompare(right))
    );
  const items = tasks.map((task) =>
    Object.freeze({
      teamId,
      taskId: visibleIds.get(task.rawId)!,
      subject: task.subject,
      // The hosted task command clears a description as desktop does, to an empty string.
      description: task.description === '' ? null : task.description,
      status: task.status,
      ownerId: task.owner === null ? null : resolveOwner(task.owner),
      column: hostedBoardColumnFor(kanban, task.rawId, task.status) as HostedTaskBoardColumn,
      order: orders.get(task.rawId) ?? 0,
      blockedByTaskIds: mapRelationships(task.blockedBy),
      blocksTaskIds: mapRelationships(task.blocks),
      relatedTaskIds: mapRelationships(task.related),
    })
  );
  return Object.freeze(
    [...items].sort((left, right) => {
      const leftColumn = HOSTED_BOARD_COLUMNS.indexOf(left.column);
      const rightColumn = HOSTED_BOARD_COLUMNS.indexOf(right.column);
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

      const files = await readHostedTaskBoardFiles({
        teamDirectory,
        tasksDirectory,
        taskFilePattern: TASK_FILE,
        maxTaskFiles: MAX_TASK_FILES,
        maxTaskFileBytes: MAX_TASK_FILE_BYTES,
        maxTaskSnapshotBytes: MAX_TASK_SNAPSHOT_BYTES,
        maxKanbanBytes: MAX_KANBAN_STATE_BYTES,
        assertStillActive,
      });
      const descriptors: TaskDescriptor[] = files.taskFiles.map((file) =>
        Object.freeze({ ...file, taskId: hostedTaskBoardTaskId(request.teamId, file.rawTaskId) })
      );
      if (new Set(descriptors.map((descriptor) => descriptor.taskId)).size !== descriptors.length) {
        throw new Error('hosted-task-board-read-task-id-collision');
      }
      const kanban = parseHostedTaskBoardKanbanRecord(files.kanbanText);
      const roster = await this.rosterAuthority.readActiveRoster(
        teamDirectory,
        identity,
        assertStillActive
      );
      const allSnapshots = [identityFile, ...files.observed, ...roster.files];
      const items = projectTasks(
        request.teamId,
        descriptors,
        kanban,
        (rawOwner) => roster.ownerAliases.get(rawOwner) ?? null
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
      const revision = hostedTaskBoardRevisionForContents({
        sourceGeneration,
        taskFiles: descriptors.map((descriptor) => ({
          name: descriptor.fileName,
          text: descriptor.text,
        })),
        kanbanText: files.kanbanText,
        rosterFiles: roster.files
          .filter((file) => HOSTED_REVISION_ROSTER_FILES.includes(file.name))
          .map((file) => ({ name: file.name, text: file.exists ? file.text : null })),
      });
      await revalidateHostedTaskBoardDirectoryMembership(
        tasksDirectory,
        files.listedTaskNames,
        files.listingBudget,
        assertStillActive
      );
      // Every file the page depends on must be unchanged at the end, so a board written while it
      // was read comes back unavailable and the browser reads it again.
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
