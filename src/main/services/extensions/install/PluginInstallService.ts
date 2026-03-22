/**
 * PluginInstallService — installs/uninstalls plugins via Claude CLI.
 *
 * Security model: renderer sends ONLY pluginId, main resolves qualifiedName
 * from the current catalog snapshot (never trusts renderer-provided paths).
 */

import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { execCli } from '@main/utils/childProcess';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { CLI_NOT_FOUND_MESSAGE } from '@shared/constants/cli';
import { createLogger } from '@shared/utils/logger';
import path from 'path';

import type { PluginCatalogService } from '../catalog/PluginCatalogService';
import type { OperationResult, PluginInstallRequest } from '@shared/types/extensions';

const logger = createLogger('Extensions:PluginInstall');

/** Validate qualifiedName: must be <name>@<marketplace> with safe characters */
const QUALIFIED_NAME_RE = /^[\w.-]+@[\w.-]+$/;

/** Allowed scope values (prevent command injection) */
const VALID_SCOPES = new Set(['local', 'user', 'project']);

const INSTALL_TIMEOUT_MS = 120_000; // plugins may clone repos
const UNINSTALL_TIMEOUT_MS = 30_000;

export class PluginInstallService {
  constructor(private readonly catalogService: PluginCatalogService) {}

  async install(request: PluginInstallRequest): Promise<OperationResult> {
    const { pluginId, scope, projectPath } = request;

    // 1. Validate scope
    if (scope && !VALID_SCOPES.has(scope)) {
      return {
        state: 'error',
        error: `Invalid scope: "${scope}". Must be one of: local, user, project.`,
      };
    }

    // 2. Validate projectPath
    if (projectPath && !path.isAbsolute(projectPath)) {
      return {
        state: 'error',
        error: 'projectPath must be an absolute path',
      };
    }

    // 3. Resolve qualifiedName from catalog (NOT from renderer)
    const resolved = await this.catalogService.resolvePlugin(pluginId);
    if (!resolved) {
      return {
        state: 'error',
        error: `Plugin "${pluginId}" not found in catalog`,
      };
    }

    const { qualifiedName } = resolved;

    // 2. Validate qualifiedName format (prevent injection)
    if (!QUALIFIED_NAME_RE.test(qualifiedName)) {
      return {
        state: 'error',
        error: `Invalid plugin identifier: ${qualifiedName}`,
      };
    }

    // 5. Build CLI args: claude plugin install [-s scope] <qualifiedName>
    const args = ['plugin', 'install'];
    if (scope && scope !== 'user') {
      args.push('-s', scope);
    }
    args.push(qualifiedName);

    logger.info(`Installing plugin: ${qualifiedName} (scope: ${scope ?? 'user'})`);

    try {
      const claudeBinary = await ClaudeBinaryResolver.resolve();
      if (!claudeBinary) {
        return {
          state: 'error',
          error: CLI_NOT_FOUND_MESSAGE,
        };
      }

      const { stdout, stderr } = await execCli(claudeBinary, args, {
        timeout: INSTALL_TIMEOUT_MS,
        cwd: projectPath,
        env: buildEnrichedEnv(claudeBinary),
      });

      if (stderr && !stdout) {
        logger.warn(`Plugin install stderr: ${stderr}`);
      }

      return { state: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Plugin install failed: ${message}`);
      return { state: 'error', error: message };
    }
  }

  async uninstall(
    pluginId: string,
    scope?: string,
    projectPath?: string
  ): Promise<OperationResult> {
    // Validate scope
    if (scope && !VALID_SCOPES.has(scope)) {
      return {
        state: 'error',
        error: `Invalid scope: "${scope}". Must be one of: local, user, project.`,
      };
    }

    if (projectPath && !path.isAbsolute(projectPath)) {
      return {
        state: 'error',
        error: 'projectPath must be an absolute path',
      };
    }

    // Resolve qualifiedName from catalog
    const resolved = await this.catalogService.resolvePlugin(pluginId);
    if (!resolved) {
      return {
        state: 'error',
        error: `Plugin "${pluginId}" not found in catalog`,
      };
    }

    const { qualifiedName } = resolved;

    if (!QUALIFIED_NAME_RE.test(qualifiedName)) {
      return {
        state: 'error',
        error: `Invalid plugin identifier: ${qualifiedName}`,
      };
    }

    const args = ['plugin', 'uninstall'];
    if (scope && scope !== 'user') {
      args.push('-s', scope);
    }
    args.push(qualifiedName);

    logger.info(`Uninstalling plugin: ${qualifiedName} (scope: ${scope ?? 'user'})`);

    try {
      const claudeBinary = await ClaudeBinaryResolver.resolve();
      if (!claudeBinary) {
        return {
          state: 'error',
          error: CLI_NOT_FOUND_MESSAGE,
        };
      }

      await execCli(claudeBinary, args, {
        timeout: UNINSTALL_TIMEOUT_MS,
        cwd: projectPath,
        env: buildEnrichedEnv(claudeBinary),
      });
      return { state: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Plugin uninstall failed: ${message}`);
      return { state: 'error', error: message };
    }
  }
}
