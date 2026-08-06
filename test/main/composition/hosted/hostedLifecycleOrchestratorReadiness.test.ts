import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostedLifecycleOrchestratorReadiness } from '../../../../src/main/composition/hosted/hostedLifecycleOrchestratorReadiness';

import type { Server, Socket } from 'node:net';

const roots: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fakeOwner(
  response: 'ready' | 'silent' | 'drip' = 'ready'
): Promise<{ readonly socketPath: string; readonly ownerSocket: () => Socket | undefined }> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-owner-readiness-'));
  roots.push(root);
  const socketPath = join(root, 'owner.sock');
  let ownerSocket: Socket | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    ownerSocket = socket;
    let body = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      body += chunk;
      if (!body.includes('\n')) return;
      if (response === 'silent') return;
      if (response === 'drip') {
        const interval = setInterval(() => socket.write(' '), 5);
        socket.once('close', () => clearInterval(interval));
        return;
      }
      socket.write(
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'ready',
          owner: 'external-orchestrator',
          capability: 'hosted-lifecycle-command',
        })}\n`
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return { socketPath, ownerSocket: () => ownerSocket };
}

function identity() {
  return {
    expectedUid: process.getuid?.() ?? 0,
    expectedGid: process.getgid?.() ?? 0,
    expectedMode: 0o600,
  };
}

describe('HostedLifecycleOrchestratorReadiness', () => {
  it('grants readiness only after the bounded external-owner handshake and revokes it on loss', async () => {
    const owner = await fakeOwner();
    const onOwnerLoss = vi.fn();
    const readiness = await HostedLifecycleOrchestratorReadiness.connect({
      socketPath: owner.socketPath,
      ...identity(),
      handshakeTimeoutMs: 100,
      onOwnerLoss,
    });

    expect(readiness.isReady()).toBe(true);
    owner.ownerSocket()?.destroy();
    await vi.waitFor(() => expect(readiness.isReady()).toBe(false));
    expect(onOwnerLoss).toHaveBeenCalledOnce();
    readiness.close();
    expect(onOwnerLoss).toHaveBeenCalledOnce();
  });

  it('fails closed when the owner does not complete the handshake within its bound', async () => {
    const owner = await fakeOwner('silent');
    await expect(
      HostedLifecycleOrchestratorReadiness.connect({
        socketPath: owner.socketPath,
        ...identity(),
        handshakeTimeoutMs: 10,
        onOwnerLoss: vi.fn(),
      })
    ).rejects.toThrow('hosted-lifecycle-orchestrator-handshake-timeout');
  });

  it('enforces an absolute handshake deadline while the owner drips partial bytes', async () => {
    const owner = await fakeOwner('drip');
    await expect(
      HostedLifecycleOrchestratorReadiness.connect({
        socketPath: owner.socketPath,
        ...identity(),
        handshakeTimeoutMs: 50,
        onOwnerLoss: vi.fn(),
      })
    ).rejects.toThrow('hosted-lifecycle-orchestrator-handshake-timeout');
  });

  it('rejects non-sockets and mismatched uid, gid, or mode before connecting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-owner-identity-'));
    roots.push(root);
    const regularFile = join(root, 'not-a-socket');
    await writeFile(regularFile, 'not a socket');
    await expect(
      HostedLifecycleOrchestratorReadiness.connect({
        socketPath: regularFile,
        ...identity(),
        onOwnerLoss: vi.fn(),
      })
    ).rejects.toThrow('hosted-lifecycle-orchestrator-socket-identity-invalid');

    const owner = await fakeOwner();
    for (const mismatch of [
      { expectedUid: identity().expectedUid + 1 },
      { expectedGid: identity().expectedGid + 1 },
      { expectedMode: 0o660 },
    ]) {
      await expect(
        HostedLifecycleOrchestratorReadiness.connect({
          socketPath: owner.socketPath,
          ...identity(),
          ...mismatch,
          onOwnerLoss: vi.fn(),
        })
      ).rejects.toThrow('hosted-lifecycle-orchestrator-socket-identity-invalid');
    }
  });

  it('rejects unsafe paths and unbounded handshake configuration synchronously', async () => {
    await expect(
      HostedLifecycleOrchestratorReadiness.connect({
        socketPath: 'relative.sock',
        ...identity(),
        onOwnerLoss: vi.fn(),
      })
    ).rejects.toThrow('hosted-lifecycle-orchestrator-socket-path-invalid');

    const owner = await fakeOwner();
    await expect(
      HostedLifecycleOrchestratorReadiness.connect({
        socketPath: owner.socketPath,
        ...identity(),
        handshakeTimeoutMs: 60_001,
        onOwnerLoss: vi.fn(),
      })
    ).rejects.toThrow('hosted-lifecycle-orchestrator-handshake-timeout-invalid');
  });
});
