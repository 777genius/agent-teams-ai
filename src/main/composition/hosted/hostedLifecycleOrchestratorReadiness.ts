import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, normalize } from 'node:path';

import type { Socket } from 'node:net';

const HANDSHAKE_SCHEMA_VERSION = 1;
const HANDSHAKE_CAPABILITY = 'hosted-lifecycle-command';
const MAXIMUM_HANDSHAKE_BYTES = 4_096;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;

export interface HostedLifecycleOrchestratorReadinessOptions {
  readonly socketPath: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly expectedMode: number;
  readonly handshakeTimeoutMs?: number;
  readonly onOwnerLoss: () => void;
}

function validateIdentityPart(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`hosted-lifecycle-orchestrator-${name}-invalid`);
  }
  return value;
}

function validateMode(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o777) {
    throw new TypeError('hosted-lifecycle-orchestrator-mode-invalid');
  }
  return value;
}

function validateSocketPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    Buffer.byteLength(value) > 103
  ) {
    throw new TypeError('hosted-lifecycle-orchestrator-socket-path-invalid');
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError('hosted-lifecycle-orchestrator-handshake-timeout-invalid');
  }
  return value;
}

function isReadyResponse(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const response = value as Readonly<Record<string, unknown>>;
  return (
    response.schemaVersion === HANDSHAKE_SCHEMA_VERSION &&
    response.kind === 'ready' &&
    response.owner === 'external-orchestrator' &&
    response.capability === HANDSHAKE_CAPABILITY
  );
}

/**
 * Holds a readiness lease from the external lifecycle owner. This transport is only an admission
 * boundary: it neither serves the socket nor starts, supervises, or implements lifecycle work.
 */
export class HostedLifecycleOrchestratorReadiness {
  private ready = false;
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    private readonly onOwnerLoss: () => void
  ) {}

  static async connect(
    options: HostedLifecycleOrchestratorReadinessOptions
  ): Promise<HostedLifecycleOrchestratorReadiness> {
    const socketPath = validateSocketPath(options.socketPath);
    const expectedUid = validateIdentityPart(options.expectedUid, 'uid');
    const expectedGid = validateIdentityPart(options.expectedGid, 'gid');
    const expectedMode = validateMode(options.expectedMode);
    const timeoutMs = validateTimeout(options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    const stat = await lstat(socketPath);
    if (
      !stat.isSocket() ||
      stat.isSymbolicLink() ||
      stat.uid !== expectedUid ||
      stat.gid !== expectedGid ||
      (stat.mode & 0o777) !== expectedMode
    ) {
      throw new Error('hosted-lifecycle-orchestrator-socket-identity-invalid');
    }

    const socket = createConnection({ path: socketPath });
    try {
      await new Promise<void>((resolve, reject) => {
        let response = '';
        let responseBytes = 0;
        let settled = false;
        let handshakeDeadline: ReturnType<typeof setTimeout> | null = null;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          if (handshakeDeadline !== null) clearTimeout(handshakeDeadline);
          socket.removeListener('error', onError);
          socket.removeListener('close', onClose);
          socket.removeListener('data', onData);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onError = (): void =>
          finish(new Error('hosted-lifecycle-orchestrator-handshake-unavailable'));
        const onClose = (): void =>
          finish(new Error('hosted-lifecycle-orchestrator-handshake-incomplete'));
        const onData = (chunk: Buffer): void => {
          responseBytes += chunk.byteLength;
          if (responseBytes > MAXIMUM_HANDSHAKE_BYTES) {
            finish(new Error('hosted-lifecycle-orchestrator-handshake-invalid'));
            return;
          }
          response += chunk.toString('utf8');
          const newline = response.indexOf('\n');
          if (newline < 0) return;
          if (response.slice(newline + 1).trim().length !== 0) {
            finish(new Error('hosted-lifecycle-orchestrator-handshake-invalid'));
            return;
          }
          try {
            if (!isReadyResponse(JSON.parse(response.slice(0, newline)))) throw new Error();
            finish();
          } catch {
            finish(new Error('hosted-lifecycle-orchestrator-handshake-invalid'));
          }
        };
        handshakeDeadline = setTimeout(
          () => finish(new Error('hosted-lifecycle-orchestrator-handshake-timeout')),
          timeoutMs
        );
        socket.once('error', onError);
        socket.once('close', onClose);
        socket.on('data', onData);
        socket.once('connect', () => {
          socket.write(
            `${JSON.stringify({
              schemaVersion: HANDSHAKE_SCHEMA_VERSION,
              operation: 'readiness',
              capability: HANDSHAKE_CAPABILITY,
            })}\n`
          );
        });
      });
    } catch (error) {
      socket.destroy();
      throw error;
    }

    const readiness = new HostedLifecycleOrchestratorReadiness(socket, options.onOwnerLoss);
    readiness.ready = true;
    socket.once('error', () => readiness.loseOwner());
    socket.once('end', () => readiness.loseOwner());
    socket.once('close', () => readiness.loseOwner());
    return readiness;
  }

  isReady(): boolean {
    return this.ready && !this.closed && !this.socket.destroyed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.socket.destroy();
  }

  private loseOwner(): void {
    if (!this.ready || this.closed) return;
    this.ready = false;
    this.socket.destroy();
    this.onOwnerLoss();
  }
}
