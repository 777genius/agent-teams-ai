import { getProjectPathName } from '../../core/domain';

import type { ProjectPathProject } from '@renderer/components/team/dialogs/projectPathProjects';

export function resolveRuntimeProviderProjectContext(
  projectPath: string | null | undefined,
  projects: readonly ProjectPathProject[]
): { path: string | null; name: string | null } {
  const normalizedProjectPath = projectPath?.trim() || null;
  const matchingProject = normalizedProjectPath
    ? projects.find((project) => project.path.trim() === normalizedProjectPath)
    : undefined;
  if (matchingProject?.filesystemState === 'deleted') {
    return { path: null, name: null };
  }
  return {
    path: normalizedProjectPath,
    name: matchingProject?.name ?? getProjectPathName(normalizedProjectPath),
  };
}
