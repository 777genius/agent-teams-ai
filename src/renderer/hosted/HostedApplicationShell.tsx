import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getHostedCsrfToken, useHostedAuthRevalidation } from '@features/hosted-access/renderer';
import { createHostedTeamConfigurationTransport } from '@features/team-configuration/renderer';
import { createHostedWorkspaceRegistryTransport } from '@features/workspace-registry/renderer';
import { HostedTeamWorkspace } from '@renderer/components/team/HostedTeamWorkspace';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { HostedDashboardPalette } from '@renderer/hosted/dashboard/HostedDashboardPalette';
import { HostedDashboardSurface } from '@renderer/hosted/dashboard/HostedDashboardSurface';
import { createHostedDashboardTransport } from '@renderer/hosted/dashboard/hostedDashboardTransport';
import { HostedOperatorControl } from '@renderer/hosted/dashboard/HostedOperatorControl';
import { HostedShellHeader } from '@renderer/hosted/dashboard/HostedShellHeader';
import { useHostedDashboardPaletteShortcut } from '@renderer/hosted/dashboard/useHostedDashboardPaletteShortcut';
import { useHostedRecentProjectsConnector } from '@renderer/hosted/dashboard/useHostedRecentProjectsConnector';
import { createHostedBrowserTeamCoordinationEventPorts } from '@renderer/hosted/hostedTeamCoordinationEventPorts';

import { createHostedCreateSessionRegistry } from './hostedCreateSessionRegistry';
import { workspaceLoadErrorText } from './hostedShellErrors';

import type { HostedAccessSnapshot } from './dashboard/hostedDashboardTransport';
import type { HostedApplicationShellProps } from './hostedApplicationShellProps';
import type { HostedRecentProjectDto } from '@features/recent-projects/contracts';
import type { OpenResult } from '@features/recent-projects/renderer/hosted';
import type { RunningTeamsSectionViewProps } from '@features/running-teams/renderer/hosted';
import type { HostedTeamConfigurationFetchPort } from '@features/team-configuration/renderer';
import type { HostedTeamDirectoryReadState } from '@features/team-lifecycle/renderer';
import type { HostedWorkspaceDto } from '@features/workspace-registry/contracts';
import type { HostedWorkspaceRegistryFetchPort } from '@features/workspace-registry/renderer';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

export type { HostedApplicationShellProps } from './hostedApplicationShellProps';

const workspaceFetch: HostedWorkspaceRegistryFetchPort = (input, init) => fetch(input, init);
const configurationFetch: HostedTeamConfigurationFetchPort = (input, init) => fetch(input, init);

export const HostedApplicationShell = ({
  workspaceTransport: providedWorkspaceTransport,
  workspaceFetch: providedWorkspaceFetch = workspaceFetch,
  configurationTransport: providedConfigurationTransport,
  configurationFetch: providedConfigurationFetch = configurationFetch,
  getCsrfToken = getHostedCsrfToken,
  coordinationEvents: providedCoordinationEvents,
  teamWorkspaceProps,
  runtimeIdentity,
  dashboardFetch = fetch,
}: HostedApplicationShellProps): React.JSX.Element => {
  const [page, setPage] = useState<'dashboard' | 'chooser' | 'team'>('dashboard');
  const recentScopeKey = `${runtimeIdentity?.deploymentId ?? 'unknown'}:${runtimeIdentity?.bootId ?? 'unknown'}`;
  const recentOpenHistory = useRef<{ scopeKey: string; openedAt: Map<WorkspaceId, number> }>({
    scopeKey: recentScopeKey,
    openedAt: new Map(),
  });
  if (recentOpenHistory.current.scopeKey !== recentScopeKey) {
    recentOpenHistory.current = { scopeKey: recentScopeKey, openedAt: new Map() };
  }
  const [paletteOpen, setPaletteOpen] = useState(false);
  const recentRefreshRef = useRef<() => void>(() => {});
  const registerRecentRefresh = useCallback((refresh: () => void) => {
    recentRefreshRef.current = refresh;
  }, []);
  const [directoryPublication, setDirectoryPublication] = useState<{
    readonly authorityKey: string;
    readonly state: HostedTeamDirectoryReadState;
  } | null>(null);
  const [dashboardRunningTeams, setDashboardRunningTeams] = useState<RunningTeamsSectionViewProps>({
    title: 'Running teams',
    rows: [],
    onOpen: () => {},
  });
  const [workspaceAccess, setWorkspaceAccess] = useState<HostedAccessSnapshot | null>(null);
  const [teamAccess, setTeamAccess] = useState<HostedAccessSnapshot | null>(null);
  const [workspaceAccessError, setWorkspaceAccessError] = useState<string | null>(null);
  const [workspaceAccessChecking, setWorkspaceAccessChecking] = useState(false);
  const [teamAccessError, setTeamAccessError] = useState<string | null>(null);
  const [teamAccessChecking, setTeamAccessChecking] = useState(false);
  const [accessRetrySignal, setAccessRetrySignal] = useState(0);
  const lastTeamProjection = useRef<{
    access: HostedAccessSnapshot;
    teamId: TeamId;
    retry: number;
  } | null>(null);
  const navigationGeneration = useRef(0);
  const authEpoch = useRef(0);
  const authRevalidation = useHostedAuthRevalidation();
  const [workspaces, setWorkspaces] = useState<readonly HostedWorkspaceDto[]>([]);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const runtimeRef = useRef(runtimeIdentity);
  runtimeRef.current = runtimeIdentity;
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId | null>(null);
  const selectedWorkspaceRef = useRef(selectedWorkspaceId);
  selectedWorkspaceRef.current = selectedWorkspaceId;
  const selectedWorkspace = workspaces.find((item) => item.workspaceId === selectedWorkspaceId);
  const currentWorkspaceAccess =
    workspaceAccess &&
    selectedWorkspace &&
    runtimeIdentity &&
    workspaceAccess.deploymentId === runtimeIdentity.deploymentId &&
    workspaceAccess.bootId === runtimeIdentity.bootId &&
    workspaceAccess.registrationRevision === selectedWorkspace.registrationRevision &&
    workspaceAccess.mountGeneration === selectedWorkspace.mount.mountGeneration
      ? workspaceAccess
      : null;
  const currentTeamAccess =
    teamAccess &&
    currentWorkspaceAccess &&
    teamAccess.deploymentId === currentWorkspaceAccess.deploymentId &&
    teamAccess.bootId === currentWorkspaceAccess.bootId &&
    teamAccess.registrationRevision === currentWorkspaceAccess.registrationRevision &&
    teamAccess.mountGeneration === currentWorkspaceAccess.mountGeneration &&
    teamAccess.grantRevision === currentWorkspaceAccess.grantRevision
      ? teamAccess
      : null;
  const [loading, setLoading] = useState(true);
  const [selectingWorkspaceId, setSelectingWorkspaceId] = useState<WorkspaceId | null>(null);
  const selectingRef = useRef<WorkspaceId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<TeamId | null>(null);
  const [teamAdmissionFailure, setTeamAdmissionFailure] = useState<{
    workspaceId: WorkspaceId;
    teamId: TeamId;
    authorityKey: string;
    directory: HostedTeamDirectoryReadState;
    access: HostedAccessSnapshot;
  } | null>(null);
  const teamAdmissionGeneration = useRef(0);
  const admitTeamRef = useRef<(teamId: TeamId | null) => void>(() => {});
  const teamSelectionScope = useRef<WorkspaceId | null>(null);
  const [lifecycleRefreshSignal, setLifecycleRefreshSignal] = useState(0);
  const [protectedAuthBlocked, setProtectedAuthBlocked] = useState(false);
  const revalidateProtectedAuthRef = useRef<() => Promise<void>>(async () => {});
  const protectedAuthCheckPending = useRef(false);
  const protectedAuthAutomaticCheckDone = useRef(false);
  const createRegistry = useMemo(createHostedCreateSessionRegistry, []);
  const createAuthorities = useMemo(
    () =>
      workspaces.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        epoch: `${runtimeIdentity?.deploymentId ?? 'local'}:${runtimeIdentity?.bootId ?? 'unknown'}:${workspace.mount.mountGeneration}`,
      })),
    [runtimeIdentity, workspaces]
  );
  useEffect(() => {
    createRegistry.reconcileAuthorities(createAuthorities);
  }, [createAuthorities, createRegistry]);
  useEffect(() => () => createRegistry.disposeAll(), [createRegistry]);
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const loadWorkspacesRef = useRef<() => Promise<boolean>>(async () => false);
  const workspaceTransport = useMemo(
    () =>
      providedWorkspaceTransport ??
      createHostedWorkspaceRegistryTransport({
        fetch: providedWorkspaceFetch,
        getCsrfToken,
      }),
    [getCsrfToken, providedWorkspaceFetch, providedWorkspaceTransport]
  );
  const configurationTransport = useMemo(
    () =>
      providedConfigurationTransport ??
      createHostedTeamConfigurationTransport({
        fetch: providedConfigurationFetch,
        getCsrfToken,
      }),
    [getCsrfToken, providedConfigurationFetch, providedConfigurationTransport]
  );
  const coordinationEvents = useMemo(
    () => providedCoordinationEvents ?? createHostedBrowserTeamCoordinationEventPorts(getCsrfToken),
    [getCsrfToken, providedCoordinationEvents]
  );
  const dashboardTransport = useMemo(
    () => createHostedDashboardTransport(dashboardFetch, getCsrfToken),
    [dashboardFetch, getCsrfToken]
  );
  const authorityKey = `${runtimeIdentity?.deploymentId ?? 'unknown'}:${runtimeIdentity?.bootId ?? 'unknown'}:${selectedWorkspaceId ?? 'none'}:${selectedWorkspace?.registrationRevision ?? 'none'}:${selectedWorkspace?.mount.mountGeneration ?? 'none'}:${currentWorkspaceAccess?.grantRevision ?? 'none'}`;
  const authorityKeyRef = useRef(authorityKey);
  authorityKeyRef.current = authorityKey;
  const dashboardDirectory =
    directoryPublication?.authorityKey === authorityKey ? directoryPublication.state : null;
  const currentTeamAdmissionFailure =
    teamAdmissionFailure?.workspaceId === selectedWorkspaceId &&
    teamAdmissionFailure.authorityKey === authorityKey &&
    teamAdmissionFailure.access === currentWorkspaceAccess &&
    !protectedAuthBlocked &&
    authRevalidation.availability === 'available' &&
    !workspaceAccessChecking &&
    workspaceAccessError === null &&
    teamAdmissionFailure.directory.snapshot === dashboardDirectory?.snapshot
      ? teamAdmissionFailure
      : null;
  const admissionSnapshotRef = useRef({
    authorityKey,
    directory: dashboardDirectory,
    authAvailable: !protectedAuthBlocked && authRevalidation.availability === 'available',
    workspaceAccess: currentWorkspaceAccess,
    accessReady: !workspaceAccessChecking && workspaceAccessError === null,
  });
  admissionSnapshotRef.current = {
    authorityKey,
    directory: dashboardDirectory,
    authAvailable: !protectedAuthBlocked && authRevalidation.availability === 'available',
    workspaceAccess: currentWorkspaceAccess,
    accessReady: !workspaceAccessChecking && workspaceAccessError === null,
  };
  const authAvailableRef = useRef(
    !protectedAuthBlocked && authRevalidation.availability === 'available'
  );
  authAvailableRef.current = !protectedAuthBlocked && authRevalidation.availability === 'available';
  const writeEffectsAvailable =
    !workspaceAccessChecking &&
    workspaceAccessError === null &&
    (selectedTeamId === null ||
      (!teamAccessChecking &&
        teamAccessError === null &&
        lastTeamProjection.current?.access === currentWorkspaceAccess &&
        lastTeamProjection.current.teamId === selectedTeamId &&
        lastTeamProjection.current.retry === accessRetrySignal));
  const publishDirectory = useCallback(
    (state: HostedTeamDirectoryReadState) => {
      setDirectoryPublication({ authorityKey, state });
    },
    [authorityKey]
  );

  const loadWorkspaces = (): Promise<boolean> => {
    teamAdmissionGeneration.current += 1;
    activeRequest.current?.abort();
    // A workspace-list refresh cancels a pending switch, so the retained workspace is selectable.
    teamSelectionScope.current = selectedWorkspaceId;
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    activeRequest.current = controller;
    setLoading(true);
    setSelectingWorkspaceId(null);
    selectingRef.current = null;
    setError(null);
    return workspaceTransport
      .list(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return false;
        createRegistry.reconcileAuthorities(
          result.workspaces.map((workspace) => ({
            workspaceId: workspace.workspaceId,
            epoch: `${runtimeIdentity?.deploymentId ?? 'local'}:${runtimeIdentity?.bootId ?? 'unknown'}:${workspace.mount.mountGeneration}`,
          }))
        );
        setWorkspaces(result.workspaces);
        workspacesRef.current = result.workspaces;
        for (const workspaceId of recentOpenHistory.current.openedAt.keys()) {
          if (!result.workspaces.some((item) => item.workspaceId === workspaceId))
            recentOpenHistory.current.openedAt.delete(workspaceId);
        }
        const retainedWorkspace =
          selectedWorkspaceId !== null &&
          result.workspaces.some((item) => item.workspaceId === selectedWorkspaceId);
        if (!retainedWorkspace) {
          teamSelectionScope.current = null;
          setSelectedWorkspaceId(null);
          setSelectedTeamId(null);
          setWorkspaceAccess(null);
          setTeamAccess(null);
          setDashboardRunningTeams({ title: 'Running teams', rows: [], onOpen: () => {} });
          if (selectedWorkspaceId !== null) setPage('chooser');
        }
        return true;
      })
      .catch((caught) => {
        if (!controller.signal.aborted && requestGeneration.current === generation)
          setError(workspaceLoadErrorText(caught));
        return false;
      })
      .finally(() => {
        if (!controller.signal.aborted && requestGeneration.current === generation)
          setLoading(false);
      });
  };
  loadWorkspacesRef.current = loadWorkspaces;

  const revalidateProtectedAuth = async (): Promise<void> => {
    if (protectedAuthCheckPending.current) return;
    protectedAuthCheckPending.current = true;
    authEpoch.current += 1;
    authAvailableRef.current = false;
    setProtectedAuthBlocked(true);
    try {
      const result = await authRevalidation.revalidate();
      if (
        result.kind === 'unauthenticated' ||
        (result.kind === 'authenticated' && result.identity === 'changed')
      ) {
        createRegistry.disposeAll();
        recentOpenHistory.current.openedAt.clear();
        return;
      }
      if (result.kind === 'authenticated' && (await loadWorkspaces())) {
        setProtectedAuthBlocked(false);
      }
    } finally {
      protectedAuthCheckPending.current = false;
    }
  };
  revalidateProtectedAuthRef.current = revalidateProtectedAuth;

  const onProtectedAuthFailure = useCallback((): void => {
    teamAdmissionGeneration.current += 1;
    authEpoch.current += 1;
    authAvailableRef.current = false;
    setProtectedAuthBlocked(true);
    if (protectedAuthAutomaticCheckDone.current) return;
    protectedAuthAutomaticCheckDone.current = true;
    void revalidateProtectedAuthRef.current();
  }, []);

  useEffect(() => {
    protectedAuthAutomaticCheckDone.current = false;
  }, [selectedWorkspaceId, selectedTeamId]);

  useEffect(() => {
    void loadWorkspaces();
    return () => activeRequest.current?.abort();
    // The transport identity is the complete load dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceTransport]);

  useEffect(() => {
    if (
      !selectedWorkspaceId ||
      !runtimeIdentity ||
      protectedAuthBlocked ||
      authRevalidation.availability !== 'available'
    ) {
      setWorkspaceAccessChecking(false);
      return;
    }
    const controller = new AbortController();
    const workspace = workspacesRef.current.find(
      (item) => item.workspaceId === selectedWorkspaceId
    );
    if (!workspace) return;
    setWorkspaceAccessChecking(true);
    setWorkspaceAccessError(null);
    void dashboardTransport
      .access(selectedWorkspaceId, null, controller.signal)
      .then((access) => {
        if (controller.signal.aborted) return;
        if (
          access.deploymentId !== runtimeIdentity.deploymentId ||
          access.bootId !== runtimeIdentity.bootId ||
          access.registrationRevision !== workspace.registrationRevision ||
          access.mountGeneration !== workspace.mount.mountGeneration
        ) {
          setWorkspaceAccessError('Workspace access changed. Refresh and try again.');
          setWorkspaceAccessChecking(false);
          return;
        }
        setWorkspaceAccess(access);
        setWorkspaceAccessChecking(false);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setWorkspaceAccessChecking(false);
        setWorkspaceAccessError('Workspace access could not be checked.');
        if (caught instanceof Error && caught.message === 'authentication_required')
          onProtectedAuthFailure();
      });
    return () => controller.abort();
  }, [
    authRevalidation.availability,
    dashboardTransport,
    protectedAuthBlocked,
    runtimeIdentity,
    selectedWorkspaceId,
    workspaces,
    accessRetrySignal,
    onProtectedAuthFailure,
  ]);

  useEffect(() => {
    if (
      !selectedWorkspaceId ||
      !selectedTeamId ||
      !currentWorkspaceAccess ||
      !runtimeIdentity ||
      protectedAuthBlocked ||
      authRevalidation.availability !== 'available'
    ) {
      setTeamAccessChecking(false);
      return;
    }
    if (
      lastTeamProjection.current?.access === currentWorkspaceAccess &&
      lastTeamProjection.current.teamId === selectedTeamId &&
      lastTeamProjection.current.retry === accessRetrySignal
    )
      return;
    const controller = new AbortController();
    setTeamAccessChecking(true);
    setTeamAccessError(null);
    void dashboardTransport
      .access(selectedWorkspaceId, selectedTeamId, controller.signal)
      .then((access) => {
        if (controller.signal.aborted) return;
        if (
          access.deploymentId !== runtimeIdentity.deploymentId ||
          access.bootId !== runtimeIdentity.bootId ||
          access.registrationRevision !== currentWorkspaceAccess.registrationRevision ||
          access.mountGeneration !== currentWorkspaceAccess.mountGeneration ||
          access.grantRevision !== currentWorkspaceAccess.grantRevision ||
          !access.capabilities.includes('team.open')
        ) {
          setTeamAccessError('Team access changed. Refresh and try again.');
          setTeamAccessChecking(false);
          return;
        }
        lastTeamProjection.current = {
          access: currentWorkspaceAccess,
          teamId: selectedTeamId,
          retry: accessRetrySignal,
        };
        setTeamAccess(access);
        setTeamAccessChecking(false);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setTeamAccessChecking(false);
        setTeamAccessError('Team access could not be checked.');
        if (caught instanceof Error && caught.message === 'authentication_required')
          onProtectedAuthFailure();
      });
    return () => controller.abort();
  }, [
    authRevalidation.availability,
    currentWorkspaceAccess,
    dashboardTransport,
    protectedAuthBlocked,
    runtimeIdentity,
    selectedTeamId,
    selectedWorkspaceId,
    accessRetrySignal,
    onProtectedAuthFailure,
  ]);

  const admitTeam = (teamId: TeamId | null): void => {
    const generation = ++teamAdmissionGeneration.current;
    const navigation = navigationGeneration.current;
    setTeamAdmissionFailure(null);
    setTeamAccessError(null);
    if (teamId === null) {
      navigationGeneration.current += 1;
      setSelectedTeamId(null);
      setTeamAccess(null);
      return;
    }
    const workspaceId = selectedWorkspaceRef.current;
    const access = currentWorkspaceAccess;
    const identity = runtimeRef.current;
    const directory = dashboardDirectory;
    const capturedAuthorityKey = authorityKey;
    const listedAtStart = Boolean(
      directory?.snapshot?.items.some(
        (item) => item.teamId === teamId && item.workspaceId === workspaceId
      )
    );
    if (
      !workspaceId ||
      !access ||
      !identity ||
      !admissionSnapshotRef.current.accessReady ||
      !access.capabilities.includes('directory.read') ||
      directory?.scopeKey !== workspaceId
    )
      return;
    const canSettle = (): boolean => {
      const latest = workspacesRef.current.find((item) => item.workspaceId === workspaceId);
      const current = admissionSnapshotRef.current;
      return (
        generation === teamAdmissionGeneration.current &&
        navigation === navigationGeneration.current &&
        selectedWorkspaceRef.current === workspaceId &&
        current.authAvailable &&
        current.accessReady &&
        current.workspaceAccess === access &&
        current.authorityKey === capturedAuthorityKey &&
        current.directory?.scopeKey === workspaceId &&
        (!listedAtStart ||
          (current.directory.snapshot === directory.snapshot &&
            Boolean(
              current.directory.snapshot?.items.some(
                (item) => item.teamId === teamId && item.workspaceId === workspaceId
              )
            ))) &&
        runtimeRef.current?.deploymentId === identity.deploymentId &&
        runtimeRef.current.bootId === identity.bootId &&
        latest?.registrationRevision === access.registrationRevision &&
        latest?.mount.mountGeneration === access.mountGeneration
      );
    };
    const controller = new AbortController();
    void dashboardTransport
      .access(workspaceId, teamId, controller.signal)
      .then((team) => {
        if (
          !canSettle() ||
          team.deploymentId !== identity.deploymentId ||
          team.bootId !== identity.bootId ||
          team.registrationRevision !== access.registrationRevision ||
          team.mountGeneration !== access.mountGeneration ||
          team.grantRevision !== access.grantRevision ||
          !team.capabilities.includes('team.open')
        )
          return;
        lastTeamProjection.current = { access, teamId, retry: accessRetrySignal };
        setTeamAccess(team);
        setSelectedTeamId(teamId);
        navigationGeneration.current += 1;
        setPage('team');
      })
      .catch((error) => {
        if (!canSettle()) return;
        if (error instanceof Error && error.message === 'authentication_required')
          onProtectedAuthFailure();
        else
          setTeamAdmissionFailure({
            workspaceId,
            teamId,
            authorityKey: capturedAuthorityKey,
            directory,
            access,
          });
      });
  };
  admitTeamRef.current = admitTeam;

  const navigate = useCallback((destination: 'dashboard' | 'chooser' | 'team'): void => {
    navigationGeneration.current += 1;
    setTeamAdmissionFailure(null);
    setPage(destination);
  }, []);

  const selectWorkspace = useCallback(
    async (workspaceId: WorkspaceId, expected?: HostedRecentProjectDto): Promise<OpenResult> => {
      if (selectingRef.current !== null) return { kind: 'cancelled' };
      teamAdmissionGeneration.current += 1;
      const navigation = ++navigationGeneration.current;
      const capturedAuthEpoch = authEpoch.current;
      const capturedAuthorityKey = authorityKeyRef.current;
      if (!authAvailableRef.current) return { kind: 'cancelled' };
      const workspace = workspacesRef.current.find((item) => item.workspaceId === workspaceId);
      const identity = runtimeRef.current;
      if (
        !workspace ||
        !identity ||
        workspace.mount.bootId !== identity.bootId ||
        workspace.mount.health === 'unavailable' ||
        (expected &&
          (expected.registrationRevision !== workspace.registrationRevision ||
            expected.mountGeneration !== workspace.mount.mountGeneration))
      )
        return { kind: 'stale_target' };
      if (workspaceId === selectedWorkspaceRef.current) {
        navigate('team');
        return { kind: 'opened' };
      }
      activeRequest.current?.abort();
      const controller = new AbortController();
      const generation = ++requestGeneration.current;
      activeRequest.current = controller;
      selectingRef.current = workspaceId;
      setSelectingWorkspaceId(workspaceId);
      setError(null);
      try {
        const result = await workspaceTransport.select(workspaceId, controller.signal);
        if (
          controller.signal.aborted ||
          requestGeneration.current !== generation ||
          navigationGeneration.current !== navigation ||
          authEpoch.current !== capturedAuthEpoch ||
          !authAvailableRef.current ||
          authorityKeyRef.current !== capturedAuthorityKey
        )
          return { kind: 'stale_target' };
        const latest = workspacesRef.current.find((item) => item.workspaceId === workspaceId);
        if (
          runtimeRef.current?.deploymentId !== identity.deploymentId ||
          runtimeRef.current.bootId !== identity.bootId ||
          !latest ||
          latest.registrationRevision !== workspace.registrationRevision ||
          latest.mount.mountGeneration !== workspace.mount.mountGeneration ||
          result.workspace.workspaceId !== workspaceId ||
          result.workspace.registrationRevision !== workspace.registrationRevision ||
          result.workspace.mount.bootId !== identity.bootId ||
          result.workspace.mount.mountGeneration !== workspace.mount.mountGeneration
        ) {
          void loadWorkspacesRef.current();
          return { kind: 'stale_target' };
        }
        setSelectedTeamId(null);
        setWorkspaceAccess(null);
        setTeamAccess(null);
        setWorkspaceAccessError(null);
        setTeamAccessError(null);
        teamSelectionScope.current = result.workspace.workspaceId;
        setSelectedWorkspaceId(result.workspace.workspaceId);
        selectedWorkspaceRef.current = result.workspace.workspaceId;
        navigate('team');
        return { kind: 'opened' };
      } catch (caught) {
        if (
          controller.signal.aborted ||
          requestGeneration.current !== generation ||
          navigationGeneration.current !== navigation ||
          authEpoch.current !== capturedAuthEpoch
        )
          return { kind: 'stale_target' };
        teamSelectionScope.current = selectedWorkspaceRef.current;
        setError(workspaceLoadErrorText(caught));
        return { kind: 'failed', message: workspaceLoadErrorText(caught) };
      } finally {
        if (!controller.signal.aborted && requestGeneration.current === generation) {
          setSelectingWorkspaceId(null);
          selectingRef.current = null;
        }
      }
    },
    [navigate, workspaceTransport]
  );

  const showChooser = useCallback(() => navigate('chooser'), [navigate]);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useHostedDashboardPaletteShortcut(page, paletteOpen, openPalette);
  const RecentProjects = useHostedRecentProjectsConnector({
    runtimeIdentity,
    workspaces,
    transport: dashboardTransport,
    authAvailable: !protectedAuthBlocked && authRevalidation.availability === 'available',
    isActive: page === 'dashboard',
    onAuthFailure: onProtectedAuthFailure,
    onOpenWorkspace: selectWorkspace,
    onShowChooser: showChooser,
    registerRefresh: registerRecentRefresh,
    openHistory: recentOpenHistory.current.openedAt,
  });

  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={1500}>
      <main className="grid size-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <HostedShellHeader
          page={page}
          selectedWorkspaceId={selectedWorkspaceId}
          workspaces={workspaces}
          selectingWorkspaceId={selectingWorkspaceId}
          loading={loading}
          error={error}
          accessError={workspaceAccessError ?? teamAccessError}
          teamAdmissionError={currentTeamAdmissionFailure !== null}
          authBlocked={protectedAuthBlocked || authRevalidation.availability !== 'available'}
          onNavigate={navigate}
          onSelectWorkspace={(workspaceId) => void selectWorkspace(workspaceId)}
          onRefreshWorkspaces={() => void loadWorkspaces()}
          onRetryAuth={() => void revalidateProtectedAuth()}
          onRetryProjection={() => setAccessRetrySignal((current) => current + 1)}
          onRetryTeamAdmission={() => {
            if (currentTeamAdmissionFailure)
              admitTeamRef.current(currentTeamAdmissionFailure.teamId);
          }}
        />

        <div className="min-h-0 overflow-hidden">
          <HostedDashboardSurface
            active={page === 'dashboard'}
            scopeKey={`${runtimeIdentity?.deploymentId ?? 'unknown'}:${runtimeIdentity?.bootId ?? 'unknown'}`}
            runningTeams={dashboardRunningTeams}
            runningTeamsAvailable={Boolean(
              selectedWorkspaceId && currentWorkspaceAccess?.capabilities.includes('directory.read')
            )}
            RecentProjects={RecentProjects}
            onSelectTeam={() => navigate(selectedWorkspaceId ? 'team' : 'chooser')}
            onOpenPalette={openPalette}
          />
          {page === 'chooser' && (
            <div className="flex items-center justify-center p-6 text-center">
              <p role="status" className="text-sm text-[var(--color-text-muted)]">
                Select a registered workspace to view its teams.
              </p>
            </div>
          )}
          {selectedWorkspaceId !== null && (
            <div className={page === 'team' ? 'size-full' : 'hidden'}>
              <HostedTeamWorkspace
                key={`${selectedWorkspaceId}:${currentWorkspaceAccess?.grantRevision ?? 'pending'}`}
                {...teamWorkspaceProps}
                workspaceId={selectedWorkspaceId}
                createRegistry={createRegistry}
                authEffectsAvailable={
                  !protectedAuthBlocked &&
                  authRevalidation.availability === 'available' &&
                  currentWorkspaceAccess !== null
                }
                writeEffectsAvailable={writeEffectsAvailable}
                workspaceCapabilities={currentWorkspaceAccess?.capabilities}
                teamCapabilities={currentTeamAccess?.capabilities}
                onDashboardRunningTeams={setDashboardRunningTeams}
                onDashboardDirectory={publishDirectory}
                onProtectedAuthFailure={onProtectedAuthFailure}
                createAuthorityEpoch={
                  createAuthorities.find((item) => item.workspaceId === selectedWorkspaceId)
                    ?.epoch ?? 'unavailable'
                }
                configurationTransport={configurationTransport}
                coordinationEvents={coordinationEvents}
                getCsrfToken={getCsrfToken}
                selectedTeamId={selectedTeamId}
                onSelectedTeamIdChange={(teamId) => {
                  if (
                    teamSelectionScope.current === selectedWorkspaceId &&
                    selectedWorkspaceRef.current === selectedWorkspaceId
                  )
                    admitTeamRef.current(teamId);
                }}
                onLifecycleInvalidation={() => {
                  setLifecycleRefreshSignal((current) => current + 1);
                  recentRefreshRef.current();
                }}
                operatorPanel={
                  <HostedOperatorControl
                    admitted={
                      !protectedAuthBlocked &&
                      authRevalidation.availability === 'available' &&
                      writeEffectsAvailable &&
                      currentWorkspaceAccess !== null &&
                      selectedTeamId !== null &&
                      Boolean(currentTeamAccess?.capabilities.includes('operator.control'))
                    }
                    teamId={selectedTeamId}
                    workspaceId={selectedWorkspaceId}
                    runtimeIdentity={runtimeIdentity}
                    getCsrfToken={getCsrfToken}
                    refreshSignal={lifecycleRefreshSignal}
                  />
                }
              />
            </div>
          )}
        </div>
      </main>
      <HostedDashboardPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        authorityKey={authorityKey}
        authAvailable={!protectedAuthBlocked && authRevalidation.availability === 'available'}
        runtimeIdentity={runtimeIdentity}
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        directory={dashboardDirectory}
        teamOpenAvailable={
          Boolean(currentWorkspaceAccess?.capabilities.includes('directory.read')) &&
          !workspaceAccessChecking &&
          workspaceAccessError === null &&
          !protectedAuthBlocked &&
          authRevalidation.availability === 'available'
        }
        loadRecent={dashboardTransport.recent}
        onSelectWorkspace={selectWorkspace}
        onSelectTeam={(teamId) => {
          if (
            !dashboardDirectory?.snapshot?.items.some(
              (item) => item.teamId === teamId && item.workspaceId === selectedWorkspaceId
            )
          )
            return;
          admitTeamRef.current(teamId);
        }}
        onAuthFailure={onProtectedAuthFailure}
      />
    </TooltipProvider>
  );
};
