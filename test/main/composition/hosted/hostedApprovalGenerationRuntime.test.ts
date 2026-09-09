import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type HostedAuthenticatedPrincipal,parseHostedSessionId, parseUserId } from '@features/hosted-access';
import { currentProductHostedProducerProvenance, requireProductHostedProducerInstance } from '@features/hosted-producer-provenance/main';
import { HOSTED_TEAM_APPROVAL_PAGE_ROUTE } from '@features/team-approvals/main/hosted';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetProductHostedProducerProvenanceForTests } from '../../../../src/features/hosted-producer-provenance/main/HostedProducerProvenanceRegistry';
import { HostedApprovalGenerationRuntime } from '../../../../src/main/composition/hosted/hostedApprovalGenerationRuntime';
import { APPROVAL_GENERATION_TRANSITION } from '../../../../src/main/composition/hosted/hostedApprovalGenerationTransitionContract';
import { nativeActivationSocketIdentity } from '../../../../src/main/composition/hosted/hostedNativeActivationSocketIdentity';
import { createProductHostedProducerSseWriteEmitter } from '../../../../src/main/composition/hosted/hostedProducerProvenanceNodeOperations';
import { verifyHostedApprovalRuntimeActivationPublication } from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';
import { appendHostedApprovalActivationProofLast, createHostedApprovalActivationProof } from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationProof';

import { generationFixture } from './fixtures/approvalGenerationFixture';
import { generationCoordinationStream } from './fixtures/generationCoordinationStream';

import type { CreateHostedApprovalProductionCompositionDependencies } from '../../../../src/main/composition/hosted/createHostedApprovalProductionComposition';
import type { HostedApprovalGenerationRuntimeOptions } from '../../../../src/main/composition/hosted/hostedApprovalGenerationRuntime';
import type { HostedApprovalRuntimeActivationBinding } from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationTypes';

type Lease = Parameters<NonNullable<CreateHostedApprovalProductionCompositionDependencies['createApprovalRuntimeAuthority']>>[0]['lease'];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  resetProductHostedProducerProvenanceForTests();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(authenticated = false, afterStreamDrain?: () => Promise<void>,
  afterSend?: (reply: Readonly<Record<string, unknown>>) => Promise<void>,
  production?: Pick<HostedApprovalGenerationRuntimeOptions, 'drainStreams' | 'sseEmitter'>) {
  const fixture = generationFixture();
  if (authenticated) {
    const sessionId = parseHostedSessionId('hss_generation-test');
    fixture.input.authentication.authenticatedPrincipalFor = (): HostedAuthenticatedPrincipal => ({
      principal: { userId: parseUserId('user_generation-test'), displayName: 'Test operator', role: 'member',
        permissions: ['hosted.query', 'hosted.command'], authenticationMethod: 'oidc', sessionId },
      authenticatedSessionId: sessionId,
    });
  }
  vi.spyOn(fixture.writer, 'close');
  vi.spyOn(fixture.writer, 'emit');
  vi.spyOn(fixture.input.approvalStorage, 'hostedTeamApprovalReadDeliveryReconciliation');
  const root = await mkdtemp(join(tmpdir(), 'approval-generations-test-'));
  const server = createServer();
  server.listen(join(root, 'socket'));
  await once(server, 'listening');
  const sockets: Socket[] = [];
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const publications: HostedApprovalRuntimeActivationBinding[] = [];
  async function endpoint(generation: number, invalidReady = false) {
    const connected = once(server, 'connection');
    const product = connect(join(root, 'socket'));
    product.on('error', () => {});
    const [owner] = await connected as [Socket];
    owner.on('error', () => {});
    sockets.push(product, owner);
    let bytes = '', phase = 0, challenge = '', binding: HostedApprovalRuntimeActivationBinding;
    owner.on('data', chunk => {
      bytes += chunk.toString();
      while (bytes.includes('\n')) {
        const end = bytes.indexOf('\n'), frame = bytes.slice(0, end);
        bytes = bytes.slice(end + 1);
        let row: object, direction: string;
        if (phase++ === 0) {
          const prepare = JSON.parse(frame);
          binding = prepare.binding;
          challenge = prepare.challenge;
          direction = 'owner-ready';
          row = { schemaVersion: 2, kind: 'owner_ready', capability: 'agent-teams.hosted-approval-activation-v2', challenge, binding };
        } else {
          verifyHostedApprovalRuntimeActivationPublication(frame, fixture.proofKey,
            fixture.input.activationPublication!.signingIdentity, binding!);
          publications.push(binding!);
          direction = 'ready';
          row = { schemaVersion: 2, kind: 'ready', capability: 'agent-teams.hosted-approval-activation-v2', challenge,
            activationDigest: invalidReady ? '0'.repeat(64) : createHash('sha256').update(frame).digest('hex'), binding: binding! };
        }
        const unsigned = JSON.stringify(row);
        owner.write(`${appendHostedApprovalActivationProofLast(unsigned,
          createHostedApprovalActivationProof(fixture.proofKey, direction, unsigned))}\n`);
      }
    });
    product.pause(); // Same explicit pause as the real native handle receiver.
    return { received: { socket: product, selection: fixture.selection(generation),
      ...(generation > 1 ? { successor: fixture.successor(fixture.selection(generation), nativeActivationSocketIdentity(product)) } : {}) }, owner };
  }
  const first = await endpoint(1);
  const fatal = vi.fn(), revokeLifecycle = vi.fn();
  const replies: Readonly<Record<string, unknown>>[] = [];
  const leases: Lease[] = [];
  const original = fixture.input.createApprovalRuntimeAuthority!;
  const runtime = new HostedApprovalGenerationRuntime({
    dependencies: { ...fixture.input, onApprovalOwnerLoss: fatal,
      createApprovalRuntimeAuthority: options => { leases.push(options.lease); return original(options); } },
    createRouteAdmission: fixture.createRouteAdmission,
    initial: first.received, serializedBootstrap: fixture.bootstrap, provenance: fixture.writer,
    sseEmitter: () => true,
    drainStreams: async operation => {
      const result = await operation();
      await afterStreamDrain?.();
      return result;
    },
    ...production,
    revokeLifecycle,
    send: async reply => { replies.push(reply); await afterSend?.(reply); },
  });
  cleanup.push(async () => { runtime.close(); });
  await runtime.start();
  return { ...fixture, runtime, replies, leases, fatal, revokeLifecycle, first, endpoint, publications };
}

describe('actual Product approval generation composition', () => {
  it('drains the production hosted registry through real backpressure and delayed pinned evidence before ACK', async () => {
    const coordination = generationCoordinationStream();
    cleanup.push(async () => { coordination.raw.destroy(); coordination.stream.close(); });
    const evidenceStarted = deferred(), releaseEvidence = deferred();
    const emit = createProductHostedProducerSseWriteEmitter({});
    const f = await setup(false, undefined, undefined, {
      drainStreams: operation => coordination.stream.runWithStreamsDrained(operation),
      sseEmitter: async (frame, identity, wrote, provenance) => {
        evidenceStarted.resolve();
        await releaseEvidence.promise;
        return emit(frame, identity, wrote, provenance);
      },
    });
    const opened = coordination.open();
    // Wait for replay to reach its heartbeat wait, not for a guessed wall-clock delay.
    await vi.waitFor(() => expect(() => coordination.heartbeat()).not.toThrow());
    await coordination.blocked;
    const preparing = f.runtime.prepare(f.ticket());
    expect(await coordination.gapRequest()).toBe(503);
    expect(f.replies.some(row => row.contract === `${APPROVAL_GENERATION_TRANSITION}/drained`)).toBe(false);
    coordination.releaseWrite();
    await evidenceStarted.promise;
    expect(f.replies.some(row => row.contract === `${APPROVAL_GENERATION_TRANSITION}/drained`)).toBe(false);
    expect(requireProductHostedProducerInstance(currentProductHostedProducerProvenance()!).ownerGeneration).toBe(1);
    releaseEvidence.resolve();
    await preparing;
    await opened;
    expect(await coordination.gapRequest()).toBe(503);
    const evidence = vi.mocked(f.writer.emit).mock.calls.find(([, row]) => row.recordType === 'coordination-sse-write-succeeded');
    expect(evidence?.[1].native).toMatchObject({ ownerGeneration: 1 });
    const second = await f.endpoint(2);
    await f.runtime.adopt(second.received);
    expect(f.runtime.isReady()).toBe(true);
    expect(f.leases[0]!.currentBinding()).toBeNull();
    expect(requireProductHostedProducerInstance(currentProductHostedProducerProvenance()!).ownerGeneration).toBe(2);
  });

  it('adopts two authenticated generations in one runtime, permanently revokes old leases and preserves one evidence writer', async () => {
    const f = await setup();
    const pid = process.pid;
    const oldProvenance = currentProductHostedProducerProvenance()!;
    expect(f.leases[0]!.currentBinding()?.ownerGeneration).toBe(1);
    const prepared = f.runtime.prepare(f.ticket());
    expect(f.runtime.isReady()).toBe(false);
    expect(f.leases[0]!.currentBinding()).toBeNull();
    expect(f.revokeLifecycle).toHaveBeenCalledOnce();
    await prepared;
    expect(f.replies.at(-1)?.contract).toBe(`${APPROVAL_GENERATION_TRANSITION}/drained`);
    const second = await f.endpoint(2);
    await f.runtime.adopt(second.received);
    expect(process.pid).toBe(pid);
    expect(f.runtime.isReady()).toBe(true);
    expect(f.fatal).not.toHaveBeenCalled();
    expect(f.publications.map(binding => binding.ownerBinding.ownerGeneration)).toEqual([1, 2]);
    expect(f.leases[0]!.currentBinding()).toBeNull();
    expect(f.leases[1]!.currentBinding()?.ownerGeneration).toBe(2);
    expect(requireProductHostedProducerInstance(oldProvenance).ownerGeneration).toBe(1);
    expect(requireProductHostedProducerInstance(currentProductHostedProducerProvenance()!).ownerGeneration).toBe(2);
    expect(f.writer.close).not.toHaveBeenCalled();
    expect(f.replies.at(-1)).toMatchObject({ contract: `${APPROVAL_GENERATION_TRANSITION}/ready`, selection: f.selection(2) });
    f.runtime.close();
    expect(f.writer.close).toHaveBeenCalledOnce();
  });

  it.each(['signature', 'predecessor', 'gap', 'stale', 'descriptor'] as const)('fails closed on %s', async variant => {
    const f = await setup();
    let ticket = f.ticket();
    if (variant === 'signature') ticket = { ...ticket, signature: 'A'.repeat(86) };
    if (variant === 'predecessor') ticket = f.ticket(2, { predecessorProcessStartToken: '9'.repeat(64) });
    if (variant === 'gap') ticket = f.ticket(3);
    if (variant === 'stale') ticket = f.ticket(1);
    if (variant === 'descriptor') ticket = { ...ticket, admissionDocument: ticket.admissionDocument.replace('manual', 'auto') };
    await expect(f.runtime.prepare(ticket)).rejects.toThrow();
    expect(f.runtime.isReady()).toBe(false);
    expect(f.fatal).toHaveBeenCalledOnce();
    expect(f.leases[0]!.currentBinding()).toBeNull();
    expect(f.replies.filter(row => row.contract === `${APPROVAL_GENERATION_TRANSITION}/ready`)).toHaveLength(1);
  });

  it('rejects overlapping transitions and cannot publish late readiness', async () => {
    const f = await setup();
    const first = f.runtime.prepare(f.ticket());
    const outcome = first.catch(error => error);
    await expect(f.runtime.prepare(f.ticket())).rejects.toThrow();
    await outcome;
    expect(f.fatal).toHaveBeenCalledOnce();
    expect(f.runtime.isReady()).toBe(false);
  });

  it.each(['session', 'bootstrap', 'start', 'generation', 'activation', 'endpoint'] as const)('rejects a substituted %s successor', async variant => {
    const f = await setup();
    await f.runtime.prepare(f.ticket());
    const second = await f.endpoint(2, variant === 'activation');
    const selection = { ...second.received.selection };
    if (variant === 'session') selection.ownerSessionId = 'owner-session_substituted';
    if (variant === 'bootstrap') selection.bootstrapDigest = '9'.repeat(64);
    if (variant === 'start') selection.ownerProcessStartToken = f.selection(1).ownerProcessStartToken;
    if (variant === 'generation') selection.ownerGeneration = 3;
    await expect(f.runtime.adopt({ ...second.received, selection, successor: f.successor(selection, variant === 'endpoint' ? { device: '99999', inode: '99999' } : nativeActivationSocketIdentity(second.received.socket)) })).rejects.toThrow();
    expect(f.fatal).toHaveBeenCalledOnce();
    expect(second.received.socket.destroyed).toBe(true);
    expect(f.runtime.isReady()).toBe(false);
  });

  it.each(['complete', 'close', 'failure'] as const)(
    'keeps successor readiness unpublished until stream drain finalization: %s', async outcome => {
      const entered = deferred(), finish = deferred();
      const f = await setup(false, async () => {
        entered.resolve();
        await finish.promise;
        if (outcome === 'failure') throw new Error('test_stream_finalization_failed');
      });
      await f.runtime.prepare(f.ticket());
      const second = await f.endpoint(2);
      const adoption = f.runtime.adopt(second.received);
      // Install the rejection observer before the deliberate failure/close.
      const result = adoption.then(() => 'adopted', () => 'rejected');
      await entered.promise;
      expect(f.publications).toHaveLength(2);
      expect(f.runtime.isReady()).toBe(false);
      expect(f.replies.filter(row => row.contract === `${APPROVAL_GENERATION_TRANSITION}/ready`)).toHaveLength(1);
      if (outcome === 'close') f.runtime.close();
      finish.resolve();
      expect(await result).toBe(outcome === 'complete' ? 'adopted' : 'rejected');
      expect(f.runtime.isReady()).toBe(outcome === 'complete');
      expect(f.replies.filter(row => row.contract === `${APPROVAL_GENERATION_TRANSITION}/ready`)).toHaveLength(outcome === 'complete' ? 2 : 1);
      if (outcome === 'failure') expect(f.fatal).toHaveBeenCalledOnce();
    }
  );

  it.each(['close', 'loss'] as const)('rejects adoption on %s during readiness delivery', async outcome => {
    const entered = deferred(), delivered = deferred();
    const f = await setup(false, undefined, async reply => {
      if (reply.contract === `${APPROVAL_GENERATION_TRANSITION}/ready` && reply.transitionSha256) {
        entered.resolve();
        await delivered.promise;
      }
    });
    await f.runtime.prepare(f.ticket());
    const second = await f.endpoint(2);
    const adoption = f.runtime.adopt(second.received);
    const rejected = expect(adoption).rejects.toThrow();
    await entered.promise;
    if (outcome === 'close') f.runtime.close();
    else {
      second.owner.destroy();
      await vi.waitFor(() => expect(f.fatal).toHaveBeenCalledOnce());
    }
    delivered.resolve();
    await rejected;
    expect(f.runtime.isReady()).toBe(false);
    expect(f.leases[1]!.currentBinding()).toBeNull();
    expect(f.fatal).toHaveBeenCalledTimes(outcome === 'loss' ? 1 : 0);
  });

  it('rejects replay after actual adoption and preserves the revoked predecessor', async () => {
    const f = await setup();
    const ticket = f.ticket();
    await f.runtime.prepare(ticket);
    const second = await f.endpoint(2);
    await f.runtime.adopt(second.received);
    await expect(f.runtime.prepare(ticket)).rejects.toThrow();
    expect(f.leases[0]!.currentBinding()).toBeNull();
    expect(f.leases[1]!.currentBinding()).toBeNull();
    expect(f.fatal).toHaveBeenCalledOnce();
  });

  it('fails after drain when an authenticated successor descriptor cannot activate', async () => {
    const f = await setup();
    const ticket = f.ticket(2, { admissionDocument: 'not-json\n' });
    await f.runtime.prepare(ticket);
    const second = await f.endpoint(2);
    await expect(f.runtime.adopt({ ...second.received,
      successor: f.successor(second.received.selection, nativeActivationSocketIdentity(second.received.socket), ticket),
    })).rejects.toThrow();
    expect(f.runtime.isReady()).toBe(false);
    expect(f.fatal).toHaveBeenCalledOnce();
    expect(f.publications).toHaveLength(1);
  });

  it('drains an admitted storage operation before closing evidence and acknowledging retirement', async () => {
    const f = await setup();
    const gate = deferred(), entered = deferred();
    vi.mocked(f.input.approvalStorage.hostedTeamApprovalReadDeliveryReconciliation).mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; return { kind: 'not_found' };
    });
    // The concrete bridge reads this storage port before returning its terminal result.
    const operation = f.runtime.reconcileApprovalDecision({ deadlineAtMs: Date.now() + 5000 } as never);
    await entered.promise;
    const transition = f.runtime.prepare(f.ticket());
    await Promise.resolve();
    expect(f.leases[0]!.currentBinding()).toBeNull();
    expect(f.replies).toHaveLength(1);
    gate.resolve();
    await operation; await transition;
    expect(f.replies.at(-1)?.contract).toBe(`${APPROVAL_GENERATION_TRANSITION}/drained`);
  });

  it('keeps unexpected Owner loss fatal, including while waiting for handler/evidence drain', async () => {
    const f = await setup();
    const gate = deferred(), entered = deferred();
    vi.mocked(f.input.approvalStorage.hostedTeamApprovalReadDeliveryReconciliation).mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; return { kind: 'not_found' };
    });
    const operation = f.runtime.reconcileApprovalDecision({ deadlineAtMs: Date.now() + 5000 } as never);
    await entered.promise;
    const prepared = f.runtime.prepare(f.ticket());
    const rejected = expect(prepared).rejects.toThrow();
    f.first.owner.destroy();
    await rejected;
    gate.resolve(); await operation;
    expect(f.fatal).toHaveBeenCalledOnce();
    expect(f.replies).toHaveLength(1);
  });

  it('fails stop on unexplained loss in the active generation', async () => {
    const f = await setup();
    f.first.owner.destroy();
    await vi.waitFor(() => expect(f.fatal).toHaveBeenCalledOnce());
    expect(f.runtime.isReady()).toBe(false);
  });

  it('rebinds the already registered HTTP routes to the new immutable generation after drain', async () => {
    const f = await setup(true);
    const app = Fastify();
    cleanup.push(async () => { await app.close(); });
    f.runtime.register(app);
    await app.ready();
    expect((await app.inject({ method: 'POST', url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE, payload: {} })).statusCode).toBe(400);
    await f.runtime.prepare(f.ticket());
    const response = await app.inject({ method: 'POST', url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE, payload: {} });
    expect(response.statusCode).toBe(503);
    const second = await f.endpoint(2);
    await f.runtime.adopt(second.received);
    expect((await app.inject({ method: 'POST', url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE, payload: {} })).statusCode).toBe(400);
    const responses = vi.mocked(f.writer.emit).mock.calls.filter(([, row]) => row.recordType === 'approval-http-response-finalized');
    expect(responses.map(([, row]) => row.recordType === 'approval-http-response-finalized' ? row.native.ownerGeneration : null)).toEqual([1, 2]);
    expect(f.fatal).not.toHaveBeenCalled();
  });
});
