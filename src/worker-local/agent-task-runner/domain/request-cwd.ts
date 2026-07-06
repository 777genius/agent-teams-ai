import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export async function resolveRequestCwd(
  workspaceRoot: string,
  requestedCwd: string,
): Promise<string> {
  const root = await realpath(resolve(workspaceRoot));
  let resolved: string;
  try {
    resolved = await realpath(resolve(root, requestedCwd));
  } catch {
    throw new Error("Agent task cwd must stay within the current workspace.");
  }
  const rel = relative(root, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolved;
  }
  throw new Error("Agent task cwd must stay within the current workspace.");
}
