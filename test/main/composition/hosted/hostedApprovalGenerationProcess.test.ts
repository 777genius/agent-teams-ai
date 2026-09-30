import { fork } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { transferNativeActivationHandle } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/native-handle-transfer';
import { prepareProductGenerationTransition } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/product-generation-transition';
import { type ApprovalGenerationTransition,approvalGenerationTransitionSigningBytes } from '../../../../src/main/composition/hosted/hostedApprovalGenerationTransitionContract';
import { NATIVE_ACTIVATION_ENTRY_ARGUMENT, type NativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';
import { nativeActivationSocketIdentity } from '../../../../src/main/composition/hosted/hostedNativeActivationSocketIdentity';
import { NATIVE_SUCCESSOR_HANDLE, type NativeSuccessorHandle,nativeSuccessorHandleSigningBytes } from '../../../../src/main/composition/hosted/hostedNativeSuccessorHandleContract';
import { appendHostedApprovalActivationProofLast, createHostedApprovalActivationProof } from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationProof';

interface FixtureMessage {
  fixture: 'approval-generation-child'; first: NativeActivationHandleSelection;
  second: NativeActivationHandleSelection; ticket: ApprovalGenerationTransition; successorManifest: string;
}

describe('Product process native generation replacement', () => {
  it.skipIf(process.platform !== 'linux' || !!process.versions.bun).each(['replace', 'invalid-loss', 'substituted-handle'] as const)(
    '%s through the existing Node IPC receiver and real production composition', async scenario => {
      const root = await mkdtemp(join(tmpdir(), 'product-generation-process-'));
      const server = createServer();
      const sockets: Socket[] = [];
      const launcher = generateKeyPairSync('ed25519');
      const child = fork(resolve('test/main/composition/hosted/fixtures/nativeApprovalGenerationChild.ts'),
        [NATIVE_ACTIVATION_ENTRY_ARGUMENT, launcher.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_384); });
      const exit = once(child, 'exit');
      const startup = new Promise<FixtureMessage>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`child startup deadline; stderr: ${stderr}`)), 5_000);
        const onExit = (code: number | null, signal: string | null) =>
          finish(new Error(`child exited before fixture: ${code}/${signal}; stderr: ${stderr}`));
        const onError = (error: Error) => finish(new Error(`child startup: ${error.message}; stderr: ${stderr}`));
        const onMessage = (message: FixtureMessage) => finish(undefined, message);
        const finish = (error?: Error, message?: FixtureMessage) => {
          clearTimeout(timer);
          child.removeListener('exit', onExit);
          child.removeListener('error', onError);
          child.removeListener('message', onMessage);
          if (error) reject(error); else resolve(message!);
        };
        child.once('exit', onExit);
        child.once('error', onError);
        child.once('message', onMessage);
      });
      try {
        const fixture = await startup;
        expect(fixture.fixture).toBe('approval-generation-child');
        server.listen(join(root, 'socket'));
        await once(server, 'listening');
        const generations: number[] = [];
        const endpoint = async () => {
          const accepted = once(server, 'connection');
          const owner = connect(join(root, 'socket'));
          owner.on('error', () => {});
          const [product] = await accepted as [Socket];
          product.on('error', () => {});
          sockets.push(owner, product);
          let bytes = '', challenge = '';
          let binding: Record<string, unknown> | undefined;
          owner.on('data', chunk => {
            bytes += chunk.toString();
            while (bytes.includes('\n')) {
              const end = bytes.indexOf('\n'), frame = bytes.slice(0, end);
              bytes = bytes.slice(end + 1);
              let row: object, direction: string;
              if (!binding) {
                const request = JSON.parse(frame);
                binding = request.binding; challenge = request.challenge;
                direction = 'owner-ready';
                row = { schemaVersion: 2, kind: 'owner_ready', capability: 'agent-teams.hosted-approval-activation-v2', challenge, binding };
              } else {
                generations.push((binding.ownerBinding as { ownerGeneration: number }).ownerGeneration);
                direction = 'ready';
                row = { schemaVersion: 2, kind: 'ready', capability: 'agent-teams.hosted-approval-activation-v2', challenge,
                  activationDigest: createHash('sha256').update(frame).digest('hex'), binding };
              }
              const unsigned = JSON.stringify(row);
              owner.write(`${appendHostedApprovalActivationProofLast(unsigned,
                createHostedApprovalActivationProof(new Uint8Array(32), direction, unsigned))}\n`);
            }
          });
          return { owner, product };
        };
        const initial = await endpoint();
        const first = await transferNativeActivationHandle(child, initial.product, fixture.first);
        await first.waitForAdoption();
        const pid = child.pid;
        if (scenario === 'invalid-loss') {
          initial.owner.destroy();
          expect((await exit)[0]).toBe(1);
          expect(generations).toEqual([1]);
          return;
        }
        await prepareProductGenerationTransition(child, fixture.ticket, 2, new AbortController().signal);
        const next = await endpoint();
        const envelope: NativeSuccessorHandle = { contract: NATIVE_SUCCESSOR_HANDLE, selection: fixture.second,
          endpointIdentity: nativeActivationSocketIdentity(next.product), successorManifest: fixture.successorManifest,
          transitionSha256: createHash('sha256').update(approvalGenerationTransitionSigningBytes(fixture.ticket)).digest('hex'), signature: '' };
        const successor = { ...envelope, signature: sign(null, nativeSuccessorHandleSigningBytes(envelope), launcher.privateKey).toString('base64url') };
        const wire = scenario === 'substituted-handle'
          ? { ...successor, selection: { ...fixture.second, bootstrapV2HeaderSha256: '9'.repeat(64) } }
          : successor;
        const second = await transferNativeActivationHandle(child, next.product, wire);
        if (scenario === 'substituted-handle') {
          await expect(second.waitForAdoption()).rejects.toThrow();
          expect((await exit)[0]).toBe(1);
          expect(generations).toEqual([1]);
          return;
        }
        await second.waitForAdoption();
        expect(child.pid).toBe(pid);
        expect(child.exitCode).toBeNull();
        expect(child.connected).toBe(true);
        expect(generations).toEqual([1, 2]);
        // The correctly adopted successor still retains ordinary loss fail-stop.
        next.owner.destroy();
        expect((await exit)[0]).toBe(1);
      } finally {
        for (const socket of sockets) socket.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        server.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 15_000);
});
