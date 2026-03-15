import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { useStore } from '@renderer/store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  AlertTriangle,
  ArrowUpAZ,
  ArrowUpDown,
  BookOpen,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  Plus,
  Search,
} from 'lucide-react';

import { SearchInput } from '../common/SearchInput';

import { SkillDetailDialog } from './SkillDetailDialog';
import { SkillEditorDialog } from './SkillEditorDialog';
import { SkillImportDialog } from './SkillImportDialog';

import type { SkillCatalogItem, SkillDetail } from '@shared/types/extensions';
import type { SkillsSortState } from '@renderer/hooks/useExtensionsTabState';

const SUCCESS_BANNER_MS = 2500;
const NEW_SKILL_HIGHLIGHT_MS = 4000;
const USER_SKILLS_CATALOG_KEY = '__user__';
type SkillsQuickFilter = 'all' | 'project' | 'personal' | 'needs-attention' | 'has-scripts';

interface SkillsPanelProps {
  projectPath: string | null;
  projectLabel: string | null;
  skillsSearchQuery: string;
  setSkillsSearchQuery: (value: string) => void;
  skillsSort: SkillsSortState;
  setSkillsSort: (value: SkillsSortState) => void;
  selectedSkillId: string | null;
  setSelectedSkillId: (id: string | null) => void;
}

function sortSkills(skills: SkillCatalogItem[], sort: SkillsSortState): SkillCatalogItem[] {
  const next = [...skills];
  next.sort((a, b) => {
    if (sort === 'recent-desc') {
      return b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name) || b.modifiedAt - a.modifiedAt;
  });
  return next;
}

function formatRootKind(rootKind: SkillCatalogItem['rootKind']): string {
  return `.${rootKind}`;
}

function getScopeLabel(skill: SkillCatalogItem): string {
  return skill.scope === 'project' ? 'This project' : 'Personal';
}

function getInvocationLabel(skill: SkillCatalogItem): string {
  return skill.invocationMode === 'manual-only'
    ? 'Only runs when you explicitly ask for it'
    : 'Claude can use this automatically when it fits';
}

function getSkillStatus(skill: SkillCatalogItem): string {
  if (!skill.isValid) {
    return 'Needs attention before you rely on it';
  }
  if (skill.flags.hasScripts) {
    return 'Includes scripts, so review it carefully';
  }
  return 'Ready to use';
}

export const SkillsPanel = ({
  projectPath,
  projectLabel,
  skillsSearchQuery,
  setSkillsSearchQuery,
  skillsSort,
  setSkillsSort,
  selectedSkillId,
  setSelectedSkillId,
}: SkillsPanelProps): React.JSX.Element => {
  const catalogKey = projectPath ?? USER_SKILLS_CATALOG_KEY;
  const fetchSkillsCatalog = useStore((s) => s.fetchSkillsCatalog);
  const fetchSkillDetail = useStore((s) => s.fetchSkillDetail);
  const skillsLoading = useStore((s) => s.skillsCatalogLoadingByProjectPath[catalogKey] ?? false);
  const skillsError = useStore((s) => s.skillsCatalogErrorByProjectPath[catalogKey] ?? null);
  const detailById = useStore((s) => s.skillsDetailsById);
  const userSkills = useStore((s) => s.skillsUserCatalog);
  const projectSkills = useStore((s) =>
    projectPath ? (s.skillsProjectCatalogByProjectPath[projectPath] ?? []) : []
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingDetail, setEditingDetail] = useState<SkillDetail | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [quickFilter, setQuickFilter] = useState<SkillsQuickFilter>('all');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [highlightedSkillId, setHighlightedSkillId] = useState<string | null>(null);
  const selectedSkillIdRef = useRef<string | null>(selectedSkillId);
  selectedSkillIdRef.current = selectedSkillId;

  const mergedSkills = useMemo(
    () => [...projectSkills, ...userSkills],
    [projectSkills, userSkills]
  );
  const selectedDetail = selectedSkillId ? (detailById[selectedSkillId] ?? null) : null;

  useEffect(() => {
    if (!selectedSkillId) return;
    if (mergedSkills.some((skill) => skill.id === selectedSkillId)) return;
    setSelectedSkillId(null);
  }, [mergedSkills, selectedSkillId, setSelectedSkillId]);

  useEffect(() => {
    if (!successMessage) return;
    const timeoutId = window.setTimeout(() => setSuccessMessage(null), SUCCESS_BANNER_MS);
    return () => window.clearTimeout(timeoutId);
  }, [successMessage]);

  useEffect(() => {
    if (!highlightedSkillId) return;
    const timeoutId = window.setTimeout(() => setHighlightedSkillId(null), NEW_SKILL_HIGHLIGHT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [highlightedSkillId]);

  useEffect(() => {
    const skillsApi = api.skills;
    if (!skillsApi) return;

    let watchId: string | null = null;
    let disposed = false;
    void skillsApi.startWatching(projectPath ?? undefined).then((id) => {
      if (disposed) {
        void skillsApi.stopWatching(id);
        return;
      }
      watchId = id;
    });
    const changeCleanup = skillsApi.onChanged((event) => {
      const shouldRefresh =
        event.scope === 'user' ||
        (event.scope === 'project' && event.projectPath === (projectPath ?? null));
      if (!shouldRefresh) return;

      void fetchSkillsCatalog(projectPath ?? undefined);
      if (selectedSkillIdRef.current) {
        void fetchSkillDetail(selectedSkillIdRef.current, projectPath ?? undefined).catch(
          () => undefined
        );
      }
    });

    return () => {
      disposed = true;
      changeCleanup();
      if (watchId) {
        void skillsApi.stopWatching(watchId);
      }
    };
  }, [fetchSkillDetail, fetchSkillsCatalog, projectPath]);

  const visibleSkills = useMemo(() => {
    const q = skillsSearchQuery.trim().toLowerCase();
    const filteredByQuery = q
      ? mergedSkills.filter(
          (skill) =>
            skill.name.toLowerCase().includes(q) ||
            skill.description.toLowerCase().includes(q) ||
            skill.folderName.toLowerCase().includes(q)
        )
      : mergedSkills;
    const filtered =
      quickFilter === 'all'
        ? filteredByQuery
        : filteredByQuery.filter((skill) => {
            switch (quickFilter) {
              case 'project':
                return skill.scope === 'project';
              case 'personal':
                return skill.scope === 'user';
              case 'needs-attention':
                return !skill.isValid;
              case 'has-scripts':
                return skill.flags.hasScripts;
              default:
                return true;
            }
          });
    return sortSkills(filtered, skillsSort);
  }, [mergedSkills, quickFilter, skillsSearchQuery, skillsSort]);
  const visibleProjectSkills = useMemo(
    () => visibleSkills.filter((skill) => skill.scope === 'project'),
    [visibleSkills]
  );
  const visibleUserSkills = useMemo(
    () => visibleSkills.filter((skill) => skill.scope === 'user'),
    [visibleSkills]
  );
  const isRefreshing = skillsLoading && mergedSkills.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-surface-raised/20 rounded-xl border border-border p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1 space-y-1 xl:max-w-2xl">
            <div className="flex items-center gap-2">
              <BookOpen className="size-4 text-text-muted" />
              <h2 className="text-sm font-semibold text-text">Teach Claude repeatable work</h2>
            </div>
            <p className="max-w-2xl text-sm leading-5 text-text-muted">
              Skills are reusable instructions that help Claude handle the same kind of task more
              consistently.{' '}
              {projectPath
                ? `You are seeing skills for ${projectLabel ?? projectPath} plus your personal skills.`
                : 'You are seeing only your personal skills right now.'}
            </p>
            <p className="max-w-2xl text-xs leading-5 text-text-muted">
              Use personal skills for habits you want everywhere. Use project skills for workflows
              that only make sense inside one codebase.
            </p>
          </div>

          <div className="flex w-full flex-col gap-3 xl:w-auto xl:min-w-[32rem] xl:max-w-[40rem]">
            <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center xl:justify-end">
              <div className="w-full lg:min-w-[18rem] lg:flex-1 xl:w-80 xl:flex-none">
                <SearchInput
                  value={skillsSearchQuery}
                  onChange={setSkillsSearchQuery}
                  placeholder="Search by skill name or what it helps with..."
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-1.5 size-3.5" />
                  Create Skill
                </Button>
                <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                  <Download className="mr-1.5 size-3.5" />
                  Import
                </Button>
                <Popover open={sortMenuOpen} onOpenChange={setSortMenuOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-9 shrink-0"
                          aria-label="Sort skills"
                        >
                          <ArrowUpDown className="size-4" />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Sort skills</TooltipContent>
                  </Tooltip>
                  <PopoverContent align="end" className="w-44 p-1">
                    <button
                      type="button"
                      className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-text hover:bg-surface-raised"
                      onClick={() => {
                        setSkillsSort('name-asc');
                        setSortMenuOpen(false);
                      }}
                    >
                      <ArrowUpAZ className="mr-2 size-3.5" />
                      Name
                      {skillsSort === 'name-asc' && <Check className="ml-auto size-3.5" />}
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-text hover:bg-surface-raised"
                      onClick={() => {
                        setSkillsSort('recent-desc');
                        setSortMenuOpen(false);
                      }}
                    >
                      <Clock3 className="mr-2 size-3.5" />
                      Recent
                      {skillsSort === 'recent-desc' && <Check className="ml-auto size-3.5" />}
                    </button>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 text-[11px] text-text-muted xl:justify-end">
              <Badge variant="secondary" className="font-normal">
                {mergedSkills.length} total
              </Badge>
              <Badge variant="secondary" className="font-normal">
                {projectSkills.length} project
              </Badge>
              <Badge variant="secondary" className="font-normal">
                {userSkills.length} personal
              </Badge>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ['all', 'All skills'],
            ['project', 'Project'],
            ['personal', 'Personal'],
            ['needs-attention', 'Needs attention'],
            ['has-scripts', 'Has scripts'],
          ] as Array<[SkillsQuickFilter, string]>
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={quickFilter === value ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setQuickFilter(value)}
            className="rounded-full"
          >
            {label}
          </Button>
        ))}
      </div>

      {skillsError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
          {skillsError}
        </div>
      )}

      {successMessage && (
        <div className="flex items-center gap-2 rounded-md border border-green-500/20 bg-green-500/10 p-4 text-sm text-green-700 dark:text-green-400">
          <CheckCircle2 className="size-4 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {isRefreshing && (
        <div className="rounded-md border border-blue-500/20 bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-300">
          Refreshing skills...
        </div>
      )}

      {skillsLoading && visibleSkills.length === 0 && (
        <div className="rounded-lg border border-border p-6 text-sm text-text-muted">
          Loading skills...
        </div>
      )}

      {!skillsLoading && !skillsError && visibleSkills.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-sm border border-dashed border-border px-8 py-16">
          <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface-raised">
            <Search className="size-5 text-text-muted" />
          </div>
          <p className="text-sm text-text-secondary">
            {skillsSearchQuery ? 'No skills match your search' : 'No skills yet'}
          </p>
          <p className="text-xs text-text-muted">
            {skillsSearchQuery
              ? 'Try a different search term or switch filters.'
              : 'Create your first skill to teach Claude a repeatable workflow, or import one you already use.'}
          </p>
        </div>
      )}

      {visibleSkills.length > 0 && (
        <div className="space-y-6">
          {visibleProjectSkills.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-text">Project skills</h3>
                  <p className="text-xs text-text-muted">
                    Workflows that only make sense for this codebase.
                  </p>
                </div>
                <Badge variant="secondary" className="font-normal">
                  {visibleProjectSkills.length}
                </Badge>
              </div>
              <div className="skills-grid grid grid-cols-1 gap-3 xl:grid-cols-2">
                {visibleProjectSkills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => setSelectedSkillId(skill.id)}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      highlightedSkillId === skill.id
                        ? 'border-green-500/50 bg-green-500/10 shadow-[0_0_0_1px_rgba(34,197,94,0.18)]'
                        : 'bg-surface-raised/10 border-border hover:border-border-emphasis'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-sm font-semibold text-text">{skill.name}</h3>
                          {!skill.isValid && (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                            >
                              Needs attention
                            </Badge>
                          )}
                        </div>
                        <p className="line-clamp-2 text-sm text-text-secondary">
                          {skill.description}
                        </p>
                      </div>
                      <Badge variant="outline">{getScopeLabel(skill)}</Badge>
                    </div>

                    <div className="mt-3 space-y-2 text-xs text-text-muted">
                      <p>{getInvocationLabel(skill)}</p>
                      <p>{getSkillStatus(skill)}</p>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge variant="secondary" className="font-normal">
                        Stored in {formatRootKind(skill.rootKind)}
                      </Badge>
                      {skill.flags.hasScripts && (
                        <Badge variant="destructive" className="font-normal">
                          Has scripts
                        </Badge>
                      )}
                      {skill.flags.hasReferences && (
                        <Badge variant="secondary" className="font-normal">
                          References
                        </Badge>
                      )}
                      {skill.flags.hasAssets && (
                        <Badge variant="secondary" className="font-normal">
                          Assets
                        </Badge>
                      )}
                    </div>

                    {skill.issues.length > 0 && (
                      <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span>{skill.issues[0]?.message}</span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}

          {visibleUserSkills.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-text">Personal skills</h3>
                  <p className="text-xs text-text-muted">
                    Habits and instructions you want Claude to remember everywhere.
                  </p>
                </div>
                <Badge variant="secondary" className="font-normal">
                  {visibleUserSkills.length}
                </Badge>
              </div>
              <div className="skills-grid grid grid-cols-1 gap-3 xl:grid-cols-2">
                {visibleUserSkills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => setSelectedSkillId(skill.id)}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      highlightedSkillId === skill.id
                        ? 'border-green-500/50 bg-green-500/10 shadow-[0_0_0_1px_rgba(34,197,94,0.18)]'
                        : 'bg-surface-raised/10 border-border hover:border-border-emphasis'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-sm font-semibold text-text">{skill.name}</h3>
                          {!skill.isValid && (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                            >
                              Needs attention
                            </Badge>
                          )}
                        </div>
                        <p className="line-clamp-2 text-sm text-text-secondary">
                          {skill.description}
                        </p>
                      </div>
                      <Badge variant="outline">{getScopeLabel(skill)}</Badge>
                    </div>

                    <div className="mt-3 space-y-2 text-xs text-text-muted">
                      <p>{getInvocationLabel(skill)}</p>
                      <p>{getSkillStatus(skill)}</p>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge variant="secondary" className="font-normal">
                        Stored in {formatRootKind(skill.rootKind)}
                      </Badge>
                      {skill.flags.hasScripts && (
                        <Badge variant="destructive" className="font-normal">
                          Has scripts
                        </Badge>
                      )}
                      {skill.flags.hasReferences && (
                        <Badge variant="secondary" className="font-normal">
                          References
                        </Badge>
                      )}
                      {skill.flags.hasAssets && (
                        <Badge variant="secondary" className="font-normal">
                          Assets
                        </Badge>
                      )}
                    </div>

                    {skill.issues.length > 0 && (
                      <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span>{skill.issues[0]?.message}</span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <SkillDetailDialog
        skillId={selectedSkillId}
        open={selectedSkillId !== null}
        onClose={() => setSelectedSkillId(null)}
        projectPath={projectPath}
        onEdit={() => {
          if (!selectedDetail) return;
          setEditingDetail(selectedDetail);
          setSelectedSkillId(null);
          setEditOpen(true);
        }}
        onDeleted={() => setSelectedSkillId(null)}
      />

      <SkillEditorDialog
        open={createOpen}
        mode="create"
        projectPath={projectPath}
        projectLabel={projectLabel}
        detail={null}
        onClose={() => setCreateOpen(false)}
        onSaved={(skillId) => {
          setCreateOpen(false);
          setSuccessMessage('Skill created successfully.');
          setHighlightedSkillId(skillId);
          setSelectedSkillId(null);
        }}
      />

      <SkillEditorDialog
        open={editOpen}
        mode="edit"
        projectPath={projectPath}
        projectLabel={projectLabel}
        detail={editingDetail}
        onClose={() => {
          setEditOpen(false);
          setEditingDetail(null);
        }}
        onSaved={(skillId) => {
          setEditOpen(false);
          setEditingDetail(null);
          setSuccessMessage('Skill saved successfully.');
          setSelectedSkillId(skillId);
        }}
      />

      <SkillImportDialog
        open={importOpen}
        projectPath={projectPath}
        projectLabel={projectLabel}
        onClose={() => setImportOpen(false)}
        onImported={(skillId) => {
          setImportOpen(false);
          setSuccessMessage('Skill imported successfully.');
          setSelectedSkillId(skillId);
        }}
      />
    </div>
  );
};
