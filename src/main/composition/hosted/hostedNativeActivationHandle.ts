import { Socket } from 'node:net';

import { APPROVAL_GENERATION_TRANSITION } from './hostedApprovalGenerationTransitionContract';
import {
  decodeNativeActivationHandleSelection,
  NATIVE_ACTIVATION_ENTRY_ARGUMENT,
  NATIVE_ACTIVATION_HANDLE_CONTRACT,
  type NativeActivationHandleSelection,
} from './hostedNativeActivationHandleContract';
import {
  decodeNativeSuccessorHandle,
  NATIVE_SUCCESSOR_HANDLE,
  type NativeSuccessorHandle,
} from './hostedNativeSuccessorHandleContract';

import type { HostedLifecycleProductionOwnerAdmission } from './hostedLifecycleProductionOwnerAdmission';

export type ReceivedNativeActivation = Readonly<{
  selection: NativeActivationHandleSelection;
  socket: Socket;
  successor?: NativeSuccessorHandle;
}>;

/** Installed by the actual Product composition import before asynchronous startup.
 * Node's IPC channel carries the real socket handle; FD6 never enters this inbox.
 * An ownership reply is confined to that same existing process IPC channel. */
class NativeActivationInbox {
  private pending: ReceivedNativeActivation | undefined;
  private waiting:
    | { resolve(value: ReceivedNativeActivation): void; reject(error: Error): void }
    | undefined;
  private failure: Error | undefined;
  private disabled = false;
  private lastGeneration = 0;
  private outstanding = false;
  private replacement: NativeActivationReplacementReceiver | undefined;
  private preparing = false;
  private successorExpected = false;
  private readonly starts = new Set<string>();
  private readonly sockets = new Set<Socket>();

  constructor() {
    if (!process.send || !process.connected || process.versions.bun) {
      throw new Error('native_activation_node_handle_ipc_required');
    }
    process.on('message', (message: unknown, handle: unknown) => {
      try {
        if (
          message &&
          typeof message === 'object' &&
          Reflect.get(message, 'contract') === APPROVAL_GENERATION_TRANSITION
        ) {
          if (
            handle ||
            !this.replacement ||
            this.preparing ||
            this.successorExpected ||
            this.outstanding ||
            this.failure ||
            this.disabled
          ) {
            throw new Error('native_activation_transition_overlap');
          }
          this.preparing = true;
          // prepare authenticates and revokes synchronously before returning a promise.
          void this.replacement.prepare(message).then(
            () => {
              if (this.failure) return;
              this.preparing = false;
              this.successorExpected = true;
            },
            (error) =>
              this.fail(
                error instanceof Error ? error : new Error('native_activation_transition_failed')
              )
          );
          return;
        }
        const successorEnvelope =
          message &&
          typeof message === 'object' &&
          Reflect.get(message, 'contract') === NATIVE_SUCCESSOR_HANDLE
            ? decodeNativeSuccessorHandle(message)
            : undefined;
        const selection =
          successorEnvelope?.selection ?? decodeNativeActivationHandleSelection(message);
        if (this.lastGeneration > 0 !== (successorEnvelope !== undefined))
          throw new Error('native_activation_successor_envelope_required');
        if (
          !(handle instanceof Socket) ||
          handle.destroyed ||
          !handle.readable ||
          !handle.writable ||
          handle.remoteAddress !== undefined ||
          handle.localAddress !== undefined ||
          this.failure ||
          this.disabled ||
          this.outstanding ||
          [...this.sockets].some((socket) => !socket.destroyed) ||
          this.starts.size >= 32 ||
          this.starts.has(selection.ownerProcessStartToken) ||
          (this.lastGeneration > 0 &&
            (!this.successorExpected || selection.ownerGeneration !== this.lastGeneration + 1))
        ) {
          throw new Error('native_activation_handle_reuse_or_invalid_socket');
        }
        this.outstanding = true;
        const successor = this.lastGeneration > 0;
        this.successorExpected = false;
        handle.pause();
        this.starts.add(selection.ownerProcessStartToken);
        this.lastGeneration = selection.ownerGeneration;
        this.sockets.add(handle);
        handle.once('close', () => this.sockets.delete(handle));
        handle.on('error', () => this.fail(new Error('native_activation_handle_lost')));
        const received = Object.freeze({
          selection,
          socket: handle,
          ...(successorEnvelope ? { successor: successorEnvelope } : {}),
        });
        // This reports handle ownership only. It does not acknowledge selection
        // admission, an activation publication, a provider effect or a receipt.
        process.send!(
          {
            contract: `${NATIVE_ACTIVATION_HANDLE_CONTRACT}/owned`,
            ownerProcessStartToken: selection.ownerProcessStartToken,
            bootstrapV2HeaderSha256: selection.bootstrapV2HeaderSha256,
            ownerGeneration: selection.ownerGeneration,
          },
          (error) => {
            if (error) {
              this.fail(new Error('native_activation_handle_ownership_reply'));
              return;
            }
            if (this.failure || this.disabled) {
              handle.destroy();
              return;
            }
            if (successor) {
              void this.replacement!.adopt(received).then(
                () => {
                  this.outstanding = false;
                },
                (error) =>
                  this.fail(
                    error instanceof Error ? error : new Error('native_activation_adoption_failed')
                  )
              );
            } else if (this.waiting) {
              const waiter = this.waiting;
              this.waiting = undefined;
              waiter.resolve(received);
            } else this.pending = received;
          }
        );
      } catch {
        if (handle instanceof Socket) handle.destroy();
        this.fail(new Error('native_activation_handle_rejected'));
      }
    });
    process.once('disconnect', () =>
      this.fail(new Error('native_activation_supervisor_disconnected'))
    );
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const socket of this.sockets) socket.destroy();
    this.pending = undefined;
    this.waiting?.reject(this.failure);
    this.waiting = undefined;
    this.replacement?.fail(this.failure);
  }

  disable(): void {
    if (this.disabled) return;
    this.disabled = true;
    const error = new Error('native_activation_disabled');
    for (const socket of this.sockets) socket.destroy();
    this.pending = undefined;
    this.waiting?.reject(error);
    this.waiting = undefined;
    this.replacement?.fail(error);
  }

  install(receiver: NativeActivationReplacementReceiver): void {
    if (this.replacement) throw new Error('native_activation_receiver_already_installed');
    this.replacement = receiver;
    if (this.failure) receiver.fail(this.failure);
  }

  async take(
    admission: HostedLifecycleProductionOwnerAdmission | null
  ): Promise<ReceivedNativeActivation> {
    if (this.disabled) throw new Error('native_activation_disabled');
    if (this.failure) throw this.failure;
    if (!admission || this.waiting) {
      this.fail(new Error('native_activation_admitted_owner_required'));
      throw this.failure!;
    }
    // Copy independently verified signed admission before waiting for IPC.
    const expected = {
      generation: admission.expectedOwnerBinding.ownerGeneration,
      session: admission.expectedOwnerBinding.ownerSessionId,
      bootstrap: admission.bootstrapBinding.bootstrapDigest,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const received =
        this.pending ??
        (await new Promise<ReceivedNativeActivation>((resolve, reject) => {
          this.waiting = { resolve, reject };
          timer = setTimeout(() => this.fail(new Error('native_activation_handle_deadline')), 5000);
        }));
      this.pending = undefined;
      this.outstanding = false;
      if (
        received.selection.ownerGeneration !== expected.generation ||
        received.selection.ownerSessionId !== expected.session ||
        received.selection.bootstrapDigest !== expected.bootstrap ||
        received.socket.destroyed
      ) {
        this.fail(new Error('native_activation_handle_owner_binding'));
        throw this.failure!;
      }
      return received;
    } finally {
      clearTimeout(timer);
    }
  }
}

const inbox = process.argv.includes(NATIVE_ACTIVATION_ENTRY_ARGUMENT)
  ? new NativeActivationInbox()
  : undefined;

export async function takeHostedNativeActivationHandle(
  admission: HostedLifecycleProductionOwnerAdmission | null
) {
  if (!inbox) return undefined;
  const received = await inbox.take(admission);
  return Object.freeze({
    selection: received.selection,
    transport: Object.freeze({ socket: received.socket }),
    expectedOpenCodeExecutableSha256: received.selection.expectedOpenCodeExecutableSha256,
  });
}

/** Rejects the native handoff path without waiting for a handle or acknowledging any provider
 * effect. A pending endpoint is destroyed and every later endpoint is rejected by the installed
 * inbox listener. */
export function disableHostedNativeActivationInbox(): void {
  inbox?.disable();
}

export interface NativeActivationReplacementReceiver {
  prepare(message: unknown): Promise<void>;
  adopt(received: ReceivedNativeActivation): Promise<void>;
  fail(error: Error): void;
}

export function installHostedNativeActivationReplacementReceiver(
  receiver: NativeActivationReplacementReceiver
): void {
  if (!inbox) throw new Error('native_activation_receiver_unavailable');
  inbox.install(receiver);
}
