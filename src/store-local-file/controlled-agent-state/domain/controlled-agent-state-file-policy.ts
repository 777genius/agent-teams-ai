import { createHash } from "node:crypto";

export function hashControlledAgentStateId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}
