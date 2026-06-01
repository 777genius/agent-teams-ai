import { RuntimeConfigurationError } from "../domain/errors.js";
import { negotiateCapabilities } from "./policy.js";
export const subscriptionRuntimeCoreVersion = "0.0.0";
export const subscriptionRuntimeProtocolVersion = 1;
export function createAdapterRegistry(adapters = []) {
    return new DefaultAdapterRegistry(adapters);
}
export function assertRuntimeAdapterManifest(manifest, coreVersion = subscriptionRuntimeCoreVersion) {
    if (!manifest.adapterId ||
        !/^[a-z0-9._:-]{3,120}$/i.test(manifest.adapterId)) {
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
export function assertCompatibleRuntimeManifests(input) {
    const coreVersion = input.coreVersion ?? subscriptionRuntimeCoreVersion;
    assertRuntimeAdapterManifest(input.provider, coreVersion);
    if (input.store) {
        assertRuntimeAdapterManifest(input.store, coreVersion);
    }
    assertRuntimeAdapterManifest(input.runner, coreVersion);
    const session = input.provider.capabilities.session;
    const agent = input.provider.capabilities.agent;
    if (!session || !agent) {
        throw new RuntimeConfigurationError("provider_manifest_missing_capabilities");
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
export function defineSubscriptionRuntimeConfig(config) {
    assertNoSessionBytesInConfig(config);
    return config;
}
export function assertNoSessionBytesInConfig(value) {
    scanConfig(value, []);
}
class DefaultAdapterRegistry {
    byId = new Map();
    constructor(adapters) {
        for (const adapter of adapters) {
            this.register(adapter);
        }
    }
    register(adapter) {
        assertRuntimeAdapterManifest(adapter.manifest);
        if (this.byId.has(adapter.manifest.adapterId)) {
            throw new RuntimeConfigurationError("duplicate_adapter_id");
        }
        this.byId.set(adapter.manifest.adapterId, adapter);
    }
    getManifest(adapterId) {
        return this.byId.get(adapterId)?.manifest ?? null;
    }
    create(adapterId, options) {
        const adapter = this.byId.get(adapterId);
        if (!adapter) {
            throw new RuntimeConfigurationError("adapter_not_registered");
        }
        return adapter.create(options);
    }
}
function scanConfig(value, path) {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        throw new RuntimeConfigurationError(`runtime_config_contains_session_bytes:${path.join(".") || "<root>"}`);
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => scanConfig(entry, [...path, String(index)]));
        return;
    }
    if (!value || typeof value !== "object") {
        return;
    }
    for (const [key, nested] of Object.entries(value)) {
        if (isSensitiveConfigKey(key)) {
            throw new RuntimeConfigurationError(`runtime_config_contains_secret_field:${[...path, key].join(".")}`);
        }
        scanConfig(nested, [...path, key]);
    }
}
function isSensitiveConfigKey(key) {
    return /(?:auth_json|refresh_token|access_token|id_token|session_bytes|secret_value|plaintext)/i.test(key);
}
function compareSemver(left, right) {
    const leftParts = parseSemver(left);
    const rightParts = parseSemver(right);
    for (let index = 0; index < 3; index += 1) {
        const diff = leftParts[index] - rightParts[index];
        if (diff !== 0)
            return diff;
    }
    return 0;
}
function parseSemver(value) {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
        throw new RuntimeConfigurationError("adapter_manifest_invalid_semver");
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
//# sourceMappingURL=adapters.js.map