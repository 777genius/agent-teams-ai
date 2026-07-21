import { parseInstalledMcpJsonOutput } from '@main/services/extensions/runtime/mcpRuntimeJson';
import { describe, expect, it } from 'vitest';

describe('multimodel MCP list JSON parsing', () => {
  it('preserves a secret-free target identity for custom server names', () => {
    expect(
      parseInstalledMcpJsonOutput(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              name: 'my-context7',
              scope: 'global',
              transport: 'stdio',
              target: 'npx -y @upstash/context7-mcp',
            },
          ],
        })
      )
    ).toEqual([
      {
        name: 'my-context7',
        scope: 'global',
        transport: 'stdio',
        targetKey: 'npm:@upstash/context7-mcp',
      },
    ]);
  });

  it('does not retain sensitive HTTP target values', () => {
    const [entry] = parseInstalledMcpJsonOutput(
      JSON.stringify({
        servers: [
          {
            name: 'remote',
            scope: 'global',
            transport: 'http',
            target: 'https://***:***@example.com/mcp?token=REDACTED#REDACTED',
          },
        ],
      })
    );

    expect(entry?.targetKey).toBe('http:https://example.com/mcp?token');
    expect(JSON.stringify(entry)).not.toContain('REDACTED');
  });
});
