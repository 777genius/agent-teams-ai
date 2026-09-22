import { normalizePath, normalizePathForMatching } from '@renderer/utils/pathNormalize';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';

import type {
  DashboardRecentProjectFilesystemState,
  DashboardRecentProjectSource,
} from '@features/recent-projects/contracts';
import type { ComboboxOption } from '@renderer/components/ui/combobox';
import type { Project } from '@shared/types';

export interface ProjectPathProject extends Project {
  discoverySource?: DashboardRecentProjectSource;
  filesystemState?: DashboardRecentProjectFilesystemState;
}

export interface ProjectPathOptionMeta extends Record<string, unknown> {
  discoverySource?: DashboardRecentProjectSource;
  filesystemState?: DashboardRecentProjectFilesystemState;
}

function toProjectOption(project: ProjectPathProject): ComboboxOption {
  const option: ComboboxOption = {
    value: project.path,
    label: project.name,
    description: project.path,
  };

  if (project.filesystemState === 'deleted') {
    option.disabled = true;
  }

  if (project.discoverySource !== undefined || project.filesystemState !== undefined) {
    const meta: ProjectPathOptionMeta = {};
    if (project.discoverySource !== undefined) {
      meta.discoverySource = project.discoverySource;
    }
    if (project.filesystemState !== undefined) {
      meta.filesystemState = project.filesystemState;
    }
    option.meta = meta;
  }

  return option;
}

export function isSelectableProjectPathProject(
  project: Pick<ProjectPathProject, 'path' | 'filesystemState'>
): boolean {
  return !isEphemeralProjectPath(project.path) && project.filesystemState !== 'deleted';
}

export function isLaunchPreflightProjectSelectionReady({
  draftLoaded,
  effectiveCwd,
  cwdMode,
  projectsLoading,
  projects,
  selectedProjectPath,
  defaultProjectPath,
  appliedDefaultProjectPath,
  forceDefaultProjectSelection = false,
  appliedDefaultProjectModePath,
}: {
  draftLoaded: boolean;
  effectiveCwd: string;
  cwdMode: 'project' | 'custom';
  projectsLoading: boolean;
  projects: readonly ProjectPathProject[];
  selectedProjectPath: string;
  defaultProjectPath?: string | null;
  appliedDefaultProjectPath: string | null;
  forceDefaultProjectSelection?: boolean;
  appliedDefaultProjectModePath?: string | null;
}): boolean {
  const normalizedDefaultPath = defaultProjectPath ? normalizePath(defaultProjectPath) : null;
  const pendingDefaultSelection =
    normalizedDefaultPath !== null &&
    appliedDefaultProjectPath !== normalizedDefaultPath &&
    projects.some(
      (project) =>
        isSelectableProjectPathProject(project) &&
        normalizePath(project.path) === normalizedDefaultPath
    );

  return (
    draftLoaded &&
    (!forceDefaultProjectSelection ||
      !defaultProjectPath ||
      isEphemeralProjectPath(defaultProjectPath) ||
      appliedDefaultProjectModePath === normalizedDefaultPath) &&
    Boolean(effectiveCwd) &&
    (cwdMode === 'custom' ||
      (!projectsLoading &&
        projects.some(
          (project) =>
            isSelectableProjectPathProject(project) &&
            normalizePathForMatching(project.path) === normalizePathForMatching(selectedProjectPath)
        ) &&
        (!pendingDefaultSelection || normalizePath(selectedProjectPath) === normalizedDefaultPath)))
  );
}

export function findProjectPathProjectByPath(
  projects: readonly ProjectPathProject[],
  projectPath: string
): ProjectPathProject | undefined {
  const normalizedPath = normalizePathForMatching(projectPath);
  return projects.find((project) => normalizePathForMatching(project.path) === normalizedPath);
}

export function isDeletedProjectPathSelection(
  projects: readonly ProjectPathProject[],
  projectPath: string
): boolean {
  return findProjectPathProjectByPath(projects, projectPath)?.filesystemState === 'deleted';
}

/**
 * Collapse duplicate project entries that resolve to the same filesystem path.
 * This keeps combobox item values unique even when scanner sources overlap.
 */
export function buildProjectPathOptions(
  projects: ProjectPathProject[],
  preferredPath?: string
): ComboboxOption[] {
  const options: ComboboxOption[] = [];
  const optionIndexByNormalizedPath = new Map<string, number>();
  const normalizedPreferredPath = preferredPath ? normalizePathForMatching(preferredPath) : null;

  for (const project of projects) {
    if (isEphemeralProjectPath(project.path)) {
      continue;
    }

    const normalizedProjectPath = normalizePathForMatching(project.path);
    const existingIndex = optionIndexByNormalizedPath.get(normalizedProjectPath);

    if (existingIndex === undefined) {
      optionIndexByNormalizedPath.set(normalizedProjectPath, options.length);
      options.push(toProjectOption(project));
      continue;
    }

    const shouldPreferCurrentOption =
      normalizedPreferredPath === normalizedProjectPath && project.path === preferredPath;

    if (shouldPreferCurrentOption) {
      options[existingIndex] = toProjectOption(project);
    }
  }

  return options;
}
