import { codexJsonAgentCapabilities, codexSessionCapabilities, } from "./capabilities.js";
export const codexProviderManifest = {
    adapterId: "provider.codex-cli",
    adapterKind: "combined-provider",
    packageName: "@777genius/subscription-runtime/provider-codex",
    packageVersion: "0.0.0",
    protocolVersion: 1,
    capabilities: {
        session: codexSessionCapabilities,
        agent: codexJsonAgentCapabilities,
    },
    experimental: false,
    minimumCoreVersion: "0.0.0",
};
//# sourceMappingURL=manifest.js.map