import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCursorAgentTeamsMcpConfig, stripUrlFragment } from './CursorMcpConfigWriter';

describe('CursorMcpConfigWriter ownership', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-owner-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:9999/mcp';
  const write = (mcpUrl = url) => ensureCursorAgentTeamsMcpConfig({ profileHome: home, mcpUrl });
  const configPath = () => path.join(home, '.cursor', 'mcp.json');
  const read = () => fs.readFile(configPath(), 'utf8');
  const seed = async (contents: string) => {
    await fs.mkdir(path.dirname(configPath()), { recursive: true });
    await fs.writeFile(configPath(), contents);
  };

  it('creates, keeps unchanged, and updates only its own entry across endpoint changes', async () => {
    expect((await write()).action).toBe('created');
    const before = await read();
    const stat = await fs.stat(configPath());
    expect((await write()).action).toBe('unchanged');
    expect(await read()).toBe(before);
    expect((await fs.stat(configPath())).mtimeMs).toBe(stat.mtimeMs);
    expect((await write('http://127.0.0.1:9998/mcp')).action).toBe('updated');
    expect(JSON.parse(await read()).mcpServers['agent-teams'].url).toBe(
      'http://127.0.0.1:9998/mcp'
    );
  });

  it.each([
    { command: 'node', args: ['mine.js'], env: { TOKEN: 'private' }, disabled: true },
    { type: 'http', url, headers: { Authorization: 'private' }, custom: { name: 'mine' } },
    { type: 'http', url },
    null,
  ])('never adopts an existing entry, even with the same URL: %j', async (entry) => {
    const original = JSON.stringify({
      mcpServers: { 'agent-teams': entry, docs: { command: 'docs' } },
    });
    await seed(original);
    expect(await write()).toMatchObject({ action: 'skipped', reason: 'user-owned-entry' });
    expect(await read()).toBe(original);
    expect(await fs.readdir(path.dirname(configPath()))).toEqual(['mcp.json']);
  });

  it.each([
    '{ /* comment */ "mcpServers": {} }',
    '[1]',
    '{"mcpServers":null}',
    '{"mcpServers":[]}',
  ])('preserves unsupported config %s', async (original) => {
    await seed(original);
    expect(await write()).toMatchObject({ action: 'skipped', reason: 'unparsable-config' });
    expect(await read()).toBe(original);
  });

  it('preserves all unrelated data when creating and updating managed entries', async () => {
    await seed(JSON.stringify({ editor: { size: 13 }, mcpServers: { docs: { command: 'docs' } } }));
    await write();
    await write('http://127.0.0.1:9998/mcp');
    expect(JSON.parse(await read())).toMatchObject({
      editor: { size: 13 },
      mcpServers: { docs: { command: 'docs' } },
    });
  });

  it('relinquishes ownership after user customization', async () => {
    await write();
    const config = JSON.parse(await read());
    config.mcpServers['agent-teams'].disabled = true;
    const original = JSON.stringify(config);
    await seed(original);
    expect(await write('http://127.0.0.1:9998/mcp')).toMatchObject({
      action: 'skipped',
      reason: 'user-owned-entry',
    });
    expect(await read()).toBe(original);
  });

  it('fails closed when the ownership receipt is missing or corrupt', async () => {
    await write();
    const original = await read();
    await fs.writeFile(path.join(home, '.cursor', 'mcp.agent-teams-managed.json'), 'broken');
    expect((await write('http://127.0.0.1:9998/mcp')).reason).toBe('user-owned-entry');
    expect(await read()).toBe(original);
  });

  it('serializes concurrent launches and leaves refreshable ownership', async () => {
    await Promise.all([write(), write('http://127.0.0.1:9998/mcp')]);
    expect((await write()).action).toBe('updated');
  });

  it('rejects empty URLs and strips only the instance fragment', async () => {
    await expect(write('  ')).rejects.toThrow(/MCP URL is required/);
    expect(stripUrlFragment(`${url}?q=1#instance`)).toBe(`${url}?q=1`);
  });
});
