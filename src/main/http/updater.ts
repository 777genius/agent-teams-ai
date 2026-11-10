/**
 * HTTP route handlers for Update Operations.
 *
 * Routes:
 * - POST /api/updater/check - Check for updates
 * - POST /api/updater/download - Download update
 * - POST /api/updater/install - Install update
 */

import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import type { HttpServices } from './index';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:updater');

export function registerUpdaterRoutes(app: FastifyInstance, services: HttpServices): void {
  app.post('/api/updater/check', async () => {
    try {
      await services.updaterService.checkForUpdates();
      return { success: true };
    } catch (error) {
      logger.error('Error in POST /api/updater/check:', getErrorMessage(error));
      return { success: false, error: getErrorMessage(error) };
    }
  });

  app.post('/api/updater/download', async () => {
    try {
      await services.updaterService.downloadUpdate();
      return { success: true };
    } catch (error) {
      logger.error('Error in POST /api/updater/download:', getErrorMessage(error));
      return { success: false, error: getErrorMessage(error) };
    }
  });

  app.post('/api/updater/install', async () => {
    try {
      await services.updaterService.quitAndInstall();
      return { success: true };
    } catch (error) {
      logger.error('Error in POST /api/updater/install:', getErrorMessage(error));
      return { success: false, error: getErrorMessage(error) };
    }
  });
}
