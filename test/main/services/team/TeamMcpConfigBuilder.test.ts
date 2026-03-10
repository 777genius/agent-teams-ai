import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';

import { TeamMcpConfigBuilder } from '@main/services/team/TeamMcpConfigBuilder';

describe('TeamMcpConfigBuilder', () => {
  const createdPaths: string[] = [];

  afterEach(() => {
    for (const filePath of createdPaths.splice(0)) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // ignore cleanup issues in temp dir
      }
    }
  });

  it('prefers the source MCP entry when workspace source is available', async () => {
    const builder = new TeamMcpConfigBuilder();

    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };

    const server = parsed.mcpServers?.['agent-teams'];
    expect(server?.command).toBe('pnpm');
    expect(server?.args).toEqual([
      '--dir',
      `${process.cwd()}/mcp-server`,
      'exec',
      'tsx',
      `${process.cwd()}/mcp-server/src/index.ts`,
    ]);
  });
});
