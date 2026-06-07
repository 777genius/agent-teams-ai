import { claudeBgTaskAgentCapabilities, claudeSessionCapabilities, } from "./capabilities.js";
export const claudeProviderManifest = {
    adapterId: "provider.claude-bg",
    adapterKind: "combined-provider",
    packageName: "@vioxen/subscription-runtime/provider-claude",
    packageVersion: "0.0.0",
    protocolVersion: 1,
    capabilities: {
        session: claudeSessionCapabilities,
        agent: claudeBgTaskAgentCapabilities,
    },
    experimental: true,
    minimumCoreVersion: "0.0.0",
};
//# sourceMappingURL=manifest.js.map