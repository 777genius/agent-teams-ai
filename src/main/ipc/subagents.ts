/**
 * IPC Handlers for Subagent Operations.
 *
 * Handlers:
 * - get-subagent-detail: Get detailed information for a specific subagent
 */

import { createLogger } from '@shared/utils/logger';
import { type IpcMain, type IpcMainInvokeEvent } from 'electron';

import { type SubagentDetail } from '../types';

import { validateProjectId, validateSessionId, validateSubagentId } from './guards';

import type { ServiceContextRegistry } from '../services';

const logger = createLogger('IPC:subagents');

// Service registry - set via initialize
let registry: ServiceContextRegistry;

/**
 * Initializes subagent handlers with service registry.
 */
export function initializeSubagentHandlers(contextRegistry: ServiceContextRegistry): void {
  registry = contextRegistry;
}

/**
 * Registers all subagent-related IPC handlers.
 */
export function registerSubagentHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('get-subagent-detail', handleGetSubagentDetail);

  logger.info('Subagent handlers registered');
}

/**
 * Removes all subagent IPC handlers.
 */
export function removeSubagentHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler('get-subagent-detail');

  logger.info('Subagent handlers removed');
}

// =============================================================================
// Handler Implementations
// =============================================================================

/**
 * Handler for 'get-subagent-detail' IPC call.
 * Gets detailed information for a specific subagent for drill-down modal.
 */
async function handleGetSubagentDetail(
  _event: IpcMainInvokeEvent,
  projectId: string,
  sessionId: string,
  subagentId: string,
  options?: { bypassCache?: boolean }
): Promise<SubagentDetail | null> {
  try {
    const validatedProject = validateProjectId(projectId);
    const validatedSession = validateSessionId(sessionId);
    const validatedSubagent = validateSubagentId(subagentId);
    if (!validatedProject.valid || !validatedSession.valid || !validatedSubagent.valid) {
      logger.error(
        `get-subagent-detail rejected: ${
          validatedProject.error ??
          validatedSession.error ??
          validatedSubagent.error ??
          'Invalid parameters'
        }`
      );
      return null;
    }
    const safeProjectId = validatedProject.value!;
    const safeSessionId = validatedSession.value!;
    const safeSubagentId = validatedSubagent.value!;

    const { chunkBuilder, sessionParser, subagentResolver, projectScanner, dataCache } =
      registry.getActive();

    const cacheKey = `subagent-${safeProjectId}-${safeSessionId}-${safeSubagentId}`;

    // Check cache first
    let subagentDetail = dataCache.getSubagent(cacheKey);

    if (subagentDetail && !options?.bypassCache) {
      return subagentDetail;
    }

    // Get provider and projectsDir from projectScanner
    const fsProvider = projectScanner.getFileSystemProvider();
    const projectsDir = projectScanner.getProjectsDir();

    // Build subagent detail
    const builtDetail = await chunkBuilder.buildSubagentDetail(
      safeProjectId,
      safeSessionId,
      safeSubagentId,
      sessionParser,
      subagentResolver,
      fsProvider,
      projectsDir
    );

    if (!builtDetail) {
      logger.error(`Subagent not found: ${safeSubagentId}`);
      return null;
    }

    subagentDetail = builtDetail;

    // Cache the result
    dataCache.setSubagent(cacheKey, subagentDetail);

    return subagentDetail;
  } catch (error) {
    logger.error(`Error in get-subagent-detail for ${subagentId}:`, error);
    return null;
  }
}
