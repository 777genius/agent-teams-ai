import {
  chooseDiagnosticSignal,
  isSchedulerEligible,
  recommendedActionForAvailability,
} from "./policy";
import { summarizeProviderAccountPoolAvailability } from "./pool-availability";
import { sanitizeDiagnosticDetails } from "./details";
import type {
  ListProviderAccountDiagnosticsDependencies,
  ListProviderAccountDiagnosticsOptions,
  ListProviderAccountDiagnosticsResult,
  ProviderAccountDiagnostic,
  ProviderAccountIdentity,
  ProviderAccountDiagnosticSignal,
  ProviderAccountInventoryItem,
  ProviderAccountProbeMode,
} from "./types";

export class ListProviderAccountDiagnostics<
  Account extends ProviderAccountInventoryItem = ProviderAccountInventoryItem,
> {
  constructor(
    private readonly dependencies: ListProviderAccountDiagnosticsDependencies<Account>,
  ) {}

  async execute(
    options: ListProviderAccountDiagnosticsOptions = {},
  ): Promise<ListProviderAccountDiagnosticsResult> {
    const checkedAt = this.dependencies.clock?.now() ?? new Date();
    const probeMode = options.probeMode ?? "cached";
    const accounts = await this.dependencies.registry.listAccounts({
      ...(options.provider ? { provider: options.provider } : {}),
    });
    const maxConcurrency = Math.max(1, options.maxConcurrency ?? 1);
    const probeSignals = new Map<string, Promise<ProviderAccountDiagnosticSignal>>();
    const diagnostics = await mapWithConcurrency(
      accounts,
      maxConcurrency,
      async (account) =>
        this.diagnoseAccount({
          account,
          checkedAt,
          probeMode,
          probeSignals,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        }),
    );
    const withSharedCapacity = markSharedCapacity(diagnostics);
    const filtered = options.only?.length
      ? withSharedCapacity.filter((diagnostic) =>
          options.only?.includes(diagnostic.availability),
        )
      : withSharedCapacity;

    return {
      checkedAt,
      diagnostics: filtered,
      summary: summarizeProviderAccountPoolAvailability({
        diagnostics: filtered,
        checkedAt,
      }),
    };
  }

  private async diagnoseAccount(input: {
    readonly account: Account;
    readonly checkedAt: Date;
    readonly probeMode: ProviderAccountProbeMode;
    readonly probeSignals: Map<string, Promise<ProviderAccountDiagnosticSignal>>;
    readonly timeoutMs?: number;
  }): Promise<ProviderAccountDiagnostic> {
    const identityResult = await this.dependencies.identityReader.readIdentity({
      account: input.account,
      now: input.checkedAt,
    });
    const signals: ProviderAccountDiagnosticSignal[] = [];
    if (identityResult.signal) signals.push(identityResult.signal);

    const capacity = await this.dependencies.capacityReader?.readCapacity({
      account: input.account,
      identity: identityResult.identity,
      now: input.checkedAt,
    });
    if (capacity) signals.push(capacity);

    if (input.probeMode !== "cached" && this.dependencies.healthProbe) {
      signals.push(
        await this.readProbeSignal({
          account: input.account,
          identity: identityResult.identity,
          mode: input.probeMode,
          now: input.checkedAt,
          probeSignals: input.probeSignals,
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        }),
      );
    }

    const selected = chooseDiagnosticSignal({
      signals,
      probeMode: input.probeMode,
      checkedAt: input.checkedAt,
    });
    const warnings = identityResult.identity.warnings;
    const details = sanitizeDiagnosticDetails(selected.details);
    const display = displayFields(input.account.metadata);
    return {
      provider: input.account.provider,
      slotId: input.account.slotId,
      ...display,
      ...(input.account.providerInstanceId
        ? { providerInstanceId: input.account.providerInstanceId }
        : {}),
      ...(input.account.model ? { model: input.account.model } : {}),
      safeIdentity: identityResult.identity.safeIdentity,
      ...(identityResult.identity.accountKeyHash
        ? { accountKeyHash: identityResult.identity.accountKeyHash }
        : {}),
      availability: selected.availability,
      ...(selected.reason ? { reason: selected.reason } : {}),
      ...(selected.limitResetAt ? { limitResetAt: selected.limitResetAt } : {}),
      ...(selected.rawResetText ? { rawResetText: selected.rawResetText } : {}),
      reconnectRequired:
        selected.reconnectRequired ??
        selected.availability === "reconnect_required",
      recommendedAction: recommendedActionForAvailability(selected.availability),
      source: selected.source,
      checkedAt: selected.checkedAt ?? input.checkedAt,
      schedulerEligible: isSchedulerEligible(selected.availability),
      ...(warnings?.length ? { warnings } : {}),
      ...(details ? { details } : {}),
    };
  }

  private readProbeSignal(input: {
    readonly account: Account;
    readonly identity: ProviderAccountIdentity;
    readonly mode: Exclude<ProviderAccountProbeMode, "cached">;
    readonly now: Date;
    readonly probeSignals: Map<string, Promise<ProviderAccountDiagnosticSignal>>;
    readonly timeoutMs?: number;
  }): Promise<ProviderAccountDiagnosticSignal> {
    const key = probeCacheKey(input.account, input.identity);
    const existing = input.probeSignals.get(key);
    if (existing) return existing;

    const probe = this.dependencies.healthProbe
      ?.probeAccount({
        account: input.account,
        identity: input.identity,
        mode: input.mode,
        now: input.now,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      })
      .catch((): ProviderAccountDiagnosticSignal => ({
        availability: "unhealthy",
        source: input.mode === "health" ? "health" : "live_probe",
        reason: "probe_failed",
        checkedAt: input.now,
      }));
    const signal =
      probe ??
      Promise.resolve({
        availability: "unknown",
        source: "cached",
        reason: "probe_unavailable",
        checkedAt: input.now,
      } satisfies ProviderAccountDiagnosticSignal);
    input.probeSignals.set(key, signal);
    return signal;
  }
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const outputs = new Array<Output>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const value = values[currentIndex];
      if (value === undefined) continue;
      outputs[currentIndex] = await mapper(value);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return outputs;
}

function displayFields(
  metadata: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (!metadata) return {};
  return Object.fromEntries(
    ["displayName", "email", "shortName", "operatorLabel"]
      .map((key) => [key, metadata[key]] as const)
      .filter((entry): entry is readonly [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0,
      ),
  );
}

function probeCacheKey(
  account: ProviderAccountInventoryItem,
  identity: ProviderAccountIdentity,
): string {
  return [
    account.provider,
    identity.accountKeyHash ??
      account.capacityAccountId ??
      identity.providerAccountId ??
      `slot:${account.slotId}`,
  ].join(":");
}

function markSharedCapacity(
  diagnostics: readonly ProviderAccountDiagnostic[],
): readonly ProviderAccountDiagnostic[] {
  const byHash = new Map<string, ProviderAccountDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.accountKeyHash) continue;
    const existing = byHash.get(diagnostic.accountKeyHash) ?? [];
    existing.push(diagnostic);
    byHash.set(diagnostic.accountKeyHash, existing);
  }

  return diagnostics.map((diagnostic) => {
    if (!diagnostic.accountKeyHash) return diagnostic;
    const group = byHash.get(diagnostic.accountKeyHash) ?? [];
    const sharedWith = group
      .filter((candidate) => candidate.slotId !== diagnostic.slotId)
      .map((candidate) => candidate.slotId);
    if (sharedWith.length === 0) return diagnostic;
    return {
      ...diagnostic,
      capacitySharedWithSlotIds: sharedWith,
    };
  });
}
