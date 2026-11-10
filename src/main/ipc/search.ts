/**
 * IPC Handlers for Search Operations.
 *
 * Handlers:
 * - search-sessions: Search sessions in a project
 */

import { createLogger } from '@shared/utils/logger';
import { type IpcMain, type IpcMainInvokeEvent } from 'electron';

import { type SearchSessionsResult } from '../types';

import { coerceSearchMaxResults, validateProjectId, validateSearchQuery } from './guards';

const logger = createLogger('IPC:search');

import type { ServiceContextRegistry } from '../services';

// Service registry - set via initialize
let registry: ServiceContextRegistry;

/**
 * Initializes search handlers with service registry.
 */
export function initializeSearchHandlers(contextRegistry: ServiceContextRegistry): void {
  registry = contextRegistry;
}

/**
 * Registers all search-related IPC handlers.
 */
export function registerSearchHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('search-sessions', handleSearchSessions);
  ipcMain.handle('search-all-projects', handleSearchAllProjects);

  logger.info('Search handlers registered');
}

/**
 * Removes all search IPC handlers.
 */
export function removeSearchHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler('search-sessions');
  ipcMain.removeHandler('search-all-projects');

  logger.info('Search handlers removed');
}

// =============================================================================
// Handler Implementations
// =============================================================================

/**
 * Handler for 'search-sessions' IPC call.
 * Searches sessions in a project for a query string.
 */
async function handleSearchSessions(
  _event: IpcMainInvokeEvent,
  projectId: string,
  query: string,
  maxResults?: number
): Promise<SearchSessionsResult> {
  try {
    const validatedProject = validateProjectId(projectId);
    const validatedQuery = validateSearchQuery(query);
    if (!validatedProject.valid || !validatedQuery.valid) {
      logger.error(
        `search-sessions rejected: ${validatedProject.error ?? validatedQuery.error ?? 'Invalid inputs'}`
      );
      return { results: [], totalMatches: 0, sessionsSearched: 0, query };
    }

    const { projectScanner } = registry.getActive();
    const safeMaxResults = coerceSearchMaxResults(maxResults, 50);
    const result = await projectScanner.searchSessions(
      validatedProject.value!,
      validatedQuery.value!,
      safeMaxResults
    );
    return result;
  } catch (error) {
    logger.error(`Error in search-sessions for project ${projectId}:`, error);
    return { results: [], totalMatches: 0, sessionsSearched: 0, query };
  }
}

/**
 * Handler for 'search-all-projects' IPC call.
 * Searches sessions across all projects for a query string.
 */
async function handleSearchAllProjects(
  _event: IpcMainInvokeEvent,
  query: string,
  maxResults?: number
): Promise<SearchSessionsResult> {
  try {
    const validatedQuery = validateSearchQuery(query);
    if (!validatedQuery.valid) {
      logger.error(`search-all-projects rejected: ${validatedQuery.error ?? 'Invalid query'}`);
      return { results: [], totalMatches: 0, sessionsSearched: 0, query };
    }

    const { projectScanner } = registry.getActive();
    const safeMaxResults = coerceSearchMaxResults(maxResults, 50);
    const result = await projectScanner.searchAllProjects(validatedQuery.value!, safeMaxResults);
    return result;
  } catch (error) {
    logger.error('Error in search-all-projects:', error);
    return { results: [], totalMatches: 0, sessionsSearched: 0, query };
  }
}
