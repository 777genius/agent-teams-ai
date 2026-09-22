import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createHostedAccessNodeLocalControlTransportFactory,
  createHostedAccessNodePlatform,
} from '@main/composition/hosted/hostedAccessNodePlatform';
import { afterEach, describe, expect, it } from 'vitest';

const listen = (server: ReturnType<typeof createServer>, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

const closeServer = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

describe.skipIf(process.platform === 'win32')('hosted access node platform', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('does not unlink an existing listener when an unstarted transport is closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-access-node-platform-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const listener = createServer();
    await listen(listener, socketPath);
    try {
      const transport = createHostedAccessNodeLocalControlTransportFactory(
        createHostedAccessNodePlatform()
      ).create({ socketPath, maximumRequestBytes: 1_024, requestTimeoutMs: 1_000 });

      await expect(transport.start(async () => '{}')).rejects.toThrow(
        'hosted_local_control_socket_path_occupied'
      );
      await transport.close();

      expect((await lstat(socketPath)).isSocket()).toBe(true);
    } finally {
      await closeServer(listener);
    }
  });
});
