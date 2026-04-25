/**
 * HTTP route handlers for Validation Operations.
 *
 * Routes:
 * - POST /api/validate/path - Validate file/directory path
 * - POST /api/validate/mentions - Batch validate path mentions
 * - POST /api/session/scroll-to-line - Deep link scroll handler
 */

import { createLogger } from '@shared/utils/logger';
import * as fsp from 'fs/promises';
import * as path from 'path';

import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:validation');

/**
 * Checks if a path is contained within a base directory.
 * Prevents path traversal attacks.
 */
function isPathContained(fullPath: string, basePath: string): boolean {
  const normalizedFull = normalizeForContainment(fullPath);
  const normalizedBase = normalizeForContainment(basePath);
  return normalizedFull === normalizedBase || normalizedFull.startsWith(normalizedBase + path.sep);
}

function normalizeForContainment(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveProjectPath(projectPath: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath) ? requestedPath : path.join(projectPath, requestedPath);
}

export function registerValidationRoutes(app: FastifyInstance): void {
  // Validate path
  app.post<{ Body: { relativePath: string; projectPath: string } }>(
    '/api/validate/path',
    async (request) => {
      try {
        const { relativePath, projectPath } = request.body;
        const fullPath = resolveProjectPath(projectPath, relativePath);

        if (!isPathContained(fullPath, projectPath)) {
          logger.warn('validate-path blocked path traversal attempt:', relativePath);
          return { exists: false };
        }

        // Single async stat — no TOCTOU, doesn't block the main thread
        const stats = await fsp.stat(fullPath);
        return { exists: true, isDirectory: stats.isDirectory() };
      } catch {
        return { exists: false };
      }
    }
  );

  // Validate mentions
  app.post<{ Body: { mentions: { type: 'path'; value: string }[]; projectPath: string } }>(
    '/api/validate/mentions',
    async (request) => {
      const { mentions, projectPath } = request.body;

      // Validate all mentions in parallel with async I/O
      const entries = await Promise.all(
        mentions.map(async (mention) => {
          const fullPath = resolveProjectPath(projectPath, mention.value);
          if (!isPathContained(fullPath, projectPath)) {
            return [`@${mention.value}`, false] as const;
          }
          try {
            await fsp.access(fullPath);
            return [`@${mention.value}`, true] as const;
          } catch {
            return [`@${mention.value}`, false] as const;
          }
        })
      );

      return Object.fromEntries(entries);
    }
  );

  // Scroll to line
  app.post<{ Body: { sessionId: string; lineNumber: number } }>(
    '/api/session/scroll-to-line',
    async (request) => {
      try {
        const { sessionId, lineNumber } = request.body;

        if (!sessionId) {
          logger.error('scroll-to-line called with empty sessionId');
          return { success: false, sessionId: '', lineNumber: 0 };
        }

        if (typeof lineNumber !== 'number' || lineNumber < 0) {
          logger.error('scroll-to-line called with invalid lineNumber');
          return { success: false, sessionId, lineNumber: 0 };
        }

        return { success: true, sessionId, lineNumber };
      } catch (error) {
        logger.error('Error in POST /api/session/scroll-to-line:', error);
        return { success: false, sessionId: '', lineNumber: 0 };
      }
    }
  );
}
