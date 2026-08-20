import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Loader2, RotateCcw } from 'lucide-react';

import { getProjectPathName } from '../../core/domain';
import {
  OPENROUTER_FREE_MODEL_ID,
  presentOpenCodeDefaultModelInheritance,
} from '../view-models/openCodeDefaultModelInheritance';

import {
  canUseOpenCodeModelRoute,
  needsOpenCodeModelExecutionProof,
} from './runtimeProviderModelAccess';

import type { RuntimeProviderDefaultScopeDto } from '../../contracts';
import type {
  RuntimeProviderManagementActions,
  RuntimeProviderManagementState,
} from '../hooks/useRuntimeProviderManagement';
import type { ProjectPathProject } from '@renderer/components/team/dialogs/projectPathProjects';
import type { JSX, Ref } from 'react';

const NO_PROJECT = '__runtime-provider-no-project__';

export const OpenCodeDefaultModelInheritanceCard = ({
  state,
  actions,
  disabled,
  projectPath,
  projects,
  projectsLoading,
  projectError,
  onProjectChange,
  onChooseModel,
  allProjectsActionRef,
  projectActionRef,
}: {
  readonly state: RuntimeProviderManagementState;
  readonly actions: RuntimeProviderManagementActions;
  readonly disabled: boolean;
  readonly projectPath: string | null;
  readonly projects: readonly ProjectPathProject[];
  readonly projectsLoading: boolean;
  readonly projectError: string | null;
  readonly onProjectChange?: (projectPath: string | null) => void;
  readonly onChooseModel: (target: RuntimeProviderDefaultScopeDto) => void;
  readonly allProjectsActionRef?: Ref<HTMLButtonElement>;
  readonly projectActionRef?: Ref<HTMLButtonElement>;
}): JSX.Element => {
  const { t } = useAppTranslation('settings');
  const options = useMemo(() => {
    const unique = new Map<string, ProjectPathProject>();
    for (const project of projects) {
      if (project.path.trim() && project.filesystemState !== 'deleted') {
        unique.set(project.path.trim(), project);
      }
    }
    if (projectPath && !unique.has(projectPath)) {
      unique.set(projectPath, {
        id: projectPath,
        path: projectPath,
        name: getProjectPathName(projectPath) ?? projectPath,
        sessions: [],
        totalSessions: 0,
        createdAt: 0,
      });
    }
    return [...unique.values()];
  }, [projectPath, projects]);
  const activeProjectName =
    options.find((project) => project.path === projectPath)?.name ??
    getProjectPathName(projectPath);
  const model = presentOpenCodeDefaultModelInheritance({
    view: state.view,
    projectPath,
    projectName: activeProjectName,
  });
  const translatedOpenCodeDefault = t('runtimeProvider.summary.defaultModel', { model: '' })
    .trim()
    .replace(/[:：]\s*$/u, '');
  const getUnavailableReason = (modelId: string | null): string | null => {
    if (!modelId) return null;
    const configuredModel = state.view?.configuredModels?.find(
      (entry) => entry.modelId === modelId
    );
    if (
      !configuredModel ||
      canUseOpenCodeModelRoute(configuredModel) ||
      needsOpenCodeModelExecutionProof(configuredModel)
    ) {
      return null;
    }
    return configuredModel.accessReason ?? t('runtimeProvider.models.routeUnavailableGeneric');
  };
  const baseUnavailableReason = getUnavailableReason(model.baseModelId);
  const projectUnavailableReason = getUnavailableReason(model.projectEffectiveModelId);
  const unavailableLabel = t('providerRuntime.connectionUi.status.unavailableInCurrentRuntime');
  const busy = Boolean(state.savingDefaultModelId) || state.clearingProjectDefault;

  return (
    <div
      data-testid="opencode-default-inheritance"
      className="rounded-lg border p-4"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'rgba(255,255,255,0.025)',
      }}
    >
      <div className="text-sm font-semibold text-[var(--color-text)]">
        {t('runtimeProvider.defaults.title')}
      </div>
      <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
        {t('runtimeProvider.defaults.inheritanceDescription')}
      </p>

      <div className="mt-4 divide-y divide-white/10 rounded-md border border-white/10">
        <div className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-[var(--color-text-secondary)]">
              {t('runtimeProvider.defaults.allProjects')}
            </div>
            <div className="mt-1 break-all text-sm font-medium text-[var(--color-text)]">
              {baseUnavailableReason
                ? unavailableLabel
                : (model.baseDisplayName ?? translatedOpenCodeDefault)}
            </div>
            {model.baseModelId &&
            (baseUnavailableReason || model.baseDisplayName !== model.baseModelId) ? (
              <div
                data-testid="opencode-default-base-model-id"
                className="mt-1 break-all text-[11px] text-[var(--color-text-muted)]"
              >
                {model.baseModelId}
              </div>
            ) : null}
            {model.baseModelId === OPENROUTER_FREE_MODEL_ID ? (
              <div className="mt-1 text-xs leading-5 text-amber-200">
                {t('runtimeProvider.defaults.freeRouterAdvisory')}
              </div>
            ) : null}
            {baseUnavailableReason ? (
              <div className="mt-1 text-xs leading-5 text-amber-200">{baseUnavailableReason}</div>
            ) : null}
          </div>
          <Button
            ref={allProjectsActionRef}
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || busy}
            aria-label={`${t('runtimeProvider.defaults.change')}: ${t(
              'runtimeProvider.defaults.allProjects'
            )}`}
            onClick={() => onChooseModel('all_projects')}
          >
            {t('runtimeProvider.defaults.change')}
          </Button>
        </div>

        <div className="p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                  {activeProjectName
                    ? `${t('runtimeProvider.defaults.thisProject')}: ${activeProjectName}`
                    : t('runtimeProvider.defaults.thisProject')}
                </span>
                {projectPath ? (
                  <Badge variant="outline" className="border-white/10 text-[10px]">
                    {model.projectInherits
                      ? t('runtimeProvider.defaults.inherits')
                      : t('runtimeProvider.defaults.override')}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-1 break-all text-sm font-medium text-[var(--color-text)]">
                {projectPath
                  ? projectUnavailableReason
                    ? unavailableLabel
                    : (model.projectEffectiveDisplayName ?? translatedOpenCodeDefault)
                  : t('runtimeProvider.defaults.selectProjectContext')}
              </div>
              {projectPath &&
              model.projectEffectiveModelId &&
              (projectUnavailableReason ||
                model.projectEffectiveDisplayName !== model.projectEffectiveModelId) ? (
                <div
                  data-testid="opencode-default-project-model-id"
                  className="mt-1 break-all text-[11px] text-[var(--color-text-muted)]"
                >
                  {model.projectEffectiveModelId}
                </div>
              ) : null}
              {projectPath && projectUnavailableReason ? (
                <div className="mt-1 text-xs leading-5 text-amber-200">
                  {projectUnavailableReason}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                ref={projectActionRef}
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || busy || !projectPath}
                aria-label={`${
                  model.projectInherits
                    ? t('runtimeProvider.defaults.useAnotherModel')
                    : t('runtimeProvider.defaults.change')
                }: ${t('runtimeProvider.defaults.thisProject')}${
                  activeProjectName ? `: ${activeProjectName}` : ''
                }`}
                onClick={() => onChooseModel('project')}
              >
                {model.projectInherits
                  ? t('runtimeProvider.defaults.useAnotherModel')
                  : t('runtimeProvider.defaults.change')}
              </Button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select
              value={projectPath ?? NO_PROJECT}
              disabled={disabled || projectsLoading || !onProjectChange || busy}
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
            {model.projectOverrideModelId ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                aria-label={`${t('runtimeProvider.defaults.useDefault')}: ${t(
                  'runtimeProvider.defaults.thisProject'
                )}${activeProjectName ? `: ${activeProjectName}` : ''}`}
                onClick={() => projectPath && void actions.clearProjectDefault(projectPath)}
              >
                {state.clearingProjectDefault ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1 size-3.5" />
                )}
                {t('runtimeProvider.defaults.useDefault')}
              </Button>
            ) : null}
          </div>
          {projectError ? (
            <div role="alert" className="mt-2 text-xs text-red-300">
              {projectError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export const OpenCodeDefaultTargetBanner = ({
  target,
  projectName: targetProjectName,
  onCancel,
  focusRef,
}: {
  readonly target: RuntimeProviderDefaultScopeDto;
  readonly projectName: string | null;
  readonly onCancel: () => void;
  readonly focusRef?: Ref<HTMLDivElement>;
}): JSX.Element => {
  const { t } = useAppTranslation('settings');
  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      data-testid="opencode-default-target-banner"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-400/25 bg-sky-400/[0.08] px-3 py-2 text-xs text-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40"
    >
      <span>
        {target === 'all_projects'
          ? t('runtimeProvider.defaults.choosingAllProjects')
          : t('runtimeProvider.defaults.choosingProject', {
              project: targetProjectName ?? t('runtimeProvider.defaults.thisProject'),
            })}
      </span>
      <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onCancel}>
        {t('runtimeProvider.defaults.cancelChoosing')}
      </Button>
    </div>
  );
};
