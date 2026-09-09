import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { transferNativeActivationHandle } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/native-handle-transfer';
import { decodeNativeActivationHandleSelection, NATIVE_ACTIVATION_ENTRY_ARGUMENT,
  NATIVE_ACTIVATION_HANDLE_CONTRACT, type NativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';

const selection = {
  contract: NATIVE_ACTIVATION_HANDLE_CONTRACT,
  ownerProcessStartToken: '1'.repeat(64), bootstrapV2HeaderSha256: '2'.repeat(64),
  bootstrapDigest: '3'.repeat(64), ownerGeneration: 1, ownerSessionId: 'owner_test',
  expectedOpenCodeExecutableSha256: 'cffecbe3ff685de84d7fa028e552c42d15a7c720a8f8d5d1cddd265110e5eb88' as const,
} satisfies NativeActivationHandleSelection;

describe('selected native socket-handle contract', () => {
  it('rejects old, unknown, oversized, and invalid selection metadata', () => {
    expect(decodeNativeActivationHandleSelection(selection)).toEqual(selection);
    for (const mutation of [{ contract: 'old' }, { unexpected: true }, { ownerGeneration: 0 },
      { ownerSessionId: 'x'.repeat(16 * 1024) }, { bootstrapV2HeaderSha256: 'wrong' },
      { expectedOpenCodeExecutableSha256: '4'.repeat(64) }]) {
      expect(() => decodeNativeActivationHandleSelection({ ...selection, ...mutation })).toThrow();
    }
  });

  it.skipIf(process.platform !== 'linux' || !!process.versions.bun).each([
    { name: 'matching admission', generation: 1, session: 'owner_test', digest: selection.bootstrapDigest, accepted: true },
    { name: 'wrong generation', generation: 2, session: 'owner_test', digest: selection.bootstrapDigest, accepted: false },
    { name: 'wrong session', generation: 1, session: 'other_owner', digest: selection.bootstrapDigest, accepted: false },
    { name: 'wrong bootstrap', generation: 1, session: 'owner_test', digest: '9'.repeat(64), accepted: false },
  ])('passes a real Unix handle to the actual receiver: $name', async admission => {
      const root = await mkdtemp(join(tmpdir(), 'native-handle-r1014-'));
      const server = createServer();
      let client: Socket | undefined;
      let retained: Socket | undefined;
      let concurrentClient: Socket | undefined;
      let concurrentHandle: Socket | undefined;
      const child = fork(resolve('test/main/composition/hosted/fixtures/nativeActivationHandleChild.ts'), [
        NATIVE_ACTIVATION_ENTRY_ARGUMENT,
        JSON.stringify({ expectedOwnerBinding: { ownerGeneration: admission.generation, ownerSessionId: admission.session },
          bootstrapBinding: { bootstrapDigest: admission.digest } }),
      ], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const exited = once(child, 'exit');
      try {
        server.listen(join(root, 'socket'));
        await once(server, 'listening');
        const accepted = once(server, 'connection');
        client = connect(join(root, 'socket'));
        client.on('error', () => undefined);
        const bytes: Buffer[] = [];
        client.on('data', part => bytes.push(Buffer.from(part)));
        const ended = once(client, 'end');
        [retained] = await accepted as [Socket];
        const secondAccepted = once(server, 'connection');
        concurrentClient = connect(join(root, 'socket'));
        concurrentClient.on('error', () => undefined);
        [concurrentHandle] = await secondAccepted as [Socket];
        const transferred = transferNativeActivationHandle(child, retained, selection);
        // A concurrent replacement must not reach the receiver and poison the
        // first transfer. Its rejected endpoint still belongs to the sender.
        await expect(transferNativeActivationHandle(child, concurrentHandle, {
          ...selection, ownerGeneration: 2, ownerProcessStartToken: '8'.repeat(64),
        })).rejects.toThrow('native_handle_transfer_in_progress');
        expect(concurrentHandle.destroyed).toBe(true);
        const result = await transferred;
        expect(result.selection).toEqual(selection);
        expect(result.productPid).toBe(child.pid);
        expect(retained.destroyed).toBe(true);
        await ended;
        expect(Buffer.concat(bytes).toString()).toBe(admission.accepted ? 'actual transferred endpoint' : '');
        concurrentClient.destroy();
        const reusedAccepted = once(server, 'connection');
        concurrentClient = connect(join(root, 'socket'));
        concurrentClient.on('error', () => undefined);
        [concurrentHandle] = await reusedAccepted as [Socket];
        await expect(transferNativeActivationHandle(child, concurrentHandle, selection))
          .rejects.toThrow('native_handle_generation_reused');
        expect(concurrentHandle.destroyed).toBe(true);
        child.disconnect();
        expect((await exited)[0]).toBe(admission.accepted ? 0 : 1);
      } finally {
        client?.destroy(); retained?.destroy(); concurrentClient?.destroy(); concurrentHandle?.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        server.close();
        await rm(root, { recursive: true, force: true });
      }
    });
});
