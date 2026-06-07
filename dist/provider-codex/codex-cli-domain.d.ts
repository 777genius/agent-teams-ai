export declare const codexAuthJsonMaxBytes: number;
export type ValidatedCodexAuthJson = {
    readonly auth_mode: "chatgpt";
    readonly tokens: {
        readonly refresh_token: string;
        readonly access_token?: string;
        readonly id_token?: string;
        readonly expiry?: string | number;
        readonly [key: string]: unknown;
    };
    readonly last_refresh?: string;
    readonly [key: string]: unknown;
};
export type CodexAuthJsonValidationResult = {
    readonly parsed: ValidatedCodexAuthJson;
    readonly byteLength: number;
    readonly exactBytesSha256: string;
    readonly warnings: readonly string[];
};
export type CodexAuthJsonFreshness = {
    readonly lastRefreshAt: Date | null;
    readonly expiresAt: Date | null;
    readonly warnings: readonly string[];
};
export declare function validateCodexAuthJsonBytes(input: {
    readonly authJsonBytes: string;
    readonly maxBytes?: number;
    readonly staleWarningDays?: number;
    readonly now?: Date;
}): CodexAuthJsonValidationResult;
export declare function compactCodexAuthJson(input: {
    readonly authJsonBytes: string;
    readonly maxBytes?: number;
}): {
    readonly compactAuthJsonBytes: string;
    readonly byteLength: number;
};
export declare function readCodexAuthJsonFreshness(input: {
    readonly authJsonBytes: string;
    readonly now?: Date;
}): CodexAuthJsonFreshness;
export declare function classifyCodexRuntimeFailure(message: string): string;
export declare function pruneCodexChildEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string>;
export declare function buildCodexRefreshBootstrapPlan(input: {
    readonly codexBinaryPath: string;
    readonly tempHome: string;
    readonly tempCodexHome: string;
    readonly emptyWorkingDirectory: string;
    readonly authJsonPath: string;
    readonly model?: string;
}): {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
};
//# sourceMappingURL=codex-cli-domain.d.ts.map