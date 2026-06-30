export type ParsedLimitReset = {
    readonly rawResetText?: string;
    readonly limitResetAt?: Date;
};
export declare function parseLimitResetFromText(input: {
    readonly text: string;
    readonly now: Date;
}): ParsedLimitReset;
//# sourceMappingURL=reset-time.d.ts.map