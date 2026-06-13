import type { AgentDriver, ProviderSessionDriver, RedactorPort, SessionStorePort } from "../ports/index.js";
import type { SessionArtifact } from "../domain/types.js";
export type ProviderDriverTestFixture = {
    readonly driver: ProviderSessionDriver;
    readonly goodSession: SessionArtifact;
    readonly redactor: RedactorPort;
    readonly reconnectError: unknown;
};
export declare function providerSessionDriverContract(name: string, factory: () => ProviderDriverTestFixture): void;
export type AgentDriverTestFixture = {
    readonly driver: AgentDriver;
    readonly goodSession: SessionArtifact;
    readonly redactor: RedactorPort;
};
export declare function agentDriverContract(name: string, factory: () => AgentDriverTestFixture): void;
export type SessionStoreTestFixture = {
    readonly store: SessionStorePort;
    readonly providerInstanceId: string;
    readonly currentArtifact: SessionArtifact;
    readonly nextArtifact: SessionArtifact;
    seed(input: {
        readonly generation: number;
    }): Promise<void> | void;
};
export declare function sessionStoreContract(name: string, factory: () => SessionStoreTestFixture): void;
//# sourceMappingURL=contracts.d.ts.map