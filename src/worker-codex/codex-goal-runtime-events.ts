import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ObservabilityPort,
  RuntimeEvent,
  RuntimeMetric,
} from "@vioxen/subscription-runtime/core";

export type CodexGoalRuntimeEventLevel = "info" | "warning" | "error";

export type CodexGoalRuntimeEvent = {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly event: string;
  readonly level: CodexGoalRuntimeEventLevel;
  readonly timestamp: string;
  readonly pid: number;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
};

export function createCodexGoalRuntimeEventWriter(input: {
  readonly eventPath: string;
  readonly taskId: string;
}) {
  let writes = Promise.resolve();
  const write = (
    event: string,
    attributes: Readonly<Record<string, string | number | boolean>> = {},
    level: CodexGoalRuntimeEventLevel = "info",
  ) => {
    writes = writes.then(async () => {
      await mkdir(dirname(input.eventPath), { recursive: true, mode: 0o700 });
      const compactedAttributes = compactEventAttributes(attributes);
      const entry: CodexGoalRuntimeEvent = {
        schemaVersion: 1,
        taskId: input.taskId,
        event,
        level,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        ...(compactedAttributes === undefined
          ? {}
          : { attributes: compactedAttributes }),
      };
      await appendFile(input.eventPath, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
    return writes;
  };
  return {
    write(
      event: string,
      attributes?: Readonly<Record<string, string | number | boolean>> & {
        readonly level?: CodexGoalRuntimeEventLevel;
      },
    ): Promise<void> {
      const { level, ...eventAttributes } = attributes ?? {};
      return write(event, eventAttributes, level ?? "info");
    },
  };
}

export function codexGoalRuntimeEventObservability(
  writer: ReturnType<typeof createCodexGoalRuntimeEventWriter>,
): ObservabilityPort {
  return {
    emit(event: RuntimeEvent): void {
      void writer.write("runtime_observability_event", {
        name: event.name,
        ...(event.providerId ? { providerId: event.providerId } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.storeId ? { storeId: event.storeId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        ...(event.durationMs === undefined
          ? {}
          : { durationMs: event.durationMs }),
      });
    },
    count(metric: RuntimeMetric, value = 1): void {
      void writer.write("runtime_metric", {
        kind: "count",
        metric,
        value,
      });
    },
    timing(metric: RuntimeMetric, durationMs: number): void {
      void writer.write("runtime_metric", {
        kind: "timing",
        metric,
        value: durationMs,
        unit: "milliseconds",
      });
    },
  };
}

function compactEventAttributes(
  attributes: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> | undefined {
  const compacted = Object.fromEntries(
    Object.entries(attributes).filter(([, value]) =>
      value !== "" && value !== undefined && value !== null
    ),
  );
  return Object.keys(compacted).length ? compacted : undefined;
}
