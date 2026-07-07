import type { RuntimeAdapterManifest } from "@vioxen/subscription-runtime/core";
import {
  githubActionsSecretStoreCapabilities,
} from "./domain/github-actions-secret-store-policy";

export const githubActionsSecretStoreManifest = {
  adapterId: "store.github-actions-secret",
  adapterKind: "store",
  packageName: "@vioxen/subscription-runtime/store-github-actions-secret",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: githubActionsSecretStoreCapabilities,
  custody: "no-plaintext-backend",
  experimental: false,
  minimumCoreVersion: "0.0.0",
} satisfies RuntimeAdapterManifest<typeof githubActionsSecretStoreCapabilities>;
