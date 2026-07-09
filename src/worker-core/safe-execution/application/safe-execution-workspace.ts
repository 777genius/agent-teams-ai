import { createHash } from "node:crypto";
import type { WorkspaceRunId } from "../domain/safe-execution-task";

export function workspaceRunId(workspacePath: string): WorkspaceRunId {
  return `workspace:${hashText(workspacePath).slice(0, 24)}`;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeRelativePath(path: string): string {
  return path.split(/[\\/]/).join("/");
}

export const systemClock = {
  now(): Date {
    return new Date();
  },
};
