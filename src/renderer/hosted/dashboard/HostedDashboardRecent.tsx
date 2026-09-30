import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  RecentProjectsSectionView,
  sortRecentProjectPriority,
} from '@features/recent-projects/renderer/hosted';

import type { createHostedDashboardTransport } from './hostedDashboardTransport';
import type {
  HostedRecentProjectDto,
  HostedRecentProjectsResult,
} from '@features/recent-projects/contracts';
import type {
  OpenResult,
  RecentProjectCardModel,
  RecentProjectIdentity,
  RecentProjectsCollectionSource,
} from '@features/recent-projects/renderer/hosted';
import type { HostedWorkspaceDto } from '@features/workspace-registry/contracts';
import type { BootId, DeploymentId, WorkspaceId } from '@shared/contracts/hosted';

type DashboardTransport = ReturnType<typeof createHostedDashboardTransport>;
const REFRESH_MS = 30_000;

interface Props {
  readonly runtimeIdentity: Readonly<{ deploymentId: DeploymentId; bootId: BootId }> | undefined;
  readonly workspaces: readonly HostedWorkspaceDto[];
  readonly transport: DashboardTransport;
  readonly authAvailable: boolean;
  readonly isActive: boolean;
  readonly onAuthFailure: () => void;
  readonly onOpenWorkspace: (
    workspaceId: WorkspaceId,
    expected: HostedRecentProjectDto
  ) => Promise<OpenResult>;
  readonly onShowChooser: () => void;
  readonly registerRefresh?: (refresh: () => void) => void;
  readonly openHistory: Map<WorkspaceId, number>;
  readonly searchQuery: string;
}

function currentProject(
  project: HostedRecentProjectDto,
  workspaces: readonly HostedWorkspaceDto[]
): boolean {
  const workspace = workspaces.find((item) => item.workspaceId === project.workspaceId);
  return (
    workspace !== undefined &&
    workspace.registrationRevision === project.registrationRevision &&
    workspace.mount.mountGeneration === project.mountGeneration &&
    workspace.mount.health !== 'unavailable'
  );
}

function makeCard(
  project: HostedRecentProjectDto,
  scopeKey: string,
  readEpoch: number,
  workspaces: readonly HostedWorkspaceDto[],
  authAvailable: boolean
): RecentProjectCardModel {
  const latest = project.sources.reduce((best, source) =>
    source.observedAt > best.observedAt ? source : best
  );
  const admitted = currentProject(project, workspaces);
  return {
    identity: { scopeKey, readEpoch, targetKey: project.workspaceId },
    name: project.label,
    activity: {
      kind: 'known',
      value: {
        label: new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(latest.observedAt),
        observedAt: latest.observedAt,
        freshness: latest.freshness,
      },
    },
    providers: {
      kind: 'known',
      value: project.sources.map((source) => ({
        id: source.provider,
        freshness: source.freshness,
      })),
    },
    branch: { kind: 'unknown', reason: 'not_provided' },
    taskCounts: { kind: 'unknown', reason: 'not_provided' },
    tasksLoading: false,
    activeTeams: { kind: 'unknown', reason: 'not_provided' },
    open:
      authAvailable && admitted && project.openAvailability === 'available'
        ? { support: 'supported', availability: 'available' }
        : {
            support: 'supported',
            availability: 'unavailable',
            reason: 'Workspace is unavailable. Refresh and try again.',
          },
    reveal: { support: 'unsupported', reason: 'native_only' },
  };
}

/** One authority-scoped recent source. Search is local; refresh is on entry/focus/TTL. */
export const HostedDashboardRecent = ({
  runtimeIdentity,
  workspaces,
  transport,
  authAvailable,
  isActive,
  onAuthFailure,
  onOpenWorkspace,
  onShowChooser,
  registerRefresh,
  openHistory,
  searchQuery,
}: Props): React.JSX.Element => {
  const scopeKey = `${runtimeIdentity?.deploymentId ?? 'unknown'}:${runtimeIdentity?.bootId ?? 'unknown'}`;
  const [result, setResult] = useState<HostedRecentProjectsResult | null>(null);
  const [readEpoch, setReadEpoch] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openedAt, setOpenedAt] = useState<ReadonlyMap<WorkspaceId, number>>(
    () => new Map(openHistory)
  );
  const active = useRef<AbortController | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const trailing = useRef(false);
  const failedAttempts = useRef(0);
  const lastAttemptAt = useRef(0);
  const generation = useRef(0);
  const readAt = useRef(0);
  const current = useRef({ result, readEpoch, workspaces, scopeKey, authAvailable });
  current.current = { result, readEpoch, workspaces, scopeKey, authAvailable };

  const runRead = useCallback(async (): Promise<void> => {
    if (!runtimeIdentity || !authAvailable || !isActive) return;
    const controller = new AbortController();
    const request = ++generation.current;
    active.current = controller;
    lastAttemptAt.current = Date.now();
    setLoading(current.current.result === null);
    setError(null);
    try {
      const response = await transport.recent(controller.signal);
      if (controller.signal.aborted || generation.current !== request) return;
      if (response.kind === 'unavailable') throw new Error('source_unavailable');
      if (
        response.deploymentId !== runtimeIdentity.deploymentId ||
        response.bootId !== runtimeIdentity.bootId ||
        current.current.scopeKey !== scopeKey
      )
        return;
      const admittedProjects = response.projects.filter((project) =>
        currentProject(project, current.current.workspaces)
      );
      setResult({
        ...response,
        projects: admittedProjects,
        completeness:
          admittedProjects.length === response.projects.length ? response.completeness : 'partial',
      });
      setReadEpoch((epoch) => epoch + 1);
      readAt.current = Date.now();
      failedAttempts.current = 0;
    } catch (caught) {
      if (controller.signal.aborted || generation.current !== request) return;
      failedAttempts.current += 1;
      if (caught instanceof Error && caught.message === 'authentication_required') onAuthFailure();
      setResult((prior) =>
        prior?.kind === 'recent-projects' &&
        prior.deploymentId === runtimeIdentity.deploymentId &&
        prior.bootId === runtimeIdentity.bootId
          ? {
              ...prior,
              readAt: Date.now(),
              completeness: 'partial',
              projects: prior.projects.map((project) => ({
                ...project,
                sources: project.sources.map((source) => ({
                  ...source,
                  freshness: 'stale' as const,
                })),
              })),
            }
          : prior
      );
      setError('Recent activity could not be refreshed.');
    } finally {
      if (!controller.signal.aborted && generation.current === request) setLoading(false);
    }
  }, [authAvailable, isActive, onAuthFailure, runtimeIdentity, scopeKey, transport]);
  const runReadRef = useRef(runRead);
  runReadRef.current = runRead;
  const reload = useCallback((): Promise<void> => {
    if (inFlight.current) {
      trailing.current = true;
      return inFlight.current;
    }
    const operation = runReadRef.current();
    inFlight.current = operation;
    void operation.finally(() => {
      if (inFlight.current !== operation) return;
      inFlight.current = null;
      if (trailing.current) {
        trailing.current = false;
        void reloadRef.current();
      }
    });
    return operation;
  }, []);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    generation.current += 1;
    active.current?.abort();
    inFlight.current = null;
    trailing.current = false;
    failedAttempts.current = 0;
    setResult(null);
    setOpenedAt(new Map(openHistory));
    readAt.current = 0;
    if (isActive) void reloadRef.current();
    return () => {
      generation.current += 1;
      active.current?.abort();
    };
  }, [scopeKey, isActive, openHistory]);
  useEffect(() => {
    if (!authAvailable || !isActive) {
      generation.current += 1;
      active.current?.abort();
      inFlight.current = null;
      trailing.current = false;
      return;
    }
    const onFocus = (): void => {
      const interval = failedAttempts.current >= 3 ? 120_000 : REFRESH_MS;
      if (Date.now() - lastAttemptAt.current >= interval) void reload();
    };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(onFocus, REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [authAvailable, isActive, reload]);
  useEffect(() => {
    if (isActive)
      registerRefresh?.(() => {
        void reload();
      });
    return () => registerRefresh?.(() => {});
  }, [isActive, registerRefresh, reload]);

  const source = useMemo<RecentProjectsCollectionSource>(() => {
    const projects =
      result?.kind === 'recent-projects' &&
      result.deploymentId === runtimeIdentity?.deploymentId &&
      result.bootId === runtimeIdentity.bootId
        ? result.projects.filter((project) => currentProject(project, workspaces))
        : [];
    const rows = sortRecentProjectPriority(projects, (project) => ({
      name: project.label,
      activityAt: Math.max(...project.sources.map((item) => item.observedAt)),
      openedAt: openedAt.get(project.workspaceId) ?? 0,
    })).map((project) => makeCard(project, scopeKey, readEpoch, workspaces, authAvailable));
    return {
      scopeKey,
      readEpoch,
      rows,
      completeness: result?.kind === 'recent-projects' ? result.completeness : 'partial',
      stale: error !== null,
      openProject: async (intent: RecentProjectIdentity) => {
        const captured = current.current;
        if (
          !captured.authAvailable ||
          captured.scopeKey !== intent.scopeKey ||
          captured.readEpoch !== intent.readEpoch ||
          captured.result?.kind !== 'recent-projects'
        )
          return { kind: 'stale_target' };
        const project = captured.result.projects.find(
          (item) => item.workspaceId === intent.targetKey
        );
        if (!project || !currentProject(project, captured.workspaces))
          return { kind: 'stale_target' };
        const outcome = await onOpenWorkspace(project.workspaceId, project);
        if (outcome.kind === 'opened' && current.current.scopeKey === intent.scopeKey) {
          openHistory.set(project.workspaceId, Date.now());
          setOpenedAt(new Map(openHistory));
        }
        return outcome;
      },
      extensionAction: {
        label: 'All workspaces',
        ariaLabel: 'All workspaces',
        icon: 'workspaces',
        run: async () => {
          onShowChooser();
          return { kind: 'opened' };
        },
      },
    };
  }, [
    authAvailable,
    error,
    onOpenWorkspace,
    onShowChooser,
    openHistory,
    openedAt,
    readEpoch,
    result,
    runtimeIdentity,
    scopeKey,
    workspaces,
  ]);
  return (
    <RecentProjectsSectionView
      source={source}
      searchQuery={searchQuery}
      loading={loading}
      error={error}
      reload={reload}
    />
  );
};
