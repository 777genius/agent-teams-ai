/**
 * McpInstallService — installs/uninstalls MCP servers via Claude CLI.
 *
 * Security model: renderer sends ONLY registryId + user inputs (env values,
 * headers, server name). Main re-fetches server spec from registry via getById()
 * and builds CLI args from the fresh registry data (never trusts install spec
 * from renderer).
 */

import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { execCli } from '@main/utils/childProcess';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { CLI_NOT_FOUND_MESSAGE } from '@shared/constants/cli';
import { createLogger } from '@shared/utils/logger';
import path from 'path';

import type { McpCatalogAggregator } from '../catalog/McpCatalogAggregator';
import type {
  McpCustomInstallRequest,
  McpInstallRequest,
  OperationResult,
} from '@shared/types/extensions';

const logger = createLogger('Extensions:McpInstall');

/** Validate server name: alphanumeric, dashes, underscores, dots */
const SERVER_NAME_RE = /^[\w.-]{1,100}$/;

/** Allowed scope values (prevent command injection) */
const VALID_SCOPES = new Set(['local', 'user', 'project']);

/** Env var key must be safe shell identifier */
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,100}$/i;

/** HTTP header key must be safe (RFC 7230 token) */
const HEADER_KEY_RE = /^[A-Za-z][\w-]{0,100}$/;

const TIMEOUT_MS = 30_000;

export class McpInstallService {
  constructor(private readonly aggregator: McpCatalogAggregator) {}

  async install(request: McpInstallRequest): Promise<OperationResult> {
    const { registryId, serverName, scope, projectPath, envValues, headers } = request;

    // 1. Validate server name
    if (!SERVER_NAME_RE.test(serverName)) {
      return {
        state: 'error',
        error: `Invalid server name: "${serverName}". Use alphanumeric, dashes, underscores, dots.`,
      };
    }

    // 2. Validate scope
    if (scope && !VALID_SCOPES.has(scope)) {
      return {
        state: 'error',
        error: `Invalid scope: "${scope}". Must be one of: local, user, project.`,
      };
    }

    if (scope === 'project' && !projectPath) {
      return {
        state: 'error',
        error: 'projectPath is required for project scope',
      };
    }

    // 3. Validate env var keys (prevent command injection)
    for (const key of Object.keys(envValues)) {
      if (!ENV_KEY_RE.test(key)) {
        return {
          state: 'error',
          error: `Invalid environment variable name: "${key}". Use uppercase alphanumeric and underscores.`,
        };
      }
    }

    // 4. Validate header keys (prevent header injection)
    for (const header of headers) {
      if (header.key && !HEADER_KEY_RE.test(header.key)) {
        return {
          state: 'error',
          error: `Invalid header name: "${header.key}". Use alphanumeric, dashes, underscores.`,
        };
      }
    }

    // 5. Validate projectPath (if provided, must be absolute)
    if (projectPath && !path.isAbsolute(projectPath)) {
      return {
        state: 'error',
        error: 'projectPath must be an absolute path',
      };
    }

    // 6. Re-fetch from registry (don't trust renderer-provided install spec)
    const server = await this.aggregator.getById(registryId);
    if (!server) {
      return {
        state: 'error',
        error: `MCP server "${registryId}" not found in registry`,
      };
    }

    if (!server.installSpec) {
      return {
        state: 'error',
        error: `MCP server "${server.name}" does not have an automatic install spec. Manual setup required.`,
      };
    }

    // 7. Build CLI args based on install spec type
    const args: string[] = ['mcp', 'add'];

    // Scope flag (-s)
    if (scope && scope !== 'local') {
      args.push('-s', scope);
    }

    if (server.installSpec.type === 'stdio') {
      // Stdio: claude mcp add [-s scope] [-e KEY=val...] <name> -- npx -y <package>[@version]
      // Add env flags
      for (const [key, value] of Object.entries(envValues)) {
        if (key && value) {
          args.push('-e', `${key}=${value}`);
        }
      }

      args.push(serverName);
      args.push('--');
      args.push('npx', '-y');

      const pkg = server.installSpec.npmVersion
        ? `${server.installSpec.npmPackage}@${server.installSpec.npmVersion}`
        : server.installSpec.npmPackage;
      args.push(pkg);
    } else if (server.installSpec.type === 'http') {
      // HTTP/SSE: claude mcp add [-s scope] -t <transport> [-H "Key: val"...] <name> <url>
      const transport = server.installSpec.transportType === 'sse' ? 'sse' : 'http';
      args.push('-t', transport);

      // Add header flags
      for (const header of headers) {
        if (header.key && header.value) {
          args.push('-H', `${header.key}: ${header.value}`);
        }
      }

      // Add env flags (some HTTP servers also need env vars)
      for (const [key, value] of Object.entries(envValues)) {
        if (key && value) {
          args.push('-e', `${key}=${value}`);
        }
      }

      args.push(serverName);
      args.push(server.installSpec.url);
    } else {
      return {
        state: 'error',
        error: `Unsupported install spec type: ${(server.installSpec as { type: string }).type}`,
      };
    }

    logger.info(
      `Installing MCP server: ${serverName} (type: ${server.installSpec.type}, scope: ${scope ?? 'local'})`
    );
    // Don't log env values or header values (may contain secrets)

    try {
      const claudeBinary = await ClaudeBinaryResolver.resolve();
      if (!claudeBinary) {
        return {
          state: 'error',
          error: CLI_NOT_FOUND_MESSAGE,
        };
      }

      const { stderr } = await execCli(claudeBinary, args, {
        timeout: TIMEOUT_MS,
        cwd: projectPath,
        env: buildEnrichedEnv(claudeBinary),
      });

      if (stderr) {
        logger.warn(`MCP install stderr: ${stderr.slice(0, 200)}`);
      }

      return { state: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mask potential secrets in error output
      const safeMessage = maskSecrets(
        message,
        envValues,
        headers.map((h) => h.value)
      );
      logger.error(`MCP install failed: ${safeMessage}`);
      return { state: 'error', error: safeMessage };
    }
  }

  /**
   * Install a custom MCP server — user provides installSpec directly (bypasses registry).
   */
  async installCustom(request: McpCustomInstallRequest): Promise<OperationResult> {
    const { serverName, scope, projectPath, installSpec, envValues, headers } = request;

    // Validate inputs (same rules as registry install)
    if (!SERVER_NAME_RE.test(serverName)) {
      return {
        state: 'error',
        error: `Invalid server name: "${serverName}". Use alphanumeric, dashes, underscores, dots.`,
      };
    }

    if (scope && !VALID_SCOPES.has(scope)) {
      return { state: 'error', error: `Invalid scope: "${scope}".` };
    }

    if (scope === 'project' && !projectPath) {
      return { state: 'error', error: 'projectPath is required for project scope' };
    }

    for (const key of Object.keys(envValues)) {
      if (!ENV_KEY_RE.test(key)) {
        return { state: 'error', error: `Invalid env var name: "${key}".` };
      }
    }

    for (const header of headers) {
      if (header.key && !HEADER_KEY_RE.test(header.key)) {
        return { state: 'error', error: `Invalid header name: "${header.key}".` };
      }
    }

    if (projectPath && !path.isAbsolute(projectPath)) {
      return { state: 'error', error: 'projectPath must be an absolute path' };
    }

    // Build CLI args from provided installSpec
    const args: string[] = ['mcp', 'add'];

    if (scope && scope !== 'local') {
      args.push('-s', scope);
    }

    if (installSpec.type === 'stdio') {
      for (const [key, value] of Object.entries(envValues)) {
        if (key && value) args.push('-e', `${key}=${value}`);
      }

      args.push(serverName);
      args.push('--');
      args.push('npx', '-y');

      const pkg = installSpec.npmVersion
        ? `${installSpec.npmPackage}@${installSpec.npmVersion}`
        : installSpec.npmPackage;
      args.push(pkg);
    } else if (installSpec.type === 'http') {
      const transport = installSpec.transportType === 'sse' ? 'sse' : 'http';
      args.push('-t', transport);

      for (const header of headers) {
        if (header.key && header.value) {
          args.push('-H', `${header.key}: ${header.value}`);
        }
      }

      for (const [key, value] of Object.entries(envValues)) {
        if (key && value) args.push('-e', `${key}=${value}`);
      }

      args.push(serverName);
      args.push(installSpec.url);
    } else {
      return { state: 'error', error: 'Unsupported install spec type' };
    }

    logger.info(
      `Installing custom MCP server: ${serverName} (type: ${installSpec.type}, scope: ${scope ?? 'local'})`
    );

    try {
      const claudeBinary = await ClaudeBinaryResolver.resolve();
      if (!claudeBinary) {
        return {
          state: 'error',
          error: CLI_NOT_FOUND_MESSAGE,
        };
      }

      const { stderr } = await execCli(claudeBinary, args, {
        timeout: TIMEOUT_MS,
        cwd: projectPath,
        env: buildEnrichedEnv(claudeBinary),
      });

      if (stderr) {
        logger.warn(`Custom MCP install stderr: ${stderr.slice(0, 200)}`);
      }

      return { state: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const safeMessage = maskSecrets(
        message,
        envValues,
        headers.map((h) => h.value)
      );
      logger.error(`Custom MCP install failed: ${safeMessage}`);
      return { state: 'error', error: safeMessage };
    }
  }

  async uninstall(name: string, scope?: string, projectPath?: string): Promise<OperationResult> {
    if (!SERVER_NAME_RE.test(name)) {
      return {
        state: 'error',
        error: `Invalid server name: "${name}"`,
      };
    }

    if (scope && !VALID_SCOPES.has(scope)) {
      return {
        state: 'error',
        error: `Invalid scope: "${scope}". Must be one of: local, user, project.`,
      };
    }

    if (scope === 'project' && !projectPath) {
      return {
        state: 'error',
        error: 'projectPath is required for project scope',
      };
    }

    if (projectPath && !path.isAbsolute(projectPath)) {
      return {
        state: 'error',
        error: 'projectPath must be an absolute path',
      };
    }

    const args = ['mcp', 'remove'];
    if (scope && scope !== 'local') {
      args.push('-s', scope);
    }
    args.push(name);

    logger.info(`Removing MCP server: ${name} (scope: ${scope ?? 'local'})`);

    try {
      const claudeBinary = await ClaudeBinaryResolver.resolve();
      if (!claudeBinary) {
        return {
          state: 'error',
          error: CLI_NOT_FOUND_MESSAGE,
        };
      }

      await execCli(claudeBinary, args, {
        timeout: TIMEOUT_MS,
        cwd: projectPath,
        env: buildEnrichedEnv(claudeBinary),
      });
      return { state: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`MCP uninstall failed: ${message}`);
      return { state: 'error', error: message };
    }
  }
}

/** Replace secret values in error messages with [REDACTED] */
function maskSecrets(
  message: string,
  envValues: Record<string, string>,
  headerValues: string[]
): string {
  let result = message;
  const secrets = [
    ...Object.values(envValues).filter((v) => v.length > 3),
    ...headerValues.filter((v) => v.length > 3),
  ];
  for (const secret of secrets) {
    result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
}
