import { fstat as nodeFstat, type Stats } from 'node:fs';
import { lstat as nodeLstat, realpath as nodeRealpath } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

import {
  DispatchAgentRuntimeLifecycleEffect,
  rejectInvalidAgentRuntimeLifecycleFrame,
} from '../../../../core/application/agent-runtime-lifecycle/DispatchAgentRuntimeLifecycleEffect';

import { AgentRuntimeLifecycleWireCodec } from './AgentRuntimeLifecycleWireCodec';

export interface AgentRuntimeLifecycleSocketConnection {
  readonly peerCredentials: {
    readonly source: string;
    readonly uid: number;
    readonly gid: number;
  };
  onData(listener: (chunk: Uint8Array) => void): void;
  onClose(listener: () => void): void;
  write(frame: string): Promise<void>;
  close(): void;
}

/** Expectations only. Filesystem provenance is established by the server after bind. */
export interface AgentRuntimeLifecycleListenerSecurityBinding {
  readonly kind: 'agent-runtime-lifecycle-listener-security-binding/v1';
  readonly bootId: string;
  readonly socketPath: string;
  readonly trustedParentDirectoryPath: string;
  readonly expectedParentOwnerUid: number;
  readonly expectedParentOwnerGid: number;
  readonly expectedOwnerUid: number;
  readonly expectedOwnerGid: number;
  readonly expectedPeerUid: number;
  readonly expectedPeerGid: number;
  readonly maximumConnections: number;
  readonly maximumInflight: number;
  readonly idleTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly dispatchTimeoutMs: number;
  readonly writeTimeoutMs: number;
}

export interface AgentRuntimeLifecycleSocketListenerPort {
  readonly securityBinding: AgentRuntimeLifecycleListenerSecurityBinding;
  onConnection(listener: (connection: AgentRuntimeLifecycleSocketConnection) => void): void;
  /**
   * Binds at a private staging pathname, opens that socket node with O_PATH,
   * atomically publishes it, then locks and retains the trusted parent directory.
   * Both identity descriptors and the locked directory remain live until stop completes.
   */
  start(): Promise<{
    readonly socketFd: number;
    readonly boundAddress: {
      readonly source: 'kernel_getsockname';
      readonly family: 'unix';
      readonly path: string;
    };
    readonly publishedPathIdentity: {
      readonly source: 'linux_o_path_before_atomic_publish_in_locked_parent';
      readonly socketNodeFd: number;
      readonly parentDirectoryFd: number;
      readonly stagedPath: string;
      readonly path: string;
      readonly parentDirectoryPath: string;
    };
  }>;
  stop(): Promise<void>;
}

export interface AgentRuntimeLifecycleSocketServerDeps {
  readonly listener: AgentRuntimeLifecycleSocketListenerPort;
  readonly dispatch: DispatchAgentRuntimeLifecycleEffect;
  readonly codec?: AgentRuntimeLifecycleWireCodec;
}

/** A private one-frame socket adapter; it does not register HTTP/IPC routes or own commands. */
export class AgentRuntimeLifecycleSocketServer {
  private readonly codec: AgentRuntimeLifecycleWireCodec;
  private readonly binding: AgentRuntimeLifecycleListenerSecurityBinding;
  private started = false;
  private listenerActive = false;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private connectionHandlerInstalled = false;
  private verifiedBootId: string | null = null;
  private activeConnections = 0;
  private inflight = 0;

  constructor(private readonly deps: AgentRuntimeLifecycleSocketServerDeps) {
    if (!isValidListenerSecurityBinding(deps.listener.securityBinding)) {
      throw new TypeError('agent-runtime-lifecycle-listener-not-machine-only');
    }
    this.codec = deps.codec ?? new AgentRuntimeLifecycleWireCodec();
    this.binding = Object.freeze({ ...deps.listener.securityBinding });
  }

  start(): Promise<void> {
    return this.serializeLifecycle(() => this.startOnce());
  }

  stop(): Promise<void> {
    return this.serializeLifecycle(() => this.stopOnce());
  }

  private async startOnce(): Promise<void> {
    if (this.started) return;
    if (this.listenerActive) {
      throw new Error('agent-runtime-lifecycle-listener-cleanup-required');
    }
    if (!this.connectionHandlerInstalled) {
      this.deps.listener.onConnection((connection) => this.accept(connection));
      this.connectionHandlerInstalled = true;
    }
    const bound = await this.deps.listener.start();
    this.listenerActive = true;
    try {
      await verifyPostBindSocket(this.binding, bound);
    } catch (verificationError) {
      try {
        await this.stopListener();
      } catch (cleanupError) {
        throw new AggregateError(
          [verificationError, cleanupError],
          'agent-runtime-lifecycle-listener-post-bind-cleanup-failed'
        );
      }
      throw verificationError;
    }
    this.verifiedBootId = this.binding.bootId;
    this.started = true;
  }

  private async stopOnce(): Promise<void> {
    if (!this.listenerActive) return;
    await this.stopListener();
  }

  private async stopListener(): Promise<void> {
    // Revoke acceptance before asynchronous teardown. A failed stop leaves the
    // listener in cleanup-required state and cannot be mistaken for stopped.
    this.started = false;
    this.verifiedBootId = null;
    await this.deps.listener.stop();
    this.listenerActive = false;
  }

  private serializeLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private accept(connection: AgentRuntimeLifecycleSocketConnection): void {
    const binding = this.binding;
    if (
      !this.started ||
      this.verifiedBootId !== binding.bootId ||
      this.activeConnections >= binding.maximumConnections ||
      connection.peerCredentials?.source !== 'kernel_peer_credentials' ||
      connection.peerCredentials.uid !== binding.expectedPeerUid ||
      connection.peerCredentials.gid !== binding.expectedPeerGid
    ) {
      connection.close();
      return;
    }

    this.activeConnections += 1;
    let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let closed = false;
    let frameAccepted = false;
    let connectionReleased = false;
    const timers: {
      read?: ReturnType<typeof setTimeout>;
      idle?: ReturnType<typeof setTimeout>;
    } = {};
    const close = () => {
      if (closed) return;
      closed = true;
      if (timers.read) clearTimeout(timers.read);
      if (timers.idle) clearTimeout(timers.idle);
      buffered = new Uint8Array();
      releaseConnection();
      connection.close();
    };
    const releaseConnection = () => {
      if (connectionReleased) return;
      connectionReleased = true;
      this.activeConnections -= 1;
    };
    timers.read = setTimeout(close, binding.readTimeoutMs);
    timers.idle = setTimeout(close, binding.idleTimeoutMs);

    connection.onClose(() => {
      closed = true;
      if (timers.read) clearTimeout(timers.read);
      if (timers.idle) clearTimeout(timers.idle);
      buffered = new Uint8Array();
      releaseConnection();
    });
    connection.onData((chunk) => {
      if (closed || !(chunk instanceof Uint8Array)) return;
      if (frameAccepted) {
        close();
        return;
      }
      if (buffered.byteLength + chunk.byteLength > this.codec.maximumFrameBytes) {
        frameAccepted = true;
        void this.writeThenClose(
          connection,
          this.codec.encode(rejectInvalidAgentRuntimeLifecycleFrame('invalid-request', null)),
          close
        );
        return;
      }
      buffered = appendBytes(buffered, chunk);
      const newline = buffered.indexOf(10);
      if (newline < 0) return;
      frameAccepted = true;
      if (timers.read) clearTimeout(timers.read);
      // Exactly one newline-delimited frame is permitted on each connection.
      if (newline !== buffered.byteLength - 1) {
        close();
        return;
      }
      const frameBytes = buffered.slice(0, newline);
      buffered = new Uint8Array();
      if (this.inflight >= binding.maximumInflight) {
        close();
        return;
      }
      this.inflight += 1;
      void this.dispatchOne(
        connection,
        frameBytes,
        close,
        () => closed,
        () => {
          this.inflight -= 1;
        }
      );
    });
  }

  private async dispatchOne(
    connection: AgentRuntimeLifecycleSocketConnection,
    frameBytes: Uint8Array,
    close: () => void,
    isClosed: () => boolean,
    releaseInflight: () => void
  ): Promise<void> {
    let dispatchStarted = false;
    try {
      const decoded = this.codec.decode(
        new TextDecoder('utf-8', { fatal: true }).decode(frameBytes)
      );
      let response;
      if (decoded.status === 'decoded') {
        const dispatchPromise = this.deps.dispatch.execute(decoded.request);
        dispatchStarted = true;
        void dispatchPromise.then(releaseInflight, releaseInflight);
        response = await withTimeout(dispatchPromise, this.binding.dispatchTimeoutMs);
      } else {
        response = rejectInvalidAgentRuntimeLifecycleFrame(decoded.requestId, decoded.effect);
      }
      if (!isClosed()) {
        await withTimeout(
          connection.write(this.codec.encode(response)),
          this.binding.writeTimeoutMs
        );
      }
    } catch {
      // Decode, dispatch, timeout, and write failures all fail closed.
    } finally {
      if (!dispatchStarted) releaseInflight();
      close();
    }
  }

  private async writeThenClose(
    connection: AgentRuntimeLifecycleSocketConnection,
    frame: string,
    close: () => void
  ): Promise<void> {
    try {
      await withTimeout(connection.write(frame), this.binding.writeTimeoutMs);
    } catch {
      // The peer may already be gone; closing remains mandatory.
    } finally {
      close();
    }
  }
}

export function isValidListenerSecurityBinding(
  value: unknown
): value is AgentRuntimeLifecycleListenerSecurityBinding {
  if (!isRecord(value) || value.kind !== 'agent-runtime-lifecycle-listener-security-binding/v1') {
    return false;
  }
  if (
    !hasExactKeys(value, [
      'kind',
      'bootId',
      'socketPath',
      'trustedParentDirectoryPath',
      'expectedParentOwnerUid',
      'expectedParentOwnerGid',
      'expectedOwnerUid',
      'expectedOwnerGid',
      'expectedPeerUid',
      'expectedPeerGid',
      'maximumConnections',
      'maximumInflight',
      'idleTimeoutMs',
      'readTimeoutMs',
      'dispatchTimeoutMs',
      'writeTimeoutMs',
    ])
  ) {
    return false;
  }
  const pathBytes =
    typeof value.socketPath === 'string'
      ? new TextEncoder().encode(value.socketPath).byteLength
      : 0;
  return (
    typeof value.socketPath === 'string' &&
    isSafeSocketPath(value.socketPath) &&
    pathBytes > 1 &&
    pathBytes <= 107 &&
    resolvePath(value.socketPath) === value.socketPath &&
    typeof value.trustedParentDirectoryPath === 'string' &&
    isSafeSocketPath(value.trustedParentDirectoryPath) &&
    resolvePath(value.trustedParentDirectoryPath) === value.trustedParentDirectoryPath &&
    dirname(value.socketPath) === value.trustedParentDirectoryPath &&
    isNonNegativeSafeInteger(value.expectedParentOwnerUid) &&
    isNonNegativeSafeInteger(value.expectedParentOwnerGid) &&
    value.expectedParentOwnerUid !== value.expectedPeerUid &&
    isNonNegativeSafeInteger(value.expectedOwnerUid) &&
    isNonNegativeSafeInteger(value.expectedOwnerGid) &&
    isNonNegativeSafeInteger(value.expectedPeerUid) &&
    isNonNegativeSafeInteger(value.expectedPeerGid) &&
    value.expectedPeerUid === value.expectedOwnerUid &&
    value.expectedPeerGid === value.expectedOwnerGid &&
    isPositiveBoundedInteger(value.maximumConnections, 1_024) &&
    isPositiveBoundedInteger(value.maximumInflight, value.maximumConnections) &&
    isBoundedTimeout(value.idleTimeoutMs) &&
    isBoundedTimeout(value.readTimeoutMs) &&
    isBoundedTimeout(value.dispatchTimeoutMs) &&
    isBoundedTimeout(value.writeTimeoutMs) &&
    isBoundedIdentifier(value.bootId, 512)
  );
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isSafeSocketPath(value: string): boolean {
  if (!value.startsWith('/')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

function isBoundedIdentifier(value: unknown, maximumLength: number): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

function isBoundedTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 30_000;
}

function isPositiveBoundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

async function verifyPostBindSocket(
  binding: AgentRuntimeLifecycleListenerSecurityBinding,
  bound: Awaited<ReturnType<AgentRuntimeLifecycleSocketListenerPort['start']>>
): Promise<void> {
  const { socketFd, boundAddress, publishedPathIdentity } = bound;
  if (!Number.isSafeInteger(socketFd) || socketFd < 0) {
    throw new TypeError('agent-runtime-lifecycle-listener-descriptor-invalid');
  }
  if (
    boundAddress?.source !== 'kernel_getsockname' ||
    boundAddress.family !== 'unix' ||
    !isSafeStagingSocketPath(boundAddress.path, binding.socketPath)
  ) {
    throw new TypeError('agent-runtime-lifecycle-listener-bound-address-invalid');
  }
  if (
    publishedPathIdentity?.source !== 'linux_o_path_before_atomic_publish_in_locked_parent' ||
    publishedPathIdentity.stagedPath !== boundAddress.path ||
    publishedPathIdentity.path !== binding.socketPath ||
    !Number.isSafeInteger(publishedPathIdentity.socketNodeFd) ||
    publishedPathIdentity.socketNodeFd < 0 ||
    !Number.isSafeInteger(publishedPathIdentity.parentDirectoryFd) ||
    publishedPathIdentity.parentDirectoryFd < 0 ||
    publishedPathIdentity.parentDirectoryPath !== binding.trustedParentDirectoryPath ||
    publishedPathIdentity.socketNodeFd === socketFd ||
    publishedPathIdentity.parentDirectoryFd === socketFd ||
    publishedPathIdentity.parentDirectoryFd === publishedPathIdentity.socketNodeFd
  ) {
    throw new TypeError('agent-runtime-lifecycle-listener-path-identity-invalid');
  }
  const [
    pathStatsBefore,
    parentStatsBefore,
    descriptorStats,
    pathIdentityStats,
    parentIdentityStats,
    canonicalPath,
    canonicalParentPath,
  ] = await Promise.all([
    nodeLstat(binding.socketPath),
    nodeLstat(binding.trustedParentDirectoryPath),
    nodeSocketFstat(socketFd),
    nodeSocketFstat(publishedPathIdentity.socketNodeFd),
    nodeSocketFstat(publishedPathIdentity.parentDirectoryFd),
    nodeRealpath(binding.socketPath),
    nodeRealpath(binding.trustedParentDirectoryPath),
  ]);
  const [pathStatsAfter, parentStatsAfter] = await Promise.all([
    nodeLstat(binding.socketPath),
    nodeLstat(binding.trustedParentDirectoryPath),
  ]);
  if (
    canonicalPath !== binding.socketPath ||
    canonicalParentPath !== binding.trustedParentDirectoryPath ||
    !isAuthorizedSocketPath(pathStatsBefore, binding) ||
    !isAuthorizedSocketPath(pathStatsAfter, binding) ||
    pathStatsBefore.dev !== pathStatsAfter.dev ||
    pathStatsBefore.ino !== pathStatsAfter.ino ||
    pathStatsBefore.dev !== pathIdentityStats.dev ||
    pathStatsBefore.ino !== pathIdentityStats.ino ||
    !isAuthorizedSocketPath(pathIdentityStats, binding) ||
    !isTrustedLockedDirectory(parentStatsBefore, binding) ||
    !isTrustedLockedDirectory(parentStatsAfter, binding) ||
    !isTrustedLockedDirectory(parentIdentityStats, binding) ||
    parentStatsBefore.dev !== parentStatsAfter.dev ||
    parentStatsBefore.ino !== parentStatsAfter.ino ||
    parentStatsBefore.dev !== parentIdentityStats.dev ||
    parentStatsBefore.ino !== parentIdentityStats.ino ||
    !descriptorStats.isSocket() ||
    descriptorStats.uid !== binding.expectedOwnerUid ||
    descriptorStats.gid !== binding.expectedOwnerGid
  ) {
    throw new TypeError('agent-runtime-lifecycle-listener-post-bind-proof-invalid');
  }
  await verifyTrustedDirectoryChain(binding, parentIdentityStats);
}

async function verifyTrustedDirectoryChain(
  binding: AgentRuntimeLifecycleListenerSecurityBinding,
  parentIdentityStats: Stats
): Promise<void> {
  const paths: string[] = [];
  let currentPath = binding.trustedParentDirectoryPath;
  while (true) {
    paths.push(currentPath);
    const nextPath = dirname(currentPath);
    if (nextPath === currentPath) break;
    currentPath = nextPath;
  }
  const before = await Promise.all(paths.map((path) => nodeLstat(path)));
  const after = await Promise.all(paths.map((path) => nodeLstat(path)));
  for (let index = 0; index < paths.length; index += 1) {
    const beforeStats = before[index];
    const afterStats = after[index];
    if (
      !beforeStats ||
      !afterStats ||
      !isTrustedLockedAncestor(beforeStats, binding.expectedPeerUid) ||
      !isTrustedLockedAncestor(afterStats, binding.expectedPeerUid) ||
      beforeStats.dev !== afterStats.dev ||
      beforeStats.ino !== afterStats.ino ||
      (index === 0 &&
        (beforeStats.dev !== parentIdentityStats.dev ||
          beforeStats.ino !== parentIdentityStats.ino))
    ) {
      throw new TypeError('agent-runtime-lifecycle-listener-post-bind-proof-invalid');
    }
  }
}

function isTrustedLockedAncestor(stats: Stats, expectedPeerUid: number): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isDirectory() &&
    stats.uid !== expectedPeerUid &&
    (stats.mode & 0o022) === 0 &&
    (stats.mode & 0o111) === 0o111
  );
}

function isTrustedLockedDirectory(
  stats: Stats,
  binding: AgentRuntimeLifecycleListenerSecurityBinding
): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isDirectory() &&
    stats.uid === binding.expectedParentOwnerUid &&
    stats.gid === binding.expectedParentOwnerGid &&
    stats.uid !== binding.expectedPeerUid &&
    (stats.mode & 0o222) === 0 &&
    (stats.mode & 0o111) === 0o111
  );
}

function isSafeStagingSocketPath(value: string, publishedPath: string): boolean {
  const pathBytes = new TextEncoder().encode(value).byteLength;
  return (
    value !== publishedPath &&
    pathBytes > 1 &&
    pathBytes <= 107 &&
    isSafeSocketPath(value) &&
    resolvePath(value) === value
  );
}

function isAuthorizedSocketPath(
  stats: Stats,
  binding: AgentRuntimeLifecycleListenerSecurityBinding
): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isSocket() &&
    stats.uid === binding.expectedOwnerUid &&
    stats.gid === binding.expectedOwnerGid &&
    (stats.mode & 0o177) === 0
  );
}

function nodeSocketFstat(fd: number): Promise<Stats> {
  return new Promise<Stats>((resolve, reject) => {
    nodeFstat(fd, (error, stats) => (error ? reject(error) : resolve(stats)));
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent-runtime-lifecycle-timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
