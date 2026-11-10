import type {
  AssignOrganizationTeamRequest,
  CreateOrganizationRequest,
  DeleteOrganizationRelationRequest,
  MoveOrganizationUnitRequest,
  OrganizationMapPayload,
  OrganizationMapRequest,
  OrganizationStructurePayload,
  RemoveOrganizationTeamRequest,
  RemoveOrganizationUnitRequest,
  UpsertOrganizationRelationRequest,
  UpsertOrganizationUnitRequest,
} from './dto';

export interface OrganizationsElectronApi {
  getOrganizationMap(request?: OrganizationMapRequest): Promise<OrganizationMapPayload>;
  getOrganizationStructure(request?: OrganizationMapRequest): Promise<OrganizationStructurePayload>;
  createOrganization(request: CreateOrganizationRequest): Promise<OrganizationStructurePayload>;
  upsertOrganizationUnit(request: UpsertOrganizationUnitRequest): Promise<OrganizationStructurePayload>;
  moveOrganizationUnit(request: MoveOrganizationUnitRequest): Promise<OrganizationStructurePayload>;
  removeOrganizationUnit(request: RemoveOrganizationUnitRequest): Promise<OrganizationStructurePayload>;
  assignTeamToUnit(request: AssignOrganizationTeamRequest): Promise<OrganizationStructurePayload>;
  removeTeamFromOrganization(
    request: RemoveOrganizationTeamRequest
  ): Promise<OrganizationStructurePayload>;
  upsertOrganizationRelation(
    request: UpsertOrganizationRelationRequest
  ): Promise<OrganizationStructurePayload>;
  deleteOrganizationRelation(
    request: DeleteOrganizationRelationRequest
  ): Promise<OrganizationStructurePayload>;
}
