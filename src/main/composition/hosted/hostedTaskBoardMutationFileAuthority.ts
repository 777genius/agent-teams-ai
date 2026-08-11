import { isAbsolute, join, resolve } from 'node:path';

import {
  parseLegacyTeamKey,
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
// eslint-disable-next-line no-restricted-imports -- Hosted task-board authority is main-process-only.
import {
  type HostedTaskBoardAuthorityMutationRequest,
  type HostedTaskBoardAuthorityMutationResult,
  type HostedTaskBoardAuthorityPort,
  type HostedTaskBoardAuthorityReadWindowRequest,
  type HostedTaskBoardAuthorityReadWindowResult,
  type HostedTaskBoardSourceGeneration,
  type HostedTaskMutationCommand,
  type HostedTaskMutationCommittedReceipt,
  type TaskId,
} from '@features/team-task-board/main/hosted';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import { type QueryContext, type Revision, type TeamId } from '@shared/contracts/hosted';

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
  calculateHostedTaskBoardMutationPostimages,
  hostedTaskBoardDirectoryFingerprint,
  type HostedTaskBoardKanbanState,
  type HostedTaskBoardMutationPostimages,
  HostedTaskBoardMutationRelationshipConflictError,
  HostedTaskBoardMutationStateConflictError,
  type HostedTaskBoardMutationTaskDocument,
  HostedTaskBoardMutationTaskNotFoundError,
  hostedTaskBoardRevisionForContents,
  hostedTaskBoardSourceGeneration,
  hostedTaskBoardTaskId,
  parseHostedTaskBoardKanbanState,
} from './hostedTaskBoardKanbanState';
import {
  HOSTED_TASK_BOARD_MUTATION_LEDGER_FILE,
  HOSTED_TASK_BOARD_MUTATION_MAX_LEDGER_BYTES,
  HostedTaskBoardMutationFence,
  type HostedTaskBoardMutationLedger,
  type HostedTaskBoardMutationLedgerEntry,
  hostedTaskBoardMutationLedgerKey,
  parseHostedTaskBoardMutationLedger,
  serializeHostedTaskBoardMutationLedger,
  withHostedTaskBoardMutationLedgerEntry,
} from './hostedTaskBoardMutationLedger';
import {
  createHostedTaskBoardMutationWal,
  createHostedTaskBoardMutationWalHandle,
  type HostedTaskBoardMutationTarget,
  publishHostedTaskBoardMutationWal,
  readHostedTaskBoardMutationWal,
  recoverHostedTaskBoardMutationWal,
} from './hostedTaskBoardMutationTransaction';
import { HostedTaskBoardRosterAuthority } from './hostedTaskBoardRosterAuthority';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

const MAX_TASK_FILES = 512;
const MAX_TASK_FILE_BYTES = 256 * 1024;
const MAX_TASK_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_KANBAN_STATE_BYTES = 512 * 1024;
const MAX_RELATIONSHIPS = 100;
const FENCE_DURATION_MS = 5_000;
const TASK_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
type JsonRecord = Record<string, unknown>;
export type HostedTaskBoardMutationFaultPoint =
  | 'wal_fsynced'
  | 'before_target_publish'
  | 'existing_target_postimage_ready'
  | 'existing_target_precommit_validated'
  | 'existing_target_preimage_detached'
  | 'existing_target_replaced'
  | 'task_published'
  | 'kanban_published'
  | 'ledger_published';
interface TaskDocument extends HostedTaskBoardMutationTaskDocument {
  readonly snapshot: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
  readonly blockedBy: readonly string[];
  readonly blocks: readonly string[];
  readonly related: readonly string[];
}
interface TaskFile {
  readonly rawTaskId: string;
  readonly fileName: string;
  readonly snapshot: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
  readonly document: TaskDocument | null;
}
interface BoardSnapshot {
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly revision: Revision;
  readonly taskDirectoryNames: readonly string[];
  readonly taskFiles: readonly TaskFile[];
  readonly documents: ReadonlyMap<TaskId, TaskDocument>;
  readonly kanban: HostedTaskBoardKanbanState;
  readonly kanbanSnapshot: HostedTaskBoardFileSnapshot;
  readonly roster: Awaited<ReturnType<HostedTaskBoardRosterAuthority['readActiveRoster']>>;
  readonly ledger: HostedTaskBoardMutationLedger<HostedTaskBoardFileSnapshot>;
  readonly ledgerSnapshot: HostedTaskBoardFileSnapshot;
  readonly snapshots: readonly HostedTaskBoardFileSnapshot[];
}
export interface HostedTaskBoardMutationFileAuthorityDependencies {
  readonly readSource: Pick<HostedTaskBoardAuthorityPort, 'readWindow'>;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly nowMs?: () => number;
  readonly onFaultPoint?: (
    point: HostedTaskBoardMutationFaultPoint
  ) => void | 'crash' | Promise<void | 'crash'>;
}
class MutationUnavailableError extends Error {}
class MutationCrashError extends Error {}
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseRelationships(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) {
    throw new TypeError('hosted-task-board-mutation-relationship-invalid');
  }
  const entries = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 128) {
      throw new TypeError('hosted-task-board-mutation-relationship-invalid');
    }
    return entry;
  });
  if (new Set(entries).size !== entries.length) {
    throw new TypeError('hosted-task-board-mutation-relationship-invalid');
  }
  return Object.freeze(entries);
}

function parseTaskDocument(
  teamId: TeamId,
  rawTaskId: string,
  fileName: string,
  snapshot: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>
): TaskDocument | null {
  const value: unknown = JSON.parse(snapshot.text);
  if (!isRecord(value)) throw new TypeError('hosted-task-board-mutation-task-invalid');
  if (isRecord(value.metadata) && value.metadata._internal === true) return null;
  const parsedId =
    typeof value.id === 'number' && Number.isSafeInteger(value.id) ? String(value.id) : value.id;
  if (
    parsedId !== rawTaskId ||
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
    throw new TypeError('hosted-task-board-mutation-task-invalid');
  }
  return Object.freeze({
    rawTaskId,
    fileName,
    taskId: hostedTaskBoardTaskId(teamId, rawTaskId),
    serialized: snapshot.text,
    snapshot,
    record: value,
    status: value.status as TaskDocument['status'],
    blockedBy: parseRelationships(value.blockedBy ?? []),
    blocks: parseRelationships(value.blocks ?? []),
    related: parseRelationships(value.related ?? []),
  });
}

function assertRelationships(documents: Iterable<TaskDocument>): void {
  const tasks = [...documents];
  const byRawTaskId = new Map(tasks.map((task) => [task.rawTaskId, task]));
  for (const task of tasks) {
    for (const otherId of task.blockedBy) {
      if (
        otherId === task.rawTaskId ||
        !byRawTaskId.get(otherId)?.blocks.includes(task.rawTaskId)
      ) {
        throw new TypeError('hosted-task-board-mutation-relationship-asymmetric');
      }
    }
    for (const otherId of task.blocks) {
      if (
        otherId === task.rawTaskId ||
        !byRawTaskId.get(otherId)?.blockedBy.includes(task.rawTaskId)
      ) {
        throw new TypeError('hosted-task-board-mutation-relationship-asymmetric');
      }
    }
    for (const otherId of task.related) {
      if (
        otherId === task.rawTaskId ||
        !byRawTaskId.get(otherId)?.related.includes(task.rawTaskId)
      ) {
        throw new TypeError('hosted-task-board-mutation-relationship-asymmetric');
      }
    }
  }
}

export class DescriptorBoundHostedTaskBoardMutationFileAuthority implements HostedTaskBoardAuthorityPort {
  private readonly runtimeInstance: RuntimeInstanceContext;
  private readonly claudeRoot: string;
  private readonly nowMs: () => number;
  private readonly rosterAuthority = new HostedTaskBoardRosterAuthority();
  private readonly observedBindings = new Map<
    TeamIdentityRecord['teamId'],
    NonNullable<TeamIdentityRecord['workspaceBinding']>
  >();

  constructor(private readonly dependencies: HostedTaskBoardMutationFileAuthorityDependencies) {
    this.runtimeInstance = createRuntimeInstanceContext(dependencies.runtimeInstance);
    if (
      !(dependencies.mountBinding instanceof WorkspaceMountBinding) ||
      dependencies.mountBinding.health !== 'healthy' ||
      dependencies.mountBinding.bootId !== this.runtimeInstance.bootId
    ) {
      throw new TypeError('hosted-task-board-mutation-mount-binding-invalid');
    }
    this.claudeRoot = this.runtimeInstance.claudeRoot.reference as string;
    if (
      !isAbsolute(this.claudeRoot) ||
      resolve(this.claudeRoot) !== this.claudeRoot ||
      this.claudeRoot === resolve('/')
    ) {
      throw new TypeError('hosted-task-board-mutation-claude-root-invalid');
    }
    this.nowMs = dependencies.nowMs ?? Date.now;
  }

  async readWindow(
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityReadWindowResult> {
    return this.dependencies.readSource.readWindow(request, context);
  }

  async admitTaskMutation(
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityMutationResult> {
    let fence: HostedTaskBoardMutationFence | null = null;
    const directories: HostedTaskBoardDirectoryDescriptor[] = [];
    let snapshot: BoardSnapshot | null = null;
    try {
      this.assertActive(context);
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(request.payloadFingerprint)) {
        throw new MutationUnavailableError();
      }
      const identity = await this.readActiveIdentity(request.command.teamId);
      if (identity === null) return Object.freeze({ kind: 'not_found' });
      const bound = await this.openBoundDirectories(identity, context, directories);
      const assertStillActive = (): void => this.assertActive(context);
      fence = await HostedTaskBoardMutationFence.acquire({
        teamDirectory: bound.teamDirectory,
        nowMs: this.nowMs,
        durationMs: FENCE_DURATION_MS,
        assertStillActive,
      });
      if (fence === null)
        return Object.freeze({ kind: 'unavailable', retryAfterMs: FENCE_DURATION_MS });

      const existingWal = await readHostedTaskBoardMutationWal(
        bound.teamDirectory,
        assertStillActive
      );
      if (existingWal?.wal.phase === 'prepared') {
        await recoverHostedTaskBoardMutationWal({
          handle: existingWal,
          teamDirectory: bound.teamDirectory,
          tasksDirectory: bound.tasksDirectory,
          fence,
          assertStillActive,
        });
      }
      const previousTerminal = await readHostedTaskBoardMutationWal(
        bound.teamDirectory,
        assertStillActive
      );
      if (previousTerminal !== null && previousTerminal.wal.phase !== 'terminal') {
        return Object.freeze({ kind: 'unsafe_active' });
      }

      const sourceGeneration = this.sourceGeneration(request.command.teamId, bound);
      if (sourceGeneration !== request.command.expectedSourceGeneration) {
        return Object.freeze({
          kind: 'stale_generation',
          currentSourceGeneration: sourceGeneration,
        });
      }
      const boardSnapshot = (snapshot = await this.readBoardSnapshot(
        request.command.teamId,
        sourceGeneration,
        bound,
        identity,
        assertStillActive
      ));
      const ledgerKey = hostedTaskBoardMutationLedgerKey(
        request.command.teamId,
        sourceGeneration,
        request.command.idempotencyKey
      );
      const previous = boardSnapshot.ledger.entries.get(ledgerKey);
      if (previous !== undefined) {
        return this.replay(previous, request, boardSnapshot);
      }
      if (boardSnapshot.revision !== request.command.expectedRevision) {
        return Object.freeze({
          kind: 'stale_revision',
          currentSourceGeneration: sourceGeneration,
          currentRevision: boardSnapshot.revision,
        });
      }

      const postimages = this.calculatePostimages(boardSnapshot, request.command);
      const createdTaskCount = [...postimages.taskPostimages.keys()].filter(
        (name) => !boardSnapshot.taskDirectoryNames.includes(name)
      ).length;
      if (boardSnapshot.taskDirectoryNames.length + createdTaskCount > MAX_TASK_FILES) {
        throw new HostedTaskBoardMutationStateConflictError();
      }
      const finalRevision = hostedTaskBoardRevisionForContents({
        sourceGeneration,
        taskFiles: this.postimageTaskFiles(boardSnapshot, postimages.taskPostimages),
        kanbanText:
          postimages.kanbanPostimage ??
          (boardSnapshot.kanbanSnapshot.exists ? boardSnapshot.kanbanSnapshot.text : null),
        rosterFiles: boardSnapshot.roster.files
          .filter((file) => file.name !== 'team.identity.json')
          .map((file) => ({ name: file.name, text: file.exists ? file.text : null })),
      });
      const receipt: HostedTaskMutationCommittedReceipt = Object.freeze({
        schemaVersion: 1,
        outcome: 'committed',
        commandId: request.command.commandId,
        teamId: request.command.teamId,
        sourceGeneration: request.command.expectedSourceGeneration,
        revision: finalRevision,
        affectedTaskIds: Object.freeze([...postimages.affectedTaskIds]),
      });
      const ledgerEntry: HostedTaskBoardMutationLedgerEntry = Object.freeze({
        fingerprint: request.payloadFingerprint,
        commandId: request.command.commandId,
        sourceGeneration,
        expectedRevision: request.command.expectedRevision,
        receipt,
        committedAtMs: this.checkedNow(),
      });
      const nextLedger = withHostedTaskBoardMutationLedgerEntry(
        boardSnapshot.ledger,
        ledgerKey,
        ledgerEntry
      );
      const ledgerPostimage = serializeHostedTaskBoardMutationLedger(nextLedger);
      const targets = await this.targetsFor(
        bound,
        boardSnapshot,
        postimages,
        ledgerPostimage,
        assertStillActive
      );
      await revalidateHostedTaskBoardSnapshots(
        [bound.teamDirectory, bound.tasksDirectory],
        [...boardSnapshot.snapshots, ...targets.map((target) => target.snapshot)],
        assertStillActive
      );
      await revalidateHostedTaskBoardDirectoryMembership(
        bound.tasksDirectory,
        boardSnapshot.taskDirectoryNames,
        MAX_TASK_FILES,
        assertStillActive
      );
      await fence.renew(assertStillActive);
      const wal = createHostedTaskBoardMutationWal({
        nowMs: this.checkedNow(),
        command: request.command,
        payloadFingerprint: request.payloadFingerprint,
        fence,
        teamDirectory: bound.teamDirectory,
        tasksDirectory: bound.tasksDirectory,
        taskDirectoryNames: boardSnapshot.taskDirectoryNames,
        guards: boardSnapshot.snapshots
          .filter(
            (guard) =>
              !targets.some(
                (target) =>
                  target.parent === (guard.parent === bound.teamDirectory ? 'team' : 'tasks') &&
                  target.name === guard.name
              )
          )
          .map((snapshot) =>
            Object.freeze({
              parent:
                snapshot.parent === bound.teamDirectory ? ('team' as const) : ('tasks' as const),
              snapshot,
            })
          ),
        targets,
        finalReceipt: receipt,
      });
      const handle = await createHostedTaskBoardMutationWalHandle({
        teamDirectory: bound.teamDirectory,
        wal,
        fence,
        previousTerminal,
        assertStillActive,
      });
      await this.fault('wal_fsynced');
      await publishHostedTaskBoardMutationWal({
        handle,
        teamDirectory: bound.teamDirectory,
        tasksDirectory: bound.tasksDirectory,
        fence,
        assertStillActive,
        beforePublish: () => this.fault('before_target_publish'),
        onExistingTargetPublicationCheckpoint: (point) => this.fault(point),
        onPublished: async (kind) =>
          this.fault(`${kind}_published` as HostedTaskBoardMutationFaultPoint),
      });
      return Object.freeze({
        kind: 'committed',
        currentSourceGeneration: sourceGeneration,
        payloadFingerprint: request.payloadFingerprint,
        receipt,
      });
    } catch (error) {
      if (error instanceof HostedTaskBoardMutationTaskNotFoundError) {
        return Object.freeze({ kind: 'not_found' });
      }
      if (error instanceof HostedTaskBoardMutationStateConflictError) {
        return snapshot === null
          ? Object.freeze({ kind: 'unsafe_active' })
          : Object.freeze({
              kind: 'conflict',
              reason: 'state_conflict',
              currentSourceGeneration: snapshot.sourceGeneration,
              currentRevision: snapshot.revision,
            });
      }
      if (error instanceof HostedTaskBoardMutationRelationshipConflictError) {
        return snapshot === null
          ? Object.freeze({ kind: 'unsafe_active' })
          : Object.freeze({
              kind: 'conflict',
              reason: 'relationship_conflict',
              currentSourceGeneration: snapshot.sourceGeneration,
              currentRevision: snapshot.revision,
            });
      }
      if (error instanceof MutationUnavailableError || error instanceof MutationCrashError) {
        return Object.freeze({ kind: 'unavailable', retryAfterMs: FENCE_DURATION_MS });
      }
      return Object.freeze({ kind: 'unsafe_active' });
    } finally {
      await fence?.release();
      await closeHostedTaskBoardDirectories(directories).catch(() => undefined);
    }
  }

  private async readActiveIdentity(teamId: TeamId): Promise<TeamIdentityRecord | null> {
    let value: TeamIdentityRecord | null;
    try {
      value = await this.dependencies.teamIdentities.getTeamIdentity(teamId);
    } catch {
      throw new MutationUnavailableError();
    }
    if (value === null) return null;
    const identity = parseTeamIdentityRecord(value);
    const binding = identity.workspaceBinding;
    if (identity.state !== 'active' || binding === null) return null;
    const observed = this.observedBindings.get(identity.teamId);
    if (
      observed &&
      (binding.generation < observed.generation ||
        (binding.generation === observed.generation &&
          binding.workspaceId !== observed.workspaceId))
    ) {
      throw new MutationUnavailableError();
    }
    this.observedBindings.set(identity.teamId, binding);
    // Stable identity binding generations do not advance with the boot-scoped mount generation.
    return binding.workspaceId === this.dependencies.mountBinding.workspaceId ? identity : null;
  }

  private async openBoundDirectories(
    identity: TeamIdentityRecord,
    context: QueryContext,
    directories: HostedTaskBoardDirectoryDescriptor[]
  ): Promise<{
    readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
    readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  }> {
    const assertStillActive = (): void => this.assertActive(context);
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
    const legacyTeamKey = parseLegacyTeamKey(identity.legacyKey);
    const root = await bind(this.claudeRoot, null, null);
    const teamsRoot = await bind(join(root.identity.canonicalPath, 'teams'), root, 'teams');
    const teamDirectory = await bind(
      join(teamsRoot.identity.canonicalPath, legacyTeamKey),
      teamsRoot,
      legacyTeamKey
    );
    if (
      hostedTaskBoardDirectoryFingerprint(teamDirectory.identity) !== identity.directoryFingerprint
    ) {
      throw new TypeError('hosted-task-board-mutation-team-directory-substituted');
    }
    const tasksRoot = await bind(join(root.identity.canonicalPath, 'tasks'), root, 'tasks');
    const tasksDirectory = await bind(
      join(tasksRoot.identity.canonicalPath, legacyTeamKey),
      tasksRoot,
      legacyTeamKey
    );
    return Object.freeze({ teamDirectory, tasksDirectory });
  }

  private sourceGeneration(
    teamId: TeamId,
    directories: {
      readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
      readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
    }
  ): HostedTaskBoardSourceGeneration {
    return hostedTaskBoardSourceGeneration({
      deploymentId: this.runtimeInstance.deploymentId,
      bootId: this.runtimeInstance.bootId,
      workspaceId: this.dependencies.mountBinding.workspaceId,
      mountGeneration: this.dependencies.mountBinding.mountGeneration,
      teamId,
      teamDirectory: directories.teamDirectory,
      tasksDirectory: directories.tasksDirectory,
    });
  }

  private async readBoardSnapshot(
    teamId: TeamId,
    sourceGeneration: HostedTaskBoardSourceGeneration,
    directories: {
      readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
      readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
    },
    identity: TeamIdentityRecord,
    assertStillActive: () => void
  ): Promise<BoardSnapshot> {
    const names = await listHostedTaskBoardDirectoryNames(
      directories.tasksDirectory,
      MAX_TASK_FILES,
      assertStillActive
    );
    const taskFiles: TaskFile[] = [];
    let totalBytes = 0;
    for (const fileName of names) {
      const matched = TASK_FILE.exec(fileName);
      if (matched === null) continue;
      const snapshot = await readHostedTaskBoardFile(
        directories.tasksDirectory,
        fileName,
        MAX_TASK_FILE_BYTES,
        { assertStillActive }
      );
      if (!snapshot.exists) throw new TypeError('hosted-task-board-mutation-task-raced');
      totalBytes += Number(snapshot.stamp.size);
      if (totalBytes > MAX_TASK_SNAPSHOT_BYTES) {
        throw new TypeError('hosted-task-board-mutation-task-budget-exceeded');
      }
      taskFiles.push(
        Object.freeze({
          rawTaskId: matched[1],
          fileName,
          snapshot,
          document: parseTaskDocument(teamId, matched[1], fileName, snapshot),
        })
      );
    }
    const documents = new Map<TaskId, TaskDocument>();
    for (const taskFile of taskFiles) {
      if (taskFile.document === null || documents.has(taskFile.document.taskId)) continue;
      documents.set(taskFile.document.taskId, taskFile.document);
    }
    if (documents.size !== taskFiles.filter((taskFile) => taskFile.document !== null).length) {
      throw new TypeError('hosted-task-board-mutation-task-id-collision');
    }
    assertRelationships(documents.values());
    const kanbanSnapshot = await readHostedTaskBoardFile(
      directories.teamDirectory,
      'kanban-state.json',
      MAX_KANBAN_STATE_BYTES,
      { optional: true, assertStillActive }
    );
    const kanban = parseHostedTaskBoardKanbanState(
      kanbanSnapshot.exists ? kanbanSnapshot.text : null,
      new Set([...documents.values()].map((document) => document.rawTaskId))
    );
    const roster = await this.rosterAuthority.readActiveRoster(
      directories.teamDirectory,
      identity,
      assertStillActive
    );
    const ledgerSnapshot = await readHostedTaskBoardFile(
      directories.teamDirectory,
      HOSTED_TASK_BOARD_MUTATION_LEDGER_FILE,
      HOSTED_TASK_BOARD_MUTATION_MAX_LEDGER_BYTES,
      { optional: true, assertStillActive }
    );
    const ledger = parseHostedTaskBoardMutationLedger(
      ledgerSnapshot.exists ? ledgerSnapshot.text : null,
      ledgerSnapshot
    );
    const snapshots = Object.freeze([
      ...taskFiles.map((taskFile) => taskFile.snapshot),
      kanbanSnapshot,
      ...roster.files,
      ledgerSnapshot,
    ]);
    await revalidateHostedTaskBoardDirectoryMembership(
      directories.tasksDirectory,
      names,
      MAX_TASK_FILES,
      assertStillActive
    );
    await revalidateHostedTaskBoardSnapshots(
      [directories.teamDirectory, directories.tasksDirectory],
      snapshots,
      assertStillActive
    );
    return Object.freeze({
      sourceGeneration,
      revision: hostedTaskBoardRevisionForContents({
        sourceGeneration,
        taskFiles: taskFiles.map((taskFile) => ({
          name: taskFile.fileName,
          text: taskFile.snapshot.text,
        })),
        kanbanText: kanbanSnapshot.exists ? kanbanSnapshot.text : null,
        rosterFiles: roster.files
          .filter((file) => file.name !== 'team.identity.json')
          .map((file) => ({ name: file.name, text: file.exists ? file.text : null })),
      }),
      taskDirectoryNames: names,
      taskFiles: Object.freeze(taskFiles),
      documents,
      kanban,
      kanbanSnapshot,
      roster,
      ledger,
      ledgerSnapshot,
      snapshots,
    });
  }

  private calculatePostimages(
    snapshot: BoardSnapshot,
    command: HostedTaskMutationCommand
  ): HostedTaskBoardMutationPostimages {
    return calculateHostedTaskBoardMutationPostimages({
      command,
      kanban: snapshot.kanban,
      documents: snapshot.documents,
      taskFileNames: new Set(snapshot.taskFiles.map((taskFile) => taskFile.fileName)),
      timestamp: new Date(this.checkedNow()).toISOString(),
      taskIdFor: (rawTaskId) => hostedTaskBoardTaskId(command.teamId, rawTaskId),
      resolveOwner: (ownerId) => this.rosterAuthority.resolveActiveMember(snapshot.roster, ownerId),
    });
  }

  private postimageTaskFiles(
    snapshot: BoardSnapshot,
    taskPostimages: ReadonlyMap<string, string>
  ): readonly { readonly name: string; readonly text: string }[] {
    const files = new Map(
      snapshot.taskFiles.map((taskFile) => [taskFile.fileName, taskFile.snapshot.text])
    );
    for (const [name, text] of taskPostimages) files.set(name, text);
    return Object.freeze([...files.entries()].map(([name, text]) => Object.freeze({ name, text })));
  }

  private async targetsFor(
    directories: {
      readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
      readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
    },
    snapshot: BoardSnapshot,
    postimages: HostedTaskBoardMutationPostimages,
    ledgerPostimage: string,
    assertStillActive: () => void
  ): Promise<readonly HostedTaskBoardMutationTarget[]> {
    const targets: HostedTaskBoardMutationTarget[] = [];
    const taskSnapshots = new Map(
      snapshot.taskFiles.map((taskFile) => [taskFile.fileName, taskFile.snapshot])
    );
    for (const [name, postimage] of [...postimages.taskPostimages.entries()].sort(
      ([left], [right]) => left.localeCompare(right)
    )) {
      let taskSnapshot: HostedTaskBoardFileSnapshot | undefined = taskSnapshots.get(name);
      if (taskSnapshot === undefined) {
        taskSnapshot = await readHostedTaskBoardFile(
          directories.tasksDirectory,
          name,
          MAX_TASK_FILE_BYTES,
          { optional: true, assertStillActive }
        );
      }
      targets.push(
        Object.freeze({ kind: 'task', parent: 'tasks', name, snapshot: taskSnapshot, postimage })
      );
    }
    if (postimages.kanbanPostimage !== undefined) {
      targets.push(
        Object.freeze({
          kind: 'kanban',
          parent: 'team',
          name: 'kanban-state.json',
          snapshot: snapshot.kanbanSnapshot,
          postimage: postimages.kanbanPostimage,
        })
      );
    }
    targets.push(
      Object.freeze({
        kind: 'ledger',
        parent: 'team',
        name: HOSTED_TASK_BOARD_MUTATION_LEDGER_FILE,
        snapshot: snapshot.ledgerSnapshot,
        postimage: ledgerPostimage,
      })
    );
    return Object.freeze(targets);
  }

  private replay(
    entry: HostedTaskBoardMutationLedgerEntry,
    request: HostedTaskBoardAuthorityMutationRequest,
    snapshot: BoardSnapshot
  ): HostedTaskBoardAuthorityMutationResult {
    if (
      entry.fingerprint !== request.payloadFingerprint ||
      entry.commandId !== request.command.commandId ||
      entry.sourceGeneration !== snapshot.sourceGeneration
    ) {
      return Object.freeze({
        kind: 'conflict',
        reason: 'idempotency_mismatch',
        currentSourceGeneration: snapshot.sourceGeneration,
      });
    }
    return Object.freeze({
      kind: 'idempotent_replay',
      currentSourceGeneration: snapshot.sourceGeneration,
      payloadFingerprint: request.payloadFingerprint,
      receipt: Object.freeze({ ...entry.receipt, outcome: 'idempotent_replay' }),
    });
  }

  private async fault(point: HostedTaskBoardMutationFaultPoint): Promise<void> {
    const action = await this.dependencies.onFaultPoint?.(point);
    if (action === 'crash') throw new MutationCrashError();
  }

  private checkedNow(): number {
    const now = this.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) throw new MutationUnavailableError();
    return now;
  }

  private assertActive(context: QueryContext): void {
    const now = this.checkedNow();
    if (
      context.deploymentId !== this.runtimeInstance.deploymentId ||
      context.bootId !== this.runtimeInstance.bootId ||
      context.signal.aborted ||
      now >= context.deadlineAtMs
    ) {
      throw new MutationUnavailableError();
    }
  }
}

export function createHostedTaskBoardMutationFileAuthority(
  dependencies: HostedTaskBoardMutationFileAuthorityDependencies
): DescriptorBoundHostedTaskBoardMutationFileAuthority {
  return new DescriptorBoundHostedTaskBoardMutationFileAuthority(dependencies);
}
