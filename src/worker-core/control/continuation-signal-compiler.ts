import type { WorkerControlSignal } from "./types";

export function compileWorkerControlSignalsForContinuation(
  signals: readonly WorkerControlSignal[],
): string | undefined {
  if (signals.length === 0) return undefined;
  const items = signals
    .slice()
    .sort(compareWorkerControlSignals)
    .map((signal, index) => {
      const metadata = Object.entries(signal.metadata)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      return [
        `${index + 1}. ${signal.intent} (${signal.deliveryMode}, ${signal.priority})`,
        `Signal id: ${signal.signalId}`,
        `Created by: ${signal.createdBy} at ${signal.createdAt.toISOString()}`,
        metadata ? `Metadata: ${metadata}` : "",
        "Message:",
        signal.body.trim(),
      ]
        .filter(Boolean)
        .join("\n");
    });

  return [
    "Runtime control inbox instructions:",
    "The following durable control signals were queued for this worker after the original task text. Treat them as current runtime instructions for the same task.",
    "If a control signal conflicts with older task text, follow the newer control signal unless it is unsafe, impossible, or outside the allowed workspace and policy boundaries.",
    "Do not restart from scratch. Continue from the current workspace and session state.",
    "",
    ...items,
    "",
    "Apply the runtime control signals now. For this turn, the newest applicable non-record-only control signal is the active user/operator instruction.",
  ].join("\n\n");
}

export function compareWorkerControlSignals(
  left: WorkerControlSignal,
  right: WorkerControlSignal,
): number {
  const priority = priorityRank(right.priority) - priorityRank(left.priority);
  if (priority !== 0) return priority;
  const created = left.createdAt.getTime() - right.createdAt.getTime();
  if (created !== 0) return created;
  return left.signalId.localeCompare(right.signalId);
}

function priorityRank(priority: WorkerControlSignal["priority"]): number {
  if (priority === "high") return 3;
  if (priority === "normal") return 2;
  return 1;
}
