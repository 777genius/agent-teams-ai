import type {
  ObservabilityPort,
  RuntimeEvent,
  RuntimeMetric,
} from "@vioxen/subscription-runtime/core";

export class NullWorkerObservability implements ObservabilityPort {
  emit(event: RuntimeEvent): void {
    void event;
  }

  count(metric: RuntimeMetric, value?: number): void {
    void metric;
    void value;
  }

  timing(metric: RuntimeMetric, durationMs: number): void {
    void metric;
    void durationMs;
  }
}
