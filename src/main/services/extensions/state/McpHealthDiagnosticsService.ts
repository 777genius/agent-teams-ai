/**
 * Resolves MCP diagnostics through the active runtime adapter.
 *
 * Direct Claude mode parses `claude mcp list` text output.
 * Multimodel mode uses the structured `mcp diagnose --json` runtime contract.
 */

import { createExtensionsRuntimeAdapter } from '../runtime/ExtensionsRuntimeAdapter';
import {
  parseMcpDiagnosticsJsonOutput,
  parseMcpDiagnosticsOutput,
} from '../runtime/mcpDiagnosticsParser';

import type { ExtensionsRuntimeAdapter } from '../runtime/ExtensionsRuntimeAdapter';
import type { McpServerDiagnostic } from '@shared/types/extensions';

export { parseMcpDiagnosticsJsonOutput, parseMcpDiagnosticsOutput };

export class McpHealthDiagnosticsService {
  constructor(
    private readonly runtimeAdapter: ExtensionsRuntimeAdapter = createExtensionsRuntimeAdapter()
  ) {}

  async diagnose(projectPath?: string): Promise<McpServerDiagnostic[]> {
    return this.runtimeAdapter.diagnoseMcp(projectPath);
  }
}
