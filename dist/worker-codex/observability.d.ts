import type { ObservabilityPort, RuntimeEvent, RuntimeMetric } from "@vioxen/subscription-runtime/core";
export declare class NullWorkerObservability implements ObservabilityPort {
    emit(event: RuntimeEvent): void;
    count(metric: RuntimeMetric, value?: number): void;
    timing(metric: RuntimeMetric, durationMs: number): void;
}
//# sourceMappingURL=observability.d.ts.map