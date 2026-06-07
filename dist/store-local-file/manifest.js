import { localFileLeaseStoreCapabilities } from "./local-file-lease-store.js";
import { localEncryptedFileStoreCapabilities } from "./local-encrypted-file-store.js";
export const localEncryptedFileStoreManifest = {
    adapterId: "store.local-encrypted-file",
    adapterKind: "store",
    packageName: "@vioxen/subscription-runtime/store-local-file",
    packageVersion: "0.0.0",
    protocolVersion: 1,
    capabilities: localEncryptedFileStoreCapabilities,
    custody: "local-only",
    experimental: false,
    minimumCoreVersion: "0.0.0",
};
export const localFileLeaseStoreManifest = {
    adapterId: "lease.local-file",
    adapterKind: "lease-store",
    packageName: "@vioxen/subscription-runtime/store-local-file",
    packageVersion: "0.0.0",
    protocolVersion: 1,
    capabilities: localFileLeaseStoreCapabilities,
    custody: "local-only",
    experimental: false,
    minimumCoreVersion: "0.0.0",
};
//# sourceMappingURL=manifest.js.map