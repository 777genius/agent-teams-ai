import { normalizePath } from '@renderer/utils/pathNormalize';
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
  const normalizedPreferredPath = preferredPath ? normalizePath(preferredPath) : null;

  for (const project of projects) {
    if (isEphemeralProjectPath(project.path)) {
      continue;
    }

    const normalizedProjectPath = normalizePath(project.path);
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
