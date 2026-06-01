import { CodexCliAgentDriver, } from "./codex-cli-agent-driver.js";
import { CodexCliSessionDriver, } from "./codex-cli-session-driver.js";
export class CodexCliProviderDriver {
    sessionDriver;
    agentDriver;
    providerId;
    agentId;
    supportedArtifactKinds;
    capabilities;
    agentCapabilities;
    constructor(options = {}) {
        this.sessionDriver = new CodexCliSessionDriver(options);
        this.agentDriver = new CodexCliAgentDriver(options);
        this.providerId = this.sessionDriver.providerId;
        this.agentId = this.agentDriver.agentId;
        this.supportedArtifactKinds = this.sessionDriver.supportedArtifactKinds;
        this.capabilities = this.sessionDriver.capabilities;
        this.agentCapabilities = this.agentDriver.capabilities;
    }
    validateSession(input) {
        return this.sessionDriver.validateSession(input);
    }
    refreshSession(input) {
        return this.sessionDriver.refreshSession(input);
    }
    classifySessionFailure(error) {
        return this.sessionDriver.classifySessionFailure(error);
    }
    runTask(input) {
        return this.agentDriver.runTask(input);
    }
    classifyRunFailure(error) {
        return this.agentDriver.classifyRunFailure(error);
    }
}
//# sourceMappingURL=codex-cli-provider-driver.js.map