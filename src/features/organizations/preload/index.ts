import {
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
  type OrganizationsElectronApi,
} from '../contracts';

import type { IpcRenderer } from 'electron';

export function createOrganizationsBridge(ipcRenderer: IpcRenderer): OrganizationsElectronApi {
  return {
    getOrganizationMap: (request) => ipcRenderer.invoke(ORGANIZATIONS_GET_MAP, request),
    getOrganizationStructure: (request) =>
      ipcRenderer.invoke(ORGANIZATIONS_GET_STRUCTURE, request),
    createOrganization: (request) =>
      ipcRenderer.invoke(ORGANIZATIONS_CREATE_ORGANIZATION, request),
    upsertOrganizationUnit: (request) => ipcRenderer.invoke(ORGANIZATIONS_UPSERT_UNIT, request),
    moveOrganizationUnit: (request) => ipcRenderer.invoke(ORGANIZATIONS_MOVE_UNIT, request),
    removeOrganizationUnit: (request) => ipcRenderer.invoke(ORGANIZATIONS_REMOVE_UNIT, request),
    assignTeamToUnit: (request) => ipcRenderer.invoke(ORGANIZATIONS_ASSIGN_TEAM, request),
    removeTeamFromOrganization: (request) => ipcRenderer.invoke(ORGANIZATIONS_REMOVE_TEAM, request),
    upsertOrganizationRelation: (request) =>
      ipcRenderer.invoke(ORGANIZATIONS_UPSERT_RELATION, request),
    deleteOrganizationRelation: (request) =>
      ipcRenderer.invoke(ORGANIZATIONS_DELETE_RELATION, request),
  };
}
