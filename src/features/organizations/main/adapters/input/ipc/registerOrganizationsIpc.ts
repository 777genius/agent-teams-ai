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
  ORGANIZATIONS_ASSIGN_TEAM,
  ORGANIZATIONS_CREATE_ORGANIZATION,
  ORGANIZATIONS_DELETE_RELATION,
  ORGANIZATIONS_GET_MAP,
  ORGANIZATIONS_GET_STRUCTURE,
  ORGANIZATIONS_MOVE_UNIT,
  ORGANIZATIONS_REMOVE_TEAM,
  ORGANIZATIONS_REMOVE_UNIT,
  ORGANIZATIONS_UPSERT_RELATION,
  ORGANIZATIONS_UPSERT_UNIT,
} from '../../../../contracts';

import type { OrganizationStructurePayload } from '../../../../contracts';
import type { OrganizationsFeatureFacade } from '../../../composition/createOrganizationsFeature';
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:Organizations:IPC');

export function registerOrganizationsIpc(
  ipcMain: IpcMain,
  feature: OrganizationsFeatureFacade
): void {
  ipcMain.handle(ORGANIZATIONS_GET_MAP, async (_event, rawRequest: unknown) => {
    const startedAt = Date.now();
    try {
      const payload = normalizeOrganizationMapPayload(
        await feature.getOrganizationMap(normalizeOrganizationMapRequest(rawRequest))
      );
      if (!payload) {
        throw new Error('Organization map IPC returned an invalid map payload.');
      }
      logger.info('organization map IPC loaded', {
        nodes: payload.nodes.length,
        relations: payload.relations.length,
        degraded: payload.degraded,
        durationMs: Date.now() - startedAt,
      });
      return payload;
    } catch (error) {
      logger.error('Failed to load organization map via IPC', error);
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
    logger.info(`organization ${action} IPC completed`, {
      organizations: payload.organizations.length,
      units: payload.units.length,
      relations: payload.relations.length,
      durationMs: Date.now() - startedAt,
    });
    return payload;
  };

  ipcMain.handle(ORGANIZATIONS_GET_STRUCTURE, async (_event, rawRequest: unknown) =>
    loadStructure('get structure', () =>
      feature.getOrganizationStructure(normalizeOrganizationMapRequest(rawRequest))
    )
  );
  ipcMain.handle(ORGANIZATIONS_CREATE_ORGANIZATION, async (_event, rawRequest: unknown) =>
    loadStructure('create organization', () =>
      feature.createOrganization(normalizeCreateOrganizationRequest(rawRequest))
    )
  );
  ipcMain.handle(ORGANIZATIONS_UPSERT_UNIT, async (_event, rawRequest: unknown) =>
    loadStructure('upsert unit', () =>
      feature.upsertOrganizationUnit(normalizeUpsertOrganizationUnitRequest(rawRequest))
    )
  );
  ipcMain.handle(ORGANIZATIONS_MOVE_UNIT, async (_event, rawRequest: unknown) =>
    loadStructure('move unit', () =>
      feature.moveOrganizationUnit(normalizeMoveOrganizationUnitRequest(rawRequest))
    )
  );
  ipcMain.handle(ORGANIZATIONS_REMOVE_UNIT, async (_event, rawRequest: unknown) =>
    loadStructure('remove unit', () =>
      feature.removeOrganizationUnit(normalizeRemoveOrganizationUnitRequest(rawRequest))
    )
  );
  ipcMain.handle(ORGANIZATIONS_ASSIGN_TEAM, async (_event, rawRequest: unknown) =>
    loadStructure('assign team', () =>
      feature.assignTeamToUnit(normalizeAssignOrganizationTeamRequest(rawRequest))
    )
  );
  ipcMain.handle(ORGANIZATIONS_REMOVE_TEAM, async (_event, rawRequest: unknown) =>
    loadStructure('remove team', () =>
      feature.removeTeamFromOrganization(normalizeRemoveOrganizationTeamRequest(rawRequest))
    )
  );
  ipcMain.handle(ORGANIZATIONS_UPSERT_RELATION, async (_event, rawRequest: unknown) =>
    loadStructure('upsert relation', () =>
      feature.upsertOrganizationRelation(normalizeUpsertOrganizationRelationRequest(rawRequest))
    )
  );
  ipcMain.handle(ORGANIZATIONS_DELETE_RELATION, async (_event, rawRequest: unknown) =>
    loadStructure('delete relation', () =>
      feature.deleteOrganizationRelation(normalizeDeleteOrganizationRelationRequest(rawRequest))
    )
  );
}

export function removeOrganizationsIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(ORGANIZATIONS_GET_MAP);
  ipcMain.removeHandler(ORGANIZATIONS_GET_STRUCTURE);
  ipcMain.removeHandler(ORGANIZATIONS_CREATE_ORGANIZATION);
  ipcMain.removeHandler(ORGANIZATIONS_UPSERT_UNIT);
  ipcMain.removeHandler(ORGANIZATIONS_MOVE_UNIT);
  ipcMain.removeHandler(ORGANIZATIONS_REMOVE_UNIT);
  ipcMain.removeHandler(ORGANIZATIONS_ASSIGN_TEAM);
  ipcMain.removeHandler(ORGANIZATIONS_REMOVE_TEAM);
  ipcMain.removeHandler(ORGANIZATIONS_UPSERT_RELATION);
  ipcMain.removeHandler(ORGANIZATIONS_DELETE_RELATION);
}
