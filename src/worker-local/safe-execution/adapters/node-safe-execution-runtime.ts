import { randomUUID } from "node:crypto";
import type { SafeExecutionRuntime } from "@vioxen/subscription-runtime/worker-core";

export class NodeSafeExecutionRuntime implements SafeExecutionRuntime {
  createOwnerId(): string {
    return `safe-execution:${randomUUID()}`;
  }

  currentPid(): number | undefined {
    return process.pid;
  }
}
