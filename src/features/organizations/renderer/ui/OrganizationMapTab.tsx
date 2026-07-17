import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Bot, Building2, Link2, Network, Pencil, RadioTower, RefreshCw, Users } from 'lucide-react';

import { getOrganizationIdForNodeId } from '../adapters/organizationMapViewModel';
import { useOrganizationCreateTeamDialog } from '../hooks/useOrganizationCreateTeamDialog';
import { useOrganizationMap } from '../hooks/useOrganizationMap';
import { useOrganizationStructureManager } from '../hooks/useOrganizationStructureManager';

import { OrganizationEditorPanel } from './OrganizationEditorPanel';
import { OrgGraphSurface } from './OrgGraphSurface';
import { OrgInspector } from './OrgInspector';

import type { OrganizationMapScope, OrganizationPlacementSelection } from '../../contracts';
import type { GraphLayoutMode } from '@claude-teams/agent-graph';

const CreateTeamDialog = lazy(() =>
  import('@renderer/components/team/dialogs/CreateTeamDialog').then((module) => ({
    default: module.CreateTeamDialog,
  }))
);

export interface OrganizationMapTabProps {
  isActive?: boolean;
  isPaneFocused?: boolean;
}

export const OrganizationMapTab = ({
  isActive = true,
}: OrganizationMapTabProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editMode, setEditMode] = useState(false);
  const [layoutMode, setLayoutMode] = useState<GraphLayoutMode>('grid-under-lead');
  const [mapScope, setMapScope] = useState<OrganizationMapScope>('all');
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | undefined>(undefined);
  const [createTeamPlacement, setCreateTeamPlacement] =
    useState<OrganizationPlacementSelection | null>(null);
  const {
    viewModel,
    selectedNodeId,
    loading,
    error,
    setSelectedNodeId,
    refresh,
    openTeam,
    openTeamGraph,
  } = useOrganizationMap({ isActive, organizationId: activeOrganizationId, scope: mapScope });
  const refreshMapAfterStructureMutation = useCallback(() => refresh({ force: true }), [refresh]);
  const structureManager = useOrganizationStructureManager({
    isActive,
    organizationId: activeOrganizationId,
    refreshMap: refreshMapAfterStructureMutation,
  });
  const createTeamDialog = useOrganizationCreateTeamDialog();
  const organizations = useMemo(
    () => structureManager.structure?.organizations ?? viewModel?.payload.organizations ?? [],
    [structureManager.structure?.organizations, viewModel?.payload.organizations]
  );
  const activeOrganization = useMemo(
    () =>
      organizations.find((organization) => organization.id === activeOrganizationId) ??
      organizations.find(
        (organization) => organization.id === structureManager.structure?.activeOrganizationId
      ) ??
      organizations.find(
        (organization) => organization.id === viewModel?.payload.activeOrganizationId
      ) ??
      organizations[0] ??
      null,
    [
      activeOrganizationId,
      organizations,
      structureManager.structure?.activeOrganizationId,
      viewModel?.payload.activeOrganizationId,
    ]
  );
  const selectedOrganizationId =
    activeOrganizationId ??
    structureManager.structure?.activeOrganizationId ??
    viewModel?.payload.activeOrganizationId ??
    '';
  const mapTitle =
    mapScope === 'all'
      ? t('organizations.map.allOrganizationsTitle')
      : (activeOrganization?.name ?? t('organizations.map.defaultTitle'));
  const organizationIdsKey = organizations.map((organization) => organization.id).join('\0');

  useEffect(() => {
    const preferredOrganizationId =
      structureManager.structure?.activeOrganizationId ?? viewModel?.payload.activeOrganizationId;
    if (!preferredOrganizationId) return;
    setActiveOrganizationId(preferredOrganizationId);
  }, [
    organizationIdsKey,
    structureManager.structure?.activeOrganizationId,
    viewModel?.payload.activeOrganizationId,
  ]);

  useEffect(() => {
    setSelectedNodeId(null);
    setCollapsedNodeIds(new Set());
  }, [mapScope, setSelectedNodeId]);

  const selectedNode = useMemo(() => {
    if (!viewModel || !selectedNodeId) return null;
    return viewModel.nodeById.get(selectedNodeId) ?? null;
  }, [selectedNodeId, viewModel]);
  const selectedChildCount =
    selectedNode && viewModel
      ? (viewModel.childNodeIdsByParentId.get(selectedNode.id)?.length ?? 0)
      : 0;
  const canToggleSelectedNode = Boolean(
    selectedNode && selectedChildCount > 0 && selectedNode.id !== viewModel?.rootNode?.id
  );
  const toggleNodeCollapse = useCallback(
    (nodeId: string) => {
      if (!viewModel || nodeId === viewModel.rootNode?.id) return;
      const childCount = viewModel.childNodeIdsByParentId.get(nodeId)?.length ?? 0;
      if (childCount === 0) return;
      setSelectedNodeId(nodeId);
      if (mapScope === 'all') {
        const organizationId = getOrganizationIdForNodeId(viewModel, nodeId);
        if (organizationId) {
          setActiveOrganizationId(organizationId);
        }
      }
      setCollapsedNodeIds((current) => {
        const next = new Set(current);
        if (next.has(nodeId)) {
          next.delete(nodeId);
        } else {
          next.add(nodeId);
        }
        return next;
      });
    },
    [mapScope, setSelectedNodeId, viewModel]
  );
  const toggleSelectedCollapse = useCallback(() => {
    if (!selectedNode || !canToggleSelectedNode) return;
    toggleNodeCollapse(selectedNode.id);
  }, [canToggleSelectedNode, selectedNode, toggleNodeCollapse]);

  const selectOrganizationNode = useCallback(
    (nodeId: string | null) => {
      setSelectedNodeId(nodeId);
      if (mapScope !== 'all' || !viewModel) return;
      const organizationId = getOrganizationIdForNodeId(viewModel, nodeId);
      if (organizationId) {
        setActiveOrganizationId(organizationId);
      }
    },
    [mapScope, setSelectedNodeId, viewModel]
  );

  return (
    <div className="flex size-full flex-col bg-[var(--color-background)]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
            <Network size={16} className="text-[var(--color-text-muted)]" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[var(--color-text)]">
              {mapTitle}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
              {mapScope === 'all' ? (
                <span className="inline-flex items-center gap-1">
                  <Building2 size={11} />
                  {t('organizations.map.stats.orgs', { count: organizations.length })}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <Users size={11} />
                {t('organizations.map.stats.teams', { count: viewModel?.stats.teamCount ?? 0 })}
              </span>
              <span className="inline-flex items-center gap-1">
                <Bot size={11} />
                {t('organizations.map.stats.agents', { count: viewModel?.stats.agentCount ?? 0 })}
              </span>
              <span className="inline-flex items-center gap-1">
                <Link2 size={11} />
                {t('organizations.map.stats.relations', {
                  count: viewModel?.stats.manualRelationCount ?? 0,
                })}
              </span>
              <span className="inline-flex items-center gap-1">
                <RadioTower size={11} />
                {t('organizations.map.stats.runtimeLinks', {
                  count: viewModel?.stats.communicationEdgeCount ?? 0,
                })}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex h-8 items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-0.5">
            <Button
              size="sm"
              variant={mapScope === 'organization' ? 'secondary' : 'ghost'}
              className="h-7 rounded-sm px-2"
              onClick={() => setMapScope('organization')}
            >
              {t('organizations.map.scope.currentOrg')}
            </Button>
            <Button
              size="sm"
              variant={mapScope === 'all' ? 'secondary' : 'ghost'}
              className="h-7 rounded-sm px-2"
              onClick={() => setMapScope('all')}
            >
              {t('organizations.map.scope.allOrgs')}
            </Button>
          </div>
          {organizations.length > 0 && (mapScope === 'organization' || editMode) ? (
            <Select
              value={selectedOrganizationId}
              disabled={loading || structureManager.loading}
              onValueChange={setActiveOrganizationId}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder={t('organizations.map.organizationPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((organization) => (
                  <SelectItem key={organization.id} value={organization.id}>
                    {organization.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            size="sm"
            variant={editMode ? 'default' : 'outline'}
            className="h-8"
            onClick={() => setEditMode((current) => !current)}
          >
            <Pencil size={13} />
            {editMode
              ? t('organizations.map.actions.editing')
              : t('organizations.map.actions.edit')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={loading || structureManager.loading}
            onClick={() => {
              void Promise.all([
                refresh({ force: true }),
                structureManager.refreshStructure({ force: true }),
              ]);
            }}
          >
            <RefreshCw
              size={13}
              className={loading || structureManager.loading ? 'animate-spin' : undefined}
            />
            {t('organizations.map.actions.refresh')}
          </Button>
        </div>
      </div>

      {error || structureManager.error ? (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          {error ?? structureManager.error}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-w-0 flex-1">
          {viewModel ? (
            <OrgGraphSurface
              viewModel={viewModel}
              isActive={isActive}
              collapsedNodeIds={collapsedNodeIds}
              layoutMode={layoutMode}
              selectedNodeId={selectedNodeId}
              showSelectedTeamDetails={!editMode}
              onLayoutModeChange={setLayoutMode}
              onSelectNode={selectOrganizationNode}
              onToggleNodeCollapse={toggleNodeCollapse}
            />
          ) : (
            <div className="flex size-full items-center justify-center text-sm text-[var(--color-text-muted)]">
              {loading ? t('organizations.map.loading') : t('organizations.map.noOrganizationData')}
            </div>
          )}
        </div>
        {editMode ? (
          <OrganizationEditorPanel
            structure={structureManager.structure}
            selectedNode={selectedNode}
            loading={structureManager.loading}
            saving={structureManager.saving}
            onCreateOrganization={structureManager.createOrganization}
            onUpsertUnit={structureManager.upsertUnit}
            onMoveUnit={structureManager.moveUnit}
            onRemoveUnit={structureManager.removeUnit}
            onAssignTeam={structureManager.assignTeam}
            onRemoveTeam={structureManager.removeTeam}
            onUpsertRelation={structureManager.upsertRelation}
            onDeleteRelation={structureManager.deleteRelation}
            onCreateTeamHere={setCreateTeamPlacement}
          />
        ) : selectedNode ? (
          <OrgInspector
            node={selectedNode}
            childCount={selectedChildCount}
            canToggleCollapse={canToggleSelectedNode}
            isCollapsed={selectedNode ? collapsedNodeIds.has(selectedNode.id) : false}
            onToggleCollapse={toggleSelectedCollapse}
            onOpenTeam={openTeam}
            onOpenGraph={openTeamGraph}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : null}
      </div>
      {createTeamPlacement ? (
        <Suspense fallback={null}>
          <CreateTeamDialog
            open={createTeamPlacement !== null}
            canCreate={createTeamDialog.canCreate}
            provisioningErrorsByTeam={createTeamDialog.provisioningErrorsByTeam}
            clearProvisioningError={createTeamDialog.clearProvisioningError}
            existingTeamNames={createTeamDialog.existingTeamNames}
            provisioningTeamNames={createTeamDialog.provisioningTeamNames}
            activeTeams={createTeamDialog.activeTeams}
            initialOrganizationPlacement={createTeamPlacement}
            onClose={() => {
              setCreateTeamPlacement(null);
              void Promise.all([
                refresh({ force: true }),
                structureManager.refreshStructure({ force: true }),
              ]);
            }}
            onCreate={createTeamDialog.createTeam}
            onOpenTeam={createTeamDialog.openTeam}
          />
        </Suspense>
      ) : null}
    </div>
  );
};
