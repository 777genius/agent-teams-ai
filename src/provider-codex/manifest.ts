import type { RuntimeAdapterManifest } from "@vioxen/subscription-runtime/core";
import {
  codexJsonAgentCapabilities,
  codexSessionCapabilities,
} from "./capabilities";

export const codexProviderManifest = {
  adapterId: "provider.codex-cli",
  adapterKind: "combined-provider",
  packageName: "@vioxen/subscription-runtime/provider-codex",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: {
    session: codexSessionCapabilities,
    agent: codexJsonAgentCapabilities,
  },
  experimental: false,
  minimumCoreVersion: "0.0.0",
} satisfies RuntimeAdapterManifest<{
  readonly session: typeof codexSessionCapabilities;
  readonly agent: typeof codexJsonAgentCapabilities;
}>;
