import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  AgentProvider,
  identityFromAuthJson,
  type ProviderAccountIdentity,
} from "@vioxen/agent-account-observability";
import type {
  WorkerAccountCapacityStore,
  WorkerAccountLimitSignal,
} from "@vioxen/subscription-runtime/worker-core";

export type CodexAccountCapacityAliasStoreOptions = {
  readonly authRootDir: string;
  readonly store: WorkerAccountCapacityStore;
  readonly authJsonPaths?: Readonly<Record<string, string>>;
  readonly authJsonByAlias?: Readonly<Record<string, string>>;
};

export function codexCapacityAccountIdFromIdentity(
  identity: ProviderAccountIdentity | undefined,
  fallbackAccountId: string,
): string {
  return identity?.accountKeyHash
    ? `codex-provider:${identity.accountKeyHash}`
    : fallbackAccountId;
}

export function codexCapacityAccountIdFromAuthJson(input: {
  readonly authJson: unknown;
  readonly slotAlias: string;
  readonly authJsonPath: string;
}): string {
  const identity = identityFromAuthJson(input.authJson, {
    provider: AgentProvider.Codex,
    slotId: input.slotAlias,
    authHome: dirname(input.authJsonPath),
    authJsonPath: input.authJsonPath,
  });
  return identity.accountKeyHash
    ? codexCapacityAccountIdFromIdentity(identity, input.slotAlias)
    : (refreshSessionCapacityAccountId(input.authJson) ?? input.slotAlias);
}

export class CodexAccountCapacityAliasStore
  implements WorkerAccountCapacityStore
{
  private readonly aliases: CodexAccountCapacityAliasResolver;

  constructor(private readonly options: CodexAccountCapacityAliasStoreOptions) {
    this.aliases = new CodexAccountCapacityAliasResolver(options);
  }

  read(input: Parameters<WorkerAccountCapacityStore["read"]>[0]) {
    return this.options.store.read({
      ...input,
      accountId: this.aliases.resolve(input.accountId),
    });
  }

  readState(input: Parameters<WorkerAccountCapacityStore["readState"]>[0]) {
    return this.options.store.readState({
      ...input,
      accountId: this.aliases.resolve(input.accountId),
    });
  }

  observe(input: WorkerAccountLimitSignal) {
    return this.options.store.observe({
      ...input,
      accountId: this.aliases.resolve(input.accountId),
    });
  }

  tryClaimRecheck(
    input: Parameters<WorkerAccountCapacityStore["tryClaimRecheck"]>[0],
  ) {
    return this.options.store.tryClaimRecheck(input);
  }

  resolveRecheck(
    input: Parameters<WorkerAccountCapacityStore["resolveRecheck"]>[0],
  ) {
    return this.options.store.resolveRecheck(input);
  }

  releaseRecheck(
    input: Parameters<WorkerAccountCapacityStore["releaseRecheck"]>[0],
  ): void {
    this.options.store.releaseRecheck(input);
  }

  clear(input: Parameters<WorkerAccountCapacityStore["clear"]>[0]): void {
    this.options.store.clear({
      accountId: this.aliases.resolve(input.accountId),
    });
  }
}

type CachedAlias = {
  readonly signature: string;
  readonly capacityAccountId: string;
};

class CodexAccountCapacityAliasResolver {
  private readonly cache = new Map<string, CachedAlias>();

  constructor(private readonly options: CodexAccountCapacityAliasStoreOptions) {}

  resolve(slotAlias: string): string {
    if (slotAlias.startsWith("codex-provider:")) return slotAlias;
    const inlineAuthJson = this.options.authJsonByAlias?.[slotAlias];
    if (inlineAuthJson !== undefined) {
      return this.resolveAuthJson({
        slotAlias,
        authJsonPath: join(this.options.authRootDir, slotAlias, "auth.json"),
        authJsonText: inlineAuthJson,
        signature: `inline:${createHash("sha256").update(inlineAuthJson).digest("hex")}`,
      });
    }
    const authJsonPath =
      this.options.authJsonPaths?.[slotAlias] ??
      join(this.options.authRootDir, slotAlias, "auth.json");
    try {
      const stats = statSync(authJsonPath);
      return this.resolveAuthJson({
        slotAlias,
        authJsonPath,
        authJsonText: readFileSync(authJsonPath, "utf8"),
        signature: `${stats.dev}:${stats.ino}:${stats.ctimeMs}:${stats.mtimeMs}:${stats.size}`,
      });
    } catch {
      this.cache.delete(slotAlias);
      return slotAlias;
    }
  }

  private resolveAuthJson(input: {
    readonly slotAlias: string;
    readonly authJsonPath: string;
    readonly authJsonText: string;
    readonly signature: string;
  }): string {
    const cached = this.cache.get(input.slotAlias);
    if (cached?.signature === input.signature) return cached.capacityAccountId;
    try {
      const authJson: unknown = JSON.parse(input.authJsonText);
      const capacityAccountId = codexCapacityAccountIdFromAuthJson({
        authJson,
        slotAlias: input.slotAlias,
        authJsonPath: input.authJsonPath,
      });
      this.cache.set(input.slotAlias, {
        signature: input.signature,
        capacityAccountId,
      });
      return capacityAccountId;
    } catch {
      this.cache.delete(input.slotAlias);
      return input.slotAlias;
    }
  }
}

function refreshSessionCapacityAccountId(authJson: unknown): string | null {
  if (!authJson || typeof authJson !== "object" || Array.isArray(authJson)) {
    return null;
  }
  const tokens = (authJson as Record<string, unknown>).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const refreshToken = (tokens as Record<string, unknown>).refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  return `codex-auth:${createHash("sha256").update(refreshToken).digest("hex")}`;
}
