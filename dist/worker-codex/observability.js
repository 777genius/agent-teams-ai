export class NullWorkerObservability {
    emit(event) {
        void event;
    }
    count(metric, value) {
        void metric;
        void value;
    }
    timing(metric, durationMs) {
        void metric;
        void durationMs;
    }
}
//# sourceMappingURL=observability.js.map