/**
 * Runs `claude mcp list` and parses per-server health statuses.
 */

import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { execCli } from '@main/utils/childProcess';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { CLI_NOT_FOUND_MESSAGE } from '@shared/constants/cli';
import { createLogger } from '@shared/utils/logger';

import type { McpServerDiagnostic, McpServerHealthStatus } from '@shared/types/extensions';

const logger = createLogger('Extensions:McpHealthDiagnostics');

const TIMEOUT_MS = 30_000;

export class McpHealthDiagnosticsService {
  async diagnose(): Promise<McpServerDiagnostic[]> {
    const claudeBinary = await ClaudeBinaryResolver.resolve();
    if (!claudeBinary) {
      throw new Error(CLI_NOT_FOUND_MESSAGE);
    }

    const { stdout, stderr } = await execCli(claudeBinary, ['mcp', 'list'], {
      timeout: TIMEOUT_MS,
      env: buildEnrichedEnv(claudeBinary),
    });

    const output = [stdout, stderr].filter(Boolean).join('\n');
    const diagnostics = parseMcpDiagnosticsOutput(output);

    logger.info(`Parsed ${diagnostics.length} MCP diagnostic entries`);
    return diagnostics;
  }
}

export function parseMcpDiagnosticsOutput(output: string): McpServerDiagnostic[] {
  const checkedAt = Date.now();

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('Checking MCP server health'))
    .map((line) => parseDiagnosticLine(line, checkedAt))
    .filter((entry): entry is McpServerDiagnostic => entry !== null);
}

function parseDiagnosticLine(line: string, checkedAt: number): McpServerDiagnostic | null {
  const statusSeparatorIdx = line.lastIndexOf(' - ');
  if (statusSeparatorIdx === -1) {
    return null;
  }

  const descriptor = line.slice(0, statusSeparatorIdx).trim();
  const statusChunk = line.slice(statusSeparatorIdx + 3).trim();

  const nameSeparatorIdx = descriptor.indexOf(': ');
  if (nameSeparatorIdx === -1) {
    return null;
  }

  const name = descriptor.slice(0, nameSeparatorIdx).trim();
  const target = descriptor.slice(nameSeparatorIdx + 2).trim();
  if (!name || !target) {
    return null;
  }

  const { status, statusLabel } = parseStatusChunk(statusChunk);

  return {
    name,
    target,
    status,
    statusLabel,
    rawLine: line,
    checkedAt,
  };
}

function parseStatusChunk(statusChunk: string): {
  status: McpServerHealthStatus;
  statusLabel: string;
} {
  const symbol = statusChunk[0];
  const label = statusChunk.slice(1).trim() || 'Unknown';

  switch (symbol) {
    case '✓':
      return { status: 'connected', statusLabel: label };
    case '!':
      return { status: 'needs-authentication', statusLabel: label };
    case '✗':
      return { status: 'failed', statusLabel: label };
    default:
      return { status: 'unknown', statusLabel: statusChunk };
  }
}
