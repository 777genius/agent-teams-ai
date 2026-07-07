#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ListProviderAccountDiagnostics,
  createWorkerAccountCapacityReader,
  type ListProviderAccountDiagnosticsDependencies,
  type ProviderAccountAvailability,
  type ProviderAccountDiagnostic,
  type ProviderAccountProbeMode,
  type ProviderAccountProviderId,
} from "../../account-diagnostics";
import { LocalFileWorkerAccountCapacityStore } from "../../store-local-file";
import {
  createClaudeAccountHealthProbe,
  createClaudeAccountRegistry,
  createClaudeIdentityReader,
  discoverClaudeConfigAccounts,
  type ClaudeDiagnosticAccount,
} from "../../worker-claude";
import {
  createCodexAccountHealthProbe,
  createCodexAccountRegistry,
  createCodexAuthJsonIdentityReader,
  discoverCodexAuthJsonAccounts,
  type CodexDiagnosticAccount,
} from "../../worker-codex";

type ProviderSelector = ProviderAccountProviderId | "all";

export type AccountDiagnosticsCliIo = {
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  cwd(): string;
  env(): Readonly<Record<string, string | undefined>>;
};

export type AccountDiagnosticsProviderFactoryInput = {
  readonly provider: ProviderAccountProviderId;
  readonly args: AccountDiagnosticsCliParsedArgs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
};

export type AccountDiagnosticsProviderFactory = (
  input: AccountDiagnosticsProviderFactoryInput,
) => Promise<ListProviderAccountDiagnosticsDependencies>;

export type AccountDiagnosticsCliDependencies = {
  readonly providerFactory?: AccountDiagnosticsProviderFactory;
};

export type AccountDiagnosticsCliParsedArgs = {
  readonly provider: ProviderSelector;
  readonly json: boolean;
  readonly probeMode: ProviderAccountProbeMode;
  readonly only?: readonly ProviderAccountAvailability[];
  readonly timeoutMs?: number;
  readonly maxConcurrency?: number;
  readonly codexHomeRoot?: string;
  readonly codexAccounts: readonly string[];
  readonly codexBinaryPath?: string;
  readonly claudeConfigRoot?: string;
  readonly claudeAccounts: readonly string[];
  readonly claudePath?: string;
  readonly accountCapacityRoot?: string;
  readonly capacityAccounts: readonly string[];
};

export async function runAccountDiagnosticsCli(
  argv = process.argv.slice(2),
  io: AccountDiagnosticsCliIo = defaultIo,
  dependencies: AccountDiagnosticsCliDependencies = {},
): Promise<number> {
  try {
    const args = parseArgs(argv);
    const env = io.env();
    const providers =
      args.provider === "all" ? (["codex", "claude"] as const) : [args.provider];
    const diagnostics: ProviderAccountDiagnostic[] = [];
    const providerFactory = dependencies.providerFactory ?? defaultProviderFactory;
    const maxConcurrency =
      args.maxConcurrency ?? (args.probeMode === "cached" ? 4 : 1);

    for (const provider of providers) {
      const providerDependencies = await providerFactory({
        provider,
        args,
        env,
        cwd: io.cwd(),
      });
      const result = await new ListProviderAccountDiagnostics(
        providerDependencies,
      ).execute({
        provider,
        probeMode: args.probeMode,
        ...(args.only ? { only: args.only } : {}),
        ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
        maxConcurrency,
      });
      diagnostics.push(...result.diagnostics);
    }

    if (args.json) {
      io.writeStdout(
        `${JSON.stringify(
          {
            protocolVersion: 1,
            checkedAt: new Date().toISOString(),
            provider: args.provider,
            probeMode: args.probeMode,
            diagnostics,
          },
          null,
          2,
        )}\n`,
      );
      return hasBlockingDiagnostics(diagnostics) ? 1 : 0;
    }

    io.writeStdout(formatDiagnosticsTable(diagnostics));
    return hasBlockingDiagnostics(diagnostics) ? 1 : 0;
  } catch (error) {
    io.writeStderr(
      `${error instanceof Error ? error.message : "account diagnostics failed"}\n`,
    );
    return 2;
  }
}

async function defaultProviderFactory(
  input: AccountDiagnosticsProviderFactoryInput,
): Promise<ListProviderAccountDiagnosticsDependencies> {
  const capacityAccountIds = capacityAccountMap(input.args.capacityAccounts);
  const accountCapacityRoot =
    input.args.accountCapacityRoot ??
    input.env.SUBSCRIPTION_RUNTIME_ACCOUNT_CAPACITY_ROOT ??
    input.env.SUBSCRIPTION_RUNTIME_STATE_ROOT;
  const capacityReader = accountCapacityRoot
    ? createWorkerAccountCapacityReader({
        store: new LocalFileWorkerAccountCapacityStore({
          rootDir: resolve(input.cwd, accountCapacityRoot),
        }),
      })
    : undefined;

  if (input.provider === "codex") {
    const rootDir =
      input.args.codexHomeRoot ??
      input.env.SUBSCRIPTION_RUNTIME_CODEX_ACCOUNTS_ROOT;
    const accounts = await discoverCodexAuthJsonAccounts({
      accounts: explicitCodexAccounts({
        values: input.args.codexAccounts,
        env: input.env,
        cwd: input.cwd,
        capacityAccountIds,
        ...(input.args.codexBinaryPath
          ? { codexBinaryPath: input.args.codexBinaryPath }
          : {}),
      }),
      capacityAccountIds,
      ...(rootDir ? { rootDir } : {}),
      ...(input.args.codexBinaryPath
        ? { codexBinaryPath: input.args.codexBinaryPath }
        : {}),
    });
    return {
      registry: createCodexAccountRegistry(accounts),
      identityReader: createCodexAuthJsonIdentityReader(),
      ...(capacityReader ? { capacityReader } : {}),
      healthProbe: createCodexAccountHealthProbe({
        ...(input.args.codexBinaryPath
          ? { codexBinaryPath: input.args.codexBinaryPath }
          : {}),
      }),
    };
  }

  const rootDir =
    input.args.claudeConfigRoot ??
    input.env.SUBSCRIPTION_RUNTIME_CLAUDE_ACCOUNTS_ROOT;
  const accounts = await discoverClaudeConfigAccounts({
    accounts: explicitClaudeAccounts({
      values: input.args.claudeAccounts,
      env: input.env,
      cwd: input.cwd,
      capacityAccountIds,
      ...(input.args.claudePath ? { claudePath: input.args.claudePath } : {}),
    }),
    capacityAccountIds,
    ...(rootDir ? { rootDir } : {}),
    ...(input.args.claudePath ? { claudePath: input.args.claudePath } : {}),
  });
  return {
    registry: createClaudeAccountRegistry(accounts),
    identityReader: createClaudeIdentityReader(),
    ...(capacityReader ? { capacityReader } : {}),
    healthProbe: createClaudeAccountHealthProbe({
      ...(input.args.claudePath ? { claudePath: input.args.claudePath } : {}),
    }),
  };
}

function parseArgs(argv: readonly string[]): AccountDiagnosticsCliParsedArgs {
  let provider: ProviderSelector = "all";
  let json = false;
  let probeMode: ProviderAccountProbeMode = "cached";
  let only: readonly ProviderAccountAvailability[] | undefined;
  let timeoutMs: number | undefined;
  let maxConcurrency: number | undefined;
  let codexHomeRoot: string | undefined;
  const codexAccounts: string[] = [];
  let codexBinaryPath: string | undefined;
  let claudeConfigRoot: string | undefined;
  const claudeAccounts: string[] = [];
  let claudePath: string | undefined;
  let accountCapacityRoot: string | undefined;
  const capacityAccounts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--provider") {
      const value = requiredValue(argv, index, arg);
      if (value !== "codex" && value !== "claude" && value !== "all") {
        throw new Error("--provider must be codex, claude or all");
      }
      provider = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--probe") {
      probeMode = "live_probe";
      continue;
    }
    if (arg === "--health") {
      probeMode = "health";
      continue;
    }
    if (arg === "--only") {
      only = parseAvailabilityList(requiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(requiredValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--max-concurrency") {
      maxConcurrency = parsePositiveInteger(requiredValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--codex-home-root") {
      codexHomeRoot = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--codex-account") {
      codexAccounts.push(requiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--codex-binary") {
      codexBinaryPath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--claude-config-root") {
      claudeConfigRoot = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--claude-account") {
      claudeAccounts.push(requiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--claude-path") {
      claudePath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--account-capacity-root") {
      accountCapacityRoot = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--capacity-account") {
      capacityAccounts.push(requiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    provider,
    json,
    probeMode,
    ...(only ? { only } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxConcurrency ? { maxConcurrency } : {}),
    ...(codexHomeRoot ? { codexHomeRoot } : {}),
    codexAccounts,
    ...(codexBinaryPath ? { codexBinaryPath } : {}),
    ...(claudeConfigRoot ? { claudeConfigRoot } : {}),
    claudeAccounts,
    ...(claudePath ? { claudePath } : {}),
    ...(accountCapacityRoot ? { accountCapacityRoot } : {}),
    capacityAccounts,
  };
}

function explicitCodexAccounts(input: {
  readonly values: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly capacityAccountIds: Readonly<Record<string, string>>;
  readonly codexBinaryPath?: string;
}): readonly CodexDiagnosticAccount[] {
  const accounts = input.values.map((value) => {
    const parsed = parseSlotPath(value, input.cwd);
    return {
      provider: "codex" as const,
      slotId: parsed.slotId,
      providerInstanceId: `codex:${parsed.slotId}`,
      authJsonPath: parsed.path,
      ...(parsed.path.endsWith("/auth.json")
        ? { codexHome: parsed.path.slice(0, -"auth.json".length - 1) }
        : {}),
      ...(input.capacityAccountIds[parsed.slotId]
        ? { capacityAccountId: input.capacityAccountIds[parsed.slotId] }
        : {}),
      ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
    };
  });
  const envAuthPath = input.env.CODEX_AUTH_JSON_PATH;
  if (!envAuthPath) return accounts;
  return [
    ...accounts,
    {
      provider: "codex",
      slotId: "env",
      providerInstanceId: "codex:env",
      authJsonPath: resolve(input.cwd, envAuthPath),
      ...(input.capacityAccountIds.env
        ? { capacityAccountId: input.capacityAccountIds.env }
        : {}),
      ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
    },
  ];
}

function explicitClaudeAccounts(input: {
  readonly values: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly capacityAccountIds: Readonly<Record<string, string>>;
  readonly claudePath?: string;
}): readonly ClaudeDiagnosticAccount[] {
  const accounts = input.values.map((value) => {
    const parsed = parseSlotPath(value, input.cwd);
    return {
      provider: "claude" as const,
      slotId: parsed.slotId,
      providerInstanceId: `claude:${parsed.slotId}`,
      configDir: parsed.path,
      ...(input.capacityAccountIds[parsed.slotId]
        ? { capacityAccountId: input.capacityAccountIds[parsed.slotId] }
        : {}),
      ...(input.claudePath ? { claudePath: input.claudePath } : {}),
    };
  });
  const envConfigDir = input.env.CLAUDE_CONFIG_DIR;
  if (!envConfigDir) return accounts;
  return [
    ...accounts,
    {
      provider: "claude",
      slotId: basename(envConfigDir),
      providerInstanceId: `claude:${basename(envConfigDir)}`,
      configDir: resolve(input.cwd, envConfigDir),
      ...(input.capacityAccountIds[basename(envConfigDir)]
        ? { capacityAccountId: input.capacityAccountIds[basename(envConfigDir)] }
        : {}),
      ...(input.claudePath ? { claudePath: input.claudePath } : {}),
    },
  ];
}

function parseSlotPath(value: string, cwd: string): { slotId: string; path: string } {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw new Error("account must use slot=path format");
  }
  const slotId = value.slice(0, separator).trim();
  const path = value.slice(separator + 1).trim();
  if (!slotId || !path) throw new Error("account must use slot=path format");
  return {
    slotId,
    path: resolve(cwd, path),
  };
}

function capacityAccountMap(
  values: readonly string[],
): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new Error("--capacity-account must use slot=accountId format");
    }
    const slotId = value.slice(0, separator).trim();
    const accountId = value.slice(separator + 1).trim();
    if (!slotId || !accountId) {
      throw new Error("--capacity-account must use slot=accountId format");
    }
    map[slotId] = accountId;
  }
  return map;
}

function parseAvailabilityList(
  value: string,
): readonly ProviderAccountAvailability[] {
  return value.split(",").map((part) => {
    const normalized = part.trim();
    if (
      normalized !== "available" &&
      normalized !== "limited" &&
      normalized !== "reconnect_required" &&
      normalized !== "auth_unknown" &&
      normalized !== "unhealthy" &&
      normalized !== "unknown"
    ) {
      throw new Error("--only contains an unknown availability");
    }
    return normalized;
  });
}

function formatDiagnosticsTable(
  diagnostics: readonly ProviderAccountDiagnostic[],
): string {
  if (diagnostics.length === 0) {
    return "provider\tslot\tavailability\taction\tidentity\tsource\treason\treset\n";
  }
  const rows = diagnostics.map((diagnostic) =>
    [
      diagnostic.provider,
      diagnostic.slotId,
      diagnostic.availability,
      diagnostic.recommendedAction,
      diagnostic.safeIdentity,
      diagnostic.source,
      diagnostic.reason ?? "",
      diagnostic.limitResetAt?.toISOString() ?? diagnostic.rawResetText ?? "",
    ].join("\t"),
  );
  return [
    "provider\tslot\tavailability\taction\tidentity\tsource\treason\treset",
    ...rows,
  ].join("\n") + "\n";
}

function hasBlockingDiagnostics(
  diagnostics: readonly ProviderAccountDiagnostic[],
): boolean {
  return diagnostics.some((diagnostic) => !diagnostic.schedulerEligible);
}

function requiredValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function usage(): string {
  return [
    "usage: subscription-runtime-account-status [--provider codex|claude|all] [--json]",
    "       [--probe] [--only availability] [--timeout-ms ms]",
    "       [--codex-home-root dir] [--codex-account slot=auth.json]",
    "       [--claude-config-root dir] [--claude-account slot=config-dir]",
    "       [--account-capacity-root dir] [--capacity-account slot=accountId]",
  ].join("\n");
}

const defaultIo: AccountDiagnosticsCliIo = {
  writeStdout(chunk: string): void {
    process.stdout.write(chunk);
  },
  writeStderr(chunk: string): void {
    process.stderr.write(chunk);
  },
  cwd(): string {
    return process.cwd();
  },
  env(): Readonly<Record<string, string | undefined>> {
    return process.env;
  },
};

if (await isMainModule()) {
  process.exitCode = await runAccountDiagnosticsCli();
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return (await realpath(modulePath)) === (await realpath(process.argv[1]));
  } catch {
    return modulePath === process.argv[1];
  }
}
