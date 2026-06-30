export type CombinedAbortSignal = {
    readonly signal: AbortSignal;
    dispose(): void;
};
export declare function combineAbortSignals(...signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal;
//# sourceMappingURL=abort-signal.d.ts.map