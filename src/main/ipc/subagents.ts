/**
 * IPC Handlers for Subagent Operations.
 *
 * Handlers:
 * - get-subagent-detail: Get detailed information for a specific subagent
 */

import { DetailReadAdapterLifetime, readSubagentDetail } from '@features/member-log-reads/main';
import { createLogger } from '@shared/utils/logger';
import { type IpcMain, type IpcMainInvokeEvent } from 'electron';

import { type SubagentDetail } from '../types';

import { normalizeDetailReadOptions } from './detailReadOptions';
import { validateProjectId, validateSessionId, validateSubagentId } from './guards';

import type { ServiceContextRegistry } from '../services';

const logger = createLogger('IPC:subagents');

// Service registry - set via initialize
let registry: ServiceContextRegistry;
let adapter: DetailReadAdapterLifetime | undefined;

/**
 * Initializes subagent handlers with service registry.
 */
export function initializeSubagentHandlers(contextRegistry: ServiceContextRegistry): void {
  adapter?.retire();
  registry = contextRegistry;
  adapter = new DetailReadAdapterLifetime();
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
  adapter?.retire();
  adapter = undefined;
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
    const detailOptions = normalizeDetailReadOptions(options);
    const lifetime = adapter;
    if (
      !validatedProject.valid ||
      !validatedSession.valid ||
      !validatedSubagent.valid ||
      !detailOptions ||
      !lifetime
    ) {
      return null;
    }
    const context = registry.getActive();
    return await readSubagentDetail(
      context,
      lifetime,
      validatedProject.value!,
      validatedSession.value!,
      validatedSubagent.value!,
      detailOptions.bypassCache
    );
  } catch (error) {
    logger.error(`Error in get-subagent-detail for ${subagentId}:`, error);
    return null;
  }
}
