import { normalizePath } from '@renderer/utils/pathNormalize';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';

import type { ComboboxOption } from '@renderer/components/ui/combobox';
import type { Project } from '@shared/types';

function toProjectOption(project: Project): ComboboxOption {
  return {
    value: project.path,
    label: project.name,
    description: project.path,
  };
}

/**
 * Collapse duplicate project entries that resolve to the same filesystem path.
 * This keeps combobox item values unique even when scanner sources overlap.
 */
export function buildProjectPathOptions(
  projects: Project[],
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
