import type {
  OrganizationStructurePayload,
  OrganizationStructureUnitDto,
} from '@features/organizations/contracts';

export interface OrganizationPlacementUnitOption {
  unit: OrganizationStructureUnitDto;
  depth: number;
}

function getOrganizationUnitLabel(unit: OrganizationStructureUnitDto): string {
  return unit.title ? `${unit.label} - ${unit.title}` : unit.label;
}

function compareOrganizationPlacementUnits(
  left: OrganizationStructureUnitDto,
  right: OrganizationStructureUnitDto
): number {
  if (left.kind === 'organization' && right.kind !== 'organization') return -1;
  if (right.kind === 'organization' && left.kind !== 'organization') return 1;
  return getOrganizationUnitLabel(left).localeCompare(getOrganizationUnitLabel(right));
}

export function getOrganizationPlacementUnitOptions(
  structure: OrganizationStructurePayload | null,
  organizationId: string
): OrganizationPlacementUnitOption[] {
  if (!structure) return [];
  const units = structure.units.filter(
    (unit) => unit.organizationId === organizationId && unit.kind !== 'team'
  );
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const organizationRootId =
    structure.organizations.find((organization) => organization.id === organizationId)
      ?.rootNodeId ?? null;
  const rootUnit =
    (organizationRootId ? unitById.get(organizationRootId) : undefined) ??
    units.find((unit) => unit.kind === 'organization') ??
    null;
  const childrenByParentId = new Map<string | null, OrganizationStructureUnitDto[]>();

  for (const unit of units) {
    const parentId =
      unit.parentId && unitById.has(unit.parentId)
        ? unit.parentId
        : unit.kind !== 'organization' && rootUnit && unit.id !== rootUnit.id
          ? rootUnit.id
          : null;
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(unit);
    childrenByParentId.set(parentId, children);
  }
  for (const children of childrenByParentId.values()) {
    children.sort(compareOrganizationPlacementUnits);
  }

  const ordered: OrganizationPlacementUnitOption[] = [];
  const visited = new Set<string>();
  const visit = (unit: OrganizationStructureUnitDto, depth: number): void => {
    if (visited.has(unit.id)) return;
    visited.add(unit.id);
    ordered.push({ unit, depth });
    for (const child of childrenByParentId.get(unit.id) ?? []) visit(child, depth + 1);
  };
  for (const root of childrenByParentId.get(null) ?? []) visit(root, 0);
  for (const unit of units.sort(compareOrganizationPlacementUnits)) visit(unit, 0);
  return ordered;
}

export { getOrganizationUnitLabel };

export function getOrganizationPlacementUnitKindKey(
  unit: OrganizationStructureUnitDto
): 'create.organizationPlacement.kind.root' | 'create.organizationPlacement.kind.group' {
  return unit.kind === 'organization'
    ? 'create.organizationPlacement.kind.root'
    : 'create.organizationPlacement.kind.group';
}
