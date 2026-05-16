import React from 'react';

import { api } from '@renderer/api';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { Button } from '@renderer/components/ui/button';
import { Combobox } from '@renderer/components/ui/combobox';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { cn } from '@renderer/lib/utils';
import { Check, FolderOpen, FolderX } from 'lucide-react';

import {
  buildProjectPathOptions,
  type ProjectPathOptionMeta,
  type ProjectPathProject,
} from './projectPathOptions';

import type { DashboardRecentProjectSource } from '@features/recent-projects/contracts';
import type { ComboboxOption } from '@renderer/components/ui/combobox';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text: string, query: string): React.JSX.Element {
  if (!query.trim()) {
    return <span>{text}</span>;
  }

  const pattern = new RegExp(`(${escapeRegExp(query)})`, 'ig');
  const parts = text.split(pattern);

  return (
    <span>
      {parts.map((part, index) => {
        const isMatch = part.toLowerCase() === query.toLowerCase();
        if (!isMatch) {
          return <span key={`${part}-${index}`}>{part}</span>;
        }
        return (
          <span
            key={`${part}-${index}`}
            className="rounded px-0.5 font-semibold text-[var(--color-text)]"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 45%, transparent)',
            }}
          >
            {part}
          </span>
        );
      })}
    </span>
  );
}

function getOptionSource(option: ComboboxOption): DashboardRecentProjectSource | undefined {
  return (option.meta as ProjectPathOptionMeta | undefined)?.discoverySource;
}

function isDeletedOption(option: ComboboxOption): boolean {
  return (option.meta as ProjectPathOptionMeta | undefined)?.filesystemState === 'deleted';
}

function getSourceLabel(source: DashboardRecentProjectSource): string {
  switch (source) {
    case 'claude':
      return 'Found by Claude';
    case 'codex':
      return 'Found by Codex';
    case 'mixed':
      return 'Found by Claude and Codex';
  }
}

const ProjectSourceBadge = ({
  source,
}: {
  source?: DashboardRecentProjectSource;
}): React.JSX.Element | null => {
  if (!source) {
    return null;
  }

  const logos =
    source === 'mixed'
      ? (['anthropic', 'codex'] as const)
      : source === 'codex'
        ? (['codex'] as const)
        : (['anthropic'] as const);

  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-1 py-0.5"
      title={getSourceLabel(source)}
    >
      {logos.map((providerId) => (
        <ProviderBrandLogo key={providerId} providerId={providerId} className="size-3" />
      ))}
    </span>
  );
};

const ProjectDeletedBadge = (): React.JSX.Element => (
  <span
    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
    title="Project folder no longer exists"
  >
    <FolderX className="size-3" />
    Deleted
  </span>
);

export type CwdMode = 'project' | 'custom';

interface ProjectPathSelectorProps {
  cwdMode: CwdMode;
  onCwdModeChange: (mode: CwdMode) => void;
  selectedProjectPath: string;
  onSelectedProjectPathChange: (path: string) => void;
  customCwd: string;
  onCustomCwdChange: (cwd: string) => void;
  projects: ProjectPathProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  fieldError?: string | null;
}

export const ProjectPathSelector = ({
  cwdMode,
  onCwdModeChange,
  selectedProjectPath,
  onSelectedProjectPathChange,
  customCwd,
  onCustomCwdChange,
  projects,
  projectsLoading,
  projectsError,
  fieldError,
}: ProjectPathSelectorProps): React.JSX.Element => {
  const projectOptions = React.useMemo(
    () => buildProjectPathOptions(projects, selectedProjectPath),
    [projects, selectedProjectPath]
  );

  return (
    <div className="space-y-1.5">
      <Label>Project</Label>
      <div className="space-y-2">
        <div className="flex flex-col gap-2 md:flex-row md:items-start">
          <div className="inline-flex shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
            <button
              type="button"
              className={cn(
                'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
                cwdMode === 'project'
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() => onCwdModeChange('project')}
            >
              From project list
            </button>
            <button
              type="button"
              className={cn(
                'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
                cwdMode === 'custom'
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() => onCwdModeChange('custom')}
            >
              Custom path
            </button>
          </div>

          <div className="min-w-0 flex-1">
            {cwdMode === 'project' ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <FolderOpen size={16} className="shrink-0 text-[var(--color-text-muted)]" />
                  <div className="min-w-0 flex-1">
                    <Combobox
                      options={projectOptions}
                      value={selectedProjectPath}
                      onValueChange={onSelectedProjectPathChange}
                      placeholder={projectsLoading ? 'Loading projects...' : 'Select a project...'}
                      searchPlaceholder="Search project by name or path"
                      emptyMessage="Nothing found"
                      disabled={projectsLoading || projectOptions.length === 0}
                      renderTriggerLabel={(option) => (
                        <span className="flex min-w-0 items-center gap-1.5">
                          <ProjectSourceBadge source={getOptionSource(option)} />
                          {isDeletedOption(option) ? <ProjectDeletedBadge /> : null}
                          <span className="min-w-0 truncate">{option.label}</span>
                        </span>
                      )}
                      renderOption={(option, isSelected, query) => {
                        const isDeleted = isDeletedOption(option);
                        return (
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <Check
                              className={cn(
                                'size-3.5 shrink-0',
                                isSelected ? 'opacity-100' : 'opacity-0'
                              )}
                            />
                            <ProjectSourceBadge source={getOptionSource(option)} />
                            {isDeleted ? <ProjectDeletedBadge /> : null}
                            <div className="min-w-0 flex-1">
                              <p
                                className={cn(
                                  'truncate font-medium text-[var(--color-text)]',
                                  isDeleted && 'text-red-200'
                                )}
                              >
                                {renderHighlightedText(option.label, query)}
                              </p>
                              <p className="truncate text-[var(--color-text-muted)]">
                                {renderHighlightedText(option.description ?? '', query)}
                              </p>
                            </div>
                          </div>
                        );
                      }}
                    />
                  </div>
                </div>
                {!selectedProjectPath ? (
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    Select a project from the list
                  </p>
                ) : null}
                {projectsError ? <p className="text-[11px] text-red-300">{projectsError}</p> : null}
                {!projectsLoading && projectOptions.length === 0 ? (
                  <p className="text-[11px]" style={{ color: 'var(--warning-text)' }}>
                    No projects found, switch to custom path.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <FolderOpen size={16} className="shrink-0 text-[var(--color-text-muted)]" />
                  <Input
                    className="h-8 flex-1 text-xs"
                    value={customCwd}
                    aria-label="Custom working directory"
                    onChange={(event) => onCustomCwdChange(event.target.value)}
                    placeholder="/absolute/path/to/project"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void (async () => {
                        try {
                          const paths = await api.config.selectFolders();
                          if (paths.length > 0) {
                            onCustomCwdChange(paths[0]);
                          }
                        } catch {
                          // IPC error - dialog may have been cancelled or failed
                        }
                      })();
                    }}
                  >
                    Browse
                  </Button>
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  If the directory does not exist, it will be created automatically.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      {fieldError ? (
        <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
          {fieldError}
        </p>
      ) : null}
    </div>
  );
};
