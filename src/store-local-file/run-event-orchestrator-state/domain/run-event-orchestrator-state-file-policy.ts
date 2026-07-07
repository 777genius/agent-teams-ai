import { createHash } from "node:crypto";

export function hashRunEventOrchestratorId(orchestratorId: string): string {
  return createHash("sha256").update(orchestratorId).digest("hex");
}
