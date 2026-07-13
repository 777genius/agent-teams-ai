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
  return projectControlRealPathOutsideRoots(path, projectControlWorkspaceRoots(scope));
}

export async function projectControlRealPathOutsideReadScope(
  path: string,
  scope: ProjectAccessScope,
): Promise<string | undefined> {
  return projectControlRealPathOutsideRoots(path, uniqueProjectControlStrings([
    ...(scope.readRoots ?? []),
    ...projectControlWorkspaceRoots(scope),
    ...(scope.registryRoot ? [scope.registryRoot] : []),
  ]));
}

async function projectControlRealPathOutsideRoots(
  path: string,
  roots: readonly string[],
): Promise<string | undefined> {
  const realPath = await optionalRealPathForAdmission(path);
  if (!realPath) return undefined;
  const realRoots = (await Promise.all(
    roots.map((root) => optionalRealPathForAdmission(root)),
  )).filter((root): root is string => Boolean(root));
  const allowedRoots = uniqueProjectControlStrings([
    ...roots,
    ...realRoots,
  ]);
  return pathInsideAnyProjectRoot(realPath, allowedRoots) ? undefined : realPath;
}

function projectControlWorkspaceRoots(scope: ProjectAccessScope): readonly string[] {
  return uniqueProjectControlStrings([
    ...(scope.workspaceRoots ?? []),
    ...(scope.worktreeRoots ?? []),
    ...(scope.isolatedWorkspaceRoot ? [scope.isolatedWorkspaceRoot] : []),
  ]);
}
