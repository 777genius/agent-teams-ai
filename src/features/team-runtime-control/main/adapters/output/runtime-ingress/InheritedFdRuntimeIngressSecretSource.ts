import { close, createReadStream } from 'node:fs';

import { RUNTIME_INGRESS_BEARER_MAX_LENGTH } from '../../../../contracts/runtime-ingress-http';
import {
  isExactRuntimeIngressCredentialScope,
  parseRuntimeIngressPresentedSecret,
  type RuntimeIngressCredentialId,
  type RuntimeIngressCredentialScope,
  type RuntimeIngressPresentedSecret,
} from '../../../../core/domain/runtime-ingress';

import type { Readable } from 'node:stream';

export interface ConsumeRuntimeIngressRelaySecretRequest {
  readonly credentialId: RuntimeIngressCredentialId;
  readonly expectedScope: RuntimeIngressCredentialScope;
}

export type ConsumeRuntimeIngressRelaySecretResult =
  | { readonly status: 'consumed'; readonly secret: RuntimeIngressPresentedSecret }
  | { readonly status: 'rejected' | 'unavailable' };

export interface RuntimeIngressRelaySecretSource {
  consume(
    request: ConsumeRuntimeIngressRelaySecretRequest
  ): Promise<ConsumeRuntimeIngressRelaySecretResult>;
}

export interface InheritedFdRuntimeIngressSecretSourceOptions {
  readonly disposeAfterMs?: number;
  readonly createReadStream?: (inheritedFd: number) => Readable;
}

const DEFAULT_DISPOSE_AFTER_MS = 30_000;
const MAX_DISPOSE_AFTER_MS = 5 * 60_000;
const claimedInheritedFds = new Set<number>();

/**
 * Reads one bearer from a dedicated inherited pipe and closes it immediately.
 * The descriptor number and bearer are never serialized or logged.
 */
export class InheritedFdRuntimeIngressSecretSource implements RuntimeIngressRelaySecretSource {
  private terminalStatus: 'consumed' | 'rejected' | 'unavailable' | null = null;
  private readonly disposalTimer: ReturnType<typeof setTimeout>;
  private readonly streamFactory: (inheritedFd: number) => Readable;
  private stream: Readable | null = null;
  private closePromise: Promise<void> | null = null;
  private pendingResolve: ((result: ConsumeRuntimeIngressRelaySecretResult) => void) | null = null;
  private consumeOperations: Promise<void> = Promise.resolve();

  constructor(
    private readonly inheritedFd: number,
    private readonly credentialId: RuntimeIngressCredentialId,
    private readonly expectedScope: RuntimeIngressCredentialScope,
    options: InheritedFdRuntimeIngressSecretSourceOptions = {}
  ) {
    if (!Number.isSafeInteger(inheritedFd) || inheritedFd < 3) {
      throw new TypeError('runtime-ingress-bootstrap-fd-invalid');
    }
    const disposeAfterMs = options.disposeAfterMs ?? DEFAULT_DISPOSE_AFTER_MS;
    if (
      !Number.isSafeInteger(disposeAfterMs) ||
      disposeAfterMs < 1 ||
      disposeAfterMs > MAX_DISPOSE_AFTER_MS
    ) {
      throw new TypeError('runtime-ingress-bootstrap-fd-deadline-invalid');
    }
    if (claimedInheritedFds.has(inheritedFd)) {
      throw new Error('runtime-ingress-bootstrap-fd-already-claimed');
    }
    claimedInheritedFds.add(inheritedFd);
    this.streamFactory =
      options.createReadStream ??
      ((fd) => createReadStream('', { fd, autoClose: false, emitClose: true }));
    this.disposalTimer = setTimeout(() => void this.finish('unavailable'), disposeAfterMs);
    this.disposalTimer.unref?.();
  }

  async consume(
    request: ConsumeRuntimeIngressRelaySecretRequest
  ): Promise<ConsumeRuntimeIngressRelaySecretResult> {
    const consumeOnce = () => this.consumeOnce(request);
    const result = this.consumeOperations.then(consumeOnce, consumeOnce);
    this.consumeOperations = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async consumeOnce(
    request: ConsumeRuntimeIngressRelaySecretRequest
  ): Promise<ConsumeRuntimeIngressRelaySecretResult> {
    if (this.terminalStatus !== null) {
      return {
        status: this.terminalStatus === 'unavailable' ? 'unavailable' : 'rejected',
      };
    }
    if (
      request.credentialId !== this.credentialId ||
      !isExactRuntimeIngressCredentialScope(request.expectedScope, this.expectedScope)
    ) {
      await this.finish('rejected');
      return { status: 'rejected' };
    }
    const bytes = Buffer.alloc(RUNTIME_INGRESS_BEARER_MAX_LENGTH + 1);
    let offset = 0;
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      const settle = async (result: ConsumeRuntimeIngressRelaySecretResult): Promise<void> => {
        if (!this.pendingResolve) return;
        const pending = this.pendingResolve;
        this.pendingResolve = null;
        bytes.fill(0);
        await this.finish(result.status);
        pending(result);
      };
      try {
        this.stream = this.streamFactory(this.inheritedFd);
      } catch {
        void settle({ status: 'unavailable' });
        return;
      }
      this.stream.on('data', (chunk: Buffer) => {
        const available = bytes.byteLength - offset;
        const copied = Math.min(available, chunk.byteLength);
        chunk.copy(bytes, offset, 0, copied);
        offset += copied;
        chunk.fill(0);
        if (copied < chunk.byteLength || offset > RUNTIME_INGRESS_BEARER_MAX_LENGTH) {
          void settle({ status: 'rejected' });
        }
      });
      this.stream.once('end', () => {
        if (offset === 0 || offset > RUNTIME_INGRESS_BEARER_MAX_LENGTH) {
          void settle({ status: 'rejected' });
          return;
        }
        try {
          const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
          void settle(
            value.trim() === value
              ? { status: 'consumed', secret: parseRuntimeIngressPresentedSecret(value) }
              : { status: 'rejected' }
          );
        } catch {
          void settle({ status: 'rejected' });
        }
      });
      this.stream.once('error', () => void settle({ status: 'unavailable' }));
      this.stream.once('close', () => {
        if (this.terminalStatus === null) void settle({ status: 'unavailable' });
      });
    });
  }

  async dispose(): Promise<void> {
    await this.finish('unavailable');
    await this.consumeOperations;
  }

  private async finish(status: 'consumed' | 'rejected' | 'unavailable'): Promise<void> {
    if (this.terminalStatus === null) this.terminalStatus = status;
    clearTimeout(this.disposalTimer);
    this.stream?.destroy();
    this.closePromise ??= new Promise((resolve) => {
      close(this.inheritedFd, () => {
        claimedInheritedFds.delete(this.inheritedFd);
        resolve();
      });
    });
    await this.closePromise;
    const pending = this.pendingResolve;
    this.pendingResolve = null;
    pending?.({
      status: this.terminalStatus === 'rejected' ? 'rejected' : 'unavailable',
    });
  }
}
