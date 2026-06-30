import type { ProviderFailure } from "@vioxen/subscription-runtime/core";
type FailureRedactor = {
    readonly redact: (input: string) => string;
};
export declare class ClaudeProviderFailureError extends Error {
    readonly failure: ProviderFailure;
    readonly name = "ClaudeProviderFailureError";
    constructor(failure: ProviderFailure);
}
export declare function classifyClaudeFailure(error: unknown, options?: {
    readonly redactor?: FailureRedactor;
}): ProviderFailure;
export declare function classifyClaudeRuntimeFailure(message: string): string;
export {};
//# sourceMappingURL=failure-classifier.d.ts.map