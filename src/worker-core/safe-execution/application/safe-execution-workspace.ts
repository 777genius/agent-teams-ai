import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { WorkspaceRunId } from "../domain/safe-execution-task";

export async function canonicalWorkspacePath(path: string): Promise<string> {
  const resolved = resolve(path);
  return realpath(resolved).catch(() => resolved);
}

export function workspaceRunId(workspacePath: string): WorkspaceRunId {
  return `workspace:${hashText(workspacePath).slice(0, 24)}`;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

export const systemClock = {
  now(): Date {
    return new Date();
  },
};
