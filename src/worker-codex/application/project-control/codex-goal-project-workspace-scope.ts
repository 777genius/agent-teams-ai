import { lstat, realpath } from "node:fs/promises";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { optionalRealPathForAdmission } from "./codex-goal-project-admission";
import {
  pathInsideAnyProjectRoot,
  uniqueProjectControlStrings,
} from "./codex-goal-project-utils";

export async function projectControlRealPathIfExists(
  path: string,
): Promise<string | undefined> {
  return optionalRealPathForAdmission(path);
}

export async function projectControlRealPathOutsideWorkspaceScope(
  path: string,
  scope: ProjectAccessScope,
): Promise<string | undefined> {
  const realPath = await optionalRealPathForAdmission(path);
  if (!realPath) return undefined;
  const roots = projectControlWorkspaceRoots(scope);
  const realRoots = (
    await Promise.all(roots.map((root) => optionalRealPathForAdmission(root)))
  ).filter((root): root is string => Boolean(root));
  const allowedRoots = uniqueProjectControlStrings([...roots, ...realRoots]);
  return pathInsideAnyProjectRoot(realPath, allowedRoots)
    ? undefined
    : realPath;
}

export async function projectControlCanonicalWorkspacePath(
  path: string,
  scope: ProjectAccessScope,
): Promise<string> {
  const canonicalPath = await optionalRealPathForAdmission(path);
  if (!canonicalPath) {
    throw new Error("project_control_workspace_missing");
  }
  const trustedCanonicalRoots: string[] = [];
  for (const root of projectControlWorkspaceRoots(scope)) {
    try {
      const status = await lstat(root);
      if (!status.isDirectory() || status.isSymbolicLink()) continue;
      trustedCanonicalRoots.push(await realpath(root));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!pathInsideAnyProjectRoot(canonicalPath, trustedCanonicalRoots)) {
    throw new Error("project_control_workspace_real_path_outside_scope");
  }
  return canonicalPath;
}

function projectControlWorkspaceRoots(
  scope: ProjectAccessScope,
): readonly string[] {
  return uniqueProjectControlStrings([
    ...(scope.workspaceRoots ?? []),
    ...(scope.worktreeRoots ?? []),
    ...(scope.isolatedWorkspaceRoot ? [scope.isolatedWorkspaceRoot] : []),
  ]);
}
