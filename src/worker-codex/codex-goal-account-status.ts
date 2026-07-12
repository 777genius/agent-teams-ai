import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AccountAvailability as ObservedAccountAvailability,
  AgentProvider,
  CodexAccountObserver,
  CodexAppServerClientFactory,
  CodexAppServerQuotaReader,
  CodexAuthJsonReader,
  CodexExecProbe,
  NodeProcessRunner,
  type AccountObservation,
  type AvailabilityDecision,
} from "@vioxen/agent-account-observability";
import {
  isSchedulerEligible,
  recommendedActionForAvailability,
  workerCapacityToDiagnosticSignal,
  type ProviderAccountAction,
  type ProviderAccountAvailability,
} from "@vioxen/subscription-runtime/account-diagnostics";
import {
  readCodexAuthJsonFreshness,
  validateCodexAuthJsonBytes,
} from "@vioxen/subscription-runtime/provider-codex";
import type {
  WorkerAccountCapacityStore,
  WorkerCapacitySnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import { WorkerAccountCapacityPhase } from "@vioxen/subscription-runtime/worker-core";
import { recordCodexLiveQuotaCapacity } from "./application/codex-live-quota-capacity";
import {
  codexAccountCapacityStore,
  migrateLegacyCodexAccountCapacity,
} from "./application/codex-account-capacity-store";
import { recheckDueCodexAccountCapacity } from "./application/codex-account-capacity-rechecker";
import {
  codexAccountDisplayMetadataForSlot,
  readCodexAccountDisplayMetadata,
  type CodexAccountDisplayMetadata,
} from "./account-display-metadata";

export type CodexGoalAccountStatus =
  | "ready"
  | "auth_missing"
  | "auth_invalid";

export type CodexGoalAccountSlotStatus = {
  readonly name: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly shortName?: string;
  readonly operatorLabel?: string;
  readonly authJsonPath: string;
  readonly status: CodexGoalAccountStatus;
  readonly availability: ProviderAccountAvailability;
  readonly schedulerEligible: boolean;
  readonly recommendedAction: ProviderAccountAction;
  readonly byteLength?: number;
  readonly authJsonSha256Prefix?: string;
  readonly identitySource?: string;
  readonly identityHashPrefix?: string;
  readonly lastRefreshAt?: string;
  readonly expiresAt?: string;
  readonly limitResetAt?: string;
  readonly capacityAvailability?: string;
  readonly capacityReason?: string;
  readonly capacityCooldownUntil?: string;
  readonly capacityLastLimitSignalAt?: string;
  readonly liveCheck?: "passed" | "failed";
  readonly liveCheckSafeMessage?: string;
  readonly warnings: readonly string[];
  readonly safeMessage: string;
};

export type CodexGoalAccountStatusInput = {
  readonly authRootDir: string;
  readonly accounts?: readonly string[];
  readonly stateRootDir?: string;
  readonly liveCheck?: boolean;
  readonly codexBinaryPath?: string;
  readonly liveCheckTimeoutMs?: number;
  readonly accountMetadata?: Readonly<Record<string, CodexAccountDisplayMetadata>>;
  readonly accountCapacityStore?: WorkerAccountCapacityStore;
  readonly recheckDueCapacity?: boolean;
};

export async function listCodexGoalAccountStatuses(
  input: CodexGoalAccountStatusInput,
): Promise<readonly CodexGoalAccountSlotStatus[]> {
  const accountNames = input.accounts?.length
    ? input.accounts
    : await listAccountDirectories(input.authRootDir);
  const accountMetadata = {
    ...(await readCodexAccountDisplayMetadata(input.authRootDir)),
    ...(input.accountMetadata ?? {}),
  };
  if (input.stateRootDir && !input.accountCapacityStore) {
    migrateLegacyCodexAccountCapacity({
      authRootDir: input.authRootDir,
      stateRootDir: input.stateRootDir,
      accountIds: accountNames,
    });
  }
  const accountCapacityStore = resolveAccountCapacityStore(input);
  if (input.recheckDueCapacity && accountCapacityStore) {
    await Promise.all(
      accountNames.map((name) =>
        recheckDueCodexAccountCapacity({
          store: accountCapacityStore,
          accountId: name,
          authJsonPath: join(input.authRootDir, name, "auth.json"),
          codexBinaryPath: input.codexBinaryPath ?? "codex",
          now: new Date(),
          ...(input.liveCheckTimeoutMs
            ? { timeoutMs: input.liveCheckTimeoutMs }
            : {}),
        }),
      ),
    );
  }
  return Promise.all(
    accountNames.map((name) =>
      inspectCodexGoalAccount({
        authRootDir: input.authRootDir,
        name,
        ...(accountMetadata[name]
          ? { displayMetadata: accountMetadata[name] }
          : {}),
        ...(accountCapacityStore ? { accountCapacityStore } : {}),
        ...(input.liveCheck ? { liveCheck: input.liveCheck } : {}),
        ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
        ...(input.liveCheckTimeoutMs ? { liveCheckTimeoutMs: input.liveCheckTimeoutMs } : {}),
      }),
    ),
  );
}

async function inspectCodexGoalAccount(input: {
  readonly authRootDir: string;
  readonly name: string;
  readonly displayMetadata?: CodexAccountDisplayMetadata;
  readonly accountCapacityStore?: WorkerAccountCapacityStore;
  readonly liveCheck?: boolean;
  readonly codexBinaryPath?: string;
  readonly liveCheckTimeoutMs?: number;
}): Promise<CodexGoalAccountSlotStatus> {
  const authJsonPath = join(input.authRootDir, input.name, "auth.json");
  const display = codexAccountDisplayMetadataForSlot(
    input.name,
    input.displayMetadata,
  );
  try {
    const authJsonBytes = await readFile(authJsonPath, "utf8");
    const validation = validateCodexAuthJsonBytes({ authJsonBytes });
    const freshness = readCodexAuthJsonFreshness({ authJsonBytes });
    const identity = sanitizedCodexIdentity(validation.parsed.tokens.id_token);
    let capacity = readAccountCapacity({
      accountName: input.name,
      ...(input.accountCapacityStore
        ? { store: input.accountCapacityStore }
        : {}),
    });
    const live = input.liveCheck
      ? await inspectCodexAccountLiveStatus({
          name: input.name,
          codexHome: dirname(authJsonPath),
          authJsonPath,
          ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
          ...(input.liveCheckTimeoutMs ? { timeoutMs: input.liveCheckTimeoutMs } : {}),
        })
      : undefined;
    const capacityPersistenceWarning = recordLiveQuotaCapacitySafely({
      accountId: input.name,
      ...(live?.observation ? { observation: live.observation } : {}),
      ...(input.accountCapacityStore
        ? { store: input.accountCapacityStore }
        : {}),
    });
    if (live?.observation && input.accountCapacityStore && !capacityPersistenceWarning) {
      capacity = readAccountCapacity({
        accountName: input.name,
        store: input.accountCapacityStore,
      });
    }
    const warnings = [
      ...validation.warnings,
      ...freshness.warnings,
      ...(capacityPersistenceWarning ? [capacityPersistenceWarning] : []),
    ];
    const liveAvailability = live?.observation
      ? liveDecisionToDiagnosticAvailability(live.observation.decision)
      : undefined;
    const liveLimitResetAt = live?.observation?.decision.limitResetAt;
    const liveStatus = live && !liveAvailability
      ? "auth_invalid"
      : liveAvailability === "reconnect_required"
        ? "auth_invalid"
        : liveAvailability === "auth_unknown" ||
          liveAvailability === "unhealthy" ||
          liveAvailability === "unknown"
          ? "auth_invalid"
          : "ready";
    if (live && !live.ok) {
      const availability = codexGoalAccountAvailability({
        status: liveStatus,
        capacity,
        ...(liveAvailability ? { observedAvailability: liveAvailability } : {}),
        ...(liveLimitResetAt ? { observedLimitResetAt: liveLimitResetAt } : {}),
      });
      return {
        name: input.name,
        ...display,
        authJsonPath,
        status: liveStatus,
        ...availability,
        byteLength: validation.byteLength,
        authJsonSha256Prefix: validation.exactBytesSha256.slice(0, 12),
        ...(identity ? { identitySource: identity.source } : {}),
        ...(identity ? { identityHashPrefix: identity.hashPrefix } : {}),
        ...(freshness.lastRefreshAt
          ? { lastRefreshAt: freshness.lastRefreshAt.toISOString() }
          : {}),
        ...(freshness.expiresAt
          ? { expiresAt: freshness.expiresAt.toISOString() }
          : {}),
        ...(capacity?.availability
          ? { capacityAvailability: capacity.availability }
          : {}),
        ...(capacity?.reason ? { capacityReason: capacity.reason } : {}),
        ...(capacity?.cooldownUntil
          ? { capacityCooldownUntil: capacity.cooldownUntil.toISOString() }
          : {}),
        ...(capacity?.lastLimitSignalAt
          ? { capacityLastLimitSignalAt: capacity.lastLimitSignalAt.toISOString() }
          : {}),
        liveCheck: "failed",
        liveCheckSafeMessage: live.safeMessage,
        warnings,
        safeMessage: live.safeMessage,
      };
    }
    const availability = codexGoalAccountAvailability({
      status: "ready",
      capacity,
      ...(liveAvailability ? { observedAvailability: liveAvailability } : {}),
      ...(liveLimitResetAt ? { observedLimitResetAt: liveLimitResetAt } : {}),
    });
    return {
      name: input.name,
      ...display,
      authJsonPath,
      status: "ready",
      ...availability,
      byteLength: validation.byteLength,
      authJsonSha256Prefix: validation.exactBytesSha256.slice(0, 12),
      ...(identity ? { identitySource: identity.source } : {}),
      ...(identity ? { identityHashPrefix: identity.hashPrefix } : {}),
      ...(freshness.lastRefreshAt
        ? { lastRefreshAt: freshness.lastRefreshAt.toISOString() }
        : {}),
      ...(freshness.expiresAt
        ? { expiresAt: freshness.expiresAt.toISOString() }
        : {}),
      ...(capacity?.availability
        ? { capacityAvailability: capacity.availability }
        : {}),
      ...(capacity?.reason ? { capacityReason: capacity.reason } : {}),
      ...(capacity?.cooldownUntil
        ? { capacityCooldownUntil: capacity.cooldownUntil.toISOString() }
        : {}),
      ...(capacity?.lastLimitSignalAt
        ? { capacityLastLimitSignalAt: capacity.lastLimitSignalAt.toISOString() }
        : {}),
      ...(live ? { liveCheck: "passed" as const } : {}),
      ...(live ? { liveCheckSafeMessage: live.safeMessage } : {}),
      warnings,
      safeMessage: warnings.length
        ? "auth.json is readable but has warnings"
        : "auth.json is readable",
    };
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message : "auth_invalid";
    return {
      name: input.name,
      ...display,
      authJsonPath,
      status: safeMessage.includes("ENOENT") ? "auth_missing" : "auth_invalid",
      ...codexGoalAccountAvailability({
        status: safeMessage.includes("ENOENT") ? "auth_missing" : "auth_invalid",
        capacity: null,
      }),
      warnings: [],
      safeMessage: safeMessage.includes("ENOENT")
        ? "auth.json is missing"
        : safeMessage,
    };
  }
}

function codexGoalAccountAvailability(input: {
  readonly status: CodexGoalAccountStatus;
  readonly capacity: WorkerCapacitySnapshot | null;
  readonly observedAvailability?: ProviderAccountAvailability;
  readonly observedLimitResetAt?: Date;
}): {
  readonly availability: ProviderAccountAvailability;
  readonly schedulerEligible: boolean;
  readonly recommendedAction: ProviderAccountAction;
  readonly limitResetAt?: string;
} {
  if (input.status !== "ready") {
    const availability = "reconnect_required";
    return {
      availability,
      schedulerEligible: isSchedulerEligible(availability),
      recommendedAction: recommendedActionForAvailability(availability),
    };
  }

  const capacitySignal = input.capacity
    ? workerCapacityToDiagnosticSignal(input.capacity)
    : null;
  const availability =
    input.observedAvailability ?? capacitySignal?.availability ?? "available";
  return {
    availability,
    schedulerEligible: isSchedulerEligible(availability),
    recommendedAction: recommendedActionForAvailability(availability),
    ...(input.observedLimitResetAt
      ? { limitResetAt: input.observedLimitResetAt.toISOString() }
      : capacitySignal?.limitResetAt
        ? { limitResetAt: capacitySignal.limitResetAt.toISOString() }
        : {}),
  };
}

function liveDecisionToDiagnosticAvailability(
  decision: AvailabilityDecision,
): ProviderAccountAvailability {
  switch (decision.availability) {
    case ObservedAccountAvailability.Available:
      return "available";
    case ObservedAccountAvailability.Limited:
      return "limited";
    case ObservedAccountAvailability.ReloginRequired:
      return "reconnect_required";
    case ObservedAccountAvailability.AuthUnknown:
      return "auth_unknown";
    case ObservedAccountAvailability.Unhealthy:
      return "unhealthy";
    case ObservedAccountAvailability.Unknown:
      return "unknown";
  }
  return "unknown";
}

function safeMessageForLiveDecision(decision: AvailabilityDecision): string {
  switch (decision.availability) {
    case ObservedAccountAvailability.Available:
      return "codex app-server quota check passed";
    case ObservedAccountAvailability.Limited:
      return decision.limitResetAt
        ? `codex account is quota limited until ${decision.limitResetAt.toISOString()}`
        : "codex account is quota limited";
    case ObservedAccountAvailability.ReloginRequired:
      return "codex account requires relogin";
    case ObservedAccountAvailability.AuthUnknown:
    case ObservedAccountAvailability.Unhealthy:
    case ObservedAccountAvailability.Unknown:
      return "codex account live observation failed";
  }
  return "codex account live observation failed";
}

function liveDecisionOk(decision: AvailabilityDecision): boolean {
  return (
    decision.availability === ObservedAccountAvailability.Available ||
    decision.availability === ObservedAccountAvailability.Limited
  );
}

async function inspectCodexAccountLiveStatus(input: {
  readonly name: string;
  readonly codexHome: string;
  readonly authJsonPath: string;
  readonly codexBinaryPath?: string;
  readonly timeoutMs?: number;
}): Promise<{
  readonly ok: boolean;
  readonly safeMessage: string;
  readonly observation?: AccountObservation;
}> {
  try {
    const observer = new CodexAccountObserver({
      appServerReader: new CodexAppServerQuotaReader({
        clientFactory: new CodexAppServerClientFactory({
          ...(input.codexBinaryPath
            ? { codexBinaryPath: input.codexBinaryPath }
            : {}),
          ...(input.timeoutMs ? { requestTimeoutMs: input.timeoutMs } : {}),
          ...(input.timeoutMs ? { startupTimeoutMs: input.timeoutMs } : {}),
        }),
      }),
      authReader: new CodexAuthJsonReader(),
      execProbe: new CodexExecProbe({
        runner: new NodeProcessRunner(),
        ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
      }),
    });
    const observation = await observer.observe({
      account: {
        provider: AgentProvider.Codex,
        slotId: input.name,
        authHome: input.codexHome,
        authJsonPath: input.authJsonPath,
        ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
      },
      now: new Date(),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
    return {
      ok: liveDecisionOk(observation.decision),
      safeMessage: safeMessageForLiveDecision(observation.decision),
      observation,
    };
  } catch {
    return { ok: false, safeMessage: "codex account live observation failed" };
  }
}

function sanitizedCodexIdentity(idToken: string | undefined): {
  readonly source: string;
  readonly hashPrefix: string;
} | null {
  if (!idToken) return null;
  const claims = decodeJwtClaims(idToken);
  if (!claims) return null;
  const authClaims = isRecord(claims["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"]
    : {};
  const candidates = [
    ["chatgpt_account_id", authClaims.chatgpt_account_id],
    ["chatgpt_user_id", authClaims.chatgpt_user_id],
    ["sub", claims.sub],
    ["email", claims.email],
  ] as const;
  for (const [source, value] of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    return {
      source,
      hashPrefix: hashText(source + ":" + value).slice(0, 16),
    };
  }
  return null;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readAccountCapacity(input: {
  readonly store?: WorkerAccountCapacityStore;
  readonly accountName: string;
}) {
  if (!input.store) return null;
  try {
    const now = new Date();
    const capacity = input.store.read({ accountId: input.accountName, now });
    if (capacity) return capacity;
    const state = input.store.readState({
      accountId: input.accountName,
      now,
    });
    if (state?.phase !== WorkerAccountCapacityPhase.RecheckDue) return null;
    return {
      availability: "cooldown" as const,
      reason: "quota_recheck_due",
      cooldownUntil: new Date(now.getTime() + 1000),
      ...(state.capacity.lastLimitSignalAt
        ? { lastLimitSignalAt: state.capacity.lastLimitSignalAt }
        : {}),
      ...(state.capacity.details ? { details: state.capacity.details } : {}),
    };
  } catch {
    return null;
  }
}

function resolveAccountCapacityStore(
  input: CodexGoalAccountStatusInput,
): WorkerAccountCapacityStore | undefined {
  if (input.accountCapacityStore) return input.accountCapacityStore;
  return codexAccountCapacityStore(input.authRootDir);
}

function recordLiveQuotaCapacitySafely(input: {
  readonly accountId: string;
  readonly observation?: AccountObservation;
  readonly store?: WorkerAccountCapacityStore;
}): string | undefined {
  if (!input.observation || !input.store) return undefined;
  try {
    recordCodexLiveQuotaCapacity({
      accountId: input.accountId,
      observation: input.observation,
      store: input.store,
    });
    return undefined;
  } catch {
    return "live quota capacity persistence failed";
  }
}

async function listAccountDirectories(authRootDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(authRootDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
