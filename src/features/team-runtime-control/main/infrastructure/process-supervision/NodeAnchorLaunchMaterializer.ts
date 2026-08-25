import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  computeCanonicalPolicyDigest,
  type SpawnIntent,
} from '../../../core/domain/process-supervision';

import type { ResolvedRuntimeBinaryPolicy } from '../../../contracts';
import type {
  ResolvedEnvironmentAuthorityRef,
  ResolvedExecutableAuthorityRef,
  ResolvedProcessEnvironmentAuthority,
  ResolvedProcessWorkdirAuthority,
  ResolvedWorkdirAuthorityRef,
  WorkspaceExecutionGrant,
} from '../../../core/application/ports';
import type { AnchorSpawnRequest } from '../../adapters/output/process-supervision/AnchorProcessSupervisorAdapter';

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENVIRONMENT_VARIABLES = 256;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1_024;
const MAX_ENVIRONMENT_BYTES = 256 * 1_024;
const PORTABLE_O_CLOEXEC =
  (constants as Readonly<Record<string, number | undefined>>).O_CLOEXEC ?? 0;

export interface NodeExecutableLaunchAuthority {
  readonly executableRef: ResolvedExecutableAuthorityRef;
  readonly executablePath: string;
  readonly binaryPolicy: ResolvedRuntimeBinaryPolicy;
}

export interface NodeWorkdirLaunchAuthority {
  readonly workdirRef: ResolvedWorkdirAuthorityRef;
  readonly workdirPath: string;
  readonly grant: WorkspaceExecutionGrant;
  readonly registeredRootEvidence: NodeRegisteredWorkdirEvidence;
}

/** Descriptor evidence captured when the workspace root is registered for this boot/mount. */
export interface NodeRegisteredWorkdirEvidence {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mountId: bigint;
}

export interface NodeEnvironmentLaunchAuthority {
  readonly environmentRef: ResolvedEnvironmentAuthorityRef;
  readonly policy: ResolvedProcessEnvironmentAuthority['policy'];
  readonly values: Readonly<Record<string, string>>;
}

export interface NodeAnchorLaunchAuthorityCatalog {
  readonly executables: readonly NodeExecutableLaunchAuthority[];
  readonly workdirs: readonly NodeWorkdirLaunchAuthority[];
  readonly environments: readonly NodeEnvironmentLaunchAuthority[];
}

export interface MaterializedNodeAnchorLaunch {
  readonly executablePath: string;
  readonly executableDescriptor: number;
  readonly argv: readonly string[];
  readonly workdirPath: string;
  readonly workdirDescriptor: number;
  readonly environment: readonly Readonly<{ name: string; value: string }>[];
  close(): Promise<void>;
}

/** Main-process-only resolver from opaque launch authorities to concrete OS material. */
export class NodeAnchorLaunchMaterializer {
  private readonly executables: ReadonlyMap<
    ResolvedExecutableAuthorityRef,
    NodeExecutableLaunchAuthority
  >;
  private readonly workdirs: ReadonlyMap<ResolvedWorkdirAuthorityRef, NodeWorkdirLaunchAuthority>;
  private readonly environments: ReadonlyMap<
    ResolvedEnvironmentAuthorityRef,
    NodeEnvironmentLaunchAuthority
  >;

  constructor(catalog: NodeAnchorLaunchAuthorityCatalog) {
    this.executables = uniqueCatalog(catalog.executables, (entry) => entry.executableRef);
    this.workdirs = uniqueCatalog(catalog.workdirs, (entry) => entry.workdirRef);
    this.environments = uniqueCatalog(catalog.environments, (entry) => entry.environmentRef);
  }

  async materialize(request: AnchorSpawnRequest): Promise<MaterializedNodeAnchorLaunch> {
    requireIsolationFlags(request);
    const executable = this.executables.get(request.executableAuthority);
    const workdir = this.workdirs.get(request.workdirAuthority.workdirRef);
    const environment = this.environments.get(request.environmentAuthority.environmentRef);
    if (!executable || !workdir || !environment) {
      throw new TypeError('anchor-launch-authority-unavailable');
    }

    validateExecutableBinding(executable, request.intent);
    validateWorkdirBinding(workdir, request.workdirAuthority);
    validateEnvironmentBinding(environment, request);

    const executableHandle = await openRegularFile(
      executable.executablePath,
      'anchor-launch-executable'
    );
    let workdirHandle: Awaited<ReturnType<typeof openDirectory>> | undefined;
    try {
      workdirHandle = await openDirectory(workdir.workdirPath, 'anchor-launch-workdir');
      await validateRegisteredRootBinding(workdir, workdirHandle.handle);
      const actualBinaryHash = await sha256File(executableHandle.handle);
      if (actualBinaryHash !== executable.binaryPolicy.binaryHash) {
        throw new TypeError('anchor-launch-executable-hash-mismatch');
      }
      return createMaterializedLaunch({
        executablePath: executableHandle.path,
        executableHandle: executableHandle.handle,
        argv: request.argv,
        workdirPath: workdirHandle.path,
        workdirHandle: workdirHandle.handle,
        environment: materializeEnvironment(environment),
      });
    } catch (error) {
      await Promise.allSettled([executableHandle.handle.close(), workdirHandle?.handle.close()]);
      throw error;
    }
  }
}

function createMaterializedLaunch(input: {
  readonly executablePath: string;
  readonly executableHandle: FileHandle;
  readonly argv: readonly string[];
  readonly workdirPath: string;
  readonly workdirHandle: FileHandle;
  readonly environment: MaterializedNodeAnchorLaunch['environment'];
}): MaterializedNodeAnchorLaunch {
  let closed = false;
  return Object.freeze({
    executablePath: input.executablePath,
    executableDescriptor: input.executableHandle.fd,
    argv: Object.freeze([...input.argv]),
    workdirPath: input.workdirPath,
    workdirDescriptor: input.workdirHandle.fd,
    environment: input.environment,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([
        input.executableHandle.close(),
        input.workdirHandle.close(),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failure) throw failure.reason;
    },
  });
}

function requireIsolationFlags(request: AnchorSpawnRequest): void {
  if (
    request.shell !== false ||
    request.inheritParentEnvironment !== false ||
    request.closeUndeclaredDescriptors !== true
  ) {
    throw new TypeError('anchor-launch-isolation-required');
  }
}

function validateExecutableBinding(
  authority: NodeExecutableLaunchAuthority,
  intent: SpawnIntent
): void {
  if (
    computeCanonicalPolicyDigest(authority.binaryPolicy) !==
    computeCanonicalPolicyDigest(intent.binaryBinding)
  ) {
    throw new TypeError('anchor-launch-executable-authority-mismatch');
  }
}

function validateWorkdirBinding(
  authority: NodeWorkdirLaunchAuthority,
  request: ResolvedProcessWorkdirAuthority
): void {
  if (!sameWorkspaceGrant(authority.grant, request.grant)) {
    throw new TypeError('anchor-launch-workdir-authority-mismatch');
  }
}

function validateEnvironmentBinding(
  authority: NodeEnvironmentLaunchAuthority,
  request: AnchorSpawnRequest
): void {
  const policyDigest = computeCanonicalPolicyDigest(authority.policy);
  if (
    policyDigest !== computeCanonicalPolicyDigest(request.environmentAuthority.policy) ||
    policyDigest !== request.intent.environmentPolicyDigest
  ) {
    throw new TypeError('anchor-launch-environment-authority-mismatch');
  }
}

async function validateRegisteredRootBinding(
  authority: NodeWorkdirLaunchAuthority,
  handle: FileHandle
): Promise<void> {
  const expected = authority.registeredRootEvidence;
  if (
    typeof expected.device !== 'bigint' ||
    expected.device < 0n ||
    typeof expected.inode !== 'bigint' ||
    expected.inode <= 0n ||
    typeof expected.mountId !== 'bigint' ||
    expected.mountId <= 0n
  ) {
    throw new TypeError('anchor-launch-workdir-evidence-invalid');
  }

  const actual = await inspectDirectoryDescriptor(handle);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new TypeError('anchor-launch-workdir-identity-mismatch');
  }
  if (actual.mountId !== expected.mountId) {
    throw new TypeError('anchor-launch-workdir-mount-mismatch');
  }
}

function materializeEnvironment(
  authority: NodeEnvironmentLaunchAuthority
): MaterializedNodeAnchorLaunch['environment'] {
  const declared = authority.policy.variables;
  const names = new Set<string>();
  if (declared.length > MAX_ENVIRONMENT_VARIABLES) {
    throw new TypeError('anchor-launch-environment-count');
  }
  for (const variable of declared) {
    if (!ENVIRONMENT_NAME.test(variable.name) || names.has(variable.name)) {
      throw new TypeError('anchor-launch-environment-name');
    }
    names.add(variable.name);
  }
  const actualNames = Object.keys(authority.values);
  if (
    actualNames.length !== names.size ||
    actualNames.some((name) => !names.has(name)) ||
    Reflect.ownKeys(authority.values).some((key) => typeof key !== 'string')
  ) {
    throw new TypeError('anchor-launch-environment-values');
  }

  const encoder = new TextEncoder();
  let totalBytes = 0;
  const result = declared.map(({ name }: { readonly name: string }) => {
    const value = authority.values[name];
    if (typeof value !== 'string' || value.includes('\u0000') || hasUnpairedSurrogate(value)) {
      throw new TypeError('anchor-launch-environment-value');
    }
    const bytes = encoder.encode(`${name}=${value}`);
    if (bytes.byteLength > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new TypeError('anchor-launch-environment-value-too-large');
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_ENVIRONMENT_BYTES) {
      throw new TypeError('anchor-launch-environment-too-large');
    }
    return Object.freeze({ name, value });
  });
  return Object.freeze(result);
}

function uniqueCatalog<TKey, TValue>(
  entries: readonly TValue[],
  keyOf: (entry: TValue) => TKey
): ReadonlyMap<TKey, TValue> {
  const map = new Map<TKey, TValue>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (map.has(key)) throw new TypeError('anchor-launch-authority-duplicate');
    map.set(key, Object.freeze({ ...entry }));
  }
  return map;
}

function sameWorkspaceGrant(
  left: WorkspaceExecutionGrant,
  right: WorkspaceExecutionGrant
): boolean {
  return (
    left.grantId === right.grantId &&
    left.workspaceId === right.workspaceId &&
    left.registrationRevision === right.registrationRevision &&
    left.bindingGeneration === right.bindingGeneration &&
    left.mountGeneration === right.mountGeneration &&
    left.permission === 'execute_process' &&
    right.permission === 'execute_process'
  );
}

async function openRegularFile(
  value: string,
  diagnostic: string
): Promise<{ readonly path: string; readonly handle: FileHandle }> {
  const resolved = await resolveAbsolutePath(value, diagnostic);
  const handle = await open(
    resolved,
    constants.O_RDONLY | PORTABLE_O_CLOEXEC | constants.O_NOFOLLOW
  );
  try {
    if (!(await handle.stat()).isFile()) throw new TypeError(`${diagnostic}-not-file`);
    return Object.freeze({ path: resolved, handle });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openDirectory(
  value: string,
  diagnostic: string
): Promise<{ readonly path: string; readonly handle: FileHandle }> {
  const resolved = await resolveAbsolutePath(value, diagnostic);
  const handle = await open(
    resolved,
    constants.O_RDONLY | PORTABLE_O_CLOEXEC | constants.O_NOFOLLOW | constants.O_DIRECTORY
  );
  try {
    if (!(await handle.stat()).isDirectory()) throw new TypeError(`${diagnostic}-not-directory`);
    return Object.freeze({ path: resolved, handle });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function resolveAbsolutePath(value: string, diagnostic: string): Promise<string> {
  if (!path.isAbsolute(value) || value.includes('\u0000')) {
    throw new TypeError(`${diagnostic}-invalid`);
  }
  const resolved = await realpath(value);
  if (!path.isAbsolute(resolved)) throw new TypeError(`${diagnostic}-invalid`);
  return resolved;
}

async function sha256File(handle: FileHandle): Promise<`sha256:${string}`> {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `sha256:${digest.digest('hex')}`;
}

async function inspectDirectoryDescriptor(
  handle: FileHandle
): Promise<NodeRegisteredWorkdirEvidence> {
  const stats = await handle.stat({ bigint: true });
  // The descriptor is process-owned and fd is numeric; no caller-controlled path reaches /proc.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const fdInfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  const mountId = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(fdInfo)?.[1];
  if (!mountId) throw new TypeError('anchor-launch-workdir-mount-unavailable');
  return Object.freeze({
    device: stats.dev,
    inode: stats.ino,
    mountId: BigInt(mountId),
  });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (const character of value) {
    if (character.length !== 1) continue;
    const code = character.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}
