import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';

import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
} from './opencode/delivery/OpenCodePromptDeliveryLedger';
import { selectOpenCodeRuntimeDeliveryReason } from './opencode/delivery/OpenCodeRuntimeDeliveryDiagnostics';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  readOpenCodeRuntimeLaneIndex,
} from './opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import { TeamTaskReader } from './TeamTaskReader';

import type {
  MemberLogSummary,
  MemberRuntimeAdvisory,
  ResolvedTeamMember,
  TeamTask,
} from '@shared/types';

interface RuntimeAdvisoryLogFileRef {
  memberName: string;
  filePath: string;
  mtimeMs: number;
}

interface RuntimeAdvisoryLogsFinder {
  findMemberLogs(
    teamName: string,
    memberName: string,
    mtimeSinceMs?: number | null
  ): Promise<Pick<MemberLogSummary, 'filePath'>[]>;
  findRecentMemberLogFileRefsByMember?(
    teamName: string,
    memberNames: readonly string[],
    mtimeSinceMs?: number | null
  ): Promise<RuntimeAdvisoryLogFileRef[]>;
}

const LOOKBACK_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 30_000;
const TAIL_BYTES = 64 * 1024;
const BATCH_WARN_MS = 1_000;
const ADVISORY_FETCH_CONCURRENCY = 2;
const OPENCODE_DELIVERY_ERROR_LOOKBACK_MS = 30 * 60 * 1000;
const QUOTA_EXHAUSTED_TOKENS = [
  'exhausted your capacity',
  'capacity exceeded',
  'quota exceeded',
  'quota exhausted',
  'insufficient credits',
  'key limit exceeded',
  'total limit',
];
const RATE_LIMITED_TOKENS = [
  'rate limit',
  'too many requests',
  '429',
  'model cooldown',
  'cooling down',
];
const AUTH_ERROR_TOKENS = [
  'auth_unavailable',
  'no auth available',
  'authentication_failed',
  'unauthorized',
  'forbidden',
  'invalid api key',
  'authentication',
  'api key',
  'does not have access',
  'please run /login',
];
const CODEX_NATIVE_TIMEOUT_TOKENS = ['codex native exec timed out'];
const NETWORK_ERROR_TOKENS = [
  'timeout',
  'timed out',
  'network',
  'connection',
  'econn',
  'enotfound',
  'fetch failed',
];
const PROVIDER_OVERLOADED_TOKENS = [
  'overloaded',
  'temporarily unavailable',
  'service unavailable',
  '503',
];
const PROTOCOL_PROOF_MISSING_TOKENS = [
  'non_visible_tool_without_task_progress',
  'visible_reply_still_required',
  'visible_reply_ack_only_still_requires_answer',
  'plain_text_ack_only_still_requires_answer',
  'visible_reply_destination_not_found_yet',
  'visible_reply_missing_relayofmessageid',
  'visible_reply_missing_task_refs',
  'visible_reply_missing_task_refs_after_merge',
  'visible_reply_task_refs_merge_failed',
  'did not create a visible reply',
  'did not create a visible message_send reply',
  'did not create a visible reply or task progress proof',
  'without the required relayofmessageid correlation',
  'without the required taskrefs metadata',
];
const logger = createLogger('Service:TeamMemberRuntimeAdvisory');

interface CachedRuntimeAdvisory {
  value: MemberRuntimeAdvisory | null;
  expiresAt: number;
}

interface CachedTeamBatchAdvisories {
  membersSignature: string;
  value: Map<string, MemberRuntimeAdvisory>;
  expiresAt: number;
}

interface OpenCodeRuntimeDeliverySupersedingProofTimes {
  visibleReplyTimes: ReadonlyMap<string, number>;
  taskProgressTimes: ReadonlyMap<string, number>;
}

function includesAnyToken(value: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function classifyRetryReason(message: string | undefined): MemberRuntimeAdvisory['reasonCode'] {
  const normalized = message?.trim().toLowerCase();
  if (!normalized) {
    return 'unknown';
  }
  if (includesAnyToken(normalized, QUOTA_EXHAUSTED_TOKENS)) {
    return 'quota_exhausted';
  }
  if (includesAnyToken(normalized, RATE_LIMITED_TOKENS)) {
    return 'rate_limited';
  }
  if (includesAnyToken(normalized, AUTH_ERROR_TOKENS)) {
    return 'auth_error';
  }
  if (includesAnyToken(normalized, CODEX_NATIVE_TIMEOUT_TOKENS)) {
    return 'codex_native_timeout';
  }
  if (includesAnyToken(normalized, NETWORK_ERROR_TOKENS)) {
    return 'network_error';
  }
  if (includesAnyToken(normalized, PROVIDER_OVERLOADED_TOKENS)) {
    return 'provider_overloaded';
  }
  if (includesAnyToken(normalized, PROTOCOL_PROOF_MISSING_TOKENS)) {
    return 'protocol_proof_missing';
  }
  return 'backend_error';
}

function getRecordTimeMs(record: OpenCodePromptDeliveryLedgerRecord): number {
  const candidates = [
    record.failedAt,
    record.respondedAt,
    record.lastObservedAt,
    record.updatedAt,
    record.createdAt,
  ];
  for (const candidate of candidates) {
    const time = Date.parse(candidate ?? '');
    if (Number.isFinite(time)) {
      return time;
    }
  }
  return 0;
}

function isTerminalSuccessfulRecord(record: OpenCodePromptDeliveryLedgerRecord): boolean {
  return (
    record.status === 'responded' &&
    Boolean(record.inboxReadCommittedAt || record.visibleReplyMessageId)
  );
}

function isPotentialRuntimeDeliveryError(record: OpenCodePromptDeliveryLedgerRecord): boolean {
  if (record.status === 'failed_terminal') {
    return true;
  }
  return (
    record.status !== 'responded' &&
    (record.responseState === 'session_error' ||
      record.responseState === 'tool_error' ||
      record.responseState === 'permission_blocked' ||
      record.responseState === 'reconcile_failed')
  );
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await fn(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TeamMemberRuntimeAdvisoryService {
  private readonly inboxReader = new TeamInboxReader();
  private readonly taskReader = new TeamTaskReader();
  private readonly memberCache = new Map<string, CachedRuntimeAdvisory>();
  private readonly teamBatchCacheByTeam = new Map<string, CachedTeamBatchAdvisories>();
  private readonly cacheGenerationByTeam = new Map<string, number>();
  private readonly inFlightBatchRequests = new Map<
    string,
    Promise<Map<string, MemberRuntimeAdvisory>>
  >();

  constructor(
    private readonly logsFinder: RuntimeAdvisoryLogsFinder = new TeamMemberLogsFinder()
  ) {}

  invalidateMemberAdvisory(teamName: string, memberName: string): void {
    const teamKey = this.normalizeToken(teamName);
    const memberKey = this.normalizeToken(memberName);
    if (!teamKey || !memberKey) {
      return;
    }

    this.cacheGenerationByTeam.set(teamKey, (this.cacheGenerationByTeam.get(teamKey) ?? 0) + 1);
    this.memberCache.delete(`${teamKey}::${memberKey}`);
    this.teamBatchCacheByTeam.delete(teamKey);
    for (const key of this.inFlightBatchRequests.keys()) {
      if (key.startsWith(`${teamKey}::`)) {
        this.inFlightBatchRequests.delete(key);
      }
    }
  }

  async getMemberAdvisories(
    teamName: string,
    members: readonly Pick<ResolvedTeamMember, 'name' | 'removedAt'>[]
  ): Promise<Map<string, MemberRuntimeAdvisory>> {
    const activeMembers = members.filter((member) => !member.removedAt);
    if (activeMembers.length === 0) {
      return new Map();
    }

    const teamKey = this.normalizeToken(teamName);
    const membersSignature = this.buildMembersSignature(activeMembers);
    const now = Date.now();
    const cachedBatch = this.teamBatchCacheByTeam.get(teamKey);
    if (cachedBatch?.membersSignature === membersSignature && cachedBatch.expiresAt > now) {
      return this.materializeBatchAdvisories(activeMembers, cachedBatch.value);
    }

    const inFlightKey = `${teamKey}::${membersSignature}`;
    const existingRequest = this.inFlightBatchRequests.get(inFlightKey);
    if (existingRequest) {
      return this.materializeBatchAdvisories(activeMembers, await existingRequest);
    }

    const request = this.loadBatchAdvisories(teamName, teamKey, activeMembers, membersSignature);
    this.inFlightBatchRequests.set(inFlightKey, request);

    try {
      return this.materializeBatchAdvisories(activeMembers, await request);
    } finally {
      if (this.inFlightBatchRequests.get(inFlightKey) === request) {
        this.inFlightBatchRequests.delete(inFlightKey);
      }
    }
  }

  async getMemberAdvisory(
    teamName: string,
    memberName: string
  ): Promise<MemberRuntimeAdvisory | null> {
    const teamKey = this.normalizeToken(teamName);
    const cacheKey = this.getMemberCacheKey(teamName, memberName);
    const cached = this.memberCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value ? this.cloneAdvisory(cached.value) : null;
    }

    const generationAtStart = this.cacheGenerationByTeam.get(teamKey) ?? 0;
    const advisory = await this.findRecentMemberAdvisory(teamName, memberName);
    if ((this.cacheGenerationByTeam.get(teamKey) ?? 0) === generationAtStart) {
      this.memberCache.set(cacheKey, {
        value: advisory,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
    return advisory ? this.cloneAdvisory(advisory) : null;
  }

  private async loadBatchAdvisories(
    teamName: string,
    teamKey: string,
    activeMembers: readonly Pick<ResolvedTeamMember, 'name'>[],
    membersSignature: string
  ): Promise<Map<string, MemberRuntimeAdvisory>> {
    const startedAt = performance.now();
    const now = Date.now();
    const generationAtStart = this.cacheGenerationByTeam.get(teamKey) ?? 0;
    const result = new Map<string, MemberRuntimeAdvisory>();
    const membersToFetch: string[] = [];
    let memberCacheHits = 0;
    let memberCacheMisses = 0;

    for (const member of activeMembers) {
      const normalizedMemberName = this.normalizeToken(member.name);
      const cacheKey = `${teamKey}::${normalizedMemberName}`;
      const cached = this.memberCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        memberCacheHits += 1;
        if (cached.value) {
          result.set(normalizedMemberName, this.cloneAdvisory(cached.value));
        }
        continue;
      }

      memberCacheMisses += 1;
      membersToFetch.push(member.name);
    }

    if (membersToFetch.length > 0) {
      const fetched = await this.findRecentMemberAdvisories(teamName, membersToFetch);
      const fetchedAt = Date.now();
      const cacheStillCurrent =
        (this.cacheGenerationByTeam.get(teamKey) ?? 0) === generationAtStart;
      for (const [memberName, advisory] of fetched) {
        const normalizedMemberName = this.normalizeToken(memberName);
        if (cacheStillCurrent) {
          this.memberCache.set(`${teamKey}::${normalizedMemberName}`, {
            value: advisory,
            expiresAt: fetchedAt + CACHE_TTL_MS,
          });
        }
        if (advisory) {
          result.set(normalizedMemberName, this.cloneAdvisory(advisory));
        }
      }
    }

    if ((this.cacheGenerationByTeam.get(teamKey) ?? 0) === generationAtStart) {
      this.teamBatchCacheByTeam.set(teamKey, {
        membersSignature,
        value: this.cloneNormalizedAdvisories(result),
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }

    const totalMs = performance.now() - startedAt;
    if (totalMs >= BATCH_WARN_MS) {
      logger.warn(
        `[perf] getMemberAdvisories slow team=${teamName} activeMembers=${activeMembers.length} signatureMembers=${activeMembers.length} batchCache=miss memberCacheHits=${memberCacheHits} memberCacheMisses=${memberCacheMisses} fetchedMembers=${membersToFetch.length} total=${totalMs.toFixed(1)}ms`
      );
    }

    return result;
  }

  private getMemberCacheKey(teamName: string, memberName: string): string {
    return `${this.normalizeToken(teamName)}::${this.normalizeToken(memberName)}`;
  }

  private buildMembersSignature(members: readonly Pick<ResolvedTeamMember, 'name'>[]): string {
    return Array.from(new Set(members.map((member) => this.normalizeToken(member.name))))
      .sort()
      .join('|');
  }

  private normalizeToken(value: string): string {
    return value.trim().toLowerCase();
  }

  private cloneAdvisory(advisory: MemberRuntimeAdvisory): MemberRuntimeAdvisory {
    return { ...advisory };
  }

  private cloneNormalizedAdvisories(
    advisories: ReadonlyMap<string, MemberRuntimeAdvisory>
  ): Map<string, MemberRuntimeAdvisory> {
    return new Map(
      Array.from(advisories, ([memberName, advisory]) => [memberName, this.cloneAdvisory(advisory)])
    );
  }

  private materializeBatchAdvisories(
    activeMembers: readonly Pick<ResolvedTeamMember, 'name'>[],
    advisories: ReadonlyMap<string, MemberRuntimeAdvisory>
  ): Map<string, MemberRuntimeAdvisory> {
    const materialized = new Map<string, MemberRuntimeAdvisory>();
    for (const member of activeMembers) {
      const advisory = advisories.get(this.normalizeToken(member.name));
      if (advisory) {
        materialized.set(member.name, this.cloneAdvisory(advisory));
      }
    }
    return materialized;
  }

  private async findRecentMemberAdvisory(
    teamName: string,
    memberName: string
  ): Promise<MemberRuntimeAdvisory | null> {
    const openCodeAdvisory = await this.findRecentOpenCodeDeliveryAdvisory(teamName, memberName);
    if (openCodeAdvisory) {
      return openCodeAdvisory;
    }

    const summaries = await this.logsFinder.findMemberLogs(
      teamName,
      memberName,
      Date.now() - LOOKBACK_MS
    );
    return this.findRecentMemberAdvisoryInFiles(
      summaries.flatMap((summary) => summary.filePath ?? [])
    );
  }

  private async findRecentMemberAdvisories(
    teamName: string,
    memberNames: readonly string[]
  ): Promise<readonly (readonly [string, MemberRuntimeAdvisory | null])[]> {
    const openCodeAdvisories = await this.findRecentOpenCodeDeliveryAdvisories(
      teamName,
      memberNames
    );
    const remainingMemberNames = memberNames.filter(
      (memberName) => !openCodeAdvisories.has(memberName)
    );
    if (remainingMemberNames.length === 0) {
      return memberNames.map(
        (memberName) => [memberName, openCodeAdvisories.get(memberName) ?? null] as const
      );
    }

    if (this.logsFinder.findRecentMemberLogFileRefsByMember) {
      try {
        const logAdvisories = await this.findRecentMemberAdvisoriesFromBatchRefs(
          teamName,
          remainingMemberNames
        );
        const logMap = new Map(logAdvisories);
        return memberNames.map(
          (memberName) =>
            [
              memberName,
              openCodeAdvisories.get(memberName) ?? logMap.get(memberName) ?? null,
            ] as const
        );
      } catch (error) {
        logger.warn('batch member runtime advisory log lookup failed; falling back', {
          teamName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const logAdvisories = await mapLimit(
      remainingMemberNames,
      ADVISORY_FETCH_CONCURRENCY,
      async (memberName) => {
        const summaries = await this.logsFinder.findMemberLogs(
          teamName,
          memberName,
          Date.now() - LOOKBACK_MS
        );
        return [
          memberName,
          await this.findRecentMemberAdvisoryInFiles(
            summaries.flatMap((summary) => summary.filePath ?? [])
          ),
        ] as const;
      }
    );
    const logMap = new Map(logAdvisories);
    return memberNames.map(
      (memberName) =>
        [memberName, openCodeAdvisories.get(memberName) ?? logMap.get(memberName) ?? null] as const
    );
  }

  private async findRecentOpenCodeDeliveryAdvisory(
    teamName: string,
    memberName: string
  ): Promise<MemberRuntimeAdvisory | null> {
    const advisories = await this.findRecentOpenCodeDeliveryAdvisories(teamName, [memberName]);
    return advisories.get(memberName) ?? null;
  }

  private async findRecentOpenCodeDeliveryAdvisories(
    teamName: string,
    memberNames: readonly string[]
  ): Promise<Map<string, MemberRuntimeAdvisory>> {
    const activeMembersByKey = new Map<string, string>();
    for (const memberName of memberNames) {
      const normalized = this.normalizeToken(memberName);
      if (normalized && !activeMembersByKey.has(normalized)) {
        activeMembersByKey.set(normalized, memberName);
      }
    }
    if (activeMembersByKey.size === 0) {
      return new Map();
    }

    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
      () => null
    );
    if (!laneIndex) {
      return new Map();
    }

    const now = Date.now();
    const recordsByMember = new Map<string, OpenCodePromptDeliveryLedgerRecord[]>();
    for (const lane of Object.values(laneIndex.lanes)) {
      if (lane.state === 'stopped') {
        continue;
      }
      const laneMember = this.getOpenCodeLaneMemberName(lane.laneId);
      if (!laneMember || !activeMembersByKey.has(this.normalizeToken(laneMember))) {
        continue;
      }
      const ledger = createOpenCodePromptDeliveryLedgerStore({
        filePath: getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: lane.laneId,
          fileName: 'opencode-prompt-delivery-ledger.json',
        }),
      });
      const records = await ledger.list().catch(() => []);
      const existing = recordsByMember.get(this.normalizeToken(laneMember)) ?? [];
      existing.push(...records);
      recordsByMember.set(this.normalizeToken(laneMember), existing);
    }

    const memberKeysWithRecentErrors = new Set<string>();
    for (const [memberKey, records] of recordsByMember) {
      if (
        records.some((record) => {
          const observedAt = getRecordTimeMs(record);
          return (
            isPotentialRuntimeDeliveryError(record) &&
            Number.isFinite(observedAt) &&
            now - observedAt <= OPENCODE_DELIVERY_ERROR_LOOKBACK_MS
          );
        })
      ) {
        memberKeysWithRecentErrors.add(memberKey);
      }
    }
    if (memberKeysWithRecentErrors.size === 0) {
      return new Map();
    }

    const supersedingProofTimes = await this.readOpenCodeRuntimeDeliverySupersedingProofTimes(
      teamName,
      memberKeysWithRecentErrors,
      recordsByMember
    );
    const result = new Map<string, MemberRuntimeAdvisory>();
    for (const [memberKey, records] of recordsByMember) {
      if (!memberKeysWithRecentErrors.has(memberKey)) {
        continue;
      }
      const originalName = activeMembersByKey.get(memberKey);
      const advisory = originalName
        ? this.buildOpenCodeDeliveryAdvisoryFromRecords(
            originalName,
            records,
            now,
            supersedingProofTimes
          )
        : null;
      if (advisory && originalName) {
        result.set(originalName, advisory);
      }
    }
    return result;
  }

  private getOpenCodeLaneMemberName(laneId: string): string | null {
    const parts = laneId.split(':');
    if (parts.length < 3 || parts[0] !== 'secondary' || parts[1] !== 'opencode') {
      return null;
    }
    return parts.slice(2).join(':').trim() || null;
  }

  private buildOpenCodeDeliveryAdvisoryFromRecords(
    memberName: string,
    records: readonly OpenCodePromptDeliveryLedgerRecord[],
    now: number,
    supersedingProofTimes: OpenCodeRuntimeDeliverySupersedingProofTimes
  ): MemberRuntimeAdvisory | null {
    const ordered = records
      .slice()
      .sort((left, right) => getRecordTimeMs(right) - getRecordTimeMs(left));
    const latestSuccess = ordered.find(isTerminalSuccessfulRecord);
    const latestError = ordered.find((record) => {
      const observedAt = getRecordTimeMs(record);
      return (
        isPotentialRuntimeDeliveryError(record) &&
        Number.isFinite(observedAt) &&
        now - observedAt <= OPENCODE_DELIVERY_ERROR_LOOKBACK_MS
      );
    });
    if (!latestError) {
      return null;
    }
    if (latestSuccess && getRecordTimeMs(latestSuccess) > getRecordTimeMs(latestError)) {
      return null;
    }
    if (
      this.hasSupersedingProofForOpenCodeDeliveryRecord(
        memberName,
        latestError,
        supersedingProofTimes
      )
    ) {
      return null;
    }

    const message = selectOpenCodeRuntimeDeliveryReason(latestError);
    if (!message) {
      return null;
    }
    const observedAt = getRecordTimeMs(latestError);
    return {
      kind: 'api_error',
      observedAt: new Date(Number.isFinite(observedAt) ? observedAt : now).toISOString(),
      reasonCode: classifyRetryReason(message),
      message,
    };
  }

  private async readOpenCodeRuntimeDeliverySupersedingProofTimes(
    teamName: string,
    activeMemberKeys: ReadonlySet<string>,
    recordsByMember: ReadonlyMap<string, readonly OpenCodePromptDeliveryLedgerRecord[]>
  ): Promise<OpenCodeRuntimeDeliverySupersedingProofTimes> {
    const [visibleReplyTimes, taskProgressTimes] = await Promise.all([
      this.readVisibleOpenCodeRuntimeDeliveryReplyTimes(teamName, activeMemberKeys),
      this.readTaskProgressProofTimes(teamName, activeMemberKeys, recordsByMember),
    ]);
    return { visibleReplyTimes, taskProgressTimes };
  }

  private async readVisibleOpenCodeRuntimeDeliveryReplyTimes(
    teamName: string,
    activeMemberKeys: ReadonlySet<string>
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const inboxNames = await this.inboxReader.listInboxNames(teamName).catch(() => []);
    await mapLimit(inboxNames, ADVISORY_FETCH_CONCURRENCY, async (inboxName) => {
      const messages = await this.inboxReader.getMessagesFor(teamName, inboxName).catch(() => []);
      for (const message of messages) {
        if (message.source !== 'runtime_delivery' || !message.relayOfMessageId) {
          continue;
        }
        const memberKey = this.normalizeToken(message.from);
        if (activeMemberKeys.has(memberKey)) {
          const observedAt = Date.parse(message.timestamp);
          if (!Number.isFinite(observedAt)) {
            continue;
          }
          const key = this.getOpenCodeRuntimeReplyKey(memberKey, message.relayOfMessageId);
          result.set(key, Math.max(result.get(key) ?? 0, observedAt));
        }
      }
    });
    return result;
  }

  private hasVisibleRuntimeReplyForOpenCodeDeliveryRecord(
    memberName: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    visibleRuntimeReplyTimes: ReadonlyMap<string, number>
  ): boolean {
    const relayOfMessageId = record.inboxMessageId?.trim();
    if (!relayOfMessageId) {
      return false;
    }
    const replyObservedAt = visibleRuntimeReplyTimes.get(
      this.getOpenCodeRuntimeReplyKey(this.normalizeToken(memberName), relayOfMessageId)
    );
    return typeof replyObservedAt === 'number' && replyObservedAt > getRecordTimeMs(record);
  }

  private hasSupersedingProofForOpenCodeDeliveryRecord(
    memberName: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    proofTimes: OpenCodeRuntimeDeliverySupersedingProofTimes
  ): boolean {
    if (
      this.hasVisibleRuntimeReplyForOpenCodeDeliveryRecord(
        memberName,
        record,
        proofTimes.visibleReplyTimes
      )
    ) {
      return true;
    }

    return this.hasTaskProgressProofForOpenCodeDeliveryRecord(
      memberName,
      record,
      proofTimes.taskProgressTimes
    );
  }

  private async readTaskProgressProofTimes(
    teamName: string,
    activeMemberKeys: ReadonlySet<string>,
    recordsByMember: ReadonlyMap<string, readonly OpenCodePromptDeliveryLedgerRecord[]>
  ): Promise<Map<string, number>> {
    const taskIdsByMember = new Map<string, Set<string>>();
    for (const [memberKey, records] of recordsByMember) {
      if (!activeMemberKeys.has(memberKey)) {
        continue;
      }
      for (const record of records) {
        for (const taskRef of record.taskRefs) {
          const taskId = taskRef.taskId?.trim();
          if (!taskId) {
            continue;
          }
          const taskIds = taskIdsByMember.get(memberKey) ?? new Set<string>();
          taskIds.add(taskId);
          taskIdsByMember.set(memberKey, taskIds);
        }
      }
    }
    if (taskIdsByMember.size === 0) {
      return new Map();
    }

    const tasks = await this.taskReader.getTasks(teamName).catch(() => []);
    if (tasks.length === 0) {
      return new Map();
    }

    const result = new Map<string, number>();
    for (const task of tasks) {
      const taskId = task.id?.trim();
      if (!taskId) {
        continue;
      }
      for (const [memberKey, taskIds] of taskIdsByMember) {
        if (!taskIds.has(taskId)) {
          continue;
        }
        const proofAt = this.getLatestMemberTaskProgressTime(task, memberKey);
        if (proofAt <= 0) {
          continue;
        }
        const key = this.getOpenCodeTaskProgressProofKey(memberKey, taskId);
        result.set(key, Math.max(result.get(key) ?? 0, proofAt));
      }
    }
    return result;
  }

  private getLatestMemberTaskProgressTime(task: TeamTask, memberKey: string): number {
    let latest = 0;
    for (const comment of task.comments ?? []) {
      if (this.normalizeToken(comment.author) !== memberKey) {
        continue;
      }
      const createdAt = Date.parse(comment.createdAt);
      if (Number.isFinite(createdAt)) {
        latest = Math.max(latest, createdAt);
      }
    }
    for (const event of task.historyEvents ?? []) {
      if (this.normalizeToken(event.actor ?? '') !== memberKey) {
        continue;
      }
      const timestamp = Date.parse(event.timestamp);
      if (Number.isFinite(timestamp)) {
        latest = Math.max(latest, timestamp);
      }
    }
    return latest;
  }

  private hasTaskProgressProofForOpenCodeDeliveryRecord(
    memberName: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    taskProgressTimes: ReadonlyMap<string, number>
  ): boolean {
    const recordTime = getRecordTimeMs(record);
    if (!Number.isFinite(recordTime) || recordTime <= 0 || record.taskRefs.length === 0) {
      return false;
    }
    const memberKey = this.normalizeToken(memberName);
    return record.taskRefs.some((taskRef) => {
      const taskId = taskRef.taskId?.trim();
      if (!taskId) {
        return false;
      }
      const proofAt = taskProgressTimes.get(
        this.getOpenCodeTaskProgressProofKey(memberKey, taskId)
      );
      return typeof proofAt === 'number' && proofAt > recordTime;
    });
  }

  private getOpenCodeRuntimeReplyKey(memberKey: string, relayOfMessageId: string): string {
    return `${memberKey}::${relayOfMessageId.trim()}`;
  }

  private getOpenCodeTaskProgressProofKey(memberKey: string, taskId: string): string {
    return `${memberKey}::task::${taskId.trim()}`;
  }

  private async findRecentMemberAdvisoriesFromBatchRefs(
    teamName: string,
    memberNames: readonly string[]
  ): Promise<readonly (readonly [string, MemberRuntimeAdvisory | null])[]> {
    const memberNamesByKey = new Map<string, string>();
    for (const memberName of memberNames) {
      const normalized = this.normalizeToken(memberName);
      if (!memberNamesByKey.has(normalized)) {
        memberNamesByKey.set(normalized, memberName);
      }
    }

    const refs = await this.logsFinder.findRecentMemberLogFileRefsByMember!(
      teamName,
      memberNames,
      Date.now() - LOOKBACK_MS
    );
    const refsByMember = new Map<string, RuntimeAdvisoryLogFileRef[]>();
    for (const ref of refs) {
      const normalizedMemberName = this.normalizeToken(ref.memberName);
      if (!memberNamesByKey.has(normalizedMemberName)) {
        continue;
      }
      const bucket = refsByMember.get(normalizedMemberName) ?? [];
      bucket.push(ref);
      refsByMember.set(normalizedMemberName, bucket);
    }

    return mapLimit(memberNames, ADVISORY_FETCH_CONCURRENCY, async (memberName) => {
      const normalizedMemberName = this.normalizeToken(memberName);
      const refsForMember = refsByMember.get(normalizedMemberName) ?? [];
      const seenFilePaths = new Set<string>();
      const filePaths = refsForMember
        .slice()
        .sort((left, right) => right.mtimeMs - left.mtimeMs)
        .flatMap((ref) => {
          if (!ref.filePath || seenFilePaths.has(ref.filePath)) {
            return [];
          }
          seenFilePaths.add(ref.filePath);
          return [ref.filePath];
        });
      return [memberName, await this.findRecentMemberAdvisoryInFiles(filePaths)] as const;
    });
  }

  private async findRecentMemberAdvisoryInFiles(
    filePaths: readonly string[]
  ): Promise<MemberRuntimeAdvisory | null> {
    for (const filePath of filePaths) {
      const advisory = await this.readRecentApiRetryAdvisory(filePath);
      if (advisory) {
        return advisory;
      }
    }
    return null;
  }

  private async readRecentApiRetryAdvisory(
    filePath: string
  ): Promise<MemberRuntimeAdvisory | null> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(filePath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0) {
        return null;
      }
      const start = Math.max(0, stat.size - TAIL_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      if (buffer.length === 0) {
        return null;
      }
      await handle.read(buffer, 0, buffer.length, start);
      const tail = buffer.toString('utf8');
      const lines = tail.split('\n');
      if (start > 0) {
        lines.shift();
      }
      const now = Date.now();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim() ?? '';
        const advisory =
          this.extractApiRetryAdvisory(line, now) ?? this.extractApiErrorAdvisory(line, now);
        if (advisory) {
          return advisory;
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private extractApiRetryAdvisory(line: string, now = Date.now()): MemberRuntimeAdvisory | null {
    if (
      !line ||
      (!line.includes('"subtype":"api_error"') && !line.includes('"subtype": "api_error"'))
    ) {
      return null;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        retryInMs?: number;
        timestamp?: string;
        error?: {
          message?: string;
          error?: {
            message?: string;
            error?: {
              message?: string;
            };
          };
        };
      };

      if (parsed.type !== 'system' || parsed.subtype !== 'api_error') {
        return null;
      }

      const retryInMs =
        typeof parsed.retryInMs === 'number' &&
        Number.isFinite(parsed.retryInMs) &&
        parsed.retryInMs > 0
          ? parsed.retryInMs
          : null;
      const observedAt =
        typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
      if (!retryInMs || !Number.isFinite(observedAt)) {
        return null;
      }

      const retryUntil = observedAt + retryInMs;
      if (retryUntil <= now) {
        return null;
      }

      const message =
        parsed.error?.error?.error?.message?.trim() ||
        parsed.error?.error?.message?.trim() ||
        parsed.error?.message?.trim() ||
        undefined;

      return {
        kind: 'sdk_retrying',
        observedAt: new Date(observedAt).toISOString(),
        retryUntil: new Date(retryUntil).toISOString(),
        retryDelayMs: retryInMs,
        reasonCode: classifyRetryReason(message),
        ...(message ? { message } : {}),
      };
    } catch {
      return null;
    }
  }

  private extractApiErrorAdvisory(line: string, now = Date.now()): MemberRuntimeAdvisory | null {
    if (
      !line ||
      (!line.includes('"isApiErrorMessage":true') &&
        !line.includes('"isApiErrorMessage": true') &&
        !line.includes('"error":"authentication_failed"') &&
        !line.includes('"error": "authentication_failed"'))
    ) {
      return null;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        timestamp?: string;
        error?: string;
        isApiErrorMessage?: boolean;
        message?: {
          content?: { type?: string; text?: string }[];
        };
      };

      if (parsed.type !== 'assistant') {
        return null;
      }

      const observedAt =
        typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
      if (!Number.isFinite(observedAt) || observedAt < now - LOOKBACK_MS) {
        return null;
      }

      const message = this.extractAssistantText(parsed.message?.content);
      if (!parsed.isApiErrorMessage && parsed.error !== 'authentication_failed') {
        return null;
      }
      if (!message && parsed.error !== 'authentication_failed') {
        return null;
      }

      const statusMatch = /^API Error:\s*(\d{3})/.exec(message);
      return {
        kind: 'api_error',
        observedAt: new Date(observedAt).toISOString(),
        reasonCode: classifyRetryReason(message || parsed.error),
        ...(message ? { message } : {}),
        ...(statusMatch ? { statusCode: Number(statusMatch[1]) } : {}),
      };
    } catch {
      return null;
    }
  }

  private extractAssistantText(content: { type?: string; text?: string }[] | undefined): string {
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text?.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }
}
