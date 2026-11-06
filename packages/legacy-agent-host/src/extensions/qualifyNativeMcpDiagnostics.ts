import { stripVTControlCharacters } from 'node:util';
import type { InstalledMcpEntry, McpServerDiagnostic } from './contracts.js';

/** Expose only configured captured names and finite status, never raw native arguments or credentials. */
export function qualifyNativeMcpDiagnostics(
  output: string,
  installed: readonly InstalledMcpEntry[]
): McpServerDiagnostic[] {
  const checkedAt = Date.now(),
    result: McpServerDiagnostic[] = [];
  for (const raw of stripVTControlCharacters(output).split(/\r?\n/u)) {
    const at = raw.lastIndexOf(' - '),
      delimiter = raw.indexOf(': ');
    if (at < 0 || delimiter < 1 || delimiter >= at) continue;
    const name = raw.slice(0, delimiter).trim();
    if (name.startsWith('plugin:')) continue;
    // Native list applies user < project < local precedence. Preserve that exact configured row.
    const rank = { user: 0, global: 0, project: 1, local: 2 };
    const entry = installed
      .filter((value) => value.name === name)
      .sort((a, b) => rank[b.scope] - rank[a.scope])[0];
    if (!entry) continue;
    const chunk = raw.slice(at + 3).trim();
    const status = chunk.startsWith('✓')
      ? 'connected'
      : chunk.startsWith('!')
        ? 'needs-authentication'
        : chunk.startsWith('✗')
          ? 'failed'
          : 'unknown';
    const statusLabel =
      status === 'connected'
        ? 'Connected'
        : status === 'needs-authentication'
          ? 'Needs authentication'
          : status === 'failed'
            ? 'Failed'
            : 'Unknown';
    const target =
      entry.targetKey ??
      (entry.transport === 'stdio' ? 'Configured stdio server' : 'Configured MCP server');
    result.push({
      name,
      target,
      scope: entry.scope,
      ...(entry.transport ? { transport: entry.transport } : {}),
      status,
      statusLabel,
      rawLine: `${name}: ${target} - ${statusLabel}`,
      checkedAt,
    });
  }
  return result;
}
