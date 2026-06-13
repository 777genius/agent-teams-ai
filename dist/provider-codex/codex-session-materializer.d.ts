import type { RedactorPort, SessionArtifact } from "@vioxen/subscription-runtime/core";
import type { CodexMaterializedSession } from "./codex-json-execution-engine.js";
export type CodexSessionPrewarmResult = {
    readonly mode: "ephemeral" | "worker-cache";
    readonly home: string;
    readonly codexHome: string;
    readonly sessionHash: string;
    readonly reusable: boolean;
    readonly engine?: {
        readonly kind: string;
        readonly reusable: boolean;
    };
    readonly warmedAt: Date;
    readonly warnings?: readonly {
        readonly code: string;
        readonly safeMessage: string;
    }[];
};
export type CodexSessionMaterializer = {
    readonly mode: "ephemeral" | "worker-cache";
    materialize(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
    }): Promise<CodexMaterializedSession>;
    prewarm?(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
    }): Promise<CodexSessionPrewarmResult>;
    dispose?(): Promise<void>;
};
export declare class CodexEphemeralSessionMaterializer implements CodexSessionMaterializer {
    readonly mode: "ephemeral";
    materialize(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
    }): Promise<CodexMaterializedSession>;
    prewarm(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
    }): Promise<CodexSessionPrewarmResult>;
}
export type CodexWorkerCacheSessionMaterializerOptions = {
    /**
     * Host-owned stable scope, for example
     * `provider-account:${accountId}:slot:${slot}`.
     *
     * Use one materializer per worker slot. A single materializer serializes
     * access to its CODEX_HOME to avoid concurrent auth.json rewrites.
     */
    readonly cacheKey: string;
    /**
     * Parent directory for cache entries. If omitted, a process-local temp
     * directory is created and removed on dispose.
     */
    readonly rootDir?: string;
    /**
     * Keep the cache directory on dispose. Useful only for local debugging; host
     * apps should normally let durable storage own the real session.
     */
    readonly preserveOnDispose?: boolean;
};
export declare class CodexWorkerCacheSessionMaterializer implements CodexSessionMaterializer {
    private readonly options;
    readonly mode: "worker-cache";
    private readonly cacheKeyHash;
    private entry;
    private tail;
    constructor(options: CodexWorkerCacheSessionMaterializerOptions);
    materialize(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
    }): Promise<CodexMaterializedSession>;
    prewarm(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
    }): Promise<CodexSessionPrewarmResult>;
    dispose(): Promise<void>;
    private ensureEntry;
    private createEntry;
    private acquireExclusiveUse;
}
export type CodexWorkerCacheSessionPoolMaterializerOptions = {
    /**
     * Host-owned stable scope, for example `provider-account:${accountId}`.
     * The pool appends a deterministic slot suffix.
     */
    readonly cacheKey: string;
    /**
     * Number of reusable CODEX_HOME slots.
     *
     * Use this together with an app-server engine pool. One slot should handle
     * one active turn at a time unless a higher-level load test proves otherwise.
     */
    readonly slots: number;
    readonly rootDir?: string;
    readonly preserveOnDispose?: boolean;
};
export declare class CodexWorkerCacheSessionPoolMaterializer implements CodexSessionMaterializer {
    private readonly options;
    readonly mode: "worker-cache";
    private readonly slots;
    private readonly idleSlotIndexes;
    private readonly waiters;
    constructor(options: CodexWorkerCacheSessionPoolMaterializerOptions);
    materialize(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
    }): Promise<CodexMaterializedSession>;
    prewarm(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
    }): Promise<CodexSessionPrewarmResult>;
    dispose(): Promise<void>;
    private acquireSlot;
    private releaseSlot;
}
export declare function writeCodexJsonHomeSnapshot(input: {
    readonly codexHome: string;
    readonly authJson: string;
}): Promise<void>;
export declare function writeCodexAuthJson(input: {
    readonly codexHome: string;
    readonly authJson: string;
}): Promise<void>;
export declare function sessionArtifactHash(session: SessionArtifact): string;
//# sourceMappingURL=codex-session-materializer.d.ts.map