import type { ProviderAccountAction, ProviderAccountAvailability, ProviderAccountDiagnosticSignal, ProviderAccountProbeMode } from "./types.js";
export declare function chooseDiagnosticSignal(input: {
    readonly signals: readonly ProviderAccountDiagnosticSignal[];
    readonly probeMode: ProviderAccountProbeMode;
    readonly checkedAt: Date;
}): ProviderAccountDiagnosticSignal;
export declare function recommendedActionForAvailability(availability: ProviderAccountAvailability): ProviderAccountAction;
export declare function isSchedulerEligible(availability: ProviderAccountAvailability): boolean;
export declare function accountAvailabilitySeverity(availability: ProviderAccountAvailability): number;
//# sourceMappingURL=policy.d.ts.map