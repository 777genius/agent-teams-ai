import {
  findProjectPathProjectByPath,
  type ProjectPathProject,
} from '@renderer/components/team/dialogs/projectPathOptions';

import { getProjectPathName } from '../../core/domain';

export function resolveRuntimeProviderProjectContext(
  projectPath: string | null | undefined,
  projects: readonly ProjectPathProject[]
): { path: string | null; name: string | null } {
  const normalizedProjectPath = projectPath?.trim() || null;
  const matchingProject = normalizedProjectPath
    ? findProjectPathProjectByPath(projects, normalizedProjectPath)
    : undefined;
  if (matchingProject?.filesystemState === 'deleted') {
    return { path: null, name: null };
  }
  const canonicalProjectPath = matchingProject?.path.trim() || normalizedProjectPath;
  return {
    path: canonicalProjectPath,
    name: matchingProject?.name ?? getProjectPathName(canonicalProjectPath),
  };
}
