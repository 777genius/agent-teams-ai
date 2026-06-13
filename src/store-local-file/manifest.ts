import type { RuntimeAdapterManifest } from "@vioxen/subscription-runtime/core";
import { localFileLeaseStoreCapabilities } from "./local-file-lease-store";
import { localEncryptedFileStoreCapabilities } from "./local-encrypted-file-store";

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
} satisfies RuntimeAdapterManifest<typeof localEncryptedFileStoreCapabilities>;

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
} satisfies RuntimeAdapterManifest<typeof localFileLeaseStoreCapabilities>;
