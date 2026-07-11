import { HttpServer } from '@main/services/infrastructure/HttpServer';
import { describe, expect, it } from 'vitest';

import type { HttpServices } from '@main/http';

function createServices(): HttpServices {
  return {
    projectScanner: {} as HttpServices['projectScanner'],
    sessionParser: {} as HttpServices['sessionParser'],
    subagentResolver: {} as HttpServices['subagentResolver'],
    chunkBuilder: {} as HttpServices['chunkBuilder'],
    dataCache: {} as HttpServices['dataCache'],
    updaterService: {} as HttpServices['updaterService'],
    sshConnectionManager: {} as HttpServices['sshConnectionManager'],
  };
}

describe('HttpServer bound port tracking', () => {
  it('records the actual bound port when the OS assigns a standalone port', async () => {
    const server = new HttpServer();
    const port = await server.start(createServices(), async () => undefined, 0, '127.0.0.1');

    try {
      expect(port).toBeGreaterThan(0);
      expect(server.getPort()).toBe(port);
    } finally {
      await server.stop();
    }
  });
});
