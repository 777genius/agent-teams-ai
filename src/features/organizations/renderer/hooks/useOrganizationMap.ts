import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import { buildOrganizationMapViewModel } from '../adapters/organizationMapViewModel';

import type { OrganizationMapPayload, OrganizationMapScope, OrganizationNodeDto } from '../../contracts';

interface UseOrganizationMapInput {
  isActive: boolean;
  organizationId?: string;
  scope?: OrganizationMapScope;
}

interface UseOrganizationMapResult {
  payload: OrganizationMapPayload | null;
  viewModel: ReturnType<typeof buildOrganizationMapViewModel> | null;
  selectedNodeId: string | null;
  loading: boolean;
  error: string | null;
  setSelectedNodeId: (nodeId: string | null) => void;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  openTeam: (node: OrganizationNodeDto) => void;
  openTeamGraph: (node: OrganizationNodeDto) => void;
}

const REFRESH_INTERVAL_MS = 5_000;
const LARGE_ORGANIZATION_REFRESH_INTERVAL_MS = 10_000;
const ALL_ORGANIZATIONS_REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_ORGANIZATION_REQUEST_KEY = '__default__';

export function useOrganizationMap(input: UseOrganizationMapInput): UseOrganizationMapResult {
  const { organizationId, scope = 'organization' } = input;
  const [payload, setPayload] = useState<OrganizationMapPayload | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const openTeamTab = useStore((state) => state.openTeamTab);
  const openTab = useStore((state) => state.openTab);
  const selectTeam = useStore((state) => state.selectTeam);
  const inFlightRefreshRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const refreshSequenceRef = useRef(0);

  const refresh = useCallback(async (options: { force?: boolean } = {}) => {
    const requestKey = `${scope}:${organizationId ?? DEFAULT_ORGANIZATION_REQUEST_KEY}`;
    if (!options.force && inFlightRefreshRef.current?.key === requestKey) {
      return inFlightRefreshRef.current.promise;
    }

    const sequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = sequence;
    const organizationsApi = api.organizations;
    const run = (async () => {
      if (!organizationsApi?.getOrganizationMap) {
        if (sequence !== refreshSequenceRef.current) return;
        setPayload(null);
        setError('Organization map API is unavailable.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        const nextPayload = await organizationsApi.getOrganizationMap({
          scope,
          organizationId,
          maxTeams: scope === 'all' ? 160 : 120,
          maxAgentsPerTeam: scope === 'all' ? 4 : 8,
          maxTasksPerAgent: scope === 'all' ? 1 : 2,
          maxCrossTeamMessages: scope === 'all' ? 160 : 240,
        });
        if (sequence !== refreshSequenceRef.current) return;
        setPayload(nextPayload);
        setSelectedNodeId((current) =>
          current && nextPayload.nodes.some((node) => node.id === current) ? current : null
        );
      } catch (err) {
        if (sequence !== refreshSequenceRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (sequence === refreshSequenceRef.current) {
          setLoading(false);
        }
      }
    })();

    inFlightRefreshRef.current = { key: requestKey, promise: run };
    try {
      await run;
    } finally {
      if (inFlightRefreshRef.current?.promise === run) {
        inFlightRefreshRef.current = null;
      }
    }
  }, [organizationId, scope]);

  const viewModel = useMemo(
    () => (payload ? buildOrganizationMapViewModel(payload) : null),
    [payload]
  );
  const isLargeMap = Boolean(
    viewModel &&
      (viewModel.stats.teamCount > 10 ||
        viewModel.stats.agentCount > 60 ||
        viewModel.stats.communicationEdgeCount > 80)
  );
  const refreshIntervalMs = scope === 'all'
    ? ALL_ORGANIZATIONS_REFRESH_INTERVAL_MS
    : isLargeMap
    ? LARGE_ORGANIZATION_REFRESH_INTERVAL_MS
    : REFRESH_INTERVAL_MS;

  useEffect(() => {
    if (!input.isActive) return;
    void refresh();
  }, [input.isActive, refresh]);

  useEffect(() => {
    if (!input.isActive) return undefined;
    const timer = window.setInterval(() => {
      void refresh();
    }, refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [input.isActive, refresh, refreshIntervalMs]);

  const openTeam = useCallback(
    (node: OrganizationNodeDto) => {
      if (!node.team) return;
      openTeamTab(node.team.teamName, node.team.projectPath);
    },
    [openTeamTab]
  );

  const openTeamGraph = useCallback(
    (node: OrganizationNodeDto) => {
      if (!node.team) return;
      const { displayName, teamName } = node.team;
      void (async () => {
        try {
          await selectTeam(teamName);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
        openTab({
          type: 'graph',
          label: `${displayName} Graph`,
          teamName,
        });
      })();
    },
    [openTab, selectTeam]
  );

  return {
    payload,
    viewModel,
    selectedNodeId,
    loading,
    error,
    setSelectedNodeId,
    refresh,
    openTeam,
    openTeamGraph,
  };
}
