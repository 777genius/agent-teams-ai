import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { ExternalFileRegistration, ExternalWriterScope } from '../../contracts';
import type { ExternalFileObservationCatalog } from '../../core/application';

export interface RegisteredExternalFileDefinition {
  registration: ExternalFileRegistration;
  rootPath: string;
  filePath: string;
}

export interface RegisteredExternalFile {
  registration: ExternalFileRegistration;
  rootPath: string;
  realRootPath: string;
  rootDevice: string;
  rootInode: string;
  filePath: string;
  realFilePath: string;
  parentPath: string;
  realParentPath: string;
  parentDevice: string;
  parentInode: string;
}

export type RegisteredExternalFileCatalogErrorCode =
  | 'duplicate_alias'
  | 'duplicate_registration'
  | 'invalid_registration'
  | 'path_not_absolute'
  | 'path_outside_root'
  | 'root_not_directory'
  | 'symlink_not_allowed'
  | 'unsupported_file_type'
  | 'watch_invalidated';

export class RegisteredExternalFileCatalogError extends Error {
  constructor(readonly code: RegisteredExternalFileCatalogErrorCode) {
    super(`registered-external-file-catalog:${code}`);
    this.name = 'RegisteredExternalFileCatalogError';
  }
}

interface RegisteredRoot {
  rootPath: string;
  realRootPath: string;
  rootDevice: string;
  rootInode: string;
}

const isMissingError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const platformPathKey = (path: string): string =>
  process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path;

const pathsEqual = (left: string, right: string): boolean =>
  platformPathKey(resolve(left)) === platformPathKey(resolve(right));

const isPathInside = (rootPath: string, candidatePath: string): boolean => {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
};

const scopeKey = (scope: ExternalWriterScope): string =>
  `${scope.teamId.length}:${scope.teamId}${scope.featureKey.length}:${scope.featureKey}`;

const registrationKey = (registration: ExternalFileRegistration): string =>
  `${scopeKey(registration.scope)}${registration.fileKey.length}:${registration.fileKey}`;

const freezeScope = (scope: ExternalWriterScope): ExternalWriterScope =>
  Object.freeze({
    teamId: scope.teamId,
    featureKey: scope.featureKey,
  });

const freezeRegistration = (registration: ExternalFileRegistration): ExternalFileRegistration =>
  Object.freeze({
    scope: freezeScope(registration.scope),
    fileKey: registration.fileKey,
    maxBytes: registration.maxBytes,
    attributionPolicy: registration.attributionPolicy,
  });

const assertRegistration = (registration: ExternalFileRegistration): void => {
  if (
    registration.scope.teamId.length === 0 ||
    registration.scope.featureKey.length === 0 ||
    registration.fileKey.length === 0 ||
    !Number.isSafeInteger(registration.maxBytes) ||
    registration.maxBytes <= 0 ||
    (registration.attributionPolicy !== 'external_file_only' &&
      registration.attributionPolicy !== 'verified_run_evidence')
  ) {
    throw new RegisteredExternalFileCatalogError('invalid_registration');
  }
};

const registerRoot = (rootPath: string): RegisteredRoot => {
  if (!isAbsolute(rootPath)) {
    throw new RegisteredExternalFileCatalogError('path_not_absolute');
  }
  const normalizedRootPath = resolve(rootPath);
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(normalizedRootPath, { bigint: true });
  } catch {
    throw new RegisteredExternalFileCatalogError('root_not_directory');
  }
  if (rootStat.isSymbolicLink()) {
    throw new RegisteredExternalFileCatalogError('symlink_not_allowed');
  }
  if (!rootStat.isDirectory()) {
    throw new RegisteredExternalFileCatalogError('root_not_directory');
  }
  const realRootPath = realpathSync.native(normalizedRootPath);
  if (!pathsEqual(normalizedRootPath, realRootPath)) {
    throw new RegisteredExternalFileCatalogError('symlink_not_allowed');
  }
  return Object.freeze({
    rootPath: normalizedRootPath,
    realRootPath,
    rootDevice: rootStat.dev.toString(),
    rootInode: rootStat.ino.toString(),
  });
};

const registerFile = (
  definition: RegisteredExternalFileDefinition,
  root: RegisteredRoot
): {
  file: RegisteredExternalFile;
  inodeAliasKey: string | null;
} => {
  if (!isAbsolute(definition.filePath)) {
    throw new RegisteredExternalFileCatalogError('path_not_absolute');
  }
  const filePath = resolve(definition.filePath);
  if (!isPathInside(root.rootPath, filePath)) {
    throw new RegisteredExternalFileCatalogError('path_outside_root');
  }

  const relativeFilePath = relative(root.rootPath, filePath);
  const realFilePath = resolve(root.realRootPath, relativeFilePath);
  if (!isPathInside(root.realRootPath, realFilePath)) {
    throw new RegisteredExternalFileCatalogError('path_outside_root');
  }

  const parentPath = resolve(filePath, '..');
  const relativeParentPath = relative(root.rootPath, parentPath);
  const expectedRealParentPath =
    relativeParentPath.length === 0
      ? root.realRootPath
      : resolve(root.realRootPath, relativeParentPath);
  let parentStat: ReturnType<typeof lstatSync>;
  try {
    parentStat = lstatSync(parentPath, { bigint: true });
  } catch {
    throw new RegisteredExternalFileCatalogError('path_outside_root');
  }
  if (parentStat.isSymbolicLink()) {
    throw new RegisteredExternalFileCatalogError('symlink_not_allowed');
  }
  if (!parentStat.isDirectory()) {
    throw new RegisteredExternalFileCatalogError('path_outside_root');
  }
  const realParentPath = realpathSync.native(parentPath);
  if (
    !pathsEqual(realParentPath, expectedRealParentPath) ||
    (!pathsEqual(realParentPath, root.realRootPath) &&
      !isPathInside(root.realRootPath, realParentPath))
  ) {
    throw new RegisteredExternalFileCatalogError('path_outside_root');
  }

  let inodeAliasKey: string | null = null;
  try {
    const fileStat = lstatSync(filePath, { bigint: true });
    if (fileStat.isSymbolicLink()) {
      throw new RegisteredExternalFileCatalogError('symlink_not_allowed');
    }
    if (!fileStat.isFile()) {
      throw new RegisteredExternalFileCatalogError('unsupported_file_type');
    }
    const observedRealFilePath = realpathSync.native(filePath);
    if (
      !pathsEqual(observedRealFilePath, realFilePath) ||
      !isPathInside(root.realRootPath, observedRealFilePath)
    ) {
      throw new RegisteredExternalFileCatalogError('path_outside_root');
    }
    inodeAliasKey = `${fileStat.dev}:${fileStat.ino}`;
  } catch (error) {
    if (!isMissingError(error)) {
      throw error;
    }
  }

  return {
    file: Object.freeze({
      registration: freezeRegistration(definition.registration),
      rootPath: root.rootPath,
      realRootPath: root.realRootPath,
      rootDevice: root.rootDevice,
      rootInode: root.rootInode,
      filePath,
      realFilePath,
      parentPath,
      realParentPath,
      parentDevice: parentStat.dev.toString(),
      parentInode: parentStat.ino.toString(),
    }),
    inodeAliasKey,
  };
};

const registrationsEqual = (
  left: ExternalFileRegistration,
  right: ExternalFileRegistration
): boolean =>
  left.scope.teamId === right.scope.teamId &&
  left.scope.featureKey === right.scope.featureKey &&
  left.fileKey === right.fileKey &&
  left.maxBytes === right.maxBytes &&
  left.attributionPolicy === right.attributionPolicy;

interface PendingScopeScanCompletion {
  active: boolean;
  complete(): void;
}

const trackCompletedScopeScan = (
  registrations: readonly ExternalFileRegistration[],
  completions: readonly PendingScopeScanCompletion[]
): readonly ExternalFileRegistration[] => {
  let completedIterations = 0;
  const tracked = [...registrations];
  Object.defineProperty(tracked, Symbol.iterator, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: function* trackedScopeScanIterator(): IterableIterator<ExternalFileRegistration> {
      let exhausted = false;
      try {
        yield* registrations;
        exhausted = true;
      } finally {
        if (exhausted) {
          completedIterations += 1;
          // ExternalWriterObserver first validates the catalog collection, then
          // consumes that same collection for the actual scoped scan. Waiting
          // for both complete iterations keeps reconciliation inside the
          // tracked interval; nested registration lookups use Array.find and
          // therefore cannot prematurely acknowledge the scan.
          if (completedIterations === 2) {
            for (const completion of completions) {
              if (completion.active) {
                completion.active = false;
                completion.complete();
              }
            }
          }
        }
      }
    },
  });
  return Object.freeze(tracked);
};

/**
 * Immutable allowlist of exact feature-owned files. Construction performs all
 * path discovery; runtime callers can only resolve a registered scope/file key.
 */
export class RegisteredExternalFileCatalog implements ExternalFileObservationCatalog {
  private readonly scopes: readonly ExternalWriterScope[];
  private readonly files: readonly RegisteredExternalFile[];
  private readonly registrationsByScope: ReadonlyMap<string, readonly ExternalFileRegistration[]>;
  private readonly filesByRegistration: ReadonlyMap<string, RegisteredExternalFile>;
  private readonly invalidatedWatchScopes = new Set<string>();
  private readonly pendingScanCompletions = new Map<string, PendingScopeScanCompletion[]>();

  constructor(definitions: readonly RegisteredExternalFileDefinition[]) {
    const rootsByPath = new Map<string, RegisteredRoot>();
    const filesByRegistration = new Map<string, RegisteredExternalFile>();
    const filesByAlias = new Map<string, RegisteredExternalFile>();
    const filesByInode = new Map<string, RegisteredExternalFile>();
    const registrationsByScope = new Map<string, ExternalFileRegistration[]>();
    const scopesByKey = new Map<string, ExternalWriterScope>();
    const files: RegisteredExternalFile[] = [];

    for (const definition of definitions) {
      assertRegistration(definition.registration);
      const key = registrationKey(definition.registration);
      if (filesByRegistration.has(key)) {
        throw new RegisteredExternalFileCatalogError('duplicate_registration');
      }

      const normalizedRootPath = isAbsolute(definition.rootPath)
        ? resolve(definition.rootPath)
        : definition.rootPath;
      let root = rootsByPath.get(platformPathKey(normalizedRootPath));
      if (!root) {
        root = registerRoot(definition.rootPath);
        rootsByPath.set(platformPathKey(root.rootPath), root);
      }
      const registered = registerFile(definition, root);
      const aliasKey = platformPathKey(registered.file.realFilePath);
      if (
        filesByAlias.has(aliasKey) ||
        (registered.inodeAliasKey !== null && filesByInode.has(registered.inodeAliasKey))
      ) {
        throw new RegisteredExternalFileCatalogError('duplicate_alias');
      }

      const fileScopeKey = scopeKey(registered.file.registration.scope);
      const scope = scopesByKey.get(fileScopeKey) ?? registered.file.registration.scope;
      scopesByKey.set(fileScopeKey, scope);
      const registrations = registrationsByScope.get(fileScopeKey) ?? [];
      registrations.push(registered.file.registration);
      registrationsByScope.set(fileScopeKey, registrations);
      filesByRegistration.set(key, registered.file);
      filesByAlias.set(aliasKey, registered.file);
      if (registered.inodeAliasKey !== null) {
        filesByInode.set(registered.inodeAliasKey, registered.file);
      }
      files.push(registered.file);
    }

    this.scopes = Object.freeze([...scopesByKey.values()]);
    this.files = Object.freeze(files);
    this.registrationsByScope = new Map(
      [...registrationsByScope].map(([key, registrations]) => [key, Object.freeze(registrations)])
    );
    this.filesByRegistration = filesByRegistration;
    Object.freeze(this);
  }

  listScopes(): Promise<readonly ExternalWriterScope[]> {
    return Promise.resolve(this.scopes);
  }

  listRegistrations(scope: ExternalWriterScope): Promise<readonly ExternalFileRegistration[]> {
    if (this.isWatchScopeInvalidated(scope)) {
      return Promise.reject(new RegisteredExternalFileCatalogError('watch_invalidated'));
    }
    const key = scopeKey(scope);
    const registrations = this.registrationsByScope.get(key) ?? Object.freeze([]);
    const completions = this.pendingScanCompletions.get(key);
    if (!completions || completions.length === 0) {
      return Promise.resolve(registrations);
    }
    this.pendingScanCompletions.delete(key);
    return Promise.resolve(trackCompletedScopeScan(registrations, completions));
  }

  listRegisteredFiles(): readonly RegisteredExternalFile[] {
    return this.files;
  }

  /**
   * Coordinates a native watch group's periodic request with completion of the
   * resulting registered-scope scans. It observes only the immutable catalog
   * collections already consumed by the core observer; it neither scans paths
   * nor changes observer scheduling.
   */
  onNextScopeScansCompleted(
    scopes: readonly ExternalWriterScope[],
    onCompleted: () => void
  ): () => void {
    const keys = [...new Set(scopes.map(scopeKey))].filter((key) =>
      this.registrationsByScope.has(key)
    );
    if (keys.length === 0) {
      onCompleted();
      return () => undefined;
    }

    let remaining = keys.length;
    let active = true;
    const pending: Array<{ key: string; completion: PendingScopeScanCompletion }> = [];
    for (const key of keys) {
      const completion: PendingScopeScanCompletion = {
        active: true,
        complete: () => {
          if (!active) {
            return;
          }
          remaining -= 1;
          if (remaining === 0) {
            active = false;
            onCompleted();
          }
        },
      };
      const completions = this.pendingScanCompletions.get(key) ?? [];
      completions.push(completion);
      this.pendingScanCompletions.set(key, completions);
      pending.push({ key, completion });
    }

    return () => {
      if (!active) {
        return;
      }
      active = false;
      for (const { key, completion } of pending) {
        completion.active = false;
        const completions = this.pendingScanCompletions.get(key);
        if (!completions) {
          continue;
        }
        const retained = completions.filter((candidate) => candidate !== completion);
        if (retained.length === 0) {
          this.pendingScanCompletions.delete(key);
        } else {
          this.pendingScanCompletions.set(key, retained);
        }
      }
    };
  }

  getRegisteredFile(registration: ExternalFileRegistration): RegisteredExternalFile {
    this.assertWatchScopeCurrent(registration.scope);
    const registered = this.filesByRegistration.get(registrationKey(registration));
    if (!registered || !registrationsEqual(registered.registration, registration)) {
      throw new RegisteredExternalFileCatalogError('invalid_registration');
    }
    return registered;
  }

  /**
   * Permanently retires the affected catalog scopes after their native watcher
   * dies. There is deliberately no reset operation: re-establishment requires
   * a new catalog so every root and parent identity is captured again.
   */
  invalidateWatchScopes(scopes: readonly ExternalWriterScope[]): void {
    for (const scope of scopes) {
      const key = scopeKey(scope);
      if (this.registrationsByScope.has(key)) {
        this.invalidatedWatchScopes.add(key);
      }
    }
  }

  isWatchScopeInvalidated(scope: ExternalWriterScope): boolean {
    return this.invalidatedWatchScopes.has(scopeKey(scope));
  }

  isRootAndParentCurrent(file: RegisteredExternalFile): boolean {
    if (this.filesByRegistration.get(registrationKey(file.registration)) !== file) {
      return false;
    }
    try {
      const rootStat = lstatSync(file.rootPath, { bigint: true });
      const parentStat = lstatSync(file.parentPath, { bigint: true });
      const observedRootPath = realpathSync.native(file.rootPath);
      const observedParentPath = realpathSync.native(file.parentPath);
      return (
        rootStat.isDirectory() &&
        !rootStat.isSymbolicLink() &&
        rootStat.dev.toString() === file.rootDevice &&
        rootStat.ino.toString() === file.rootInode &&
        parentStat.isDirectory() &&
        !parentStat.isSymbolicLink() &&
        parentStat.dev.toString() === file.parentDevice &&
        parentStat.ino.toString() === file.parentInode &&
        pathsEqual(observedRootPath, file.realRootPath) &&
        pathsEqual(observedParentPath, file.realParentPath) &&
        (pathsEqual(observedParentPath, file.realRootPath) ||
          isPathInside(file.realRootPath, observedParentPath))
      );
    } catch {
      return false;
    }
  }

  private assertWatchScopeCurrent(scope: ExternalWriterScope): void {
    if (this.isWatchScopeInvalidated(scope)) {
      throw new RegisteredExternalFileCatalogError('watch_invalidated');
    }
  }
}
