import {
  SKILLS_APPLY_IMPORT,
  SKILLS_APPLY_UPSERT,
  SKILLS_DELETE,
  SKILLS_GET_DETAIL,
  SKILLS_LIST,
  SKILLS_PREVIEW_IMPORT,
  SKILLS_PREVIEW_UPSERT,
  SKILLS_START_WATCHING,
  SKILLS_STOP_WATCHING,
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

import type { SkillsCatalogService } from '../services/extensions/skills/SkillsCatalogService';
import type { SkillsMutationService } from '../services/extensions/skills/SkillsMutationService';
import type { SkillsWatcherService } from '../services/extensions/skills/SkillsWatcherService';
import type {
  SkillCatalogItem,
  SkillDeleteRequest,
  SkillDetail,
  SkillImportRequest,
  SkillReviewPreview,
  SkillUpsertRequest,
} from '@shared/types/extensions';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:skills');

let skillsCatalogService: SkillsCatalogService | null = null;
let skillsMutationService: SkillsMutationService | null = null;
let skillsWatcherService: SkillsWatcherService | null = null;

export function initializeSkillsHandlers(
  skillsCatalog?: SkillsCatalogService,
  skillsMutations?: SkillsMutationService,
  skillsWatcher?: SkillsWatcherService
): void {
  skillsCatalogService = skillsCatalog ?? null;
  skillsMutationService = skillsMutations ?? null;
  skillsWatcherService = skillsWatcher ?? null;
}

export function registerSkillsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(SKILLS_LIST, handleSkillsList);
  ipcMain.handle(SKILLS_GET_DETAIL, handleSkillsGetDetail);
  ipcMain.handle(SKILLS_PREVIEW_UPSERT, handleSkillsPreviewUpsert);
  ipcMain.handle(SKILLS_APPLY_UPSERT, handleSkillsApplyUpsert);
  ipcMain.handle(SKILLS_PREVIEW_IMPORT, handleSkillsPreviewImport);
  ipcMain.handle(SKILLS_APPLY_IMPORT, handleSkillsApplyImport);
  ipcMain.handle(SKILLS_DELETE, handleSkillsDelete);
  ipcMain.handle(SKILLS_START_WATCHING, handleSkillsStartWatching);
  ipcMain.handle(SKILLS_STOP_WATCHING, handleSkillsStopWatching);
}

export function removeSkillsHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(SKILLS_LIST);
  ipcMain.removeHandler(SKILLS_GET_DETAIL);
  ipcMain.removeHandler(SKILLS_PREVIEW_UPSERT);
  ipcMain.removeHandler(SKILLS_APPLY_UPSERT);
  ipcMain.removeHandler(SKILLS_PREVIEW_IMPORT);
  ipcMain.removeHandler(SKILLS_APPLY_IMPORT);
  ipcMain.removeHandler(SKILLS_DELETE);
  ipcMain.removeHandler(SKILLS_START_WATCHING);
  ipcMain.removeHandler(SKILLS_STOP_WATCHING);
}

interface IpcResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function wrapHandler<T>(name: string, fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (error) {
    logger.error(`${name} failed`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : `Unknown error in ${name}`,
    };
  }
}

function getSkillsCatalogService(): SkillsCatalogService {
  if (!skillsCatalogService) {
    throw new Error('Skills catalog service is not initialized');
  }
  return skillsCatalogService;
}

function getSkillsMutationService(): SkillsMutationService {
  if (!skillsMutationService) {
    throw new Error('Skills mutation service is not initialized');
  }
  return skillsMutationService;
}

function getSkillsWatcherService(): SkillsWatcherService {
  if (!skillsWatcherService) {
    throw new Error('Skills watcher service is not initialized');
  }
  return skillsWatcherService;
}

async function handleSkillsList(
  _event: IpcMainInvokeEvent,
  projectPath?: string
): Promise<IpcResult<SkillCatalogItem[]>> {
  return wrapHandler('skillsList', () =>
    getSkillsCatalogService().list(typeof projectPath === 'string' ? projectPath : undefined)
  );
}

async function handleSkillsGetDetail(
  _event: IpcMainInvokeEvent,
  skillId?: string,
  projectPath?: string
): Promise<IpcResult<SkillDetail | null>> {
  return wrapHandler('skillsGetDetail', () => {
    if (typeof skillId !== 'string' || !skillId) {
      throw new Error('skillId is required');
    }
    return getSkillsCatalogService().getDetail(
      skillId,
      typeof projectPath === 'string' ? projectPath : undefined
    );
  });
}

async function handleSkillsPreviewUpsert(
  _event: IpcMainInvokeEvent,
  request?: SkillUpsertRequest
): Promise<IpcResult<SkillReviewPreview>> {
  return wrapHandler('skillsPreviewUpsert', () => {
    if (!request) throw new Error('request is required');
    return getSkillsMutationService().previewUpsert(request);
  });
}

async function handleSkillsApplyUpsert(
  _event: IpcMainInvokeEvent,
  request?: SkillUpsertRequest
): Promise<IpcResult<SkillDetail | null>> {
  return wrapHandler('skillsApplyUpsert', () => {
    if (!request) throw new Error('request is required');
    return getSkillsMutationService().applyUpsert(request);
  });
}

async function handleSkillsPreviewImport(
  _event: IpcMainInvokeEvent,
  request?: SkillImportRequest
): Promise<IpcResult<SkillReviewPreview>> {
  return wrapHandler('skillsPreviewImport', () => {
    if (!request) throw new Error('request is required');
    return getSkillsMutationService().previewImport(request);
  });
}

async function handleSkillsApplyImport(
  _event: IpcMainInvokeEvent,
  request?: SkillImportRequest
): Promise<IpcResult<SkillDetail | null>> {
  return wrapHandler('skillsApplyImport', () => {
    if (!request) throw new Error('request is required');
    return getSkillsMutationService().applyImport(request);
  });
}

async function handleSkillsDelete(
  _event: IpcMainInvokeEvent,
  request?: SkillDeleteRequest
): Promise<IpcResult<void>> {
  return wrapHandler('skillsDelete', () => {
    if (!request) throw new Error('request is required');
    return getSkillsMutationService().deleteSkill(request);
  });
}

async function handleSkillsStartWatching(
  _event: IpcMainInvokeEvent,
  projectPath?: string
): Promise<IpcResult<string>> {
  return wrapHandler('skillsStartWatching', () =>
    getSkillsWatcherService().start(typeof projectPath === 'string' ? projectPath : undefined)
  );
}

async function handleSkillsStopWatching(
  _event: IpcMainInvokeEvent,
  watchId?: string
): Promise<IpcResult<void>> {
  return wrapHandler('skillsStopWatching', () => {
    if (typeof watchId !== 'string' || !watchId) {
      throw new Error('watchId is required');
    }
    return getSkillsWatcherService().stop(watchId);
  });
}
