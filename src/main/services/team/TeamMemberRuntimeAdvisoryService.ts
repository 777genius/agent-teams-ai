import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';

import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
} from './opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  decideOpenCodeRuntimeDeliveryAdvisory,
  getOpenCodeRuntimeDeliveryRecordTimeMs,
  isPotentialOpenCodeRuntimeDeliveryError,
  isTerminalSuccessfulOpenCodeDeliveryRecord,
} from './opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import {
  type OpenCodeRuntimeDeliveryProofIndex,
  OpenCodeRuntimeDeliveryProofReader,
} from './opencode/delivery/OpenCodeRuntimeDeliveryProofReader';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  readOpenCodeRuntimeLaneIndex,
} from './opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { classifyRuntimeDiagnostic } from './runtime/RuntimeDiagnosticClassifier';
import { TeamMemberLogsFinder } from './TeamMemberLogsFinder';

import type { MemberLogSummary, MemberRuntimeAdvisory, ResolvedTeamMember } from '@shared/types';

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

interface RuntimeAdvisoryLookupOptions {
  observedAfterMs?: number | null;
}

const LOOKBACK_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 30_000;
const TAIL_BYTES = 64 * 1024;
const BATCH_WARN_MS = 1_000;
const ADVISORY_FETCH_CONCURRENCY = 2;
const OPENCODE_DELIVERY_ERROR_LOOKBACK_MS = 30 * 60 * 1000;
const logger = createLogger('Service:TeamMemberRuntimeAdvisory');

interface CachedRuntimeAdvisory {
  value: MemberRuntimeAdvisory | null;
  expiresAt: number;
}

interface CachedTeamBatchAdvisories {
  membersSignature: string;
  observedAfterScopeKey: string;
  value: Map<string, MemberRuntimeAdvisory>;
  expiresAt: number;
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
  private readonly memberCache = new Map<string, CachedRuntimeAdvisory>();
  private readonly teamBatchCacheByTeam = new Map<string, CachedTeamBatchAdvisories>();
  private readonly cacheGenerationByTeam = new Map<string, number>();
  private readonly inFlightBatchRequests = new Map<
    string,
    Promise<Map<string, MemberRuntimeAdvisory>>
  >();

  constructor(
    private readonly logsFinder: RuntimeAdvisoryLogsFinder = new TeamMemberLogsFinder(),
    private readonly proofReader = new OpenCodeRuntimeDeliveryProofReader()
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

  invalidateTeamAdvisories(teamName: string): void {
    const teamKey = this.normalizeToken(teamName);
    if (!teamKey) {
      return;
    }

    this.cacheGenerationByTeam.set(teamKey, (this.cacheGenerationByTeam.get(teamKey) ?? 0) + 1);
    this.teamBatchCacheByTeam.delete(teamKey);
    for (const key of this.memberCache.keys()) {
      if (key.startsWith(`${teamKey}::`)) {
        this.memberCache.delete(key);
      }
    }
    for (const key of this.inFlightBatchRequests.keys()) {
      if (key.startsWith(`${teamKey}::`)) {
        this.inFlightBatchRequests.delete(key);
      }
    }
  }

  async getMemberAdvisories(
    teamName: string,
    members: readonly Pick<ResolvedTeamMember, 'name' | 'removedAt'>[],
    options?: RuntimeAdvisoryLookupOptions
  ): Promise<Map<string, MemberRuntimeAdvisory>> {
    const activeMembers = members.filter((member) => !member.removedAt);
    if (activeMembers.length === 0) {
      return new Map();
    }

    const teamKey = this.normalizeToken(teamName);
    const membersSignature = this.buildMembersSignature(activeMembers);
    const observedAfterMs = this.normalizeObservedAfterMs(options?.observedAfterMs);
    const scopeKey = this.buildObservedAfterScopeKey(observedAfterMs);
    const now = Date.now();
    const cachedBatch = this.teamBatchCacheByTeam.get(teamKey);
    if (
      cachedBatch?.membersSignature === membersSignature &&
      cachedBatch.observedAfterScopeKey === scopeKey &&
      cachedBatch.expiresAt > now
    ) {
      return this.materializeBatchAdvisories(activeMembers, cachedBatch.value);
    }

    const inFlightKey = `${teamKey}::${membersSignature}::${scopeKey}`;
    const existingRequest = this.inFlightBatchRequests.get(inFlightKey);
    if (existingRequest) {
      return this.materializeBatchAdvisories(activeMembers, await existingRequest);
    }

    const request = this.loadBatchAdvisories(
      teamName,
      teamKey,
      activeMembers,
      membersSignature,
      observedAfterMs,
      scopeKey
    );
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
    memberName: string,
    options?: RuntimeAdvisoryLookupOptions
  ): Promise<MemberRuntimeAdvisory | null> {
    const teamKey = this.normalizeToken(teamName);
    const observedAfterMs = this.normalizeObservedAfterMs(options?.observedAfterMs);
    const cacheKey = this.getMemberCacheKey(teamName, memberName, observedAfterMs);
    const cached = this.memberCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value ? this.cloneAdvisory(cached.value) : null;
    }

    const generationAtStart = this.cacheGenerationByTeam.get(teamKey) ?? 0;
    const advisory = await this.findRecentMemberAdvisory(teamName, memberName, observedAfterMs);
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
    membersSignature: string,
    observedAfterMs: number | null,
    observedAfterScopeKey: string
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
      const cacheKey = this.getMemberCacheKey(teamName, member.name, observedAfterMs);
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
      const fetched = await this.findRecentMemberAdvisories(
        teamName,
        membersToFetch,
        observedAfterMs
      );
      const fetchedAt = Date.now();
      const cacheStillCurrent =
        (this.cacheGenerationByTeam.get(teamKey) ?? 0) === generationAtStart;
      for (const [memberName, advisory] of fetched) {
        const normalizedMemberName = this.normalizeToken(memberName);
        if (cacheStillCurrent) {
          this.memberCache.set(this.getMemberCacheKey(teamName, memberName, observedAfterMs), {
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
        observedAfterScopeKey,
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

  private getMemberCacheKey(
    teamName: string,
    memberName: string,
    observedAfterMs?: number | null
  ): string {
    return `${this.normalizeToken(teamName)}::${this.normalizeToken(memberName)}::${this.buildObservedAfterScopeKey(
      observedAfterMs
    )}`;
  }

  private normalizeObservedAfterMs(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : null;
  }

  private buildObservedAfterScopeKey(observedAfterMs: number | null | undefined): string {
    return observedAfterMs == null ? 'recent' : `after:${observedAfterMs}`;
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
    memberName: string,
    observedAfterMs: number | null
  ): Promise<MemberRuntimeAdvisory | null> {
    const openCodeAdvisory = await this.findRecentOpenCodeDeliveryAdvisory(
      teamName,
      memberName,
      observedAfterMs
    );
    if (openCodeAdvisory) {
      return openCodeAdvisory;
    }

    const summaries = await this.logsFinder.findMemberLogs(
      teamName,
      memberName,
      Math.max(Date.now() - LOOKBACK_MS, observedAfterMs ?? 0)
    );
    return this.findRecentMemberAdvisoryInFiles(
      summaries.flatMap((summary) => summary.filePath ?? []),
      observedAfterMs
    );
  }

  private async findRecentMemberAdvisories(
    teamName: string,
    memberNames: readonly string[],
    observedAfterMs: number | null
  ): Promise<readonly (readonly [string, MemberRuntimeAdvisory | null])[]> {
    const openCodeAdvisories = await this.findRecentOpenCodeDeliveryAdvisories(
      teamName,
      memberNames,
      observedAfterMs
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
          remainingMemberNames,
          observedAfterMs
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
          Math.max(Date.now() - LOOKBACK_MS, observedAfterMs ?? 0)
        );
        return [
          memberName,
          await this.findRecentMemberAdvisoryInFiles(
            summaries.flatMap((summary) => summary.filePath ?? []),
            observedAfterMs
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
    memberName: string,
    observedAfterMs: number | null
  ): Promise<MemberRuntimeAdvisory | null> {
    const advisories = await this.findRecentOpenCodeDeliveryAdvisories(
      teamName,
      [memberName],
      observedAfterMs
    );
    return advisories.get(memberName) ?? null;
  }

  private async findRecentOpenCodeDeliveryAdvisories(
    teamName: string,
    memberNames: readonly string[],
    observedAfterMs: number | null
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
        records.some((record) =>
          this.isOpenCodeDeliveryAdvisoryCandidate(record, now, observedAfterMs)
        )
      ) {
        memberKeysWithRecentErrors.add(memberKey);
      }
    }
    if (memberKeysWithRecentErrors.size === 0) {
      return new Map();
    }

    const proofIndex = await this.proofReader
      .readProofIndex({
        teamName,
        activeMemberKeys: memberKeysWithRecentErrors,
        recordsByMember,
      })
      .catch((error) => {
        logger.warn('OpenCode runtime delivery proof lookup failed; using empty proof index', {
          teamName,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          getSnapshot: () => ({}),
        } satisfies OpenCodeRuntimeDeliveryProofIndex;
      });
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
            proofIndex,
            observedAfterMs
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
    proofIndex: OpenCodeRuntimeDeliveryProofIndex,
    observedAfterMs: number | null
  ): MemberRuntimeAdvisory | null {
    const ordered = records
      .slice()
      .sort(
        (left, right) =>
          getOpenCodeRuntimeDeliveryRecordTimeMs(right) -
          getOpenCodeRuntimeDeliveryRecordTimeMs(left)
      );
    const latestError = ordered.find((record) => {
      return this.isOpenCodeDeliveryAdvisoryCandidate(record, now, observedAfterMs);
    });
    if (!latestError) {
      return null;
    }

    const decision = decideOpenCodeRuntimeDeliveryAdvisory({
      record: latestError,
      proof: proofIndex.getSnapshot(memberName, latestError),
      now,
    });
    if (decision.action !== 'surface') {
      return null;
    }

    const message = decision.reason;
    if (!message || !decision.observedAt) {
      return null;
    }
    const retryWindow = this.extractOpenCodeDeliveryRetryWindow(latestError, now);
    return {
      kind: 'api_error',
      observedAt: decision.observedAt,
      reasonCode: decision.reasonCode,
      message,
      ...(retryWindow ? retryWindow : {}),
    };
  }

  private extractOpenCodeDeliveryRetryWindow(
    record: OpenCodePromptDeliveryLedgerRecord,
    now: number
  ): Pick<MemberRuntimeAdvisory, 'retryUntil' | 'retryDelayMs'> | null {
    const candidates = [
      ...record.diagnostics.slice().reverse(),
      record.lastReason,
      record.nextAttemptAt,
    ];
    for (const candidate of candidates) {
      const retryAt = this.parseOpenCodeRetryAt(candidate);
      if (!retryAt || retryAt <= now) {
        continue;
      }
      return {
        retryUntil: new Date(retryAt).toISOString(),
        retryDelayMs: retryAt - now,
      };
    }
    return null;
  }

  private parseOpenCodeRetryAt(value: string | null | undefined): number | null {
    const text = value?.trim();
    if (!text) {
      return null;
    }
    const lowerText = text.toLowerCase();
    const nextMarker = 'next=';
    const tokenStart = lowerText.indexOf(nextMarker);
    const valueStart = tokenStart >= 0 ? tokenStart + nextMarker.length : 0;
    let valueEnd = valueStart;
    while (valueEnd < text.length) {
      const char = text[valueEnd];
      if (
        char === ' ' ||
        char === '\t' ||
        char === '\n' ||
        char === '\r' ||
        char === ',' ||
        char === ';'
      ) {
        break;
      }
      valueEnd += 1;
    }
    let cleaned = text.slice(valueStart, valueEnd);
    while (cleaned.endsWith('.') || cleaned.endsWith(')') || cleaned.endsWith(']')) {
      cleaned = cleaned.slice(0, -1);
    }
    const parsed = Date.parse(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private isOpenCodeDeliveryAdvisoryCandidate(
    record: OpenCodePromptDeliveryLedgerRecord,
    now: number,
    observedAfterMs: number | null
  ): boolean {
    const observedAt = getOpenCodeRuntimeDeliveryRecordTimeMs(record);
    if (observedAfterMs != null && Number.isFinite(observedAt) && observedAt < observedAfterMs) {
      return false;
    }
    if (!isPotentialOpenCodeRuntimeDeliveryError(record)) {
      return false;
    }
    if (
      !isTerminalSuccessfulOpenCodeDeliveryRecord(record) &&
      record.status !== 'failed_terminal'
    ) {
      return true;
    }
    return Number.isFinite(observedAt) && now - observedAt <= OPENCODE_DELIVERY_ERROR_LOOKBACK_MS;
  }

  private async findRecentMemberAdvisoriesFromBatchRefs(
    teamName: string,
    memberNames: readonly string[],
    observedAfterMs: number | null
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
      Math.max(Date.now() - LOOKBACK_MS, observedAfterMs ?? 0)
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
      return [
        memberName,
        await this.findRecentMemberAdvisoryInFiles(filePaths, observedAfterMs),
      ] as const;
    });
  }

  private async findRecentMemberAdvisoryInFiles(
    filePaths: readonly string[],
    observedAfterMs: number | null
  ): Promise<MemberRuntimeAdvisory | null> {
    for (const filePath of filePaths) {
      const advisory = await this.readRecentApiRetryAdvisory(filePath, observedAfterMs);
      if (advisory) {
        return advisory;
      }
    }
    return null;
  }

  private async readRecentApiRetryAdvisory(
    filePath: string,
    observedAfterMs: number | null = null
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
          this.extractApiRetryAdvisory(line, now, observedAfterMs) ??
          this.extractApiErrorAdvisory(line, now, observedAfterMs);
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

  private extractApiRetryAdvisory(
    line: string,
    now = Date.now(),
    observedAfterMs: number | null = null
  ): MemberRuntimeAdvisory | null {
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
      if (observedAfterMs != null && observedAt < observedAfterMs) {
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
        reasonCode: classifyRuntimeDiagnostic(message).reasonCode,
        ...(message ? { message } : {}),
      };
    } catch {
      return null;
    }
  }

  private extractApiErrorAdvisory(
    line: string,
    now = Date.now(),
    observedAfterMs: number | null = null
  ): MemberRuntimeAdvisory | null {
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
      if (observedAfterMs != null && observedAt < observedAfterMs) {
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
        reasonCode: classifyRuntimeDiagnostic(message || parsed.error).reasonCode,
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
