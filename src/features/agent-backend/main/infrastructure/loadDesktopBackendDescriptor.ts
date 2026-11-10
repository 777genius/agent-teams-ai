import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { BackendRoutingError, captureScope, ownerKey } from '../application/backendBinding';

import { captureHostProfile } from './selectedHostProfile';

import type { BackendOwnerRef, BackendScope } from '../application/backendBinding';
import type { CapturedProviderPreferencePaths } from './CapturedProviderManagement';
import type { SelectedHostProfile } from './selectedHostProfile';

export interface DesktopBackendDescriptorSelection {
  readonly path: string;
  readonly sha256: string;
}
export interface DesktopBackendDescriptor {
  readonly schemaVersion: 1;
  readonly defaultOwner: BackendOwnerRef;
  readonly owners: readonly (BackendOwnerRef & {
    readonly storageRoot: string;
    readonly profile: SelectedHostProfile;
  })[];
  readonly handles: readonly {
    readonly handleId: string;
    readonly owner: BackendOwnerRef;
    readonly contextId: string;
    readonly label: string;
    readonly members: readonly { readonly memberId: string; readonly label: string }[];
    readonly scope: BackendScope;
  }[];
  /** Trusted unbound-create admission; no renderer may choose an owner/context. */
  readonly creation?: {
    readonly owner: BackendOwnerRef;
    readonly contextIds: readonly string[];
    /** Explicit private Host principal; never inferred from executable arguments/environment. */
    readonly importAuthority?: { readonly principalId: string };
  };
  /** Private provider bindings; they are never part of renderer connection discovery. */
  readonly management?: readonly {
    readonly runtimeId: 'opencode' | 'codex' | 'claude';
    readonly owner: BackendOwnerRef;
    readonly contextId: string;
    readonly projectPath: string | null;
    readonly profileId: string;
    readonly configRevision: string;
    readonly preferences?: CapturedProviderPreferencePaths;
  }[];
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new BackendRoutingError('hold');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    throw new BackendRoutingError('hold');
  return value;
}
function list<T>(
  value: unknown,
  max: number,
  parse: (entry: unknown) => T,
  allowEmpty = false
): T[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > max)
    throw new BackendRoutingError('hold');
  return value.map(parse);
}
function ref(value: unknown): BackendOwnerRef {
  const owner = object(value, ['ownerId', 'revision']);
  return Object.freeze({ ownerId: id(owner.ownerId), revision: id(owner.revision) });
}
function descriptor(value: unknown): DesktopBackendDescriptor {
  const input = object(value, [
    'schemaVersion',
    'defaultOwner',
    'owners',
    'handles',
    'management',
    'creation',
  ]);
  if (input.schemaVersion !== 1) throw new BackendRoutingError('hold');
  const owners = list(input.owners, 16, (entry) => {
    const owner = object(entry, ['ownerId', 'revision', 'storageRoot', 'profile']);
    if (typeof owner.storageRoot !== 'string' || !isAbsolute(owner.storageRoot))
      throw new BackendRoutingError('hold');
    const rawProfile = object(owner.profile, [
      'profileId',
      'nodeExecutable',
      'nodeVersion',
      'nodeSha256',
      'hostEntry',
      'hostEntrySha256',
      'expectedBuildId',
      'cwd',
      'env',
      'startupTimeoutMs',
      'requestTimeoutMs',
      'writeTimeoutMs',
      'shutdownTimeoutMs',
      'reviewTransport',
    ]);
    if (
      !rawProfile.env ||
      typeof rawProfile.env !== 'object' ||
      Array.isArray(rawProfile.env) ||
      Object.values(rawProfile.env).some((entry) => typeof entry !== 'string')
    )
      throw new BackendRoutingError('hold');
    const profile = captureHostProfile(rawProfile as unknown as SelectedHostProfile);
    return Object.freeze({
      ownerId: id(owner.ownerId),
      revision: id(owner.revision),
      storageRoot: owner.storageRoot,
      profile,
    });
  });
  const ownerKeys = new Set(owners.map(ownerKey));
  const defaultOwner = ref(input.defaultOwner);
  if (ownerKeys.size !== owners.length || !ownerKeys.has(ownerKey(defaultOwner)))
    throw new BackendRoutingError('hold');
  let creation: DesktopBackendDescriptor['creation'];
  if (input.creation !== undefined) {
    const selected = object(input.creation, ['owner', 'contextIds', 'importAuthority']);
    const owner = ref(selected.owner),
      contextIds = list(selected.contextIds, 64, id);
    if (!ownerKeys.has(ownerKey(owner)) || new Set(contextIds).size !== contextIds.length)
      throw new BackendRoutingError('hold');
    const authority =
      selected.importAuthority === undefined
        ? undefined
        : object(selected.importAuthority, ['principalId']);
    creation = Object.freeze({
      owner,
      contextIds: Object.freeze(contextIds),
      ...(authority
        ? { importAuthority: Object.freeze({ principalId: id(authority.principalId) }) }
        : {}),
    });
  }
  const handles = list(
    input.handles,
    512,
    (entry) => {
      const handle = object(entry, ['handleId', 'owner', 'contextId', 'label', 'members', 'scope']);
      const owner = ref(handle.owner);
      if (!ownerKeys.has(ownerKey(owner))) throw new BackendRoutingError('hold');
      const members = list(handle.members, 256, (entry) => {
        const member = object(entry, ['memberId', 'label']);
        return Object.freeze({ memberId: id(member.memberId), label: id(member.label) });
      });
      if (new Set(members.map((member) => member.memberId)).size !== members.length)
        throw new BackendRoutingError('hold');
      return Object.freeze({
        handleId: id(handle.handleId),
        owner,
        contextId: id(handle.contextId),
        label: id(handle.label),
        members: Object.freeze(members),
        scope: captureScope(handle.scope),
      });
    },
    true
  );
  if (new Set(handles.map((handle) => handle.handleId)).size !== handles.length)
    throw new BackendRoutingError('hold');
  const management =
    input.management === undefined
      ? undefined
      : list(
          input.management,
          64,
          (raw) => {
            const entry = object(raw, [
              'runtimeId',
              'owner',
              'contextId',
              'projectPath',
              'profileId',
              'configRevision',
              'preferences',
            ]);
            const owner = ref(entry.owner);
            if (
              !['opencode', 'codex', 'claude'].includes(String(entry.runtimeId)) ||
              !ownerKeys.has(ownerKey(owner)) ||
              (entry.projectPath !== null &&
                (typeof entry.projectPath !== 'string' ||
                  entry.projectPath.length > 8192 ||
                  entry.projectPath.includes('\0') ||
                  !isAbsolute(entry.projectPath) ||
                  resolve(entry.projectPath) !== entry.projectPath))
            )
              throw new BackendRoutingError('hold');
            let preferences: CapturedProviderPreferencePaths | undefined;
            if (entry.preferences !== undefined) {
              const paths = object(entry.preferences, ['projectRoot', 'globalRoot']);
              for (const path of [paths.projectRoot, paths.globalRoot]) {
                if (path === null) continue;
                if (
                  typeof path !== 'string' ||
                  path.length > 8192 ||
                  path.includes('\0') ||
                  !isAbsolute(path) ||
                  resolve(path) !== path
                )
                  throw new BackendRoutingError('hold');
              }
              if (
                typeof paths.globalRoot !== 'string' ||
                (entry.projectPath === null && paths.projectRoot !== null)
              )
                throw new BackendRoutingError('hold');
              preferences = Object.freeze({
                projectRoot: paths.projectRoot as string | null,
                globalRoot: paths.globalRoot,
              });
            }
            return Object.freeze({
              runtimeId: entry.runtimeId as 'opencode' | 'codex' | 'claude',
              owner,
              contextId: id(entry.contextId),
              projectPath: entry.projectPath,
              profileId: id(entry.profileId),
              configRevision: id(entry.configRevision),
              ...(preferences ? { preferences } : {}),
            });
          },
          true
        );
  if (
    management &&
    new Set(
      management.map((entry) =>
        JSON.stringify([entry.runtimeId, entry.contextId, entry.projectPath])
      )
    ).size !== management.length
  )
    throw new BackendRoutingError('hold');
  return Object.freeze({
    schemaVersion: 1,
    owners: Object.freeze(owners),
    defaultOwner,
    handles: Object.freeze(handles),
    ...(creation === undefined ? {} : { creation }),
    ...(management === undefined ? {} : { management: Object.freeze(management) }),
  });
}

/** Only trusted shell configuration selects this private, digest-bound descriptor. */
export async function loadDesktopBackendDescriptor(
  selection: DesktopBackendDescriptorSelection
): Promise<DesktopBackendDescriptor> {
  try {
    if (
      !isAbsolute(selection.path) ||
      !/^[a-f0-9]{64}$/.test(selection.sha256) ||
      (await realpath(selection.path)) !== selection.path
    )
      throw new BackendRoutingError('hold');
    const file = await open(selection.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > 256 * 1024 || (stats.mode & 0o077) !== 0)
        throw new BackendRoutingError('hold');
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      if (
        length > 256 * 1024 ||
        createHash('sha256').update(bytes).digest('hex') !== selection.sha256
      )
        throw new BackendRoutingError('hold');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return descriptor(JSON.parse(text));
    } finally {
      await file.close();
    }
  } catch {
    throw new BackendRoutingError('hold');
  }
}
