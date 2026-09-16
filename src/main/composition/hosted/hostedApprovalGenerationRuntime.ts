import { Socket } from 'node:net';

import {
  clearProductHostedProducerProvenance,
  installProductHostedProducerProvenance,
} from '@features/hosted-producer-provenance/main';

import { createOptionalHostedApprovalProductionComposition,
  type CreateOptionalHostedApprovalProductionCompositionDependencies } from './createHostedApprovalProductionComposition';
import { HostedApprovalGenerationProvenance } from './hostedApprovalGenerationProvenance';
import { APPROVAL_GENERATION_TRANSITION,authenticateApprovalGenerationTransition } from './hostedApprovalGenerationTransitionContract';
import { decodeNativeActivationHandleSelection } from './hostedNativeActivationHandleContract';
import { admitHostedNativeSuccessorManifest } from './hostedNativeSuccessorAdmission';
import { authenticateNativeSuccessorHandle } from './hostedNativeSuccessorHandleContract';
import { createHostedOperatorSurfacesComposition } from './hostedOperatorSurfacesComposition';

import type { HostedLifecycleProductionOwnerAdmission } from './hostedLifecycleProductionOwnerAdmission';
import type { NativeActivationReplacementReceiver, ReceivedNativeActivation } from './hostedNativeActivationHandle';
import type { HostedOperatorProductionComposition } from './hostedOperatorProductionComposition';
import type { HostedProducerProvenance, ProductSseWriteEmitter } from '@features/hosted-producer-provenance/main';
import type { FastifyInstance } from 'fastify';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export interface HostedApprovalGenerationRuntimeOptions {
  readonly dependencies: CreateOptionalHostedApprovalProductionCompositionDependencies;
  readonly initial: ReceivedNativeActivation;
  readonly serializedBootstrap: string;
  readonly provenance: HostedProducerProvenance;
  readonly sseEmitter: ProductSseWriteEmitter;
  readonly drainStreams: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Close the independently owned lifecycle lease before the supervisor retires
   * that Owner. It grants no successor lifecycle/task/message authority. */
  readonly revokeLifecycle: () => void;
  readonly createRouteAdmission: (isReady: () => boolean) => CreateOptionalHostedApprovalProductionCompositionDependencies['routeAdmissionBinding'];
  readonly send: (message: Readonly<Record<string, unknown>>) => Promise<void>;
}

/** Process-local ownership state machine. Every generation is a fresh real
 * production composition with immutable authority; handlers pin it once. */
export class HostedApprovalGenerationRuntime implements HostedOperatorProductionComposition, NativeActivationReplacementReceiver {
  private state: 'starting' | 'ready' | 'draining' | 'waiting' | 'adopting' | 'failed' | 'closed' = 'starting';
  private composition: HostedOperatorProductionComposition | undefined;
  private admission: HostedLifecycleProductionOwnerAdmission;
  private selection: ReceivedNativeActivation['selection'];
  private activeTransport: Socket | undefined;
  private provenance: HostedProducerProvenance | undefined;
  private readonly evidence: HostedApprovalGenerationProvenance;
  private transition: ReturnType<typeof authenticateApprovalGenerationTransition> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private failure: Error | undefined;
  private handlers = 0;
  private handlerDrain = deferred();
  private streamsDone: Promise<void> | undefined;
  private releaseStreams: (() => void) | undefined;
  private registered = false;
  private readonly terminal = deferred();
  private readonly sessions = new Set<string>();
  private readonly starts = new Set<string>();

  private readonly options: HostedApprovalGenerationRuntimeOptions;

  constructor(options: HostedApprovalGenerationRuntimeOptions) {
    this.options = Object.freeze({ ...options, dependencies: Object.freeze({ ...options.dependencies }) });
    if (!options.dependencies.ownerAdmission || !options.dependencies.activationPublication) {
      throw new Error('approval_generation_initial_admission_required');
    }
    this.admission = options.dependencies.ownerAdmission;
    this.selection = decodeNativeActivationHandleSelection(options.initial.selection);
    if (!(options.initial.socket instanceof Socket) || options.initial.socket.destroyed ||
      this.selection.ownerGeneration !== this.admission.expectedOwnerBinding.ownerGeneration ||
      this.selection.ownerSessionId !== this.admission.expectedOwnerBinding.ownerSessionId ||
      this.selection.bootstrapDigest !== this.admission.bootstrapBinding.bootstrapDigest) {
      throw new Error('approval_generation_initial_binding');
    }
    this.sessions.add(this.selection.ownerSessionId);
    this.starts.add(this.selection.ownerProcessStartToken);
    this.evidence = new HostedApprovalGenerationProvenance(options.provenance, error => this.fail(error));
  }

  async start(): Promise<void> {
    try {
      this.composition = await this.construct(this.options.initial, this.admission,
        this.options.dependencies.activationPublication!);
      await this.awaitReady(this.composition);
      this.assertState('starting');
      this.state = 'ready';
      await this.sendReady();
      this.assertState('ready');
    } catch (error) { this.fail(asError(error)); throw error; }
  }

  private async construct(received: ReceivedNativeActivation, admission: HostedLifecycleProductionOwnerAdmission,
    publication: NonNullable<CreateOptionalHostedApprovalProductionCompositionDependencies['activationPublication']>) {
    const expectedState = this.state;
    this.activeTransport = received.socket;
    const provenance = this.evidence.open();
    this.provenance = provenance;
    installProductHostedProducerProvenance(provenance, this.options.sseEmitter);
    let composition: HostedOperatorProductionComposition | null = null;
    const routeAdmissionBinding = this.options.createRouteAdmission(() =>
      this.isReady() && this.composition === composition);
    composition = await createOptionalHostedApprovalProductionComposition({
      ...this.options.dependencies, routeAdmissionBinding, ownerAdmission: admission, activationPublication: publication,
      inheritedCandidateActivation: { transport: { socket: received.socket },
        expectedOpenCodeExecutableSha256: received.selection.expectedOpenCodeExecutableSha256 },
      producerProvenance: provenance, onApprovalOwnerLoss: error => this.fail(error),
    });
    if (!composition?.revoke || !composition.drain || !composition.surfaceDependencies) {
      composition?.close();
      throw new Error('approval_generation_concrete_composition_required');
    }
    try { this.assertState(expectedState); }
    catch (error) { composition.close(); throw error; }
    return composition;
  }

  // Authentication and logical revocation happen before the first async boundary.
  prepare(message: unknown): Promise<void> {
    try {
      this.assertState('ready');
      if (!this.composition?.isReady()) throw new Error('approval_generation_predecessor_not_ready');
      const transition = authenticateApprovalGenerationTransition(message, this.admission,
        this.selection, this.options.serializedBootstrap);
      if (this.sessions.has(transition.ticket.successorSessionId)) {
        throw new Error('approval_generation_session_replay');
      }
      this.transition = transition;
      this.state = 'draining';
      this.composition.revoke!();
      this.options.revokeLifecycle();
      this.deadline = setTimeout(() => this.fail(new Error('approval_generation_transition_deadline')), 30_000);
      const drained = deferred(), end = deferred();
      this.releaseStreams = end.resolve;
      const old = this.composition;
      this.streamsDone = this.options.drainStreams(async () => {
        if (this.handlers) await Promise.race([this.handlerDrain.promise, this.terminal.promise]);
        this.assertState('draining');
        await old.drain!();
        this.assertState('draining');
        old.close();
        this.composition = undefined;
        this.activeTransport = undefined;
        this.provenance = undefined;
        this.state = 'waiting';
        await this.options.send({ contract: `${APPROVAL_GENERATION_TRANSITION}/drained`,
          transitionSha256: transition.transitionSha256,
          ownerGeneration: transition.ticket.successorGeneration });
        drained.resolve();
        await end.promise;
      });
      void this.streamsDone.catch(error => this.fail(asError(error)));
      // Both branches settle preparation. Never leave the receiver waiting after loss.
      return Promise.race([drained.promise, this.terminal.promise.then(() => {
        throw this.failure ?? new Error('approval_generation_transition_cancelled');
      })]).catch(error => { this.fail(asError(error)); throw error; });
    } catch (error) { this.fail(asError(error)); return Promise.reject(error); }
  }

  async adopt(received: ReceivedNativeActivation): Promise<void> {
    try {
      this.assertState('waiting');
      const next = this.transition!;
      const selection = decodeNativeActivationHandleSelection(received.selection);
      authenticateNativeSuccessorHandle(received.successor, next.transitionSha256, selection, received.socket, this.admission);
      const admission = admitHostedNativeSuccessorManifest(received.successor!.successorManifest,
        this.admission, this.options.serializedBootstrap);
      const binding = admission.expectedOwnerBinding;
      if (binding.ownerGeneration !== next.ticket.successorGeneration ||
        binding.ownerSessionId !== next.ticket.successorSessionId ||
        admission.bootstrapBinding.bootstrapDigest !== next.ticket.successorBootstrapDigest) {
        throw new Error('approval_generation_successor_intent_mismatch');
      }
      if (!(received.socket instanceof Socket) || received.socket.destroyed || selection.ownerGeneration !== binding.ownerGeneration ||
        received.selection.ownerSessionId !== binding.ownerSessionId ||
        received.selection.bootstrapDigest !== admission.bootstrapBinding.bootstrapDigest ||
        this.starts.has(received.selection.ownerProcessStartToken)) throw new Error('approval_generation_successor_binding');
      this.state = 'adopting';
      this.starts.add(received.selection.ownerProcessStartToken);
      this.sessions.add(received.selection.ownerSessionId);
      this.composition = await this.construct(received, admission, {
        ...this.options.dependencies.activationPublication!, admissionDocument: next.ticket.admissionDocument,
        admissionDocumentDigest: next.admissionDocumentDigest,
      });
      await this.awaitReady(this.composition);
      this.assertState('adopting');
      this.admission = admission;
      this.selection = selection;
      this.releaseStreams?.();
      await this.streamsDone;
      this.assertState('adopting');
      if (!this.composition.isReady()) throw new Error('approval_generation_adoption_lost');
      this.state = 'ready';
      await this.sendReady(next.transitionSha256);
      this.assertState('ready');
      clearTimeout(this.deadline);
      this.transition = undefined;
    } catch (error) {
      received.socket.destroy();
      this.fail(asError(error));
      throw error;
    }
  }

  private async awaitReady(composition: HostedOperatorProductionComposition): Promise<void> {
    const until = performance.now() + 5_000;
    while (!composition.isReady()) {
      if (this.failure) throw this.failure;
      if (this.state !== 'starting' && this.state !== 'adopting') throw new Error('approval_generation_start_cancelled');
      if (performance.now() >= until) throw new Error('approval_generation_recovery_deadline');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  private sendReady(transitionSha256: string | null = null): Promise<void> {
    if (!this.isReady()) throw new Error('approval_generation_not_adopted');
    return this.options.send({ contract: `${APPROVAL_GENERATION_TRANSITION}/ready`,
      transitionSha256, selection: this.selection, manifestDigest: this.admission.manifestDigest });
  }

  private assertState(expected: typeof this.state): void {
    if (this.failure) throw this.failure;
    if (this.state !== expected) throw new Error('approval_generation_state');
  }

  isReady(): boolean { return this.state === 'ready' && this.composition?.isReady() === true; }

  register(app: FastifyInstance): void {
    if (this.registered || !this.composition?.surfaceDependencies) throw new Error('approval_generation_routes_unavailable');
    this.registered = true;
    const initial = this.composition.surfaceDependencies;
    const readiness = initial.readiness!;
    createHostedOperatorSurfacesComposition({ ...initial,
      readiness: { ...readiness, contribution: { ...readiness.contribution,
        facade: { getReadiness: context => (this.isReady() ? this.composition!.surfaceDependencies!.readiness! : readiness)
          .contribution.facade.getReadiness(context) } } },
      acquireApprovalGeneration: () => {
        if (!this.isReady()) return null;
        const current = this.composition!.surfaceDependencies!;
        const approvals = current.approvals!;
        if (this.handlers++ === 0) this.handlerDrain = deferred();
        let released = false;
        return { contribution: approvals.contribution, routeAdmission: current.routeAdmission,
          provenance: approvals.producerProvenance, createContext: approvals.createContext,
          release: () => {
            if (released) return;
            released = true;
            if (--this.handlers === 0) this.handlerDrain.resolve();
          } };
      },
    }).register(app);
  }

  reconcileApprovalDecision(request: Parameters<HostedOperatorProductionComposition['reconcileApprovalDecision']>[0]) {
    if (!this.isReady()) return Promise.resolve(Object.freeze({ status: 'unavailable' as const }));
    return this.composition!.reconcileApprovalDecision(request);
  }

  fail(error: Error): void {
    if (this.failure || this.state === 'closed') return;
    this.failure = error;
    this.terminal.resolve();
    this.state = 'failed';
    clearTimeout(this.deadline);
    this.releaseStreams?.();
    this.activeTransport?.destroy();
    try { this.composition?.close(); }
    finally { this.options.dependencies.onApprovalOwnerLoss?.(error); }
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.terminal.resolve();
    clearTimeout(this.deadline);
    this.releaseStreams?.();
    this.activeTransport?.destroy();
    this.composition?.close();
    if (this.provenance) {
      this.provenance.close();
      clearProductHostedProducerProvenance(this.provenance);
    }
    this.evidence.close();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('approval_generation_failed', { cause: error });
}
