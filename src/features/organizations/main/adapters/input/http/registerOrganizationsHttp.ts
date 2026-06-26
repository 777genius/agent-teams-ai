import { createLogger } from '@shared/utils/logger';

import {
  normalizeAssignOrganizationTeamRequest,
  normalizeCreateOrganizationRequest,
  normalizeDeleteOrganizationRelationRequest,
  normalizeMoveOrganizationUnitRequest,
  normalizeOrganizationMapPayload,
  normalizeOrganizationMapRequest,
  normalizeOrganizationStructurePayload,
  normalizeRemoveOrganizationTeamRequest,
  normalizeRemoveOrganizationUnitRequest,
  normalizeUpsertOrganizationRelationRequest,
  normalizeUpsertOrganizationUnitRequest,
  type OrganizationMapPayload,
  ORGANIZATIONS_MAP_ROUTE,
  ORGANIZATIONS_ORGANIZATIONS_ROUTE,
  ORGANIZATIONS_RELATIONS_ROUTE,
  ORGANIZATIONS_STRUCTURE_ROUTE,
  ORGANIZATIONS_TEAM_ASSIGNMENT_ROUTE,
  ORGANIZATIONS_UNIT_MOVE_ROUTE,
  ORGANIZATIONS_UNITS_ROUTE,
  type OrganizationStructurePayload,
} from '../../../../contracts';

import type { OrganizationsFeatureFacade } from '../../../composition/createOrganizationsFeature';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('Feature:Organizations:HTTP');

export function registerOrganizationsHttp(
  app: FastifyInstance,
  feature: OrganizationsFeatureFacade
): void {
  app.get(ORGANIZATIONS_MAP_ROUTE, async (request): Promise<OrganizationMapPayload> => {
    const startedAt = Date.now();
    try {
      const payload =
        normalizeOrganizationMapPayload(
          await feature.getOrganizationMap(normalizeOrganizationMapRequest(request.query))
        ) ??
        normalizeOrganizationMapPayload(
          await feature.getOrganizationMap(normalizeOrganizationMapRequest(undefined))
        );
      if (!payload) {
        throw new Error('Organization map HTTP returned an invalid map payload.');
      }
      logger.info('organization map HTTP loaded', {
        nodes: payload.nodes.length,
        relations: payload.relations.length,
        degraded: payload.degraded,
        durationMs: Date.now() - startedAt,
      });
      return payload;
    } catch (error) {
      logger.error('Failed to load organization map via HTTP', error);
      const generatedAt = new Date().toISOString();
      return {
        scope: 'organization',
        organizations: [
          {
            id: 'default',
            name: 'All Teams',
            rootNodeId: 'org:default',
            updatedAt: generatedAt,
          },
        ],
        activeOrganizationId: 'default',
        rootNodeId: 'org:default',
        nodes: [],
        relations: [],
        degraded: true,
        diagnostics: {
          totalTeams: 0,
          renderedTeams: 0,
          totalCrossTeamMessages: 0,
          renderedCrossTeamRelations: 0,
          truncatedTeams: 0,
          truncatedCrossTeamMessages: 0,
          generatedAt,
          warnings: ['Failed to load organization map.'],
        },
      };
    }
  });

  const loadStructure = async (
    action: string,
    handler: () => Promise<OrganizationStructurePayload>
  ): Promise<OrganizationStructurePayload> => {
    const startedAt = Date.now();
    const payload = normalizeOrganizationStructurePayload(await handler());
    if (!payload) {
      throw new Error(`Organization ${action} returned an invalid structure payload.`);
    }
    logger.info(`organization ${action} HTTP completed`, {
      organizations: payload.organizations.length,
      units: payload.units.length,
      relations: payload.relations.length,
      durationMs: Date.now() - startedAt,
    });
    return payload;
  };

  app.get(ORGANIZATIONS_STRUCTURE_ROUTE, async (request): Promise<OrganizationStructurePayload> =>
    loadStructure('get structure', () =>
      feature.getOrganizationStructure(normalizeOrganizationMapRequest(request.query))
    )
  );
  app.post(ORGANIZATIONS_ORGANIZATIONS_ROUTE, async (request): Promise<OrganizationStructurePayload> =>
    loadStructure('create organization', () =>
      feature.createOrganization(normalizeCreateOrganizationRequest(request.body))
    )
  );
  app.put(ORGANIZATIONS_UNITS_ROUTE, async (request): Promise<OrganizationStructurePayload> =>
    loadStructure('upsert unit', () =>
      feature.upsertOrganizationUnit(normalizeUpsertOrganizationUnitRequest(request.body))
    )
  );
  app.put(ORGANIZATIONS_UNIT_MOVE_ROUTE, async (request): Promise<OrganizationStructurePayload> =>
    loadStructure('move unit', () =>
      feature.moveOrganizationUnit(normalizeMoveOrganizationUnitRequest(request.body))
    )
  );
  app.delete(ORGANIZATIONS_UNITS_ROUTE, async (request): Promise<OrganizationStructurePayload> =>
    loadStructure('remove unit', () =>
      feature.removeOrganizationUnit(normalizeRemoveOrganizationUnitRequest(request.body))
    )
  );
  app.put(
    ORGANIZATIONS_TEAM_ASSIGNMENT_ROUTE,
    async (request): Promise<OrganizationStructurePayload> =>
      loadStructure('assign team', () =>
        feature.assignTeamToUnit(normalizeAssignOrganizationTeamRequest(request.body))
      )
  );
  app.delete(
    ORGANIZATIONS_TEAM_ASSIGNMENT_ROUTE,
    async (request): Promise<OrganizationStructurePayload> =>
      loadStructure('remove team', () =>
        feature.removeTeamFromOrganization(normalizeRemoveOrganizationTeamRequest(request.body))
      )
  );
  app.put(ORGANIZATIONS_RELATIONS_ROUTE, async (request): Promise<OrganizationStructurePayload> =>
    loadStructure('upsert relation', () =>
      feature.upsertOrganizationRelation(normalizeUpsertOrganizationRelationRequest(request.body))
    )
  );
  app.delete(ORGANIZATIONS_RELATIONS_ROUTE, async (request): Promise<OrganizationStructurePayload> =>
    loadStructure('delete relation', () =>
      feature.deleteOrganizationRelation(normalizeDeleteOrganizationRelationRequest(request.body))
    )
  );
}
