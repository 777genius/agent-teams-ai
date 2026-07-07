import { createHash } from "node:crypto";

export function hashIntegrationAttemptId(attemptId: string): string {
  return createHash("sha256").update(attemptId).digest("hex");
}
