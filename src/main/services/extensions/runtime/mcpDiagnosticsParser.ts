import { isInstalledMcpScope } from '@shared/utils/mcpScopes';

import type { McpServerDiagnostic, McpServerHealthStatus } from '@shared/types/extensions';

interface McpDiagnoseJsonEntry {
  name?: string;
  target?: string;
  scope?: 'local' | 'user' | 'project' | 'global' | 'dynamic' | 'managed';
  transport?: string;
  status?: 'connected' | 'needs-authentication' | 'failed' | 'timeout';
  statusLabel?: string;
}

interface McpDiagnoseJsonPayload {
  checkedAt?: string;
  diagnostics?: McpDiagnoseJsonEntry[];
}

const EMBEDDED_HTTP_URL_PATTERN = /https?:\/\/[^\s"'`]+/gi;
const SENSITIVE_FLAG_VALUE_PATTERN =
  /(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|client[-_]?secret))(?:=([^\s]+)|\s+([^\s]+))/gi;

function isPluginInjectedDiagnosticName(name: string): boolean {
  return name.startsWith('plugin:');
}

function isExtensionsManagedDiagnosticEntry(entry: {
  name: string;
  scope?: 'local' | 'user' | 'project' | 'global' | 'dynamic' | 'managed';
}): boolean {
  if (isPluginInjectedDiagnosticName(entry.name)) {
    return false;
  }

  return entry.scope === undefined || isInstalledMcpScope(entry.scope);
}

function extractJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error('No JSON object found in CLI output');
  }
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

function redactHttpUrl(urlString: string): string {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return urlString;
    }

    if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
      return urlString;
    }

    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';

    for (const key of new Set(parsed.searchParams.keys())) {
      parsed.searchParams.set(key, 'REDACTED');
    }

    if (parsed.hash) {
      parsed.hash = 'REDACTED';
    }

    return parsed.toString();
  } catch {
    return urlString;
  }
}

function redactDiagnosticTarget(target: string): string {
  return target
    .replace(EMBEDDED_HTTP_URL_PATTERN, (match) => redactHttpUrl(match))
    .replace(SENSITIVE_FLAG_VALUE_PATTERN, (_match, flag: string, inlineValue?: string) =>
      inlineValue ? `${flag}=REDACTED` : `${flag} REDACTED`
    );
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
  const target = redactDiagnosticTarget(descriptor.slice(nameSeparatorIdx + 2).trim());
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

export function parseMcpDiagnosticsOutput(output: string): McpServerDiagnostic[] {
  const checkedAt = Date.now();

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('Checking MCP server health'))
    .map((line) => parseDiagnosticLine(line, checkedAt))
    .filter((entry): entry is McpServerDiagnostic => entry !== null)
    .filter((entry) => isExtensionsManagedDiagnosticEntry(entry));
}

export function parseMcpDiagnosticsJsonOutput(output: string): McpServerDiagnostic[] {
  const parsed = extractJsonObject<McpDiagnoseJsonPayload>(output);
  const checkedAtValue = parsed.checkedAt ? Date.parse(parsed.checkedAt) : Number.NaN;
  const checkedAt = Number.isFinite(checkedAtValue) ? checkedAtValue : Date.now();

  return (parsed.diagnostics ?? []).flatMap<McpServerDiagnostic>((entry) => {
    if (
      typeof entry.name !== 'string' ||
      typeof entry.target !== 'string' ||
      typeof entry.statusLabel !== 'string'
    ) {
      return [];
    }

    const redactedTarget = redactDiagnosticTarget(entry.target);
    const normalizedStatus: McpServerHealthStatus =
      entry.status === 'connected'
        ? 'connected'
        : entry.status === 'needs-authentication'
          ? 'needs-authentication'
          : entry.status === 'failed' || entry.status === 'timeout'
            ? 'failed'
            : 'unknown';

    const rawLine = `${entry.name}: ${redactedTarget} - ${entry.statusLabel}`;
    const diagnostic = {
      name: entry.name,
      target: redactedTarget,
      scope: entry.scope,
      transport: entry.transport,
      status: normalizedStatus,
      statusLabel: entry.statusLabel,
      rawLine,
      checkedAt,
    } satisfies McpServerDiagnostic;

    return isExtensionsManagedDiagnosticEntry(diagnostic) ? [diagnostic] : [];
  });
}
