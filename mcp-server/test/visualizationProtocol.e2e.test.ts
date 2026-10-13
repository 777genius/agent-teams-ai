import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import { McpStdIoClient } from './McpStdIoClient';

it('initializes the built ESM MCP and supplies its embedded visualization protocol from a sandbox cwd', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'mcp-visualization-protocol-test-'));
  const teamName = 'visualization-sandbox';
  const teamDir = join(sandbox, 'teams', teamName);
  await mkdir(join(teamDir, 'inboxes'), { recursive: true });
  await mkdir(join(sandbox, 'tasks', teamName), { recursive: true });
  await writeFile(
    join(teamDir, 'config.json'),
    JSON.stringify({
      name: teamName,
      members: [
        { name: 'lead', role: 'team-lead' },
        { name: 'alice', role: 'developer' },
      ],
    })
  );
  const client = new McpStdIoClient(
    fileURLToPath(new URL('../dist/index.js', import.meta.url)),
    sandbox,
    ['--transport', 'stdio'],
    { AGENT_TEAMS_MCP_CLAUDE_DIR: sandbox }
  );
  try {
    const initialized = (await client.initialize()) as {
      result?: { protocolVersion?: string };
      error?: unknown;
    };
    expect(initialized.error).toBeUndefined();
    expect(initialized.result?.protocolVersion).toBeTruthy();
    const response = (await client.callTool('member_briefing', {
      claudeDir: sandbox,
      teamName,
      memberName: 'alice',
      includeActiveProcesses: false,
    })) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: unknown };
    expect(response.error).toBeUndefined();
    expect(response.result?.isError).not.toBe(true);
    const briefing = response.result?.content?.[0]?.text ?? '';
    expect(briefing).toContain('CHAT VISUALIZATION PROTOCOL v1');
    expect(briefing).toContain('openui-lang');
    expect(briefing).toContain('Stack(children: Card[])');
    expect(briefing.match(/CHAT VISUALIZATION PROTOCOL v1/g)).toHaveLength(1);
  } finally {
    await client.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
