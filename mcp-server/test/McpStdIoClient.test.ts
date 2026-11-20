import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpStdIoClient } from './McpStdIoClient';

describe('McpStdIoClient child lifecycle', () => {
  let dir: string;
  const clients: McpStdIoClient[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-stdio-client-'));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await rm(dir, { recursive: true, force: true });
  });

  const start = (serverPath: string): McpStdIoClient => {
    const client = new McpStdIoClient(serverPath, dir);
    clients.push(client);
    return client;
  };

  it('fails at once, with a build hint, when the server entry file does not exist', async () => {
    const startedAt = Date.now();
    const client = start(join(dir, 'dist', 'index.js'));

    const error = await client.initialize().then(
      () => null,
      (reason: unknown) => reason as Error
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain('exited before answering');
    expect(error?.message).toContain('The entry file does not exist');
    expect(error?.message).toContain('pnpm --filter agent-teams-mcp build');
    // The old behaviour was a silent 15 s poll that raced the test timeout.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('reports the exit code and stderr of a server that crashes on start', async () => {
    const script = join(dir, 'crash.cjs');
    await writeFile(script, "process.stderr.write('boom from server\\n'); process.exit(3);\n");
    const client = start(script);

    await expect(client.initialize()).rejects.toThrow(/code 3[\s\S]*boom from server/);
  });

  it('still returns a response that the server wrote right before it exited', async () => {
    const script = join(dir, 'answer-and-exit.cjs');
    await writeFile(
      script,
      [
        "process.stdin.once('data', () => {",
        "  const reply = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\\n';",
        '  process.stdout.write(reply, () => process.exit(0));',
        '});',
        '',
      ].join('\n')
    );
    const client = start(script);

    await expect(client.initialize()).resolves.toMatchObject({ id: 1, result: { ok: true } });
  });
});
