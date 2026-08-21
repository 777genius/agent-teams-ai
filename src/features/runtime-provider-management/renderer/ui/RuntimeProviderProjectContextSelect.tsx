import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';

import { getProjectPathName } from '../../core/domain';

import { resolveRuntimeProviderProjectContext } from './runtimeProviderProjectContext';

import type { ProjectPathProject } from '@renderer/components/team/dialogs/projectPathProjects';
import type { JSX, ReactNode } from 'react';

const NO_PROJECT = '__runtime-provider-no-project__';

export const RuntimeProviderProjectContextSelect = ({
  projectPath,
  projects,
  loading,
  error,
  disabled,
  onProjectChange,
  action,
}: {
  readonly projectPath: string | null;
  readonly projects: readonly ProjectPathProject[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onProjectChange?: (projectPath: string | null) => void;
  readonly action?: ReactNode;
}): JSX.Element => {
  const { t } = useAppTranslation('settings');
  const { path: normalizedProjectPath } = resolveRuntimeProviderProjectContext(
    projectPath,
    projects
  );
  const options = useMemo(() => {
    const unique = new Map<string, ProjectPathProject>();
    for (const project of projects) {
      if (project.path.trim() && project.filesystemState !== 'deleted') {
        unique.set(project.path.trim(), project);
      }
    }
    if (normalizedProjectPath && !unique.has(normalizedProjectPath)) {
      unique.set(normalizedProjectPath, {
        id: normalizedProjectPath,
        path: normalizedProjectPath,
        name: getProjectPathName(normalizedProjectPath) ?? normalizedProjectPath,
        sessions: [],
        totalSessions: 0,
        createdAt: 0,
      });
    }
    return [...unique.values()];
  }, [normalizedProjectPath, projects]);

  return (
    <div data-testid="runtime-provider-project-context-select">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={normalizedProjectPath ?? NO_PROJECT}
          disabled={disabled || loading || !onProjectChange}
          onValueChange={(value) => onProjectChange?.(value === NO_PROJECT ? null : value)}
        >
          <SelectTrigger className="h-8 min-w-[220px] max-w-full text-xs">
            <SelectValue placeholder={t('runtimeProvider.defaults.selectProjectContext')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PROJECT}>
              {t('runtimeProvider.defaults.selectProjectContext')}
            </SelectItem>
            {options.map((project) => (
              <SelectItem key={project.path} value={project.path}>
                {project.name || getProjectPathName(project.path) || project.path}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {action}
      </div>
      {error ? (
        <div role="alert" className="mt-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  );
};
