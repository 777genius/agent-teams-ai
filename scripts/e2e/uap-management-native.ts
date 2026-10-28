import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse, type ParseError } from 'jsonc-parser';

// This proof uses the pinned OpenCode 1.x native dialect, including JSONC files
// created by `opencode debug skill` before the registry plugin is installed.
export async function openCodeMcpServer(file: string, name: string): Promise<unknown> {
  const content = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  const errors: ParseError[] = [];
  const config: unknown = parse(content, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, [], 'Native OpenCode configuration must remain valid JSONC');
  assert(config && typeof config === 'object' && !Array.isArray(config));
  const mcp = (config as Record<string, unknown>).mcp ?? {};
  assert(mcp && typeof mcp === 'object' && !Array.isArray(mcp));
  return (mcp as Record<string, unknown>)[name];
}
