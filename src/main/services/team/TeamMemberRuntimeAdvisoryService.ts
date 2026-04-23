import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';

import { TeamMemberLogsFinder } from './TeamMemberLogsFinder';

import type { MemberRuntimeAdvisory, ResolvedTeamMember } from '@shared/types';

const LOOKBACK_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 5_000;
const TAIL_BYTES = 64 * 1024;
const BATCH_WARN_MS = 200;
const QUOTA_EXHAUSTED_TOKENS = [
  'exhausted your capacity',
  'capacity exceeded',
  'quota exceeded',
  'quota exhausted',
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
  if (includesAnyToken(normalized, NETWORK_ERROR_TOKENS)) {
    return 'network_error';
  }
  if (includesAnyToken(normalized, PROVIDER_OVERLOADED_TOKENS)) {
    return 'provider_overloaded';
  }
  return 'backend_error';
}

export class TeamMemberRuntimeAdvisoryService {
  private readonly memberCache = new Map<string, CachedRuntimeAdvisory>();
  private readonly teamBatchCacheByTeam = new Map<string, CachedTeamBatchAdvisories>();
  private readonly inFlightBatchRequests = new Map<
    string,
    Promise<Map<string, MemberRuntimeAdvisory>>
  >();

  constructor(private readonly logsFinder: TeamMemberLogsFinder = new TeamMemberLogsFinder()) {}

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
    const cacheKey = this.getMemberCacheKey(teamName, memberName);
    const cached = this.memberCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value ? this.cloneAdvisory(cached.value) : null;
    }

    const advisory = await this.findRecentMemberAdvisory(teamName, memberName);
    this.memberCache.set(cacheKey, {
      value: advisory,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
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
      const fetched = await Promise.all(
        membersToFetch.map(async (memberName) => {
          const advisory = await this.findRecentMemberAdvisory(teamName, memberName);
          return [memberName, advisory] as const;
        })
      );
      const fetchedAt = Date.now();
      for (const [memberName, advisory] of fetched) {
        const normalizedMemberName = this.normalizeToken(memberName);
        this.memberCache.set(`${teamKey}::${normalizedMemberName}`, {
          value: advisory,
          expiresAt: fetchedAt + CACHE_TTL_MS,
        });
        if (advisory) {
          result.set(normalizedMemberName, this.cloneAdvisory(advisory));
        }
      }
    }

    this.teamBatchCacheByTeam.set(teamKey, {
      membersSignature,
      value: this.cloneNormalizedAdvisories(result),
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

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
    const summaries = await this.logsFinder.findMemberLogs(
      teamName,
      memberName,
      Date.now() - LOOKBACK_MS
    );
    for (const summary of summaries) {
      if (!summary.filePath) {
        continue;
      }
      const advisory = await this.readRecentApiRetryAdvisory(summary.filePath);
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
          content?: Array<{ type?: string; text?: string }>;
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

  private extractAssistantText(
    content: Array<{ type?: string; text?: string }> | undefined
  ): string {
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
