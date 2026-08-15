import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readFile, realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import {
  decodeHostedApprovalTransitionResponse,
  encodeHostedApprovalTransitionRequest,
  HOSTED_APPROVAL_TRANSITION_MAXIMUM_FRAME_BYTES,
  type HostedApprovalTransitionError,
  type HostedApprovalTransitionOperation,
  type HostedApprovalTransitionProductProjection,
  type HostedApprovalTransitionRequest,
  type HostedApprovalTransitionRequestPayload,
  type HostedApprovalTransitionResponse,
  type HostedApprovalTransitionSuccessPayload,
  immutableHostedApprovalTransitionValue,
} from './hostedApprovalTransitionWire';

import type {
  HostedApprovalRuntimeProjectionPin,
  HostedApprovalRuntimeProjectionSource,
} from './HostedApprovalRuntimeProjectionSource';
import type {
  AuthoritativeHostedApprovalRuntimeBindingLease,
  AuthoritativeHostedApprovalRuntimeBindingPin,
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimeOwnerIdentity,
} from '@main/services/team/provisioning/HostedApprovalRuntimeAdmissionPublisher';
import type { HostedApprovalRuntimeTransitionEvidence } from '@main/services/team/provisioning/HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
import type { HostedApprovalRuntimeOwnerLeaseContract } from '@main/services/team/provisioning/HostedApprovalRuntimeProductionLifecycleBoundary';

const execFileAsync = promisify(execFile);
const OPERATION_BUDGET_MS = Object.freeze({
  acquire: 5_000,
  consume: 5_000,
  assert: 2_000,
  release: 5_000,
});
const CONNECT_BUDGET_MS = 2_000;

class HostedApprovalTransitionIdentityError extends Error {}

export interface HostedApprovalTransitionPeerCredentials {
  readonly source: 'kernel_peer_credentials';
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

export interface HostedApprovalRuntimeOwnerLeaseClientOptions {
  readonly projectionSource: HostedApprovalRuntimeProjectionSource;
  /** Exact 32 raw bootstrap-secret bytes. The client copies and later zeroes this memory. */
  readonly bootstrapSecret: Uint8Array;
  /** Required native adapter: SO_PEERCRED on Linux; LOCAL_PEERPID plus getpeereid on Darwin. */
  readonly inspectPeerCredentials: (
    socket: Socket
  ) => Promise<HostedApprovalTransitionPeerCredentials>;
  readonly connect?: (path: string) => Socket;
  readonly readProcessStartIdentity?: (pid: number) => Promise<string | null>;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly randomTransitionId?: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
  /** Focused-test seam; production omits this and uses the descriptor and peer checks below. */
  readonly exchangeVerifiedFrame?: (
    owner: HostedApprovalRuntimeOwnerIdentity,
    frame: Uint8Array,
    timeoutMs: number
  ) => Promise<Uint8Array>;
}

export class HostedApprovalTransitionRemoteError extends Error {
  constructor(readonly wireError: HostedApprovalTransitionError) {
    super(`hosted-approval-transition-${wireError.code.toLowerCase()}`);
    this.name = 'HostedApprovalTransitionRemoteError';
  }
}

export function assertHostedApprovalTransitionPeerCredentials(
  peer: HostedApprovalTransitionPeerCredentials,
  owner: HostedApprovalRuntimeOwnerIdentity
): void {
  if (
    peer.source !== 'kernel_peer_credentials' ||
    peer.pid !== owner.processIdentity.pid ||
    peer.uid !== owner.socketIdentity.uid
  ) {
    throw new HostedApprovalTransitionIdentityError(
      'hosted-approval-transition-peer-identity-mismatch'
    );
  }
}

export function assertHostedApprovalTransitionSocketIdentity(
  actual: Readonly<{
    device: string;
    inode: string;
    uid: number;
    gid: number;
    mode: number;
    socket: boolean;
    symbolicLink: boolean;
  }>,
  owner: HostedApprovalRuntimeOwnerIdentity,
  effectiveUid: number | undefined
): void {
  const expected = owner.socketIdentity;
  if (
    !actual.socket ||
    actual.symbolicLink ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.uid !== expected.uid ||
    actual.gid !== expected.gid ||
    actual.mode !== 0o600 ||
    expected.uid !== effectiveUid
  ) {
    throw new HostedApprovalTransitionIdentityError(
      'hosted-approval-transition-socket-identity-mismatch'
    );
  }
}

export function writeHostedApprovalTransitionFrameBeforeDeadline(
  socket: Pick<Socket, 'write'>,
  frame: Uint8Array,
  deadlineMonotonic: number,
  monotonicNow: () => number
): void {
  if (monotonicNow() >= deadlineMonotonic)
    throw new Error('hosted-approval-transition-request-timeout');
  socket.write(frame);
}

interface LeaseState {
  readonly transitionId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly projectionDigest: string;
  readonly bindingDigest: string;
  readonly projectionPin: HostedApprovalRuntimeProjectionPin;
  sequence: number;
  consumed: boolean;
  released: boolean;
  terminalObservation: boolean;
}

/** Authenticated, single-owner adapter for HostedApprovalTransitionWire v1. */
export class HostedApprovalRuntimeOwnerLeaseClient implements HostedApprovalRuntimeOwnerLeaseContract {
  private readonly secret: Buffer;
  private readonly projectionSource: HostedApprovalRuntimeProjectionSource;
  private readonly inspectPeerCredentials: (
    socket: Socket
  ) => Promise<HostedApprovalTransitionPeerCredentials>;
  private readonly exchangeVerifiedFrame: HostedApprovalRuntimeOwnerLeaseClientOptions['exchangeVerifiedFrame'];
  private readonly connect: (path: string) => Socket;
  private readonly readProcessStartIdentity: (pid: number) => Promise<string | null>;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly randomTransitionId: () => string;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private closed = false;

  constructor(options: HostedApprovalRuntimeOwnerLeaseClientOptions) {
    if (options.bootstrapSecret.byteLength !== 32)
      throw new TypeError('hosted-approval-transition-secret-invalid');
    this.secret = Buffer.from(options.bootstrapSecret);
    this.projectionSource = options.projectionSource;
    this.inspectPeerCredentials = options.inspectPeerCredentials;
    this.exchangeVerifiedFrame = options.exchangeVerifiedFrame;
    this.connect = options.connect ?? ((path) => createConnection({ path }));
    this.readProcessStartIdentity =
      options.readProcessStartIdentity ?? readHostedApprovalProcessStartIdentity;
    this.now = options.now ?? Date.now;
    this.monotonicNow =
      options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.randomTransitionId =
      options.randomTransitionId ??
      (() => `approval-transition_${randomBytes(16).toString('hex')}`);
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** Must be called on authenticated-owner loss and shutdown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.secret.fill(0);
  }

  async acquireTransitionEvidence(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimeTransitionEvidence | null> {
    this.assertOpen();
    const projectionPin = await this.projectionSource.pin(teamName, lifecycle);
    if (!projectionPin || !(await projectionPin.assertCurrent())) return null;
    const transitionId = this.randomTransitionId();
    let sequence = 1;
    const acquired = await this.operation(
      transitionId,
      'acquire',
      () => sequence,
      (next) => {
        sequence = next;
      },
      projectionPin.projection,
      () => ({
        productProjection: projectionPin.projection,
        projectionDigest: projectionPin.projectionDigest,
      })
    );
    if (acquired.status !== 'acquired') return null;
    const state: LeaseState = {
      transitionId,
      leaseId: acquired.leaseId,
      generation: acquired.generation,
      projectionDigest: acquired.projectionDigest,
      bindingDigest: acquired.bindingDigest,
      projectionPin,
      sequence,
      consumed: false,
      released: false,
      terminalObservation: false,
    };
    if (!(await projectionPin.assertCurrent())) {
      await this.releaseState(state).catch(() => undefined);
      return null;
    }
    const lease: AuthoritativeHostedApprovalRuntimeBindingLease = Object.freeze({
      token: acquired.leaseId,
      binding: immutableHostedApprovalTransitionValue(structuredClone(acquired.binding)),
      consume: () => this.consume(state),
    });
    return Object.freeze({
      lifecycle: immutableHostedApprovalTransitionValue(structuredClone(lifecycle)),
      lease,
      resolveExpectedInstalledArtifactDigest: projectionPin.resolveExpectedInstalledArtifactDigest,
    });
  }

  private async consume(
    state: LeaseState
  ): Promise<AuthoritativeHostedApprovalRuntimeBindingPin | null> {
    if (state.consumed || state.released) return null;
    if (!(await state.projectionPin.assertCurrent())) {
      await this.releaseState(state).catch(() => undefined);
      return null;
    }
    const consumed = await this.operation(
      state.transitionId,
      'consume',
      () => state.sequence,
      (next) => {
        state.sequence = next;
      },
      state.projectionPin.projection,
      () => ({
        leaseId: state.leaseId,
        generation: state.generation,
        projectionDigest: state.projectionDigest,
        bindingDigest: state.bindingDigest,
      })
    );
    if (consumed.status !== 'consumed') return null;
    state.consumed = true;
    if (!(await state.projectionPin.assertCurrent())) {
      await this.releaseState(state).catch(() => undefined);
      return null;
    }
    const binding = immutableHostedApprovalTransitionValue(structuredClone(consumed.binding));
    const pin: AuthoritativeHostedApprovalRuntimeBindingPin = Object.freeze({
      binding,
      assertCurrent: async () => {
        if (!state.consumed || state.released || state.terminalObservation) return false;
        if (!(await state.projectionPin.assertCurrent())) {
          state.terminalObservation = true;
          return false;
        }
        const asserted = await this.operation(
          state.transitionId,
          'assert',
          () => state.sequence,
          (next) => {
            state.sequence = next;
          },
          state.projectionPin.projection,
          () => ({
            leaseId: state.leaseId,
            generation: state.generation,
            bindingDigest: state.bindingDigest,
          })
        );
        const current =
          asserted.status === 'asserted' &&
          asserted.current &&
          (await state.projectionPin.assertCurrent());
        if (!current) state.terminalObservation = true;
        return current;
      },
      release: async () => {
        await this.releaseState(state);
      },
    });
    return pin;
  }

  private async operation<T extends HostedApprovalTransitionOperation>(
    transitionId: string,
    operation: T,
    getSequence: () => number,
    setSequence: (sequence: number) => void,
    projection: HostedApprovalTransitionProductProjection,
    payload: () => HostedApprovalTransitionRequestPayload<T>
  ): Promise<HostedApprovalTransitionSuccessPayload<T>> {
    for (;;) {
      this.assertOpen();
      const sequence = getSequence();
      const budget = OPERATION_BUDGET_MS[operation];
      const startedMonotonic = this.monotonicNow();
      const deadlineAtMs = this.now() + budget;
      const request = Object.freeze({
        schemaVersion: 1,
        transitionId,
        operation,
        sequence,
        deadlineAtMs,
        payload: payload(),
      }) as HostedApprovalTransitionRequest<T>;
      const encoded = encodeHostedApprovalTransitionRequest(request, this.secret);
      const response = await this.exchangeExactReplay(
        request,
        encoded.frame,
        encoded.requestDigest,
        projection,
        startedMonotonic,
        budget
      );
      setSequence(sequence + 1);
      if ('payload' in response) {
        return response.payload;
      }
      const remote = response.error;
      if (!remote.retryable || remote.retryScope !== 'same_operation') {
        throw new HostedApprovalTransitionRemoteError(remote);
      }
      if (remote.retryAfterMs !== null && remote.retryAfterMs > 0)
        await this.wait(remote.retryAfterMs);
    }
  }

  private async exchangeExactReplay<T extends HostedApprovalTransitionOperation>(
    request: HostedApprovalTransitionRequest<T>,
    frame: Uint8Array,
    requestDigest: string,
    projection: HostedApprovalTransitionProductProjection,
    startedMonotonic: number,
    budget: number
  ): Promise<HostedApprovalTransitionResponse<T>> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = budget - (this.monotonicNow() - startedMonotonic);
      if (remaining <= 0) break;
      try {
        const responseFrame = await this.exchangeFrame(frame, projection.expectedOwner, remaining);
        return decodeHostedApprovalTransitionResponse(
          responseFrame,
          request,
          requestDigest,
          this.secret,
          projection
        );
      } catch (error) {
        if (error instanceof TypeError || error instanceof HostedApprovalTransitionIdentityError)
          throw error;
        lastError =
          error instanceof Error
            ? error
            : new Error('hosted-approval-transition-exchange-failed', { cause: error });
      }
    }
    throw lastError ?? new Error('hosted-approval-transition-deadline-exceeded');
  }

  private async exchangeFrame(
    frame: Uint8Array,
    owner: HostedApprovalRuntimeOwnerIdentity,
    remainingMs: number
  ): Promise<Uint8Array> {
    if (this.exchangeVerifiedFrame) {
      return this.exchangeVerifiedFrame(owner, frame, remainingMs);
    }
    const started = this.monotonicNow();
    const deadlineMonotonic = started + remainingMs;
    const parent = await this.identityCheck(() => this.pinSocketParent(owner));
    let socket: Socket | null = null;
    try {
      await this.identityCheck(() => this.assertSocketAndProcess(owner, parent));
      socket = this.connect(owner.socketPath);
      await waitForConnect(socket, Math.min(CONNECT_BUDGET_MS, remainingMs));
      const peer = await this.inspectPeerCredentials(socket);
      assertHostedApprovalTransitionPeerCredentials(peer, owner);
      await this.identityCheck(() => this.assertSocketAndProcess(owner, parent));
      writeHostedApprovalTransitionFrameBeforeDeadline(
        socket,
        frame,
        deadlineMonotonic,
        this.monotonicNow
      );
      const responseBudget = deadlineMonotonic - this.monotonicNow();
      if (responseBudget <= 0) throw new Error('hosted-approval-transition-response-timeout');
      const response = await readSingleFrame(
        socket,
        responseBudget,
        HOSTED_APPROVAL_TRANSITION_MAXIMUM_FRAME_BYTES
      );
      await this.identityCheck(() => this.assertSocketAndProcess(owner, parent));
      return response;
    } finally {
      socket?.destroy();
      await parent.handle.close().catch(() => undefined);
    }
  }

  private async identityCheck<T>(check: () => Promise<T>): Promise<T> {
    try {
      return await check();
    } catch (error) {
      if (error instanceof HostedApprovalTransitionIdentityError) throw error;
      throw new HostedApprovalTransitionIdentityError(
        'hosted-approval-transition-identity-check-unavailable',
        { cause: error }
      );
    }
  }

  private async pinSocketParent(owner: HostedApprovalRuntimeOwnerIdentity): Promise<PinnedParent> {
    const parentPath = dirname(owner.socketPath);
    if ((await realpath(parentPath)) !== parentPath)
      throw new HostedApprovalTransitionIdentityError(
        'hosted-approval-transition-parent-noncanonical'
      );
    const before = await lstat(parentPath, { bigint: true });
    const expectedUid = process.geteuid?.();
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      expectedUid === undefined ||
      Number(before.uid) !== expectedUid ||
      Number(before.mode & 0o022n) !== 0
    ) {
      throw new HostedApprovalTransitionIdentityError(
        'hosted-approval-transition-parent-identity-invalid'
      );
    }
    const handle = await open(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const pinned = await handle.stat({ bigint: true });
    if (pinned.dev !== before.dev || pinned.ino !== before.ino) {
      await handle.close();
      throw new HostedApprovalTransitionIdentityError(
        'hosted-approval-transition-parent-substituted'
      );
    }
    return { handle, path: parentPath, device: pinned.dev, inode: pinned.ino };
  }

  private async assertSocketAndProcess(
    owner: HostedApprovalRuntimeOwnerIdentity,
    parent: PinnedParent
  ): Promise<void> {
    const parentStat = await parent.handle.stat({ bigint: true });
    if (parentStat.dev !== parent.device || parentStat.ino !== parent.inode)
      throw new HostedApprovalTransitionIdentityError(
        'hosted-approval-transition-parent-substituted'
      );
    const parentPathStat = await lstat(parent.path, { bigint: true });
    if (
      !parentPathStat.isDirectory() ||
      parentPathStat.isSymbolicLink() ||
      parentPathStat.dev !== parent.device ||
      parentPathStat.ino !== parent.inode
    )
      throw new HostedApprovalTransitionIdentityError(
        'hosted-approval-transition-parent-substituted'
      );
    const stat = await lstat(owner.socketPath, { bigint: true });
    assertHostedApprovalTransitionSocketIdentity(
      {
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        uid: Number(stat.uid),
        gid: Number(stat.gid),
        mode: Number(stat.mode & 0o777n),
        socket: stat.isSocket(),
        symbolicLink: stat.isSymbolicLink(),
      },
      owner,
      process.geteuid?.()
    );
    const startIdentity = await this.readProcessStartIdentity(owner.processIdentity.pid);
    if (startIdentity !== owner.processIdentity.startIdentity)
      throw new HostedApprovalTransitionIdentityError(
        'hosted-approval-transition-process-identity-mismatch'
      );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('hosted-approval-transition-client-closed');
  }

  private async releaseState(state: LeaseState): Promise<void> {
    if (state.released) return;
    const released = await this.operation(
      state.transitionId,
      'release',
      () => state.sequence,
      (next) => {
        state.sequence = next;
      },
      state.projectionPin.projection,
      () => ({
        leaseId: state.leaseId,
        generation: state.generation,
        bindingDigest: state.bindingDigest,
      })
    );
    if (released.status !== 'released')
      throw new Error('hosted-approval-transition-release-invalid');
    state.released = true;
  }
}

interface PinnedParent {
  readonly handle: FileHandle;
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export async function readHostedApprovalProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  let source: string;
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 0) return null;
      const fields = stat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/u);
      const startTick = fields[19];
      if (!startTick || !/^\d+$/u.test(startTick)) return null;
      source = `proc:${startTick}`;
    } else if (process.platform === 'darwin') {
      const result = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
      });
      const start = result.stdout.trim();
      if (!start) return null;
      source = `ps:${start}`;
    } else return null;
  } catch {
    return null;
  }
  return `start_${createHash('sha256').update(String(pid), 'utf8').update('\0').update(source, 'utf8').digest('hex')}`;
}

function waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return Promise.reject(new Error('hosted-approval-transition-connect-timeout'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('hosted-approval-transition-connect-timeout')),
      timeoutMs
    );
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onConnect = (): void => finish();
    const onError = (error: Error): void => finish(error);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function readSingleFrame(
  socket: Socket,
  timeoutMs: number,
  maximumBytes: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let delimiterSeen = false;
    const timer = setTimeout(
      () => finish(new Error('hosted-approval-transition-response-timeout')),
      timeoutMs
    );
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, bytes));
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        socket.destroy();
        finish(new Error('hosted-approval-transition-response-too-large'));
        return;
      }
      if (delimiterSeen || chunk.subarray(0, -1).includes(0x0a) || chunk.includes(0x0d)) {
        socket.destroy();
        finish(new Error('hosted-approval-transition-response-framing-invalid'));
        return;
      }
      if (chunk.includes(0x0a)) delimiterSeen = true;
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void =>
      delimiterSeen ? finish() : finish(new Error('hosted-approval-transition-response-truncated'));
    const onClose = (): void =>
      delimiterSeen ? finish() : finish(new Error('hosted-approval-transition-response-truncated'));
    const onError = (error: Error): void => finish(error);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}
