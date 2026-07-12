import {
  AgentProvider,
  AuthSessionStatus,
  ObservationEvidenceConfidence,
  ObservationEvidenceKind,
  ObservationEvidenceSource,
  QuotaLimitState,
  QuotaWindowKind,
} from "../../domain/enums";
import type {
  AuthSession,
  ObservationEvidence,
  ProviderAccountIdentity,
  QuotaSnapshot,
  QuotaWindow,
} from "../../domain/model";
import {
  errorText,
  hashAccountKey,
  isReloginError,
  maskEmail,
  nestedRecord,
  numberValue,
  readRecord,
  stringValue,
  timestampFromUnix,
} from "./codexUtils";
import type {
  CodexAccountSlot,
  CodexAppServerClientFactoryPort,
} from "./codexTypes";

export type CodexAuthAndQuotaRead = {
  readonly auth: AuthSession;
  readonly quota: QuotaSnapshot | null;
  readonly evidence: readonly ObservationEvidence[];
};

export type CodexMainQuotaSummary = {
  readonly fiveHour?: QuotaWindow;
  readonly sevenDay?: QuotaWindow;
  readonly nextResetAt?: Date;
};

export class CodexAppServerQuotaReader {
  constructor(
    private readonly dependencies: {
      readonly clientFactory: CodexAppServerClientFactoryPort;
    },
  ) {}

  async readAuthAndQuota(input: {
    readonly account: CodexAccountSlot;
    readonly now: Date;
    readonly timeoutMs?: number;
  }): Promise<CodexAuthAndQuotaRead> {
    const client = await this.dependencies.clientFactory.open({
      account: input.account,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
    try {
      const accountResult = await client.call({
        method: "account/read",
        params: { refreshToken: false },
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
      const auth = authSessionFromAccountRead({
        result: accountResult,
        account: input.account,
        now: input.now,
      });
      const rateLimitsResult = await client.call({
        method: "account/rateLimits/read",
        params: {},
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
      const quota = quotaSnapshotFromRateLimits({
        result: rateLimitsResult,
        now: input.now,
      });
      return {
        auth,
        quota,
        evidence: [
          evidence({
            kind: ObservationEvidenceKind.Auth,
            observedAt: input.now,
            message: "account_read",
          }),
          evidence({
            kind: ObservationEvidenceKind.Quota,
            observedAt: input.now,
            message: "account_rate_limits_read",
          }),
        ],
      };
    } catch (error) {
      if (isReloginError(error)) {
        return {
          auth: {
            status: AuthSessionStatus.ReloginRequired,
            checkedAt: input.now,
            reason: "refresh_token_revoked",
          },
          quota: null,
          evidence: [
            evidence({
              kind: ObservationEvidenceKind.Auth,
              observedAt: input.now,
              message: "account_read_relogin_required",
            }),
          ],
        };
      }
      throw new Error(`codex_app_server_quota_read_failed:${errorText(error)}`);
    } finally {
      await client.close?.();
    }
  }
}

export function authSessionFromAccountRead(input: {
  readonly result: unknown;
  readonly account: CodexAccountSlot;
  readonly now: Date;
}): AuthSession {
  const identity = identityFromAccountRead(input.result, input.account);
  return {
    status: AuthSessionStatus.Authenticated,
    checkedAt: input.now,
    identity,
  };
}

export function quotaSnapshotFromRateLimits(input: {
  readonly result: unknown;
  readonly now: Date;
}): QuotaSnapshot {
  const root = readRecord(input.result);
  const rateRoot = readRecord(root?.rateLimits) ? root : readRecord(root?.result) ?? root;
  const windows = quotaWindowsFromRateLimits(rateRoot);
  const planType =
    planTypeFromRateLimits(rateRoot) ??
    firstString(windows.map((window) => window.limitName));
  return {
    provider: AgentProvider.Codex,
    checkedAt: input.now,
    windows,
    ...(planType ? { planType } : {}),
  };
}

export function codexMainQuotaSnapshot(
  quota: QuotaSnapshot | null,
): QuotaSnapshot | null {
  if (!quota) return null;
  return {
    ...quota,
    windows: codexMainQuotaWindows(quota),
  };
}

export function codexMainQuotaWindows(
  quota: QuotaSnapshot | null,
): readonly QuotaWindow[] {
  const windows = quota?.windows ?? [];
  const mainWindows = windows.filter(
    (window) =>
      window.limitId === "codex" ||
      window.limitId === "weekly" ||
      (!window.limitId && !window.limitName),
  );
  return mainWindows.length > 0 ? mainWindows : windows;
}

export function codexMainQuotaSummary(
  quota: QuotaSnapshot | null,
): CodexMainQuotaSummary {
  const windows = codexMainQuotaWindows(quota);
  const fiveHour = windows.find(
    (window) => window.kind === QuotaWindowKind.FiveHour,
  );
  const sevenDay = windows.find(
    (window) => window.kind === QuotaWindowKind.SevenDay,
  );
  const nextResetAt = [fiveHour?.resetsAt, sevenDay?.resetsAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(nextResetAt ? { nextResetAt } : {}),
  };
}

function quotaWindowsFromRateLimits(
  result: Record<string, unknown> | null,
): readonly QuotaWindow[] {
  if (!result) return [];
  const byLimitId = readRecord(result.rateLimitsByLimitId);
  const windows: QuotaWindow[] = [];
  if (byLimitId) {
    for (const [limitId, value] of Object.entries(byLimitId)) {
      const record = readRecord(value);
      if (!record) continue;
      windows.push(...quotaWindowsFromRecord(record, limitId));
    }
  }

  const single = result.rateLimits;
  if (Array.isArray(single)) {
    for (const value of single) {
      const record = readRecord(value);
      if (record) windows.push(...quotaWindowsFromRecord(record));
    }
  } else {
    const record = readRecord(single);
    if (record) windows.push(...quotaWindowsFromRecord(record));
  }

  return dedupeWindows(windows);
}

function planTypeFromRateLimits(
  result: Record<string, unknown> | null,
): string | undefined {
  if (!result) return undefined;
  const direct = stringValue(result.planType);
  if (direct) return direct;

  const single = result.rateLimits;
  if (Array.isArray(single)) {
    for (const value of single) {
      const planType = stringValue(readRecord(value)?.planType);
      if (planType) return planType;
    }
  } else {
    const planType = stringValue(readRecord(single)?.planType);
    if (planType) return planType;
  }

  const byLimitId = readRecord(result.rateLimitsByLimitId);
  if (!byLimitId) return undefined;
  for (const value of Object.values(byLimitId)) {
    const planType = stringValue(readRecord(value)?.planType);
    if (planType) return planType;
  }
  return undefined;
}

function quotaWindowsFromRecord(
  record: Record<string, unknown>,
  fallbackLimitId?: string,
): readonly QuotaWindow[] {
  const primary = readRecord(record.primary);
  const secondary = readRecord(record.secondary);
  if (!primary && !secondary) return [quotaWindowFromRecord(record, fallbackLimitId)];

  const windows: QuotaWindow[] = [];
  if (primary) {
    windows.push(
      quotaWindowFromNestedRecord({
        parent: record,
        nested: primary,
        ...(fallbackLimitId ? { fallbackLimitId } : {}),
      }),
    );
  }
  if (secondary) {
    windows.push(
      quotaWindowFromNestedRecord({
        parent: record,
        nested: secondary,
        ...(fallbackLimitId ? { fallbackLimitId } : {}),
      }),
    );
  }
  return windows;
}

function quotaWindowFromNestedRecord(input: {
  readonly parent: Record<string, unknown>;
  readonly nested: Record<string, unknown>;
  readonly fallbackLimitId?: string;
}): QuotaWindow {
  const limitId = stringValue(input.parent.limitId) ?? input.fallbackLimitId;
  const limitName = stringValue(input.parent.limitName);
  const reachedType = stringValue(input.nested.rateLimitReachedType);
  return quotaWindowFromRecord(
    {
      ...input.nested,
      ...(limitId ? { limitId } : {}),
      ...(limitName ? { limitName } : {}),
      ...(reachedType ? { rateLimitReachedType: reachedType } : {}),
    },
    input.fallbackLimitId,
  );
}

function quotaWindowFromRecord(
  record: Record<string, unknown>,
  fallbackLimitId?: string,
): QuotaWindow {
  const usedPercent = numberValue(record.usedPercent);
  const windowDurationMins = numberValue(record.windowDurationMins);
  const resetsAt = timestampFromUnix(record.resetsAt);
  const reachedType = stringValue(record.rateLimitReachedType);
  const credits = readRecord(record.credits);
  const resetCredits = readRecord(record.rateLimitResetCredits);
  const creditsRemaining = numberValue(credits?.remaining);
  const resetCreditsAvailable = numberValue(resetCredits?.available);
  const limitId = stringValue(record.limitId) ?? fallbackLimitId;
  const limitName = stringValue(record.limitName);
  const state =
    reachedType || (usedPercent !== undefined && usedPercent >= 100)
      ? QuotaLimitState.Limited
      : QuotaLimitState.Clear;

  return {
    kind: quotaWindowKind(windowDurationMins, limitId),
    state,
    ...(limitId ? { limitId } : {}),
    ...(limitName ? { limitName } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
    ...(resetCreditsAvailable !== undefined ? { resetCreditsAvailable } : {}),
    ...(reachedType ? { reachedType } : {}),
  };
}

function quotaWindowKind(
  windowDurationMins: number | undefined,
  limitId: string | undefined,
): QuotaWindowKind {
  if (windowDurationMins === 300) return QuotaWindowKind.FiveHour;
  if (windowDurationMins === 10_080) return QuotaWindowKind.SevenDay;
  if (limitId === "credits") return QuotaWindowKind.WorkspaceCredits;
  if (windowDurationMins !== undefined) return QuotaWindowKind.Rolling;
  return QuotaWindowKind.Unknown;
}

function identityFromAccountRead(
  result: unknown,
  account: CodexAccountSlot,
): ProviderAccountIdentity {
  const accountRecord =
    nestedRecord(result, ["account"]) ??
    nestedRecord(result, ["result", "account"]) ??
    readRecord(result);
  const userRecord = readRecord(accountRecord?.user);
  const email =
    stringValue(accountRecord?.email) ??
    stringValue(userRecord?.email) ??
    account.email;
  const providerAccountId =
    stringValue(accountRecord?.id) ??
    stringValue(accountRecord?.accountId) ??
    stringValue(accountRecord?.account_id) ??
    stringValue(userRecord?.id) ??
    account.providerAccountId;
  const accountKeyHash = providerAccountId
    ? hashAccountKey({
        provider: AgentProvider.Codex,
        accountKey: providerAccountId,
      })
    : undefined;

  return {
    safeIdentity: email
      ? maskEmail(email)
      : accountKeyHash
        ? `codex:${accountKeyHash.slice(0, 8)}`
        : `codex:${account.slotId}`,
    ...(providerAccountId ? { providerAccountId } : {}),
    ...(accountKeyHash ? { accountKeyHash } : {}),
    ...(email ? { email } : {}),
  };
}

function evidence(input: {
  readonly kind: ObservationEvidenceKind;
  readonly observedAt: Date;
  readonly message: string;
}): ObservationEvidence {
  return {
    source: ObservationEvidenceSource.CodexAppServer,
    kind: input.kind,
    confidence: ObservationEvidenceConfidence.High,
    observedAt: input.observedAt,
    message: input.message,
  };
}

function dedupeWindows(windows: readonly QuotaWindow[]): readonly QuotaWindow[] {
  const byKey = new Map<string, QuotaWindow>();
  for (const window of windows) {
    const key = `${window.limitId ?? "unknown"}:${window.kind}`;
    byKey.set(key, window);
  }
  return [...byKey.values()];
}

function firstString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return undefined;
}
