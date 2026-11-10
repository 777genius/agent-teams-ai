import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  AssignOrganizationTeamRequest,
  CreateOrganizationRequest,
  DeleteOrganizationRelationRequest,
  MoveOrganizationUnitRequest,
  OrganizationStructurePayload,
  RemoveOrganizationTeamRequest,
  RemoveOrganizationUnitRequest,
  UpsertOrganizationRelationRequest,
  UpsertOrganizationUnitRequest,
} from '../../contracts';

interface UseOrganizationStructureManagerInput {
  isActive: boolean;
  organizationId?: string;
  refreshMap: () => Promise<void>;
}

interface UseOrganizationStructureManagerResult {
  structure: OrganizationStructurePayload | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refreshStructure: (options?: { force?: boolean }) => Promise<void>;
  createOrganization: (request: CreateOrganizationRequest) => Promise<void>;
  upsertUnit: (request: UpsertOrganizationUnitRequest) => Promise<void>;
  moveUnit: (request: MoveOrganizationUnitRequest) => Promise<void>;
  removeUnit: (request: RemoveOrganizationUnitRequest) => Promise<void>;
  assignTeam: (request: AssignOrganizationTeamRequest) => Promise<void>;
  removeTeam: (request: RemoveOrganizationTeamRequest) => Promise<void>;
  upsertRelation: (request: UpsertOrganizationRelationRequest) => Promise<void>;
  deleteRelation: (request: DeleteOrganizationRelationRequest) => Promise<void>;
}

const DEFAULT_ORGANIZATION_REQUEST_KEY = '__default__';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useOrganizationStructureManager(
  input: UseOrganizationStructureManagerInput
): UseOrganizationStructureManagerResult {
  const { isActive, organizationId, refreshMap } = input;
  const [structure, setStructure] = useState<OrganizationStructurePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRefreshRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const refreshSequenceRef = useRef(0);

  const refreshStructure = useCallback(async (options: { force?: boolean } = {}) => {
    const requestKey = organizationId ?? DEFAULT_ORGANIZATION_REQUEST_KEY;
    if (!options.force && inFlightRefreshRef.current?.key === requestKey) {
      return inFlightRefreshRef.current.promise;
    }

    const sequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = sequence;
    const run = (async () => {
      const organizationsApi = api.organizations;
      if (!organizationsApi?.getOrganizationStructure) {
        if (sequence !== refreshSequenceRef.current) return;
        setStructure(null);
        setError('Organization management API is unavailable.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        const nextStructure = await organizationsApi.getOrganizationStructure({ organizationId });
        if (sequence !== refreshSequenceRef.current) return;
        setStructure(nextStructure);
      } catch (err) {
        if (sequence !== refreshSequenceRef.current) return;
        setError(getErrorMessage(err));
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
  }, [organizationId]);

  const runMutation = useCallback(
    async (operation: () => Promise<OrganizationStructurePayload>) => {
      refreshSequenceRef.current += 1;
      inFlightRefreshRef.current = null;
      setSaving(true);
      try {
        setError(null);
        setStructure(await operation());
        await refreshMap();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [refreshMap]
  );

  useEffect(() => {
    if (!isActive) return undefined;
    void refreshStructure();
    return undefined;
  }, [isActive, refreshStructure]);

  return {
    structure,
    loading,
    saving,
    error,
    refreshStructure,
    createOrganization: (request) =>
      runMutation(() => api.organizations.createOrganization(request)),
    upsertUnit: (request) => runMutation(() => api.organizations.upsertOrganizationUnit(request)),
    moveUnit: (request) => runMutation(() => api.organizations.moveOrganizationUnit(request)),
    removeUnit: (request) => runMutation(() => api.organizations.removeOrganizationUnit(request)),
    assignTeam: (request) => runMutation(() => api.organizations.assignTeamToUnit(request)),
    removeTeam: (request) =>
      runMutation(() => api.organizations.removeTeamFromOrganization(request)),
    upsertRelation: (request) =>
      runMutation(() => api.organizations.upsertOrganizationRelation(request)),
    deleteRelation: (request) =>
      runMutation(() => api.organizations.deleteOrganizationRelation(request)),
  };
}
