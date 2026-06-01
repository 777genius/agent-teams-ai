import { RuntimeConfigurationError } from "../domain/errors";
import type {
  AgentCapabilities,
  ProviderCapabilities,
  RuntimePolicy,
  RunnerCapabilities,
  SessionStoreCapabilities,
} from "../domain/types";
import { negotiateCapabilities } from "./policy";

export const subscriptionRuntimeCoreVersion = "0.0.0";
export const subscriptionRuntimeProtocolVersion = 1;

export type RuntimeAdapterKind =
  | "provider-session"
  | "agent"
  | "combined-provider"
  | "store"
  | "lease-store"
  | "runner"
  | "workspace"
  | "setup"
  | "observability";

export type RuntimeAdapterManifest<TCapabilities = unknown> = {
  readonly adapterId: string;
  readonly adapterKind: RuntimeAdapterKind;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly protocolVersion: 1;
  readonly capabilities: TCapabilities;
  readonly custody?: "no-plaintext-backend" | "backend-custody" | "local-only";
  readonly experimental: boolean;
  readonly minimumCoreVersion: string;
};

export type RuntimeAdapterFactory<TPort = unknown, TOptions = unknown> = {
  readonly manifest: RuntimeAdapterManifest;
  create(options: TOptions): TPort;
};

export type AdapterRegistry = {
  register(adapter: RuntimeAdapterFactory): void;
  getManifest(adapterId: string): RuntimeAdapterManifest | null;
  create<TPort = unknown, TOptions = unknown>(
    adapterId: string,
    options: TOptions,
  ): TPort;
};

export function createAdapterRegistry(
  adapters: readonly RuntimeAdapterFactory[] = [],
): AdapterRegistry {
  return new DefaultAdapterRegistry(adapters);
}

export function assertRuntimeAdapterManifest(
  manifest: RuntimeAdapterManifest,
  coreVersion = subscriptionRuntimeCoreVersion,
): void {
  if (
    !manifest.adapterId ||
    !/^[a-z0-9._:-]{3,120}$/i.test(manifest.adapterId)
  ) {
    throw new RuntimeConfigurationError("adapter_manifest_invalid_id");
  }
  if (manifest.protocolVersion !== subscriptionRuntimeProtocolVersion) {
    throw new RuntimeConfigurationError("adapter_manifest_protocol_mismatch");
  }
  if (compareSemver(manifest.minimumCoreVersion, coreVersion) > 0) {
    throw new RuntimeConfigurationError("adapter_manifest_core_too_old");
  }
  if (!manifest.packageName || !manifest.packageVersion) {
    throw new RuntimeConfigurationError("adapter_manifest_package_missing");
  }
}

export function assertCompatibleRuntimeManifests(input: {
  readonly provider: RuntimeAdapterManifest<{
    readonly session?: ProviderCapabilities;
    readonly agent?: AgentCapabilities;
  }>;
  readonly store?: RuntimeAdapterManifest<SessionStoreCapabilities>;
  readonly runner: RuntimeAdapterManifest<RunnerCapabilities>;
  readonly policy: RuntimePolicy;
  readonly coreVersion?: string;
}): void {
  const coreVersion = input.coreVersion ?? subscriptionRuntimeCoreVersion;
  assertRuntimeAdapterManifest(input.provider, coreVersion);
  if (input.store) {
    assertRuntimeAdapterManifest(input.store, coreVersion);
  }
  assertRuntimeAdapterManifest(input.runner, coreVersion);

  const session = input.provider.capabilities.session;
  const agent = input.provider.capabilities.agent;
  if (!session || !agent) {
    throw new RuntimeConfigurationError(
      "provider_manifest_missing_capabilities",
    );
  }

  const decision = negotiateCapabilities({
    requested: input.policy,
    provider: session,
    agent,
    runner: input.runner.capabilities,
    ...(input.store ? { store: input.store.capabilities } : {}),
  });

  if (decision.status === "rejected") {
    throw new RuntimeConfigurationError(decision.code);
  }
}

export function defineSubscriptionRuntimeConfig<
  TConfig extends Readonly<Record<string, unknown>>,
>(config: TConfig): TConfig {
  assertNoSessionBytesInConfig(config);
  return config;
}

export function assertNoSessionBytesInConfig(value: unknown): void {
  scanConfig(value, []);
}

class DefaultAdapterRegistry implements AdapterRegistry {
  private readonly byId = new Map<string, RuntimeAdapterFactory>();

  constructor(adapters: readonly RuntimeAdapterFactory[]) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: RuntimeAdapterFactory): void {
    assertRuntimeAdapterManifest(adapter.manifest);
    if (this.byId.has(adapter.manifest.adapterId)) {
      throw new RuntimeConfigurationError("duplicate_adapter_id");
    }
    this.byId.set(adapter.manifest.adapterId, adapter);
  }

  getManifest(adapterId: string): RuntimeAdapterManifest | null {
    return this.byId.get(adapterId)?.manifest ?? null;
  }

  create<TPort = unknown, TOptions = unknown>(
    adapterId: string,
    options: TOptions,
  ): TPort {
    const adapter = this.byId.get(adapterId);
    if (!adapter) {
      throw new RuntimeConfigurationError("adapter_not_registered");
    }
    return adapter.create(options) as TPort;
  }
}

function scanConfig(value: unknown, path: readonly string[]): void {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    throw new RuntimeConfigurationError(
      `runtime_config_contains_session_bytes:${path.join(".") || "<root>"}`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanConfig(entry, [...path, String(index)]),
    );
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveConfigKey(key)) {
      throw new RuntimeConfigurationError(
        `runtime_config_contains_secret_field:${[...path, key].join(".")}`,
      );
    }
    scanConfig(nested, [...path, key]);
  }
}

function isSensitiveConfigKey(key: string): boolean {
  return /(?:auth_json|refresh_token|access_token|id_token|session_bytes|secret_value|plaintext)/i.test(
    key,
  );
}

function compareSemver(left: string, right: string): number {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = leftParts[index]! - rightParts[index]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(value: string): readonly [number, number, number] {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new RuntimeConfigurationError("adapter_manifest_invalid_semver");
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
