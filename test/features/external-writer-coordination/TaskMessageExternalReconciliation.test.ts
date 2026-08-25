/* eslint-disable @typescript-eslint/require-await -- test authorities intentionally satisfy async ports. */
import {
  type ExternalFileObservationCatalog,
  type ExternalFileReconciliationPort,
  type ExternalFileReconciliationRequest,
  type ExternalFileReconciliationResult,
  type ExternalFileStat,
  type ExternalWriterObservationStateStore,
  ExternalWriterObserver,
  type ExternalWriterScope,
  type ExternalWriterWatchCallbacks,
  type FileObservationStateCheckpoint,
} from '@features/external-writer-coordination';
import {
  type ExternalWriterReconciliationRoute,
  ExternalWriterReconciliationRouter,
} from '@features/external-writer-coordination/main';
import {
  HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY,
  type HostedMessageExternalWriterAuthority,
  type HostedMessageExternalWriterReconciliationCommit,
} from '@features/team-message-delivery/main/adapters/output/external-writer';
import { createHostedTeamMessageOutputAdapters } from '@features/team-message-delivery/main/hosted';
import {
  HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY,
  type HostedTaskExternalWriterAuthority,
  type HostedTaskExternalWriterReconciliationCommit,
} from '@features/team-task-board/main/adapters/output/external-writer';
import { createHostedTeamTaskBoardOutputAdapters } from '@features/team-task-board/main/hosted';
import {
  parseTeamId,
  parseWorkspaceId,
  type WorkspaceId,
} from '@shared/contracts/hosted/identifiers';
import { describe, expect, it } from 'vitest';

import type { PublishCoordinationEventCommand } from '@features/coordination-events';

const teamId = parseTeamId('team_88888888888888888888888888888888');
const workspaceId = parseWorkspaceId('workspace_99999999999999999999999999999999');
const taskScope = { teamId, featureKey: HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY } as const;
const inboxScope = { teamId, featureKey: HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY } as const;
const taskFileKey = 'task-task-1';
const inboxFileKey = 'inbox-user';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const checksum = (content: Uint8Array): string =>
  `checksum:${content.byteLength}:${[...content].reduce((sum, value) => sum + value, 0)}`;

function fingerprint(content: Uint8Array | null, version: number) {
  return content === null
    ? Object.freeze({ exists: false as const, checksum: null, statIdentity: null })
    : Object.freeze({
        exists: true as const,
        checksum: checksum(content),
        statIdentity: Object.freeze({
          byteLength: content.byteLength,
          device: 'fixture-device',
          inode: 'fixture-inode',
          modifiedTimeNs: String(version),
          changedTimeNs: String(version),
        }),
      });
}

class MemoryStateStore implements ExternalWriterObservationStateStore {
  checkpoint: FileObservationStateCheckpoint | null = null;

  async load(): Promise<FileObservationStateCheckpoint | null> {
    return this.checkpoint;
  }

  async save(checkpoint: FileObservationStateCheckpoint): Promise<void> {
    this.checkpoint = checkpoint;
  }
}

class TaskAuthority implements HostedTaskExternalWriterAuthority {
  readonly commits: (HostedTaskExternalWriterReconciliationCommit & {
    readonly coordinationEvent: PublishCoordinationEventCommand;
  })[] = [];
  readonly createdEventIds: string[] = [];
  getResultCalls = 0;
  failGetResult = false;
  private readonly results = new Map<string, ExternalFileReconciliationResult>();
  private readonly inputs = new Map<string, string>();

  constructor(
    private readonly currentEpoch = 1,
    private readonly currentRunGeneration: number | null = null,
    private readonly sourceGenerationBase = 0,
    private readonly featureRevisionBase = 0,
    private readonly targetWorkspaceId: WorkspaceId = workspaceId
  ) {}

  async resolveTaskTarget() {
    return Object.freeze({ taskId: 'task-1', workspaceId: this.targetWorkspaceId });
  }

  createEventId({ reconciliationId }: { readonly reconciliationId: string }): string {
    const eventId = `task-event-${reconciliationId.slice(-24)}`;
    this.createdEventIds.push(eventId);
    return eventId;
  }

  nowIso(): string {
    return '2026-08-04T00:00:00.000Z';
  }

  async getResult(reconciliationId: string): Promise<ExternalFileReconciliationResult | null> {
    this.getResultCalls += 1;
    if (this.failGetResult) throw new Error('task-result-lookup-unavailable');
    return this.results.get(reconciliationId) ?? null;
  }

  async commit(
    input: HostedTaskExternalWriterReconciliationCommit
  ): Promise<ExternalFileReconciliationResult> {
    const serialized = JSON.stringify({ observation: input.observation, effect: input.effect });
    const prior = this.results.get(input.reconciliationId);
    if (prior) {
      return this.inputs.get(input.reconciliationId) === serialized
        ? prior
        : Object.freeze({ outcome: 'conflict', diagnosticCode: 'reconciliation_id_reused' });
    }
    if (input.observation.fileWriterEpoch !== this.currentEpoch) {
      return Object.freeze({ outcome: 'conflict', diagnosticCode: 'stale_file_writer_epoch' });
    }
    if (
      input.observation.actor.kind === 'verified_run' &&
      input.observation.actor.runGeneration !== this.currentRunGeneration
    ) {
      return Object.freeze({ outcome: 'conflict', diagnosticCode: 'stale_run' });
    }
    const result = Object.freeze({
      outcome: 'accepted_change' as const,
      sourceGeneration: this.sourceGenerationBase + this.commits.length + 1,
      featureRevision: this.featureRevisionBase + this.commits.length + 1,
    });
    const coordinationEvent = input.buildCommittedCoordinationEvent(result);
    this.commits.push(Object.freeze({ ...input, coordinationEvent }));
    this.results.set(input.reconciliationId, result);
    this.inputs.set(input.reconciliationId, serialized);
    return result;
  }
}

class MessageAuthority implements HostedMessageExternalWriterAuthority {
  readonly commits: (HostedMessageExternalWriterReconciliationCommit & {
    readonly coordinationEvent: PublishCoordinationEventCommand;
  })[] = [];
  readonly createdEventIds: string[] = [];
  getResultCalls = 0;
  failGetResult = false;
  private readonly results = new Map<string, ExternalFileReconciliationResult>();
  private readonly inputs = new Map<string, string>();

  constructor(
    private readonly currentEpoch = 1,
    private readonly currentRunGeneration: number | null = null,
    private readonly sourceGenerationBase = 0,
    private readonly featureRevisionBase = 0,
    private readonly targetWorkspaceId: WorkspaceId = workspaceId
  ) {}

  async resolveInboxTarget() {
    return Object.freeze({ inboxId: 'user', workspaceId: this.targetWorkspaceId });
  }

  deriveLegacyMessageId({
    from,
    timestamp,
    text,
  }: {
    from: string;
    timestamp: string;
    text: string;
  }): string {
    return `legacy-${from}-${timestamp}-${text}`;
  }

  createEventId({ reconciliationId }: { readonly reconciliationId: string }): string {
    const eventId = `message-event-${reconciliationId.slice(-22)}`;
    this.createdEventIds.push(eventId);
    return eventId;
  }

  nowIso(): string {
    return '2026-08-04T00:00:00.000Z';
  }

  async getResult(reconciliationId: string): Promise<ExternalFileReconciliationResult | null> {
    this.getResultCalls += 1;
    if (this.failGetResult) throw new Error('message-result-lookup-unavailable');
    return this.results.get(reconciliationId) ?? null;
  }

  async commit(
    input: HostedMessageExternalWriterReconciliationCommit
  ): Promise<ExternalFileReconciliationResult> {
    const serialized = JSON.stringify({ observation: input.observation, effect: input.effect });
    const prior = this.results.get(input.reconciliationId);
    if (prior) {
      return this.inputs.get(input.reconciliationId) === serialized
        ? prior
        : Object.freeze({ outcome: 'conflict', diagnosticCode: 'reconciliation_id_reused' });
    }
    if (input.observation.fileWriterEpoch !== this.currentEpoch) {
      return Object.freeze({ outcome: 'conflict', diagnosticCode: 'stale_file_writer_epoch' });
    }
    if (
      input.observation.actor.kind === 'verified_run' &&
      input.observation.actor.runGeneration !== this.currentRunGeneration
    ) {
      return Object.freeze({ outcome: 'conflict', diagnosticCode: 'stale_run' });
    }
    const result = Object.freeze({
      outcome: 'accepted_change' as const,
      sourceGeneration: this.sourceGenerationBase + this.commits.length + 1,
      featureRevision: this.featureRevisionBase + this.commits.length + 1,
    });
    const coordinationEvent = input.buildCommittedCoordinationEvent(result);
    this.commits.push(Object.freeze({ ...input, coordinationEvent }));
    this.results.set(input.reconciliationId, result);
    this.inputs.set(input.reconciliationId, serialized);
    return result;
  }
}

interface FixtureFile {
  content: Uint8Array | null;
  version: number;
}

function scopeKey(scope: ExternalWriterScope, fileKey: string): string {
  return `${scope.teamId}:${scope.featureKey}:${fileKey}`;
}

function fileStat(file: FixtureFile): ExternalFileStat {
  if (file.content === null) {
    return {
      kind: 'missing',
      contained: true,
      byteLength: 0,
      device: null,
      inode: null,
      modifiedTimeNs: null,
      changedTimeNs: null,
    };
  }
  return {
    kind: 'file',
    contained: true,
    byteLength: file.content.byteLength,
    device: 'fixture-device',
    inode: 'fixture-inode',
    modifiedTimeNs: String(file.version),
    changedTimeNs: String(file.version),
  };
}

function request(input: {
  readonly scope: typeof taskScope | typeof inboxScope;
  readonly fileKey: string;
  readonly content: Uint8Array;
  readonly reconciliationId: string;
  readonly fileWriterEpoch?: number;
  readonly observationSequence?: number;
  readonly attributionPolicy?: 'external_file_only' | 'verified_run_evidence';
  readonly actor?: ExternalFileReconciliationRequest['actor'];
}): ExternalFileReconciliationRequest {
  const observationSequence = input.observationSequence ?? 1;
  const fileWriterEpoch = input.fileWriterEpoch ?? 1;
  const sourceFingerprint = fingerprint(input.content, observationSequence);
  return Object.freeze({
    reconciliationId: input.reconciliationId,
    registration: Object.freeze({
      scope: input.scope,
      fileKey: input.fileKey,
      maxBytes: 16_384,
      attributionPolicy: input.attributionPolicy ?? 'external_file_only',
    }),
    content: input.content,
    fingerprint: sourceFingerprint,
    observationSequence,
    fileWriterEpoch,
    actor:
      input.actor ??
      Object.freeze({
        kind: 'external_file' as const,
        teamId,
        featureKey: input.scope.featureKey,
        fileKey: input.fileKey,
        checksum: sourceFingerprint.checksum,
        observationSequence,
      }),
  });
}

function createRouter(
  taskAuthority: TaskAuthority,
  messageAuthority: MessageAuthority
): {
  readonly reconciliation: ExternalFileReconciliationPort;
  readonly task: NonNullable<
    ReturnType<typeof createHostedTeamTaskBoardOutputAdapters>['externalWriterReconciliation']
  >;
  readonly message: NonNullable<
    ReturnType<typeof createHostedTeamMessageOutputAdapters>['externalWriterReconciliation']
  >;
} {
  const taskOutput = createHostedTeamTaskBoardOutputAdapters(
    {
      async readWindow() {
        return Object.freeze({ kind: 'not_found' as const });
      },
    },
    { externalWriterAuthority: taskAuthority }
  );
  const messageOutput = createHostedTeamMessageOutputAdapters(
    {
      async readWindow() {
        return Object.freeze({ kind: 'not_found' as const });
      },
      async persistMessage() {
        return Object.freeze({ kind: 'not_found' as const });
      },
      async deliverPersistedMessage() {
        return Object.freeze({ kind: 'operator_required' as const });
      },
    },
    { externalWriterAuthority: messageAuthority }
  );
  const task = taskOutput.externalWriterReconciliation;
  const message = messageOutput.externalWriterReconciliation;
  if (task === undefined || message === undefined) {
    throw new Error('external-writer-composition-was-not-created');
  }
  const routes: readonly ExternalWriterReconciliationRoute[] = Object.freeze([
    Object.freeze({ featureKey: HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY, reconciliation: task }),
    Object.freeze({
      featureKey: HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY,
      reconciliation: message,
    }),
  ]);
  return Object.freeze({
    reconciliation: new ExternalWriterReconciliationRouter(routes),
    task,
    message,
  });
}

function createObserverHarness(input: {
  readonly taskAuthority: TaskAuthority;
  readonly messageAuthority: MessageAuthority;
  readonly files: ReadonlyMap<string, FixtureFile>;
  readonly stateStore?: MemoryStateStore;
  readonly reconciliation?: ExternalFileReconciliationPort;
}) {
  const router = createRouter(input.taskAuthority, input.messageAuthority);
  const files = new Map(input.files);
  let callbacks: ExternalWriterWatchCallbacks | null = null;
  const registrationByScope = new Map<ExternalWriterScope['featureKey'], readonly string[]>([
    [HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY, [taskFileKey]],
    [HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY, [inboxFileKey]],
  ]);
  const catalog: ExternalFileObservationCatalog = {
    async listScopes() {
      return [taskScope, inboxScope];
    },
    async listRegistrations(scope) {
      const fileKeys = registrationByScope.get(scope.featureKey) ?? [];
      return fileKeys.map((fileKey) =>
        Object.freeze({
          scope,
          fileKey,
          maxBytes: 16_384,
          attributionPolicy: 'external_file_only' as const,
        })
      );
    },
  };
  const observer = new ExternalWriterObserver(
    {
      watch: {
        async start(value) {
          callbacks = value;
          return Object.freeze({ async close() {} });
        },
      },
      catalog,
      source: {
        async stat(registration) {
          const file = files.get(scopeKey(registration.scope, registration.fileKey));
          if (!file) throw new Error('fixture-file-not-found');
          return fileStat(file);
        },
        async read(registration) {
          const file = files.get(scopeKey(registration.scope, registration.fileKey));
          if (!file?.content) throw new Error('fixture-file-not-readable');
          return new Uint8Array(file.content);
        },
        async confirmAbsentByParentRescan(registration) {
          return files.get(scopeKey(registration.scope, registration.fileKey))?.content === null;
        },
      },
      checksums: { checksum },
      reconciliation: input.reconciliation ?? router.reconciliation,
      stateStore: input.stateStore ?? new MemoryStateStore(),
      clock: { nowMs: () => 0, async sleep() {} },
    },
    { atomicReplaceDebounceMs: 0, retryDelayMs: 0, stableReadDeadlineMs: 100 }
  );
  return Object.freeze({
    observer,
    router,
    replace(scope: ExternalWriterScope, fileKey: string, content: Uint8Array | null) {
      const key = scopeKey(scope, fileKey);
      const prior = files.get(key);
      if (!prior) throw new Error('fixture-file-not-found');
      files.set(key, { content, version: prior.version + 1 });
    },
    callbacks() {
      if (!callbacks) throw new Error('watch-callbacks-not-ready');
      return callbacks;
    },
  });
}

describe('task and message external-writer reconciliation', () => {
  it('routes observer work through feature composition, preserves external attribution, and fences a self-write race plus overflow', async () => {
    const taskAuthority = new TaskAuthority();
    const messageAuthority = new MessageAuthority(1, 2);
    const harness = createObserverHarness({
      taskAuthority,
      messageAuthority,
      files: new Map([
        [
          scopeKey(taskScope, taskFileKey),
          {
            content: bytes('{"id":"task-1","subject":"initial","runId":"forged-run"}'),
            version: 1,
          },
        ],
        [
          scopeKey(inboxScope, inboxFileKey),
          {
            content: bytes(
              '[{"from":"agent-a","text":"initial","timestamp":"2026-08-04T00:00:00.000Z","runId":"forged-run","source":"user_sent"}]'
            ),
            version: 1,
          },
        ],
      ]),
    });

    await harness.observer.start();
    expect(taskAuthority.commits).toHaveLength(1);
    expect(messageAuthority.commits).toHaveLength(1);
    expect(taskAuthority.commits[0]?.coordinationEvent.trustedContext).toEqual({
      actor: { kind: 'external_file', fileWriterEpoch: 1, observationSequence: 1 },
    });
    expect(messageAuthority.commits[0]?.coordinationEvent.trustedContext).toEqual({
      actor: { kind: 'external_file', fileWriterEpoch: 1, observationSequence: 2 },
    });
    expect(taskAuthority.commits[0]?.coordinationEvent.draft).toMatchObject({
      workspaceId,
      resourceRevision: { resourceKey: 'task:task-1', generation: 1, revision: 1 },
    });
    // The inbox is the second global observation, but its own committed revision is one.
    expect(messageAuthority.commits[0]?.coordinationEvent.draft).toMatchObject({
      workspaceId,
      resourceRevision: { resourceKey: 'inbox:user', generation: 1, revision: 1 },
    });
    expect(taskAuthority.commits[0]?.coordinationEvent.draft).not.toHaveProperty('runId');
    expect(messageAuthority.commits[0]?.coordinationEvent.draft).not.toHaveProperty('runId');

    const appTask = bytes('{"id":"task-1","subject":"app-write"}');
    await harness.router.task.recordAppWrite(harness.observer, {
      intentId: 'task-app-write-suppressed',
      teamId,
      fileKey: taskFileKey,
      expectedChecksum: checksum(appTask),
      sourceGeneration: 2,
      fileWriterEpoch: 1,
      expiresAtMs: 10_000,
    });
    harness.replace(taskScope, taskFileKey, appTask);
    harness.callbacks().onNotification({ kind: 'rename', scope: taskScope, fileKey: taskFileKey });
    await harness.observer.rescanScope(taskScope);

    expect(taskAuthority.commits).toHaveLength(1);

    const hostileTask = bytes('{"id":"task-1","subject":"external-won","runId":"forged-run"}');
    await harness.router.task.recordAppWrite(harness.observer, {
      intentId: 'task-app-write-lost-race',
      teamId,
      fileKey: taskFileKey,
      expectedChecksum: checksum(appTask),
      sourceGeneration: 3,
      fileWriterEpoch: 1,
      expiresAtMs: 10_000,
    });
    harness.replace(taskScope, taskFileKey, hostileTask);
    harness.callbacks().onNotification({ kind: 'rename', scope: taskScope, fileKey: taskFileKey });
    await harness.observer.rescanScope(taskScope);

    expect(taskAuthority.commits).toHaveLength(2);
    expect(taskAuthority.commits[1]?.observation.actor).toEqual({
      kind: 'external_file',
      fileWriterEpoch: 1,
      observationSequence: expect.any(Number),
    });
    expect(taskAuthority.commits[1]?.coordinationEvent.trustedContext).toEqual({
      actor: expect.objectContaining({ kind: 'external_file' }),
    });
    expect(taskAuthority.commits[1]?.coordinationEvent.draft.resourceRevision).toEqual({
      resourceKey: 'task:task-1',
      generation: 2,
      revision: 2,
    });

    harness.replace(
      inboxScope,
      inboxFileKey,
      bytes(
        '[{"from":"agent-b","text":"overflow repaired","timestamp":"2026-08-04T00:02:00.000Z"}]'
      )
    );
    harness.callbacks().onOverflow({ scopes: [inboxScope] });
    await harness.observer.rescanScope(inboxScope);

    expect(harness.observer.getSnapshot().readiness).toBe('clean');
    expect(messageAuthority.commits).toHaveLength(2);
    expect(messageAuthority.commits[1]?.effect).toMatchObject({
      kind: 'observed',
      document: { messages: [{ recipient: 'user', text: 'overflow repaired' }] },
    });
    expect(messageAuthority.commits[1]?.coordinationEvent.draft).toMatchObject({
      workspaceId,
      resourceRevision: { resourceKey: 'inbox:user', generation: 2, revision: 2 },
    });
  });

  it('rejects contradictory duplicate deliveries and stale writer/run work without applying a second effect', async () => {
    const taskAuthority = new TaskAuthority(2);
    const messageAuthority = new MessageAuthority(1, 2);
    const router = createRouter(taskAuthority, messageAuthority);
    const duplicate = bytes(
      '[{"messageId":"duplicate","from":"agent","text":"first","timestamp":"2026-08-04T00:00:00Z"},{"messageId":"duplicate","from":"agent","text":"second","timestamp":"2026-08-04T00:00:00Z"}]'
    );

    await expect(
      router.message.reconcile(
        request({
          scope: inboxScope,
          fileKey: inboxFileKey,
          content: duplicate,
          reconciliationId: 'duplicate-delivery',
        })
      )
    ).resolves.toEqual({
      outcome: 'invalid',
      diagnosticCode: 'inbox_file_duplicate_message_conflict',
      blocksDependentMutations: true,
    });
    expect(messageAuthority.commits).toHaveLength(0);

    await expect(
      router.task.reconcile(
        request({
          scope: taskScope,
          fileKey: taskFileKey,
          content: bytes('{"id":"task-1","subject":"stale epoch"}'),
          reconciliationId: 'stale-epoch',
          fileWriterEpoch: 1,
        })
      )
    ).resolves.toEqual({ outcome: 'conflict', diagnosticCode: 'stale_file_writer_epoch' });
    expect(taskAuthority.commits).toHaveLength(0);
    expect(taskAuthority.createdEventIds).toHaveLength(0);

    const idempotentTask = request({
      scope: taskScope,
      fileKey: taskFileKey,
      content: bytes('{"id":"task-1","subject":"deduplicated"}'),
      reconciliationId: 'task-duplicate-delivery',
      fileWriterEpoch: 2,
      observationSequence: 2,
    });
    await expect(router.task.reconcile(idempotentTask)).resolves.toMatchObject({
      outcome: 'accepted_change',
    });
    await expect(router.task.reconcile(idempotentTask)).resolves.toMatchObject({
      outcome: 'accepted_change',
    });
    expect(taskAuthority.commits).toHaveLength(1);
    expect(taskAuthority.createdEventIds).toHaveLength(1);

    const verifiedActor = Object.freeze({
      kind: 'verified_run' as const,
      teamId,
      runId: 'run-current',
      runGeneration: 2,
      memberId: 'member-current',
      evidenceRef: 'verified-evidence',
    });
    const verifiedContent = bytes(
      '[{"from":"agent","text":"verified","timestamp":"2026-08-04T00:01:00Z"}]'
    );
    await expect(
      router.message.reconcile(
        request({
          scope: inboxScope,
          fileKey: inboxFileKey,
          content: verifiedContent,
          reconciliationId: 'verified-run',
          observationSequence: 2,
          attributionPolicy: 'verified_run_evidence',
          actor: verifiedActor,
        })
      )
    ).resolves.toMatchObject({ outcome: 'accepted_change' });
    expect(messageAuthority.commits[0]?.coordinationEvent.trustedContext).toEqual({
      actor: {
        kind: 'verified_runtime',
        actorRef: 'verified-evidence',
        runId: 'run-current',
        memberId: 'member-current',
      },
      runId: 'run-current',
    });

    await expect(
      router.message.reconcile(
        request({
          scope: inboxScope,
          fileKey: inboxFileKey,
          content: verifiedContent,
          reconciliationId: 'stale-run',
          observationSequence: 3,
          attributionPolicy: 'verified_run_evidence',
          actor: Object.freeze({ ...verifiedActor, runGeneration: 1 }),
        })
      )
    ).resolves.toEqual({ outcome: 'conflict', diagnosticCode: 'stale_run' });
    expect(messageAuthority.commits).toHaveLength(1);
    expect(messageAuthority.createdEventIds).toHaveLength(1);
  });

  it('rejects task and inbox writes when the authority cannot bind their workspace', async () => {
    const taskAuthority = new TaskAuthority(
      1,
      null,
      0,
      0,
      'workspace_unbound' as unknown as WorkspaceId
    );
    const messageAuthority = new MessageAuthority(
      1,
      null,
      0,
      0,
      'workspace_unbound' as unknown as WorkspaceId
    );
    const router = createRouter(taskAuthority, messageAuthority);

    await expect(
      router.task.reconcile(
        request({
          scope: taskScope,
          fileKey: taskFileKey,
          content: bytes(
            `{"id":"task-1","workspaceId":"${workspaceId}","subject":"forged binding"}`
          ),
          reconciliationId: 'task-workspace-unbound',
        })
      )
    ).resolves.toEqual({
      outcome: 'invalid',
      diagnosticCode: 'task_file_workspace_unbound',
      blocksDependentMutations: true,
    });
    await expect(
      router.message.reconcile(
        request({
          scope: inboxScope,
          fileKey: inboxFileKey,
          content: bytes('[{"from":"agent","text":"unbound","timestamp":"2026-08-04T00:00:00Z"}]'),
          reconciliationId: 'inbox-workspace-unbound',
        })
      )
    ).resolves.toEqual({
      outcome: 'invalid',
      diagnosticCode: 'inbox_file_workspace_unbound',
      blocksDependentMutations: true,
    });
    expect(taskAuthority.commits).toHaveLength(0);
    expect(messageAuthority.commits).toHaveLength(0);
    expect(taskAuthority.createdEventIds).toHaveLength(0);
    expect(messageAuthority.createdEventIds).toHaveLength(0);
  });

  it('recovers a lost task response after restart even when the unrelated message lookup fails', async () => {
    const stateStore = new MemoryStateStore();
    const taskAuthority = new TaskAuthority();
    const messageAuthority = new MessageAuthority();
    const router = createRouter(taskAuthority, messageAuthority);
    let lookupAvailable = false;
    let loseResponse = true;
    const recoveryPort: ExternalFileReconciliationPort = {
      async getResult(reconciliationId) {
        if (!lookupAvailable) throw new Error('result-lookup-temporarily-unavailable');
        return router.reconciliation.getResult(reconciliationId);
      },
      async reconcile(reconciliation) {
        const result = await router.reconciliation.reconcile(reconciliation);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('response-lost-after-commit');
        }
        return result;
      },
    };
    const files = new Map<string, FixtureFile>([
      [
        scopeKey(taskScope, taskFileKey),
        { content: bytes('{"id":"task-1","subject":"restart"}'), version: 1 },
      ],
      [scopeKey(inboxScope, inboxFileKey), { content: bytes('[]'), version: 1 }],
    ]);
    const first = createObserverHarness({
      taskAuthority,
      messageAuthority,
      files,
      stateStore,
      reconciliation: recoveryPort,
    });

    const interrupted = await first.observer.start();
    await first.observer.shutdown(1_000);
    expect(interrupted.readiness).toBe('dirty');
    expect(taskAuthority.commits).toHaveLength(1);

    lookupAvailable = true;
    messageAuthority.failGetResult = true;
    const restarted = createObserverHarness({ taskAuthority, messageAuthority, files, stateStore });
    const recovered = await restarted.observer.start();

    expect(recovered.readiness).toBe('clean');
    expect(taskAuthority.commits).toHaveLength(1);
    expect(taskAuthority.getResultCalls).toBeGreaterThan(0);
    expect(messageAuthority.getResultCalls).toBe(0);
    await expect(restarted.observer.shutdown(1_000)).resolves.toMatchObject({ status: 'clean' });
  });

  it('uses committed per-resource coordinates instead of non-contiguous observation sequences', async () => {
    const taskAuthority = new TaskAuthority(1, null, 40, 80);
    const messageAuthority = new MessageAuthority(1, null, 20, 60);
    const router = createRouter(taskAuthority, messageAuthority);

    await expect(
      router.task.reconcile(
        request({
          scope: taskScope,
          fileKey: taskFileKey,
          content: bytes('{"id":"task-1","subject":"committed task"}'),
          reconciliationId: 'task-non-contiguous-observation',
          observationSequence: 101,
        })
      )
    ).resolves.toEqual({ outcome: 'accepted_change', sourceGeneration: 41, featureRevision: 81 });
    await expect(
      router.message.reconcile(
        request({
          scope: inboxScope,
          fileKey: inboxFileKey,
          content: bytes(
            '[{"from":"agent","text":"committed inbox","timestamp":"2026-08-04T00:00:00Z"}]'
          ),
          reconciliationId: 'inbox-non-contiguous-observation',
          observationSequence: 137,
        })
      )
    ).resolves.toEqual({ outcome: 'accepted_change', sourceGeneration: 21, featureRevision: 61 });

    expect(taskAuthority.commits[0]?.coordinationEvent.draft.resourceRevision).toEqual({
      resourceKey: 'task:task-1',
      generation: 41,
      revision: 81,
    });
    expect(messageAuthority.commits[0]?.coordinationEvent.draft.resourceRevision).toEqual({
      resourceKey: 'inbox:user',
      generation: 21,
      revision: 61,
    });
    expect(taskAuthority.commits[0]?.coordinationEvent.trustedContext).toEqual({
      actor: { kind: 'external_file', fileWriterEpoch: 1, observationSequence: 101 },
    });
    expect(messageAuthority.commits[0]?.coordinationEvent.trustedContext).toEqual({
      actor: { kind: 'external_file', fileWriterEpoch: 1, observationSequence: 137 },
    });
  });
});
