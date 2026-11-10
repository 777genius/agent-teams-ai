import { type DragEvent, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import {
  Building2,
  GitBranch,
  GripVertical,
  Link2,
  MoveRight,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';

import type {
  AssignOrganizationTeamRequest,
  CreateOrganizationRequest,
  DeleteOrganizationRelationRequest,
  MoveOrganizationUnitRequest,
  OrganizationNodeDto,
  OrganizationPlacementSelection,
  OrganizationRelationKind,
  OrganizationStructurePayload,
  OrganizationStructureUnitDto,
  RemoveOrganizationTeamRequest,
  RemoveOrganizationUnitRequest,
  UpsertOrganizationRelationRequest,
  UpsertOrganizationUnitRequest,
} from '../../contracts';

interface OrganizationEditorPanelProps {
  structure: OrganizationStructurePayload | null;
  selectedNode: OrganizationNodeDto | null;
  loading: boolean;
  saving: boolean;
  onCreateOrganization: (request: CreateOrganizationRequest) => Promise<void>;
  onUpsertUnit: (request: UpsertOrganizationUnitRequest) => Promise<void>;
  onMoveUnit: (request: MoveOrganizationUnitRequest) => Promise<void>;
  onRemoveUnit: (request: RemoveOrganizationUnitRequest) => Promise<void>;
  onAssignTeam: (request: AssignOrganizationTeamRequest) => Promise<void>;
  onRemoveTeam: (request: RemoveOrganizationTeamRequest) => Promise<void>;
  onUpsertRelation: (request: UpsertOrganizationRelationRequest) => Promise<void>;
  onDeleteRelation: (request: DeleteOrganizationRelationRequest) => Promise<void>;
  onCreateTeamHere?: (placement: OrganizationPlacementSelection) => void;
}

const RELATION_KINDS: OrganizationRelationKind[] = ['depends_on', 'delegates', 'observes'];
const ROOT_ORGANIZATION_PARENT_VALUE = '__root__';
const EDITOR_TAB_TRIGGER_CLASS =
  "relative h-9 min-w-[74px] flex-1 gap-1.5 rounded-b-none border border-b-0 border-transparent px-2 py-1 text-xs text-[var(--color-text-secondary)] data-[state=active]:z-10 data-[state=active]:-mb-px data-[state=active]:border-[var(--color-border)] data-[state=active]:bg-[var(--color-surface)] data-[state=active]:text-[var(--color-text)] data-[state=active]:shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:-bottom-px data-[state=active]:after:h-px data-[state=active]:after:bg-[var(--color-surface)] data-[state=active]:after:content-['']";
type OrganizationEditorMode = 'structure' | 'teams' | 'relations' | 'organizations';

interface OrganizationTreeRow {
  unit: OrganizationStructureUnitDto;
  depth: number;
}

function getUnitTeamName(unit: OrganizationStructureUnitDto): string | null {
  if (unit.kind !== 'team') {
    return null;
  }
  return unit.teamName ?? unit.id.replace(/^team:/, '');
}

function getUnitLabel(unit: OrganizationStructureUnitDto): string {
  const teamName = getUnitTeamName(unit);
  return teamName ? `${unit.label} (${teamName})` : unit.label;
}

type UnitKindTranslationKey =
  | 'organizations.editor.kind.group'
  | 'organizations.editor.kind.org'
  | 'organizations.editor.kind.team';

type StructureSourceTranslationKey =
  | 'organizations.editor.source.configured'
  | 'organizations.editor.source.generated';

type RelationKindTranslationKey =
  | 'organizations.editor.relationKind.dependsOn'
  | 'organizations.editor.relationKind.delegates'
  | 'organizations.editor.relationKind.observes';

function getUnitKindTranslationKey(
  kind: OrganizationStructureUnitDto['kind']
): UnitKindTranslationKey {
  if (kind === 'container') return 'organizations.editor.kind.group';
  if (kind === 'organization') return 'organizations.editor.kind.org';
  return 'organizations.editor.kind.team';
}

function getStructureSourceTranslationKey(
  source: OrganizationStructurePayload['source']
): StructureSourceTranslationKey {
  return source === 'generated'
    ? 'organizations.editor.source.generated'
    : 'organizations.editor.source.configured';
}

function getRelationKindTranslationKey(kind: OrganizationRelationKind): RelationKindTranslationKey {
  if (kind === 'delegates') return 'organizations.editor.relationKind.delegates';
  if (kind === 'observes') return 'organizations.editor.relationKind.observes';
  return 'organizations.editor.relationKind.dependsOn';
}

function buildUnitRows(units: readonly OrganizationStructureUnitDto[]): OrganizationTreeRow[] {
  const childrenByParentId = new Map<string | null, OrganizationStructureUnitDto[]>();
  for (const unit of units) {
    const children = childrenByParentId.get(unit.parentId) ?? [];
    children.push(unit);
    childrenByParentId.set(unit.parentId, children);
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
    );
  }

  const rows: OrganizationTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (unit: OrganizationStructureUnitDto, depth: number): void => {
    if (seen.has(unit.id)) return;
    seen.add(unit.id);
    rows.push({ unit, depth });
    for (const child of childrenByParentId.get(unit.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of childrenByParentId.get(null) ?? []) {
    visit(root, 0);
  }
  for (const unit of units) {
    visit(unit, 0);
  }
  return rows;
}

function collectDescendantUnitIds(
  units: readonly OrganizationStructureUnitDto[],
  unitId: string
): Set<string> {
  const childrenByParentId = new Map<string, OrganizationStructureUnitDto[]>();
  for (const unit of units) {
    const children = childrenByParentId.get(unit.parentId ?? '') ?? [];
    children.push(unit);
    childrenByParentId.set(unit.parentId ?? '', children);
  }

  const descendants = new Set<string>();
  const visit = (parentId: string): void => {
    for (const child of childrenByParentId.get(parentId) ?? []) {
      if (descendants.has(child.id)) continue;
      descendants.add(child.id);
      visit(child.id);
    }
  };

  visit(unitId);
  return descendants;
}

function canMoveUnitUnderTarget(
  units: readonly OrganizationStructureUnitDto[],
  draggedUnitId: string | null,
  targetParent: OrganizationStructureUnitDto
): boolean {
  if (!draggedUnitId || targetParent.kind === 'team') return false;
  const draggedUnit = units.find((unit) => unit.id === draggedUnitId);
  if (!draggedUnit || draggedUnit.kind === 'organization') return false;
  if (draggedUnit.id === targetParent.id || draggedUnit.parentId === targetParent.id) return false;
  if (draggedUnit.organizationId !== targetParent.organizationId) return false;

  return !collectDescendantUnitIds(units, draggedUnit.id).has(targetParent.id);
}

export const OrganizationEditorPanel = ({
  structure,
  selectedNode,
  loading,
  saving,
  onCreateOrganization,
  onUpsertUnit,
  onMoveUnit,
  onRemoveUnit,
  onAssignTeam,
  onRemoveTeam,
  onUpsertRelation,
  onDeleteRelation,
  onCreateTeamHere,
}: OrganizationEditorPanelProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [organizationName, setOrganizationName] = useState('');
  const [organizationParentId, setOrganizationParentId] = useState('');
  const [containerLabel, setContainerLabel] = useState('');
  const [containerParentId, setContainerParentId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [teamParentId, setTeamParentId] = useState('');
  const [moveParentId, setMoveParentId] = useState('');
  const [draggedUnitId, setDraggedUnitId] = useState<string | null>(null);
  const [dropTargetUnitId, setDropTargetUnitId] = useState<string | null>(null);
  const [editorSelectedUnitId, setEditorSelectedUnitId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<OrganizationEditorMode>('structure');
  const [relationSourceId, setRelationSourceId] = useState('');
  const [relationTargetId, setRelationTargetId] = useState('');
  const [relationKind, setRelationKind] = useState<OrganizationRelationKind>('depends_on');

  const activeOrganization = useMemo(() => {
    if (!structure) return null;
    return (
      structure.organizations.find(
        (organization) => organization.id === structure.activeOrganizationId
      ) ??
      structure.organizations[0] ??
      null
    );
  }, [structure]);
  const units = useMemo(() => {
    if (!structure || !activeOrganization) return [];
    return structure.units.filter((unit) => unit.organizationId === activeOrganization.id);
  }, [activeOrganization, structure]);
  const parentUnits = units.filter((unit) => unit.kind !== 'team');
  const rootUnit =
    parentUnits.find((unit) => unit.id === activeOrganization?.rootNodeId) ??
    parentUnits[0] ??
    null;
  const selectedUnit = useMemo(() => {
    const unitId = editorSelectedUnitId;
    if (!unitId) return null;
    return units.find((unit) => unit.id === unitId) ?? null;
  }, [editorSelectedUnitId, units]);
  const unitRows = useMemo(() => buildUnitRows(units), [units]);
  const selectedContextUnit = selectedUnit ?? rootUnit;
  const selectedAsParent =
    selectedContextUnit && selectedContextUnit.kind !== 'team'
      ? selectedContextUnit.id
      : selectedContextUnit?.parentId;
  const fallbackParentId = selectedAsParent ?? activeOrganization?.rootNodeId ?? '';
  const fallbackParentUnit = parentUnits.find((unit) => unit.id === fallbackParentId) ?? rootUnit;
  const fallbackParentLabel = fallbackParentUnit
    ? getUnitLabel(fallbackParentUnit)
    : (activeOrganization?.name ?? t('organizations.editor.fallbackOrganization'));
  const effectiveContainerParentId = containerParentId || fallbackParentId;
  const effectiveTeamParentId = teamParentId || fallbackParentId;
  const effectiveMoveParentId = moveParentId || selectedUnit?.parentId || fallbackParentId;
  const createTeamParentUnit =
    selectedUnit && selectedUnit.kind !== 'team'
      ? selectedUnit
      : selectedUnit?.parentId
        ? (units.find((unit) => unit.id === selectedUnit.parentId) ?? null)
        : (parentUnits.find((unit) => unit.id === activeOrganization?.rootNodeId) ??
          parentUnits[0] ??
          null);
  const placedTeamNames = new Set(
    units.map(getUnitTeamName).filter((name): name is string => name !== null)
  );
  const unplacedTeams =
    structure?.availableTeams.filter((team) => !placedTeamNames.has(team.teamName)) ?? [];
  const groupCount = units.filter((unit) => unit.kind === 'container').length;
  const placedTeamCount = placedTeamNames.size;
  const relationUnits = units.filter((unit) => unit.kind === 'team' && getUnitTeamName(unit));
  const manualRelations =
    structure?.relations.filter(
      (relation) =>
        relation.sourceKind === 'manual' &&
        (!relation.organizationId || relation.organizationId === activeOrganization?.id)
    ) ?? [];
  const disabled = loading || saving || !structure || !activeOrganization;
  const effectiveOrganizationParentId =
    organizationParentId || activeOrganization?.id || ROOT_ORGANIZATION_PARENT_VALUE;

  useEffect(() => {
    if (selectedNode?.structureUnitId) {
      setEditorSelectedUnitId(selectedNode.structureUnitId);
    }
  }, [selectedNode?.structureUnitId]);

  const createOrganization = async (): Promise<void> => {
    if (!organizationName.trim()) return;
    await onCreateOrganization({
      name: organizationName.trim(),
      parentOrganizationId:
        effectiveOrganizationParentId === ROOT_ORGANIZATION_PARENT_VALUE
          ? null
          : effectiveOrganizationParentId,
    });
    setOrganizationName('');
  };

  const createContainer = async (): Promise<void> => {
    if (!activeOrganization || !containerLabel.trim() || !effectiveContainerParentId) return;
    await onUpsertUnit({
      organizationId: activeOrganization.id,
      parentId: effectiveContainerParentId,
      kind: 'container',
      label: containerLabel.trim(),
    });
    setContainerLabel('');
  };

  const assignTeam = async (): Promise<void> => {
    if (!activeOrganization || !teamName || !effectiveTeamParentId) return;
    const team = structure?.availableTeams.find((candidate) => candidate.teamName === teamName);
    await onAssignTeam({
      organizationId: activeOrganization.id,
      parentUnitId: effectiveTeamParentId,
      teamName,
      label: team?.displayName,
    });
    setTeamName('');
  };

  const moveSelected = async (): Promise<void> => {
    if (!selectedUnit || selectedUnit.kind === 'organization' || !effectiveMoveParentId) return;
    await onMoveUnit({
      organizationId: selectedUnit.organizationId,
      unitId: selectedUnit.id,
      parentId: effectiveMoveParentId,
    });
  };

  const moveDraggedUnit = async (targetParent: OrganizationStructureUnitDto): Promise<void> => {
    if (!canMoveUnitUnderTarget(units, draggedUnitId, targetParent)) {
      setDropTargetUnitId(null);
      return;
    }
    const draggedUnit = units.find((unit) => unit.id === draggedUnitId);
    if (!draggedUnit) {
      return;
    }

    await onMoveUnit({
      organizationId: draggedUnit.organizationId,
      unitId: draggedUnit.id,
      parentId: targetParent.id,
    });
    setDraggedUnitId(null);
    setDropTargetUnitId(null);
  };

  const handleUnitDragOver = (
    event: DragEvent<HTMLDivElement>,
    targetUnit: OrganizationStructureUnitDto
  ): void => {
    if (!draggedUnitId) return;
    setDropTargetUnitId(targetUnit.id);
    if (canMoveUnitUnderTarget(units, draggedUnitId, targetUnit)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      return;
    }
    event.dataTransfer.dropEffect = 'none';
  };

  const removeSelected = async (): Promise<void> => {
    if (!selectedUnit || selectedUnit.kind === 'organization') return;
    const selectedTeamName = getUnitTeamName(selectedUnit);
    if (selectedTeamName) {
      await onRemoveTeam({
        organizationId: selectedUnit.organizationId,
        teamName: selectedTeamName,
      });
      return;
    }
    await onRemoveUnit({
      organizationId: selectedUnit.organizationId,
      unitId: selectedUnit.id,
      cascade: false,
    });
  };

  const createTeamHere = (): void => {
    if (!createTeamParentUnit || !onCreateTeamHere) return;
    onCreateTeamHere({
      organizationId: createTeamParentUnit.organizationId,
      parentUnitId: createTeamParentUnit.id,
    });
  };

  const createRelation = async (): Promise<void> => {
    if (!relationSourceId || !relationTargetId || relationSourceId === relationTargetId) return;
    await onUpsertRelation({
      organizationId: activeOrganization?.id,
      sourceNodeId: relationSourceId,
      targetNodeId: relationTargetId,
      kind: relationKind,
    });
    setRelationSourceId('');
    setRelationTargetId('');
  };

  return (
    <aside className="w-96 shrink-0 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
          <Building2 size={15} />
          {t('organizations.editor.title')}
        </div>
        <div className="mt-2 min-w-0">
          <div className="truncate text-xs font-medium text-[var(--color-text)]">
            {activeOrganization?.name ?? t('organizations.editor.loadingOrganization')}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {structure?.source
                ? t(getStructureSourceTranslationKey(structure.source))
                : t('organizations.editor.source.loading')}
            </Badge>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {t('organizations.editor.badges.groups', { count: groupCount })}
            </Badge>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {t('organizations.editor.badges.placed', { count: placedTeamCount })}
            </Badge>
            {unplacedTeams.length > 0 ? (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {t('organizations.editor.badges.unplaced', { count: unplacedTeams.length })}
              </Badge>
            ) : null}
            {saving ? (
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {t('organizations.editor.saving')}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-5 p-4">
        <Tabs
          value={editorMode}
          onValueChange={(value) => setEditorMode(value as OrganizationEditorMode)}
        >
          <div className="-mb-px border-b border-[var(--color-border-subtle)]">
            <TabsList className="h-auto w-full justify-start gap-1 rounded-none bg-transparent p-0">
              <TabsTrigger value="structure" className={EDITOR_TAB_TRIGGER_CLASS}>
                <GitBranch size={12} />
                {t('organizations.editor.tabs.structure')}
              </TabsTrigger>
              <TabsTrigger value="teams" className={EDITOR_TAB_TRIGGER_CLASS}>
                <Users size={12} />
                {t('organizations.editor.tabs.teams')}
              </TabsTrigger>
              <TabsTrigger value="relations" className={EDITOR_TAB_TRIGGER_CLASS}>
                <Link2 size={12} />
                {t('organizations.editor.tabs.links')}
              </TabsTrigger>
              <TabsTrigger value="organizations" className={EDITOR_TAB_TRIGGER_CLASS}>
                <Building2 size={12} />
                {t('organizations.editor.tabs.organizations')}
              </TabsTrigger>
            </TabsList>
          </div>
        </Tabs>

        {editorMode === 'organizations' ? (
          <section className="space-y-2">
            <Label htmlFor="org-name" className="text-xs">
              {t('organizations.editor.newOrganization')}
            </Label>
            {structure ? (
              <Select
                value={effectiveOrganizationParentId}
                disabled={saving}
                onValueChange={setOrganizationParentId}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={t('organizations.editor.parentOrganization')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT_ORGANIZATION_PARENT_VALUE}>
                    {t('organizations.editor.topLevel')}
                  </SelectItem>
                  {structure.organizations.map((organization) => (
                    <SelectItem key={organization.id} value={organization.id}>
                      {t('organizations.editor.underLabel', { label: organization.name })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <div className="flex gap-2">
              <Input
                id="org-name"
                className="h-8 text-xs"
                value={organizationName}
                placeholder={activeOrganization?.name ?? t('organizations.editor.newOrganization')}
                disabled={saving}
                onChange={(event) => setOrganizationName(event.target.value)}
              />
              <Button
                size="sm"
                className="h-8"
                disabled={saving || !organizationName.trim()}
                onClick={() => void createOrganization()}
              >
                <Plus size={13} />
                {t('organizations.editor.actions.create')}
              </Button>
            </div>
          </section>
        ) : null}

        {editorMode === 'structure' || editorMode === 'teams' ? (
          <section className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  {t('organizations.editor.selectedLocation')}
                </div>
                <div className="mt-1 truncate text-sm font-medium text-[var(--color-text)]">
                  {fallbackParentLabel}
                </div>
              </div>
              {fallbackParentUnit ? (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                  {t(getUnitKindTranslationKey(fallbackParentUnit.kind))}
                </Badge>
              ) : null}
            </div>
            <div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-full"
                disabled={disabled || !createTeamParentUnit || !onCreateTeamHere}
                onClick={createTeamHere}
              >
                <Plus size={13} />
                {t('organizations.editor.actions.teamHere')}
              </Button>
            </div>
          </section>
        ) : null}

        {editorMode === 'structure' ? (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text)]">
              <GitBranch size={13} />
              {t('organizations.editor.organizationTree')}
            </div>
            <div
              role="tree"
              className="max-h-72 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)]"
            >
              {unitRows.length === 0 ? (
                <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">
                  {t('organizations.editor.noOrganizationUnits')}
                </div>
              ) : (
                unitRows.map(({ unit, depth }) => {
                  const canDrag = !disabled && unit.kind !== 'organization';
                  const dropState =
                    draggedUnitId && dropTargetUnitId === unit.id
                      ? canMoveUnitUnderTarget(units, draggedUnitId, unit)
                        ? 'valid'
                        : 'invalid'
                      : null;
                  const isSelected = selectedUnit
                    ? selectedUnit.id === unit.id
                    : fallbackParentUnit?.id === unit.id;
                  return (
                    <div
                      key={unit.id}
                      role="treeitem"
                      aria-selected={isSelected}
                      aria-grabbed={draggedUnitId === unit.id}
                      data-organization-unit-id={unit.id}
                      data-drop-target-state={dropState ?? undefined}
                      tabIndex={0}
                      draggable={canDrag}
                      className={[
                        'relative flex cursor-pointer items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-xs last:border-b-0',
                        draggedUnitId ? 'transition-colors' : '',
                        draggedUnitId && unit.kind !== 'team'
                          ? 'hover:bg-[var(--color-surface-raised)]'
                          : '',
                        isSelected
                          ? 'bg-sky-500/10 ring-1 ring-inset ring-sky-400/35'
                          : 'hover:bg-[var(--color-surface-raised)]',
                        dropState === 'valid'
                          ? 'bg-sky-500/15 ring-1 ring-inset ring-sky-400/60'
                          : '',
                        dropState === 'invalid'
                          ? 'cursor-not-allowed bg-red-500/10 opacity-70 ring-1 ring-inset ring-red-400/50'
                          : '',
                      ].join(' ')}
                      style={{ paddingLeft: `${8 + depth * 14}px` }}
                      onClick={() => setEditorSelectedUnitId(unit.id)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setEditorSelectedUnitId(unit.id);
                      }}
                      onDragStart={(event) => {
                        if (!canDrag) return;
                        setDraggedUnitId(unit.id);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', unit.id);
                      }}
                      onDragEnd={() => {
                        setDraggedUnitId(null);
                        setDropTargetUnitId(null);
                      }}
                      onDragEnter={() => {
                        if (draggedUnitId) setDropTargetUnitId(unit.id);
                      }}
                      onDragLeave={(event) => {
                        const relatedTarget = event.relatedTarget;
                        if (
                          relatedTarget instanceof Node &&
                          event.currentTarget.contains(relatedTarget)
                        ) {
                          return;
                        }
                        setDropTargetUnitId((current) => (current === unit.id ? null : current));
                      }}
                      onDragOver={(event) => handleUnitDragOver(event, unit)}
                      onDrop={(event) => {
                        setDropTargetUnitId(null);
                        if (!canMoveUnitUnderTarget(units, draggedUnitId, unit)) return;
                        event.preventDefault();
                        void moveDraggedUnit(unit);
                      }}
                    >
                      {isSelected ? (
                        <span
                          aria-hidden="true"
                          className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-sky-300"
                        />
                      ) : null}
                      <GripVertical
                        size={13}
                        className={canDrag ? 'text-[var(--color-text-muted)]' : 'opacity-25'}
                      />
                      <span
                        className={[
                          'min-w-0 flex-1 truncate',
                          isSelected ? 'font-medium text-sky-100' : 'text-[var(--color-text)]',
                        ].join(' ')}
                      >
                        {getUnitLabel(unit)}
                      </span>
                      {dropState === 'valid' ? (
                        <span className="shrink-0 rounded border border-sky-400/50 bg-sky-500/10 px-1.5 py-0 text-[9px] font-medium uppercase tracking-wide text-sky-200">
                          {t('organizations.editor.dropHere')}
                        </span>
                      ) : null}
                      <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
                        {t(getUnitKindTranslationKey(unit.kind))}
                      </Badge>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        ) : null}

        {editorMode === 'structure' ? (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text)]">
                <GitBranch size={13} />
                {t('organizations.editor.createGroup')}
              </div>
              <span className="max-w-40 truncate text-[11px] text-[var(--color-text-muted)]">
                {t('organizations.editor.underLabel', { label: fallbackParentLabel })}
              </span>
            </div>
            <Input
              className="h-8 text-xs"
              value={containerLabel}
              placeholder={t('organizations.editor.groupPlaceholder')}
              disabled={disabled}
              onChange={(event) => setContainerLabel(event.target.value)}
            />
            <Select
              value={effectiveContainerParentId}
              disabled={disabled || parentUnits.length === 0}
              onValueChange={setContainerParentId}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t('organizations.editor.createUnderPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {parentUnits.map((unit) => (
                  <SelectItem key={unit.id} value={unit.id}>
                    {getUnitLabel(unit)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-full"
              disabled={disabled || !containerLabel.trim() || !effectiveContainerParentId}
              onClick={() => void createContainer()}
            >
              <Plus size={13} />
              {t('organizations.editor.actions.addGroup')}
            </Button>
          </section>
        ) : null}

        {editorMode === 'teams' ? (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text)]">
                <Users size={13} />
                {t('organizations.editor.placeExistingTeam')}
              </div>
              <span className="max-w-40 truncate text-[11px] text-[var(--color-text-muted)]">
                {t('organizations.editor.underLabel', { label: fallbackParentLabel })}
              </span>
            </div>
            <Select
              value={teamName}
              disabled={disabled || unplacedTeams.length === 0}
              onValueChange={setTeamName}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t('organizations.editor.teamPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {unplacedTeams.map((team) => (
                  <SelectItem key={team.teamName} value={team.teamName}>
                    {team.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={effectiveTeamParentId}
              disabled={disabled || parentUnits.length === 0}
              onValueChange={setTeamParentId}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t('organizations.editor.placeUnderPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {parentUnits.map((unit) => (
                  <SelectItem key={unit.id} value={unit.id}>
                    {getUnitLabel(unit)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-full"
              disabled={disabled || !teamName || !effectiveTeamParentId}
              onClick={() => void assignTeam()}
            >
              <Plus size={13} />
              {t('organizations.editor.actions.assignTeam')}
            </Button>
          </section>
        ) : null}

        {editorMode === 'structure' && selectedUnit && selectedUnit.kind !== 'organization' ? (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text)]">
              <MoveRight size={13} />
              {t('organizations.editor.selectedItem')}
            </div>
            <div className="truncate text-xs text-[var(--color-text-muted)]">
              {selectedUnit ? getUnitLabel(selectedUnit) : t('organizations.editor.rootSelected')}
            </div>
            <Select
              value={effectiveMoveParentId}
              disabled={disabled}
              onValueChange={setMoveParentId}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t('organizations.editor.moveUnderPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {parentUnits
                  .filter((unit) => unit.id !== selectedUnit?.id)
                  .map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {getUnitLabel(unit)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={disabled || !effectiveMoveParentId}
                onClick={() => void moveSelected()}
              >
                <MoveRight size={13} />
                {t('organizations.editor.actions.move')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={disabled}
                onClick={() => void removeSelected()}
              >
                <Trash2 size={13} />
                {t('organizations.editor.actions.remove')}
              </Button>
            </div>
          </section>
        ) : null}

        {editorMode === 'relations' ? (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text)]">
              <Link2 size={13} />
              {t('organizations.editor.manualRelation')}
            </div>
            <Select
              value={relationSourceId}
              disabled={disabled || relationUnits.length < 2}
              onValueChange={setRelationSourceId}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t('organizations.editor.sourcePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {relationUnits.map((unit) => (
                  <SelectItem key={unit.id} value={getUnitTeamName(unit) ?? unit.id}>
                    {getUnitLabel(unit)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={relationTargetId}
              disabled={disabled || relationUnits.length < 2}
              onValueChange={setRelationTargetId}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t('organizations.editor.targetPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {relationUnits.map((unit) => (
                  <SelectItem key={unit.id} value={getUnitTeamName(unit) ?? unit.id}>
                    {getUnitLabel(unit)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={relationKind}
              disabled={disabled}
              onValueChange={(value) => setRelationKind(value as OrganizationRelationKind)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t('organizations.editor.kindPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {RELATION_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(getRelationKindTranslationKey(kind))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-full"
              disabled={
                disabled ||
                !relationSourceId ||
                !relationTargetId ||
                relationSourceId === relationTargetId
              }
              onClick={() => void createRelation()}
            >
              <Link2 size={13} />
              {t('organizations.editor.actions.addRelation')}
            </Button>

            {manualRelations.length > 0 ? (
              <div className="space-y-1 pt-2">
                {manualRelations.map((relation) => (
                  <div
                    key={
                      relation.id ??
                      `${relation.kind}:${relation.sourceNodeId}:${relation.targetNodeId}`
                    }
                    className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] py-2"
                  >
                    <div className="min-w-0 text-[11px] text-[var(--color-text-muted)]">
                      <div className="truncate text-[var(--color-text)]">
                        {t(getRelationKindTranslationKey(relation.kind))}
                      </div>
                      <div className="truncate">
                        {relation.sourceNodeId}
                        {' -> '}
                        {relation.targetNodeId}
                      </div>
                    </div>
                    {relation.id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="size-7 p-0"
                        disabled={saving}
                        onClick={() =>
                          void onDeleteRelation({
                            organizationId: relation.organizationId,
                            relationId: relation.id!,
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
};
