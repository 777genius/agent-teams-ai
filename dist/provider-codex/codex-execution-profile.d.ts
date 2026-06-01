export type CodexExecutionProfilePreset = "stateless-completion" | "subscription-worker";
export type CodexExecutionHistoryMode = "none";
export type CodexExecutionProfile = CodexExecutionProfilePreset | {
    readonly kind: "custom";
    readonly baseInstructions?: string | null;
    readonly developerInstructions?: string | null;
    readonly disableTools?: boolean;
    readonly historyMode?: CodexExecutionHistoryMode;
};
export type ResolvedCodexExecutionProfile = {
    readonly kind: CodexExecutionProfilePreset | "custom";
    readonly baseInstructions: string | null;
    readonly developerInstructions: string | null;
    readonly disableTools: boolean;
    readonly historyMode: CodexExecutionHistoryMode;
};
export declare function resolveCodexExecutionProfile(profile: CodexExecutionProfile | undefined): ResolvedCodexExecutionProfile;
//# sourceMappingURL=codex-execution-profile.d.ts.map