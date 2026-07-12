import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import { buildOpenCodePromptDeliveryActiveBusyStatus } from '../opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { toOpenCodeRuntimeDeliveryStatus } from '../opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import {
  createOpenCodeRuntimeDeliveryPorts as createOpenCodeRuntimeDeliveryDestinationPorts,
  type OpenCodeRuntimeDeliveryCrossTeamSender,
} from '../opencode/delivery/OpenCodeRuntimeDeliveryPorts';
import { createRuntimeDeliveryJournalStore } from '../opencode/delivery/RuntimeDeliveryJournal';
import {
  type RuntimeDeliveryDestinationPort,
  RuntimeDeliveryDestinationRegistry,
  RuntimeDeliveryReconciler,
  RuntimeDeliveryService,
  type RuntimeDeliveryTeamChangeEvent,
} from '../opencode/delivery/RuntimeDeliveryService';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  type OpenCodeRuntimeLaneIndexEntry,
  readOpenCodeRuntimeLaneIndex,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { type TeamInboxReader } from '../TeamInboxReader';
import { type TeamInboxWriter } from '../TeamInboxWriter';
import { type TeamSentMessagesStore } from '../TeamSentMessagesStore';

import {
  hasStableInboxMessageId,
  isCurrentProofMissingRecoveryForegroundMessage,
  isCurrentReviewPickupRequestForegroundMessage,
} from './TeamProvisioningInboxRelayPolicy';
import {
  assertOpenCodeRuntimeEvidenceAccepted,
  createOpenCodeRuntimeCheckinPorts,
  type OpenCodeRuntimeCheckinPortCallbacks,
  type OpenCodeRuntimeCheckinPorts,
  type OpenCodeRuntimeCheckinRun,
  type OpenCodeRuntimeControlAck,
  recordOpenCodeRuntimeBootstrapCheckin,
  recordOpenCodeRuntimeHeartbeat,
  recordOpenCodeRuntimeTaskEvent,
} from './TeamProvisioningOpenCodeRuntimeCheckin';
import {
  asRuntimeRecord,
  normalizeRuntimeIso,
  requireRuntimeString,
} from './TeamProvisioningRuntimeMetadata';

import type { OpenCodeRuntimeControlPort } from '../runtime-control';
import type {
  InboxMessage,
  OpenCodeRuntimeDeliveryStatus,
  PersistedTeamLaunchSnapshot,
  TaskRef,
  TeamChangeEvent,
} from '@shared/types';

type RuntimeDeliveryLogger = Pick<Console, 'warn'>;

export interface OpenCodeRuntimeDeliveryStorePaths {
  teamsBasePath: string;
}

export interface OpenCodeRuntimeDeliveryServicePorts extends OpenCodeRuntimeDeliveryStorePaths {
  resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  createOpenCodeRuntimeDeliveryPorts(): RuntimeDeliveryDestinationPort[];
  emitTeamChange(event: RuntimeDeliveryTeamChangeEvent): void;
  logger: RuntimeDeliveryLogger;
}

export type OpenCodePromptDeliveryLedgerPorts = OpenCodeRuntimeDeliveryStorePaths;

export type OpenCodeDeliveryIdentityResolution =
  | {
      ok: true;
      canonicalMemberName: string;
      laneId: string;
    }
  | {
      ok: false;
      reason: 'recipient_is_not_opencode' | 'recipient_removed' | 'opencode_recipient_unavailable';
    };

export interface OpenCodeRuntimeDeliveryStatusPorts extends OpenCodeRuntimeDeliveryStorePaths {
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore;
  decideOpenCodeRuntimeDeliveryUserFacingAdvisory(
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<{
    record: OpenCodePromptDeliveryLedgerRecord;
    decision: Parameters<typeof toOpenCodeRuntimeDeliveryStatus>[0]['decision'];
  }>;
}

export interface OpenCodeActivePromptDeliveryRecordPorts extends OpenCodeRuntimeDeliveryStorePaths {
  resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeDeliveryIdentityResolution>;
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<boolean>;
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore;
}

export interface OpenCodeMemberDeliveryBusyStatus {
  busy: boolean;
  reason?: string;
  retryAfterIso?: string;
  activeMessageId?: string;
  activeMessageKind?: string | null;
}

export interface OpenCodeMemberDeliveryBusyStatusPorts extends OpenCodeRuntimeDeliveryStorePaths {
  isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean>;
  inboxReader: Pick<TeamInboxReader, 'getMessagesFor'>;
  getOpenCodeAgendaSyncRecoveryBypassMessageIds(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    taskRefs?: TaskRef[];
    foregroundMessages: InboxMessage[];
  }): Promise<Set<string>>;
  tryGetActiveOpenCodePromptDeliveryRecord(input: {
    teamName: string;
    memberName: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null>;
  scheduleOpenCodeMemberInboxDeliveryWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }): void;
  resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeDeliveryIdentityResolution>;
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<boolean>;
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore;
}

export interface OpenCodeRuntimeDeliveryPortsDependencies {
  sentMessagesStore: Pick<TeamSentMessagesStore, 'appendMessage' | 'readMessages'>;
  inboxReader: Pick<TeamInboxReader, 'getMessagesFor'>;
  inboxWriter: Pick<TeamInboxWriter, 'sendMessage'>;
  getCrossTeamSender: () => OpenCodeRuntimeDeliveryCrossTeamSender | null;
}

export interface OpenCodeRuntimeDeliveryJournalRecoveryPorts extends OpenCodeRuntimeDeliveryStorePaths {
  createOpenCodeRuntimeDeliveryPorts(): RuntimeDeliveryDestinationPort[];
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  nowIso(): string;
  logger: RuntimeDeliveryLogger;
}

export type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<
  Run extends OpenCodeRuntimeCheckinRun,
> = Omit<OpenCodeRuntimeCheckinPortCallbacks<Run>, 'teamsBasePath'> &
  OpenCodeRuntimeDeliveryPortsDependencies & {
    getTeamsBasePath(): string;
    logger: RuntimeDeliveryLogger;
    isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean>;
    getOpenCodeAgendaSyncRecoveryBypassMessageIds(input: {
      teamName: string;
      memberName: string;
      workSyncIntent?: 'agenda_sync' | 'review_pickup';
      taskRefs?: TaskRef[];
      foregroundMessages: InboxMessage[];
    }): Promise<Set<string>>;
    resolveOpenCodeMemberDeliveryIdentity(
      teamName: string,
      memberName: string
    ): Promise<OpenCodeDeliveryIdentityResolution>;
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
      teamName: string;
      memberName: string;
    }): Promise<boolean>;
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input: {
      teamName: string;
      memberName: string;
      laneId: string;
    }): Promise<boolean>;
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory(
      record: OpenCodePromptDeliveryLedgerRecord
    ): Promise<{
      record: OpenCodePromptDeliveryLedgerRecord;
      decision: Parameters<typeof toOpenCodeRuntimeDeliveryStatus>[0]['decision'];
    }>;
    isOpenCodePromptDeliveryWatchdogEnabled(): boolean;
    scheduleOpenCodePromptDeliveryWatchdog(input: {
      teamName: string;
      memberName: string;
      messageId?: string | null;
      delayMs: number;
    }): void;
    readLaunchStateForDeliveryRecovery(
      teamName: string
    ): Promise<PersistedTeamLaunchSnapshot | null>;
    nowIso(): string;
  };

export function createTeamProvisioningOpenCodeRuntimeDeliveryBoundary<
  Run extends OpenCodeRuntimeCheckinRun,
>(
  ports: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<Run>
): Omit<OpenCodeRuntimeControlPort, 'answerOpenCodeRuntimePermission'> & {
  createOpenCodeRuntimeCheckinPorts(): OpenCodeRuntimeCheckinPorts<Run>;
  createOpenCodeRuntimeDeliveryService(teamName: string, laneId: string): RuntimeDeliveryService;
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore;
  getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null>;
  tryGetActiveOpenCodePromptDeliveryRecord(input: {
    teamName: string;
    memberName: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null>;
  getOpenCodeMemberDeliveryBusyStatus(input: {
    teamName: string;
    memberName: string;
    nowIso: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    workSyncIntentKey?: string;
    taskRefs?: TaskRef[];
  }): Promise<OpenCodeMemberDeliveryBusyStatus>;
  scheduleOpenCodeMemberInboxDeliveryWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }): void;
  createOpenCodeRuntimeDeliveryPorts(): RuntimeDeliveryDestinationPort[];
  recoverOpenCodeRuntimeDeliveryJournal(teamName: string): Promise<{ recovered: true }>;
} {
  const createCheckinPorts = (): OpenCodeRuntimeCheckinPorts<Run> =>
    createOpenCodeRuntimeCheckinPorts<Run>({
      ...ports,
      teamsBasePath: ports.getTeamsBasePath(),
    });

  const createDeliveryDestinationPorts = (): RuntimeDeliveryDestinationPort[] =>
    createOpenCodeRuntimeDeliveryPorts({
      sentMessagesStore: ports.sentMessagesStore,
      inboxReader: ports.inboxReader,
      inboxWriter: ports.inboxWriter,
      getCrossTeamSender: ports.getCrossTeamSender,
    });

  const createDeliveryService = (teamName: string, laneId: string): RuntimeDeliveryService =>
    createOpenCodeRuntimeDeliveryService(teamName, laneId, {
      teamsBasePath: ports.getTeamsBasePath(),
      resolveCurrentOpenCodeRuntimeRunId: (candidateTeamName, candidateLaneId) =>
        ports.resolveCurrentOpenCodeRuntimeRunId(candidateTeamName, candidateLaneId),
      createOpenCodeRuntimeDeliveryPorts: createDeliveryDestinationPorts,
      emitTeamChange: (event) => {
        ports.emitTeamChange({
          type: event.type as TeamChangeEvent['type'],
          teamName: event.teamName,
          detail: typeof event.data?.detail === 'string' ? event.data.detail : undefined,
        });
      },
      logger: ports.logger,
    });

  const createPromptDeliveryLedger = (
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore =>
    createOpenCodePromptDeliveryLedger(teamName, laneId, {
      teamsBasePath: ports.getTeamsBasePath(),
    });

  const tryGetActivePromptDeliveryRecord = (input: {
    teamName: string;
    memberName: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null> =>
    tryGetActiveOpenCodePromptDeliveryRecord(input, {
      teamsBasePath: ports.getTeamsBasePath(),
      resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
        ports.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (recoverInput) =>
        ports.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(recoverInput),
      createOpenCodePromptDeliveryLedger: createPromptDeliveryLedger,
    });

  const scheduleMemberInboxDeliveryWake = (input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }): void => {
    const teamName = input.teamName.trim();
    const memberName = input.memberName.trim();
    const messageId = input.messageId.trim();
    if (
      !teamName ||
      !memberName ||
      !messageId ||
      !ports.isOpenCodePromptDeliveryWatchdogEnabled()
    ) {
      return;
    }
    ports.scheduleOpenCodePromptDeliveryWatchdog({
      teamName,
      memberName,
      messageId,
      delayMs: Math.max(0, input.delayMs ?? 500),
    });
  };

  return {
    createOpenCodeRuntimeCheckinPorts: createCheckinPorts,
    recordOpenCodeRuntimeBootstrapCheckin: (raw) =>
      recordOpenCodeRuntimeBootstrapCheckin(raw, createCheckinPorts()),
    async deliverOpenCodeRuntimeMessage(raw) {
      const payload = asRuntimeRecord(raw);
      const teamName = requireRuntimeString(payload.teamName, 'teamName');
      const runId = requireRuntimeString(payload.runId, 'runId');
      const fromMemberName = requireRuntimeString(payload.fromMemberName, 'fromMemberName');
      const laneId = await ports.resolveOpenCodeRuntimeLaneId({
        teamName,
        runId,
        memberName: fromMemberName,
      });
      await assertOpenCodeRuntimeEvidenceAccepted(
        {
          teamName,
          runId,
          laneId,
          evidenceKind: 'delivery_call',
        },
        createCheckinPorts()
      );

      const delivery = createDeliveryService(teamName, laneId);
      const ack = await delivery.deliver({
        ...payload,
        teamName,
        runId,
        providerId: 'opencode',
        createdAt: normalizeRuntimeIso(payload.createdAt),
      });

      if (!ack.ok) {
        throw new Error(`OpenCode runtime delivery rejected: ${ack.reason}`);
      }

      return {
        ok: true,
        providerId: 'opencode',
        teamName,
        runId,
        state: ack.delivered ? 'delivered' : 'duplicate',
        idempotencyKey: ack.idempotencyKey,
        location: ack.location,
        diagnostics: ack.reason ? [ack.reason] : [],
        observedAt: normalizeRuntimeIso(payload.createdAt),
      };
    },
    recordOpenCodeRuntimeTaskEvent: (raw) =>
      recordOpenCodeRuntimeTaskEvent(raw, createCheckinPorts()),
    recordOpenCodeRuntimeHeartbeat: (raw) =>
      recordOpenCodeRuntimeHeartbeat(raw, createCheckinPorts()),
    createOpenCodeRuntimeDeliveryService: createDeliveryService,
    createOpenCodePromptDeliveryLedger: createPromptDeliveryLedger,
    getOpenCodeRuntimeDeliveryStatus: (teamName, messageId) =>
      getOpenCodeRuntimeDeliveryStatus(teamName, messageId, {
        teamsBasePath: ports.getTeamsBasePath(),
        createOpenCodePromptDeliveryLedger: createPromptDeliveryLedger,
        decideOpenCodeRuntimeDeliveryUserFacingAdvisory: (record) =>
          ports.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(record),
      }),
    tryGetActiveOpenCodePromptDeliveryRecord: tryGetActivePromptDeliveryRecord,
    getOpenCodeMemberDeliveryBusyStatus: (input) =>
      getOpenCodeMemberDeliveryBusyStatus(input, {
        teamsBasePath: ports.getTeamsBasePath(),
        isOpenCodeRuntimeRecipient: (teamName, memberName) =>
          ports.isOpenCodeRuntimeRecipient(teamName, memberName),
        inboxReader: ports.inboxReader,
        getOpenCodeAgendaSyncRecoveryBypassMessageIds: (bypassInput) =>
          ports.getOpenCodeAgendaSyncRecoveryBypassMessageIds(bypassInput),
        tryGetActiveOpenCodePromptDeliveryRecord: tryGetActivePromptDeliveryRecord,
        scheduleOpenCodeMemberInboxDeliveryWake: scheduleMemberInboxDeliveryWake,
        resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
          ports.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
        tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: (recoverInput) =>
          ports.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(recoverInput),
        tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (recoverInput) =>
          ports.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(recoverInput),
        createOpenCodePromptDeliveryLedger: createPromptDeliveryLedger,
      }),
    scheduleOpenCodeMemberInboxDeliveryWake: scheduleMemberInboxDeliveryWake,
    createOpenCodeRuntimeDeliveryPorts: createDeliveryDestinationPorts,
    recoverOpenCodeRuntimeDeliveryJournal: (teamName) =>
      recoverOpenCodeRuntimeDeliveryJournal(teamName, {
        teamsBasePath: ports.getTeamsBasePath(),
        createOpenCodeRuntimeDeliveryPorts: createDeliveryDestinationPorts,
        readLaunchState: (candidateTeamName) =>
          ports.readLaunchStateForDeliveryRecovery(candidateTeamName),
        nowIso: ports.nowIso,
        logger: ports.logger,
      }),
  };
}

export function createOpenCodeRuntimeDeliveryService(
  teamName: string,
  laneId: string,
  ports: OpenCodeRuntimeDeliveryServicePorts
): RuntimeDeliveryService {
  const journal = createRuntimeDeliveryJournalStore({
    filePath: getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath: ports.teamsBasePath,
      teamName,
      laneId,
      fileName: 'opencode-delivery-journal.json',
    }),
  });
  return new RuntimeDeliveryService(
    {
      getCurrentRunId: async (candidateTeamName) =>
        ports.resolveCurrentOpenCodeRuntimeRunId(candidateTeamName, laneId),
    },
    journal,
    new RuntimeDeliveryDestinationRegistry(ports.createOpenCodeRuntimeDeliveryPorts()),
    {
      append: async (event) => {
        ports.logger.warn(`[${event.teamName}] ${event.message}`);
      },
    },
    {
      emit: (event) => ports.emitTeamChange(event),
    }
  );
}

export function createOpenCodePromptDeliveryLedger(
  teamName: string,
  laneId: string,
  ports: OpenCodePromptDeliveryLedgerPorts
): OpenCodePromptDeliveryLedgerStore {
  return createOpenCodePromptDeliveryLedgerStore({
    filePath: getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath: ports.teamsBasePath,
      teamName,
      laneId,
      fileName: 'opencode-prompt-delivery-ledger.json',
    }),
  });
}

export async function getOpenCodeRuntimeDeliveryStatus(
  teamName: string,
  messageId: string,
  ports: OpenCodeRuntimeDeliveryStatusPorts
): Promise<OpenCodeRuntimeDeliveryStatus | null> {
  const normalizedMessageId = messageId.trim();
  if (!normalizedMessageId) {
    return null;
  }
  const laneIndex = await readOpenCodeRuntimeLaneIndex(ports.teamsBasePath, teamName).catch(
    () => null
  );
  const laneIds = [
    ...new Set(
      Object.values(laneIndex?.lanes ?? {})
        .map((entry) => entry.laneId.trim())
        .filter(Boolean)
    ),
  ];
  let recordForStatus: OpenCodePromptDeliveryLedgerRecord | null = null;
  for (const laneId of laneIds) {
    const records = await ports
      .createOpenCodePromptDeliveryLedger(teamName, laneId)
      .list()
      .catch(() => []);
    for (const record of records) {
      if (
        record.inboxMessageId === normalizedMessageId &&
        (!recordForStatus || isOpenCodePromptDeliveryRecordNewer(record, recordForStatus))
      ) {
        recordForStatus = record;
      }
    }
  }
  if (!recordForStatus) {
    return null;
  }
  const { record: latestRecord, decision } =
    await ports.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(recordForStatus);
  return toOpenCodeRuntimeDeliveryStatus({ record: latestRecord, decision });
}

function isOpenCodePromptDeliveryRecordNewer(
  candidate: OpenCodePromptDeliveryLedgerRecord,
  current: OpenCodePromptDeliveryLedgerRecord
): boolean {
  const candidateTimestamp = getOpenCodePromptDeliveryRecordEffectiveTimestamp(candidate);
  const currentTimestamp = getOpenCodePromptDeliveryRecordEffectiveTimestamp(current);

  if (candidateTimestamp === null) {
    return false;
  }
  if (currentTimestamp === null) {
    return true;
  }

  // Preserve the first record encountered when effective timestamps tie. This also keeps
  // entirely invalid timestamp records deterministic in the lane/ledger traversal order.
  return candidateTimestamp > currentTimestamp;
}

function getOpenCodePromptDeliveryRecordEffectiveTimestamp(
  record: OpenCodePromptDeliveryLedgerRecord
): number | null {
  const updatedAt = Date.parse(record.updatedAt);
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }

  const createdAt = Date.parse(record.createdAt);
  return Number.isFinite(createdAt) ? createdAt : null;
}

export async function tryGetActiveOpenCodePromptDeliveryRecord(
  input: { teamName: string; memberName: string },
  ports: OpenCodeActivePromptDeliveryRecordPorts
): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
  const identity = await ports
    .resolveOpenCodeMemberDeliveryIdentity(input.teamName, input.memberName)
    .catch(() => null);
  if (!identity?.ok) {
    return null;
  }
  const laneIndex = await readOpenCodeRuntimeLaneIndex(ports.teamsBasePath, input.teamName).catch(
    () => null
  );
  if (laneIndex?.lanes[identity.laneId]?.state !== 'active') {
    const recovered = await ports.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive({
      teamName: input.teamName,
      memberName: identity.canonicalMemberName,
      laneId: identity.laneId,
    });
    if (!recovered) {
      return null;
    }
  }
  return await ports
    .createOpenCodePromptDeliveryLedger(input.teamName, identity.laneId)
    .getActiveForMember({
      teamName: input.teamName,
      memberName: identity.canonicalMemberName,
      laneId: identity.laneId,
    })
    .catch(() => null);
}

export async function getOpenCodeMemberDeliveryBusyStatus(
  input: {
    teamName: string;
    memberName: string;
    nowIso: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    workSyncIntentKey?: string;
    taskRefs?: TaskRef[];
  },
  ports: OpenCodeMemberDeliveryBusyStatusPorts
): Promise<OpenCodeMemberDeliveryBusyStatus> {
  if (!(await ports.isOpenCodeRuntimeRecipient(input.teamName, input.memberName))) {
    return { busy: false };
  }

  const nowMs = Date.parse(input.nowIso);
  const retryAfterIso = new Date(
    (Number.isFinite(nowMs) ? nowMs : Date.now()) + 60_000
  ).toISOString();

  const identity = await ports.resolveOpenCodeMemberDeliveryIdentity(
    input.teamName,
    input.memberName
  );
  if (!identity.ok) {
    return { busy: true, reason: identity.reason, retryAfterIso };
  }

  let laneIndex = await readOpenCodeRuntimeLaneIndex(ports.teamsBasePath, input.teamName).catch(
    () => null
  );
  if (laneIndex?.lanes[identity.laneId]?.state !== 'active') {
    const recovered = await ports
      .tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery({
        teamName: input.teamName,
        memberName: identity.canonicalMemberName,
      })
      .catch(() => false);
    if (recovered) {
      laneIndex = await readOpenCodeRuntimeLaneIndex(ports.teamsBasePath, input.teamName).catch(
        () => laneIndex
      );
    }
  }
  const hasActiveLane = laneIndex?.lanes[identity.laneId]?.state === 'active';

  let inboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>>;
  try {
    inboxMessages = await ports.inboxReader.getMessagesFor(input.teamName, input.memberName);
  } catch {
    return {
      busy: true,
      reason: 'opencode_inbox_read_failed',
      retryAfterIso,
    };
  }

  const foregroundMessages = inboxMessages.filter(
    (message) => message.messageKind !== 'member_work_sync_nudge'
  );
  const agendaSyncRecoveryBypassMessageIds =
    await ports.getOpenCodeAgendaSyncRecoveryBypassMessageIds({
      teamName: input.teamName,
      memberName: input.memberName,
      workSyncIntent: input.workSyncIntent,
      taskRefs: input.taskRefs,
      foregroundMessages,
    });
  const blockingForegroundMessages = foregroundMessages.filter((message) => {
    const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
    return (
      !agendaSyncRecoveryBypassMessageIds.has(messageId) &&
      !isCurrentReviewPickupRequestForegroundMessage(message, input) &&
      !isCurrentProofMissingRecoveryForegroundMessage(message, input)
    );
  });
  const unreadForeground = blockingForegroundMessages.find(
    (message) =>
      !message.read &&
      typeof message.text === 'string' &&
      message.text.trim().length > 0 &&
      hasStableInboxMessageId(message)
  );
  if (unreadForeground?.messageId) {
    if (hasActiveLane) {
      const activeRecord = await ports.tryGetActiveOpenCodePromptDeliveryRecord({
        teamName: input.teamName,
        memberName: input.memberName,
      });
      if (activeRecord) {
        return buildOpenCodePromptDeliveryActiveBusyStatus({
          teamName: input.teamName,
          memberName: input.memberName,
          retryAfterIso,
          nowMs: Number.isFinite(nowMs) ? nowMs : undefined,
          activeRecord,
          scheduleWake: (wakeInput) => ports.scheduleOpenCodeMemberInboxDeliveryWake(wakeInput),
        });
      }
    }
    ports.scheduleOpenCodeMemberInboxDeliveryWake({
      teamName: input.teamName,
      memberName: input.memberName,
      messageId: unreadForeground.messageId,
      delayMs: 500,
    });
    return {
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      retryAfterIso,
      activeMessageId: unreadForeground.messageId,
      activeMessageKind: unreadForeground.messageKind ?? null,
    };
  }

  const recentForeground = blockingForegroundMessages.find((message) => {
    const timestampMs = Date.parse(message.timestamp);
    return Number.isFinite(timestampMs) && Number.isFinite(nowMs) && nowMs - timestampMs < 60_000;
  });
  if (recentForeground?.messageId) {
    return {
      busy: true,
      reason: 'opencode_foreground_inbox_recent',
      retryAfterIso,
      activeMessageId: recentForeground.messageId,
      activeMessageKind: recentForeground.messageKind ?? null,
    };
  }

  if (!laneIndex) {
    return { busy: true, reason: 'opencode_lane_index_unavailable', retryAfterIso };
  }
  if (!hasActiveLane) {
    return { busy: true, reason: 'opencode_no_active_lane', retryAfterIso };
  }

  let activeRecord: OpenCodePromptDeliveryLedgerRecord | null;
  try {
    activeRecord = await ports
      .createOpenCodePromptDeliveryLedger(input.teamName, identity.laneId)
      .getActiveForMember({
        teamName: input.teamName,
        memberName: identity.canonicalMemberName,
        laneId: identity.laneId,
      });
  } catch {
    return {
      busy: true,
      reason: 'opencode_prompt_ledger_unavailable',
      retryAfterIso,
    };
  }
  if (activeRecord) {
    return buildOpenCodePromptDeliveryActiveBusyStatus({
      teamName: input.teamName,
      memberName: input.memberName,
      retryAfterIso,
      nowMs: Number.isFinite(nowMs) ? nowMs : undefined,
      activeRecord,
      scheduleWake: (wakeInput) => ports.scheduleOpenCodeMemberInboxDeliveryWake(wakeInput),
    });
  }

  return { busy: false };
}

export function createOpenCodeRuntimeDeliveryPorts(
  deps: OpenCodeRuntimeDeliveryPortsDependencies
): RuntimeDeliveryDestinationPort[] {
  return createOpenCodeRuntimeDeliveryDestinationPorts(deps);
}

export async function recoverOpenCodeRuntimeDeliveryJournal(
  teamName: string,
  ports: OpenCodeRuntimeDeliveryJournalRecoveryPorts
): Promise<{ recovered: true }> {
  const laneIndex = await readOpenCodeRuntimeLaneIndex(ports.teamsBasePath, teamName).catch(() => ({
    version: 1 as const,
    updatedAt: ports.nowIso(),
    lanes: {},
  }));
  const launchSnapshot =
    Object.keys(laneIndex.lanes).length > 0
      ? null
      : await ports.readLaunchState(teamName).catch(() => null);
  const recoveryLaneIds = getOpenCodeRuntimeRecoveryLaneIds({
    laneIndexEntries: laneIndex.lanes,
    launchSnapshot,
  });
  for (const laneId of recoveryLaneIds) {
    const journal = createRuntimeDeliveryJournalStore({
      filePath: getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: ports.teamsBasePath,
        teamName,
        laneId,
        fileName: 'opencode-delivery-journal.json',
      }),
    });
    const reconciler = new RuntimeDeliveryReconciler(
      journal,
      new RuntimeDeliveryDestinationRegistry(ports.createOpenCodeRuntimeDeliveryPorts()),
      {
        append: async (event) => {
          ports.logger.warn(`[${event.teamName}] ${event.message}`);
        },
      }
    );
    await reconciler.reconcileTeam(teamName);
  }
  return { recovered: true };
}

export function getOpenCodeRuntimeRecoveryLaneIds(input: {
  laneIndexEntries?: Record<string, Pick<OpenCodeRuntimeLaneIndexEntry, 'laneId'>>;
  launchSnapshot?: Pick<PersistedTeamLaunchSnapshot, 'members'> | null;
}): string[] {
  const laneIds = Object.keys(input.laneIndexEntries ?? {});
  if (laneIds.length > 0) {
    return laneIds;
  }

  const snapshotLaneIds = Array.from(
    new Set(
      Object.values(input.launchSnapshot?.members ?? {})
        .map((member) =>
          member?.laneOwnerProviderId === 'opencode' && typeof member.laneId === 'string'
            ? member.laneId.trim()
            : ''
        )
        .filter((laneId) => laneId.length > 0)
    )
  );
  return snapshotLaneIds.length > 0 ? snapshotLaneIds : ['primary'];
}
