import { ClaudeSessionDriver } from "./claude-session-driver.js";
import { ClaudeTaskAgentDriver, } from "./claude-task-agent-driver.js";
export class ClaudeBgProviderDriver {
    sessionDriver;
    agentDriver;
    providerId;
    agentId;
    supportedArtifactKinds;
    capabilities;
    agentCapabilities;
    constructor(options) {
        this.sessionDriver = new ClaudeSessionDriver();
        this.agentDriver = new ClaudeTaskAgentDriver(options);
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
    streamTask(input) {
        return this.agentDriver.streamTask(input);
    }
    async dispose() {
        await this.agentDriver.dispose();
    }
}
//# sourceMappingURL=claude-bg-provider-driver.js.map