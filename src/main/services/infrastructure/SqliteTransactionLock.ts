import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EPERM', 'EISDIR', 'EBADF']);
const SQLITE_TRANSACTION_LOCK_DATABASE_SUFFIX = '.lock.sqlite3';
const SQLITE_TRANSACTION_LOCK_SIDECAR_SUFFIXES = ['-journal', '-shm', '-wal'] as const;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
const MAX_IDENTITY_PREPARATION_ATTEMPTS = 8;
const CUSTODY_TOKEN_BYTES = 16;
const MAX_CUSTODY_DIRECTORY_ENTRIES = 4_096;
const MAX_ORPHAN_CUSTODY_LINKS = 64;
const SQLITE_TRANSACTION_LOCK_CUSTODY_SUFFIX =
  /^\.custody-([0-9a-f]{32})(-journal|-shm|-wal|\.provenance|-journal\.witness)?$/;
const PROVENANCE_VERSION = 1;

export interface SqliteTransactionLockOptions {
  acquireTimeoutMs: number;
  retryIntervalMs: number;
  timeoutMessage: string;
  ownershipLostMessage: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DatabaseIdentityGuard {
  created: boolean;
  descriptor: number;
  identity: FileIdentity;
}

interface DatabaseCustodyLink {
  path: string;
}

interface ProvenanceIdentity {
  dev: string;
  ino: string;
}

interface CustodyProvenance {
  version: number;
  token: string;
  database: ProvenanceIdentity;
  journal: ProvenanceIdentity;
}

interface PublishedProvenance {
  descriptor: number;
  identity: FileIdentity;
  journalIdentity: FileIdentity;
  journalPath: string;
  path: string;
  witnessPath: string;
}

interface Failure {
  error: unknown;
  context: string;
}

export interface SqliteTransactionLockTestHooks {
  afterAbsentFilePrecreated?(databasePath: string): void;
  beforeDatabaseOpen?(databasePath: string): void;
  afterDatabaseOpen?(databasePath: string, database: DatabaseSync): void;
  beforeProvenancePublication?(custodyPath: string): void;
  beforeOrphanDatabaseOpen?(custodyPath: string): void;
  beforeOrphanArtifactUnlink?(artifactPath: string): void;
}

let testHooks: SqliteTransactionLockTestHooks | undefined;

/** Test-only race injection seam. Production callers must not configure it. */
export function setSqliteTransactionLockTestHooksForTests(
  hooks: SqliteTransactionLockTestHooks | undefined
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('SQLite transaction lock test hooks are only available in tests');
  }
  testHooks = hooks;
}

interface OpenLock {
  custodyPath: string;
  database: DatabaseSync;
  databasePath: string;
  databaseIdentity: FileIdentity;
  identityDescriptor: number;
  parentIdentity: FileIdentity;
  provenance: PublishedProvenance;
}

export interface RetainedSqliteTransactionLock {
  readonly databasePath: string;
  assertOwned(): void;
  release(): void;
}

export function getSqliteTransactionLockDatabasePath(lockTargetPath: string): string {
  return `${lockTargetPath}${SQLITE_TRANSACTION_LOCK_DATABASE_SUFFIX}`;
}

export function isSqliteTransactionLockArtifactName(fileName: string): boolean {
  if (path.basename(fileName) !== fileName) return false;

  const databaseSuffixIndex = fileName.lastIndexOf(SQLITE_TRANSACTION_LOCK_DATABASE_SUFFIX);
  if (databaseSuffixIndex <= 0) return false;

  const artifactSuffix = fileName.slice(
    databaseSuffixIndex + SQLITE_TRANSACTION_LOCK_DATABASE_SUFFIX.length
  );
  return (
    artifactSuffix === '' ||
    SQLITE_TRANSACTION_LOCK_SIDECAR_SUFFIXES.some((suffix) => suffix === artifactSuffix) ||
    SQLITE_TRANSACTION_LOCK_CUSTODY_SUFFIX.test(artifactSuffix)
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// prettier-ignore
function pathEntryExists(pathname: string): boolean { try { fs.lstatSync(pathname); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }

function identity(stats: fs.BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function captureFailure(context: string, operation: () => void): Failure | null {
  try {
    operation();
    return null;
  } catch (error) {
    return { context, error };
  }
}

function contextualizeFailure(failure: Failure): unknown {
  if (failure.error !== undefined) return failure.error;
  return new Error(`${failure.context} failed by throwing undefined`, { cause: failure.error });
}

function throwWithCleanupFailures(primary: Failure, cleanupFailures: Failure[]): never {
  if (cleanupFailures.length === 0) throw primary.error;
  const errors = [primary, ...cleanupFailures].map(contextualizeFailure);
  throw new AggregateError(errors, `${primary.context} and cleanup failed`, { cause: errors[0] });
}

function syncDirectory(directoryPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      code === undefined ||
      !WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(code)
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureDirectoryHierarchy(directoryPath: string): void {
  const missing: string[] = [];
  let cursor = path.resolve(directoryPath);
  for (;;) {
    try {
      const stats = fs.lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Unsafe lock directory: ${cursor}`);
      }
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Unsafe lock directory: ${directory}`);
    }
    syncDirectory(path.dirname(directory));
  }
}

function assertRegularDatabase(databasePath: string): FileIdentity | null {
  try {
    const stats = fs.lstatSync(databasePath, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Unsafe lock database: ${databasePath}`);
    }
    return identity(stats);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function openDatabaseIdentityGuard(databasePath: string): DatabaseIdentityGuard {
  for (let attempt = 0; attempt < MAX_IDENTITY_PREPARATION_ATTEMPTS; attempt += 1) {
    const existingIdentity = assertRegularDatabase(databasePath);
    let descriptor: number;
    let created = false;
    try {
      if (existingIdentity) {
        descriptor = fs.openSync(databasePath, fs.constants.O_RDONLY | NO_FOLLOW);
      } else {
        descriptor = fs.openSync(
          databasePath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | NO_FOLLOW,
          0o600
        );
        created = true;
      }
    } catch (error) {
      if (
        isMissing(error) ||
        (!existingIdentity && (error as NodeJS.ErrnoException).code === 'EEXIST')
      ) {
        continue;
      }
      throw error;
    }

    try {
      const descriptorStats = fs.fstatSync(descriptor, { bigint: true });
      const pathStats = fs.lstatSync(databasePath, { bigint: true });
      const descriptorIdentity = identity(descriptorStats);
      if (
        !descriptorStats.isFile() ||
        pathStats.isSymbolicLink() ||
        !pathStats.isFile() ||
        !sameIdentity(descriptorIdentity, identity(pathStats)) ||
        (existingIdentity && !sameIdentity(existingIdentity, descriptorIdentity))
      ) {
        throw new Error(`Lock database identity changed before opening: ${databasePath}`);
      }
      if (created) syncDirectory(path.dirname(databasePath));
      return { created, descriptor, identity: descriptorIdentity };
    } catch (error) {
      const primary = { context: 'SQLite lock identity preparation', error };
      const closeFailure = captureFailure('SQLite lock identity descriptor close', () =>
        fs.closeSync(descriptor)
      );
      throwWithCleanupFailures(primary, closeFailure ? [closeFailure] : []);
    }
  }
  throw new Error(`Lock database identity kept changing before opening: ${databasePath}`);
}

function createDatabaseCustodyLink(databasePath: string): DatabaseCustodyLink {
  for (let attempt = 0; attempt < MAX_IDENTITY_PREPARATION_ATTEMPTS; attempt += 1) {
    const custodyPath = `${databasePath}.custody-${randomBytes(CUSTODY_TOKEN_BYTES).toString('hex')}`;
    try {
      fs.linkSync(databasePath, custodyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    return { path: custodyPath };
  }
  throw new Error(`Could not reserve lock database custody path: ${databasePath}`);
}

function validateDatabaseCustodyLink(
  databasePath: string,
  custodyPath: string,
  guard: DatabaseIdentityGuard
): void {
  const custodyStats = fs.lstatSync(custodyPath, { bigint: true });
  const descriptorStats = fs.fstatSync(guard.descriptor, { bigint: true });
  if (
    custodyStats.isSymbolicLink() ||
    !custodyStats.isFile() ||
    !descriptorStats.isFile() ||
    custodyStats.nlink !== 2n ||
    descriptorStats.nlink !== 2n ||
    !sameIdentity(guard.identity, identity(custodyStats)) ||
    !sameIdentity(guard.identity, identity(descriptorStats))
  ) {
    throw new Error(`Lock database custody changed before opening: ${databasePath}`);
  }
  syncDirectory(path.dirname(databasePath));
}

// These compact, ignored declarations keep this security boundary below the production-size cap.
// prettier-ignore
function serializedIdentity(value: FileIdentity): ProvenanceIdentity { return { dev: value.dev.toString(), ino: value.ino.toString() }; }
// prettier-ignore
function parseIdentity(value: unknown): FileIdentity | null { if (!value || typeof value !== 'object') return null; const item = value as Partial<ProvenanceIdentity>; if (!/^\d+$/.test(item.dev ?? '') || !/^\d+$/.test(item.ino ?? '')) return null; return { dev: BigInt(item.dev!), ino: BigInt(item.ino!) }; }

// prettier-ignore
function publishCustodyProvenance(custodyPath: string, databaseIdentity: FileIdentity): PublishedProvenance {
  const journalPath = `${custodyPath}-journal`, witnessPath = `${journalPath}.witness`, provenancePath = `${custodyPath}.provenance`;
  const journalStats = fs.lstatSync(journalPath, { bigint: true });
  if (journalStats.isSymbolicLink() || !journalStats.isFile() || journalStats.nlink !== 1n) throw new Error(`Unsafe SQLite lock journal before provenance: ${journalPath}`);
  const journalIdentity = identity(journalStats); fs.linkSync(journalPath, witnessPath);
  const witnessStats = fs.lstatSync(witnessPath, { bigint: true }), linkedStats = fs.lstatSync(journalPath, { bigint: true });
  if (linkedStats.nlink !== 2n || witnessStats.nlink !== 2n || !sameIdentity(journalIdentity, identity(linkedStats)) || !sameIdentity(journalIdentity, identity(witnessStats))) throw new Error(`SQLite lock journal witness identity changed: ${journalPath}`);
  testHooks?.beforeProvenancePublication?.(custodyPath);
  const token = custodyPath.slice(custodyPath.lastIndexOf('.custody-') + '.custody-'.length);
  const manifest: CustodyProvenance = { version: PROVENANCE_VERSION, token, database: serializedIdentity(databaseIdentity), journal: serializedIdentity(journalIdentity) };
  let descriptor: number | undefined, provenanceIdentity: FileIdentity | undefined;
  try {
    descriptor = fs.openSync(provenancePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | NO_FOLLOW, 0o600);
    provenanceIdentity = identity(fs.fstatSync(descriptor, { bigint: true })); fs.writeSync(descriptor, `${JSON.stringify(manifest)}\n`, undefined, 'utf8'); fs.fdatasyncSync(descriptor); syncDirectory(path.dirname(custodyPath));
    return { descriptor, identity: provenanceIdentity, journalIdentity, journalPath, path: provenancePath, witnessPath };
  } catch (error) {
    const failures = [descriptor === undefined ? null : captureFailure('SQLite lock provenance descriptor close', () => fs.closeSync(descriptor!)), captureFailure('SQLite lock journal witness cleanup', () => unlinkExact(witnessPath, journalIdentity, true)), provenanceIdentity ? captureFailure('SQLite lock provenance file cleanup', () => unlinkExact(provenancePath, provenanceIdentity!, true)) : null].filter((failure): failure is Failure => failure !== null);
    throwWithCleanupFailures({ context: 'SQLite lock provenance publication', error }, failures);
  }
}

// prettier-ignore
type OrphanCustodyArtifacts = { custodyPath: string; journalIdentity: FileIdentity; journalPath: string; provenanceDescriptor: number; provenanceIdentity: FileIdentity; provenancePath: string; witnessPath: string };

// prettier-ignore
function scanOrphanCustodyArtifacts(databasePath: string, expectedIdentity: FileIdentity, parentIdentity: FileIdentity): OrphanCustodyArtifacts[] {
  const directoryPath = path.dirname(databasePath), databaseName = path.basename(databasePath), prefix = `${databaseName}.custody-`;
  const groups = new Map<string, Set<string>>(), directory = fs.opendirSync(directoryPath); let entryCount = 0;
  try {
    for (;;) {
      const entry = directory.readSync(); if (!entry) break;
      if (++entryCount > MAX_CUSTODY_DIRECTORY_ENTRIES) throw new Error(`SQLite lock custody directory scan exceeded its bound: ${directoryPath}`);
      if (!entry.name.startsWith(prefix)) continue;
      const match = SQLITE_TRANSACTION_LOCK_CUSTODY_SUFFIX.exec(entry.name.slice(databaseName.length)); if (!match) continue;
      const token = match[1]; let names = groups.get(token);
      if (!names) { if (groups.size >= MAX_ORPHAN_CUSTODY_LINKS) throw new Error(`SQLite lock orphan custody scan exceeded its bound: ${databasePath}`); names = new Set(); groups.set(token, names); }
      names.add(match[2] ?? 'custody');
    }
  } finally { directory.closeSync(); }
  const parentStats = fs.lstatSync(directoryPath, { bigint: true });
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory() || !sameIdentity(parentIdentity, identity(parentStats))) throw new Error(`Lock database parent changed during custody recovery: ${databasePath}`);
  const complete: OrphanCustodyArtifacts[] = [];
  try {
    for (const [token, names] of groups) {
      const custodyPath = path.join(directoryPath, `${prefix}${token}`); let custodyStats: fs.BigIntStats;
      try { custodyStats = fs.lstatSync(custodyPath, { bigint: true }); } catch (error) { if (isMissing(error)) throw new Error('database is locked during custody cleanup'); throw error; }
      if (custodyStats.isSymbolicLink() || !custodyStats.isFile()) throw new Error(`Unsafe orphan SQLite lock custody link: ${custodyPath}`);
      if (!sameIdentity(expectedIdentity, identity(custodyStats))) continue;
      if (names.has('-wal') || names.has('-shm')) throw new Error(`Unrecoverable SQLite lock WAL/SHM custody: ${custodyPath}`);
      if (!names.has('custody') || !names.has('-journal.witness') || !names.has('.provenance')) { const remnants = [...names].filter((name) => name !== 'custody').some((name) => pathEntryExists(`${custodyPath}${name}`)); if (!remnants) throw new Error('database is locked during custody publication'); throw new Error(`Missing SQLite lock custody provenance: ${custodyPath}`); }
      const journalPath = `${custodyPath}-journal`, witnessPath = `${journalPath}.witness`, provenancePath = `${custodyPath}.provenance`;
      const witnessStats = fs.lstatSync(witnessPath, { bigint: true });
      if (witnessStats.isSymbolicLink() || !witnessStats.isFile() || (witnessStats.nlink !== 1n && witnessStats.nlink !== 2n)) throw new Error(`Unsafe orphan SQLite lock sidecar: ${journalPath}`);
      if (names.has('-journal')) { const stats = fs.lstatSync(journalPath, { bigint: true }); if (stats.isSymbolicLink() || !stats.isFile() || !sameIdentity(identity(stats), identity(witnessStats))) throw new Error(`Unsafe orphan SQLite lock sidecar: ${journalPath}`); }
      const provenanceDescriptor = fs.openSync(provenancePath, fs.constants.O_RDONLY | NO_FOLLOW);
      try {
        const descriptorStats = fs.fstatSync(provenanceDescriptor, { bigint: true }), pathStats = fs.lstatSync(provenancePath, { bigint: true });
        if (!descriptorStats.isFile() || pathStats.isSymbolicLink() || !pathStats.isFile() || descriptorStats.nlink !== 1n || descriptorStats.size > 1_024n || !sameIdentity(identity(descriptorStats), identity(pathStats))) throw new Error(`Unsafe SQLite lock custody provenance: ${provenancePath}`);
        const candidate = JSON.parse(fs.readFileSync(provenanceDescriptor, 'utf8')) as Partial<CustodyProvenance>;
        const manifestDatabase = parseIdentity(candidate?.database), manifestJournal = parseIdentity(candidate?.journal);
        if (candidate?.version !== PROVENANCE_VERSION || candidate.token !== token || !manifestDatabase || !manifestJournal || !sameIdentity(manifestDatabase, expectedIdentity) || !sameIdentity(manifestJournal, identity(witnessStats))) throw new Error(`Corrupted SQLite lock custody provenance: ${provenancePath}`);
        complete.push({ custodyPath, journalIdentity: manifestJournal, journalPath, provenanceDescriptor, provenanceIdentity: identity(descriptorStats), provenancePath, witnessPath });
      } catch (error) { fs.closeSync(provenanceDescriptor); throw error; }
    }
    const databaseStats = fs.lstatSync(databasePath, { bigint: true });
    if (databaseStats.isSymbolicLink() || !databaseStats.isFile() || !sameIdentity(expectedIdentity, identity(databaseStats)) || databaseStats.nlink !== BigInt(complete.length + 1)) throw new Error(`Unexpected SQLite lock database hard-link count: ${databasePath}`);
    return complete;
  } catch (error) { for (const item of complete) fs.closeSync(item.provenanceDescriptor); if (isMissing(error)) throw new Error('database is locked during custody cleanup'); throw error; }
}

// prettier-ignore
function unlinkExact(pathname: string, expected: FileIdentity, allowMissing = false, orphanRecovery = false): void {
  if (orphanRecovery) testHooks?.beforeOrphanArtifactUnlink?.(pathname);
  try { const stats = fs.lstatSync(pathname, { bigint: true }); if (stats.isSymbolicLink() || !stats.isFile() || !sameIdentity(expected, identity(stats))) throw new Error(`SQLite lock artifact changed before cleanup: ${pathname}`); fs.unlinkSync(pathname); }
  catch (error) { if (allowMissing && isMissing(error)) return; throw error; }
}

// prettier-ignore
function validateOrphanForOpen(orphan: OrphanCustodyArtifacts, databaseIdentity: FileIdentity, parentIdentity: FileIdentity): void {
  const paths: Array<[string, FileIdentity]> = [[orphan.custodyPath, databaseIdentity], [orphan.journalPath, orphan.journalIdentity], [orphan.witnessPath, orphan.journalIdentity], [orphan.provenancePath, orphan.provenanceIdentity]];
  for (const [pathname, expected] of paths) { const stats = fs.lstatSync(pathname, { bigint: true }); if (stats.isSymbolicLink() || !stats.isFile() || !sameIdentity(expected, identity(stats))) throw new Error(`SQLite lock custody changed before recovery open: ${pathname}`); }
  const provenanceStats = fs.fstatSync(orphan.provenanceDescriptor, { bigint: true }), parentStats = fs.lstatSync(path.dirname(orphan.custodyPath), { bigint: true });
  if (!sameIdentity(orphan.provenanceIdentity, identity(provenanceStats)) || parentStats.isSymbolicLink() || !parentStats.isDirectory() || !sameIdentity(parentIdentity, identity(parentStats))) throw new Error(`SQLite lock provenance changed before recovery: ${orphan.provenancePath}`);
}

// prettier-ignore
function restoreProvenJournal(orphan: OrphanCustodyArtifacts): void { try { fs.linkSync(orphan.witnessPath, orphan.journalPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }

// prettier-ignore
function recoverOrphanDatabaseCustodyLinks(databasePath: string, guard: DatabaseIdentityGuard, parentIdentity: FileIdentity): void {
  const orphans = scanOrphanCustodyArtifacts(databasePath, guard.identity, parentIdentity);
  for (const orphan of orphans) {
    let database: DatabaseSync | undefined;
    try {
      testHooks?.beforeOrphanDatabaseOpen?.(orphan.custodyPath); restoreProvenJournal(orphan); validateOrphanForOpen(orphan, guard.identity, parentIdentity);
      database = new DatabaseSync(orphan.custodyPath); database.exec('PRAGMA busy_timeout = 0'); database.exec('BEGIN EXCLUSIVE'); database.exec('ROLLBACK'); database.close(); database = undefined;
      const descriptorStats = fs.fstatSync(guard.descriptor, { bigint: true }), custodyStats = fs.lstatSync(orphan.custodyPath, { bigint: true }), parentStats = fs.lstatSync(path.dirname(databasePath), { bigint: true });
      if (!descriptorStats.isFile() || custodyStats.isSymbolicLink() || !custodyStats.isFile() || parentStats.isSymbolicLink() || !parentStats.isDirectory() || !sameIdentity(guard.identity, identity(descriptorStats)) || !sameIdentity(guard.identity, identity(custodyStats)) || !sameIdentity(parentIdentity, identity(parentStats))) throw new Error(`SQLite lock custody changed during recovery: ${orphan.custodyPath}`);
      unlinkExact(orphan.journalPath, orphan.journalIdentity, true, true); unlinkExact(orphan.witnessPath, orphan.journalIdentity, true, true); unlinkExact(orphan.provenancePath, orphan.provenanceIdentity, true, true);
      removeDatabaseCustodyLink(orphan.custodyPath, guard.identity); fs.closeSync(orphan.provenanceDescriptor);
    } catch (error) {
      const primaryError = isMissing(error) ? new Error('database is locked during custody cleanup') : error;
      const closeFailure = database ? captureFailure('SQLite orphan recovery database close', () => database!.close()) : null;
      const descriptorFailure = captureFailure('SQLite orphan provenance close', () => fs.closeSync(orphan.provenanceDescriptor));
      throwWithCleanupFailures({ context: 'SQLite orphan custody recovery', error: primaryError }, [closeFailure, descriptorFailure].filter((failure): failure is Failure => failure !== null));
    }
  }
  syncDirectory(path.dirname(databasePath));
}

function removeDatabaseCustodyLink(custodyPath: string, expectedIdentity: FileIdentity): void {
  let custodyStats: fs.BigIntStats;
  try {
    custodyStats = fs.lstatSync(custodyPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (
    custodyStats.isSymbolicLink() ||
    !custodyStats.isFile() ||
    !sameIdentity(expectedIdentity, identity(custodyStats))
  ) {
    throw new Error(`Lock database custody changed before cleanup: ${custodyPath}`);
  }
  fs.unlinkSync(custodyPath);
  syncDirectory(path.dirname(custodyPath));
}

function validateDatabaseIdentity(
  databasePath: string,
  custodyPath: string,
  guard: DatabaseIdentityGuard,
  parentIdentity: FileIdentity
): void {
  const descriptorStats = fs.fstatSync(guard.descriptor, { bigint: true });
  const databaseStats = fs.lstatSync(databasePath, { bigint: true });
  const custodyStats = fs.lstatSync(custodyPath, { bigint: true });
  const parentStats = fs.lstatSync(path.dirname(databasePath), { bigint: true });
  if (
    !descriptorStats.isFile() ||
    databaseStats.isSymbolicLink() ||
    !databaseStats.isFile() ||
    custodyStats.isSymbolicLink() ||
    !custodyStats.isFile() ||
    parentStats.isSymbolicLink() ||
    !parentStats.isDirectory() ||
    !sameIdentity(guard.identity, identity(descriptorStats)) ||
    !sameIdentity(guard.identity, identity(databaseStats)) ||
    !sameIdentity(guard.identity, identity(custodyStats)) ||
    !sameIdentity(parentIdentity, identity(parentStats))
  ) {
    throw new Error(`Lock database identity changed while opening: ${databasePath}`);
  }
}

function validatePublishedProvenance(provenance: PublishedProvenance): void {
  const descriptorStats = fs.fstatSync(provenance.descriptor, { bigint: true });
  const pathStats = fs.lstatSync(provenance.path, { bigint: true });
  const journalStats = fs.lstatSync(provenance.witnessPath, { bigint: true });
  if (
    !descriptorStats.isFile() ||
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    journalStats.isSymbolicLink() ||
    !journalStats.isFile() ||
    !sameIdentity(provenance.identity, identity(descriptorStats)) ||
    !sameIdentity(provenance.identity, identity(pathStats)) ||
    !sameIdentity(provenance.journalIdentity, identity(journalStats))
  ) {
    throw new Error(`SQLite lock provenance identity changed: ${provenance.path}`);
  }
  try {
    const journalPathStats = fs.lstatSync(provenance.journalPath, { bigint: true });
    if (
      journalPathStats.isSymbolicLink() ||
      !journalPathStats.isFile() ||
      !sameIdentity(provenance.journalIdentity, identity(journalPathStats))
    ) {
      throw new Error(`SQLite lock journal identity changed: ${provenance.journalPath}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function removePublishedProvenance(provenance: PublishedProvenance): void {
  const failures: Failure[] = [];
  const operations: Array<[string, () => void]> = [
    ['SQLite lock provenance descriptor close', () => fs.closeSync(provenance.descriptor)],
    [
      'SQLite lock journal witness cleanup',
      () => unlinkExact(provenance.witnessPath, provenance.journalIdentity, true),
    ],
    [
      'SQLite lock provenance file cleanup',
      () => unlinkExact(provenance.path, provenance.identity, true),
    ],
  ];
  for (const [context, operation] of operations) {
    const failure = captureFailure(context, operation);
    if (failure) failures.push(failure);
  }
  syncDirectory(path.dirname(provenance.path));
  if (failures.length > 0) throwWithCleanupFailures(failures[0], failures.slice(1));
}

function assertPathOwnership(lock: OpenLock, ownershipLostMessage: string): void {
  try {
    const parentStats = fs.lstatSync(path.dirname(lock.databasePath), { bigint: true });
    const databaseStats = fs.lstatSync(lock.databasePath, { bigint: true });
    const custodyStats = fs.lstatSync(lock.custodyPath, { bigint: true });
    const descriptorStats = fs.fstatSync(lock.identityDescriptor, { bigint: true });
    validatePublishedProvenance(lock.provenance);
    if (
      !parentStats.isSymbolicLink() &&
      parentStats.isDirectory() &&
      !databaseStats.isSymbolicLink() &&
      databaseStats.isFile() &&
      !custodyStats.isSymbolicLink() &&
      custodyStats.isFile() &&
      descriptorStats.isFile() &&
      databaseStats.nlink === 2n &&
      custodyStats.nlink === 2n &&
      descriptorStats.nlink === 2n &&
      sameIdentity(lock.parentIdentity, identity(parentStats)) &&
      sameIdentity(lock.databaseIdentity, identity(databaseStats)) &&
      sameIdentity(lock.databaseIdentity, identity(custodyStats)) &&
      sameIdentity(lock.databaseIdentity, identity(descriptorStats))
    ) {
      return;
    }
  } catch {
    // Missing or unreadable paths cannot prove ownership of the acquired inode.
  }
  throw new Error(ownershipLostMessage);
}

function openLock(databasePath: string): OpenLock {
  ensureDirectoryHierarchy(path.dirname(databasePath));
  const canonicalParent = fs.realpathSync.native(path.dirname(databasePath));
  const canonicalPath = path.join(canonicalParent, path.basename(databasePath));
  const parentIdentity = identity(fs.lstatSync(canonicalParent, { bigint: true }));
  const guard = openDatabaseIdentityGuard(canonicalPath);
  let custody: DatabaseCustodyLink | undefined;
  let database: DatabaseSync | undefined;
  let provenance: PublishedProvenance | undefined;
  try {
    if (guard.created) testHooks?.afterAbsentFilePrecreated?.(canonicalPath);
    recoverOrphanDatabaseCustodyLinks(canonicalPath, guard, parentIdentity);
    custody = createDatabaseCustodyLink(canonicalPath);
    validateDatabaseCustodyLink(canonicalPath, custody.path, guard);
    testHooks?.beforeDatabaseOpen?.(canonicalPath);
    database = new DatabaseSync(custody.path);
    database.exec('PRAGMA busy_timeout = 0');
    // Acquire through the cryptographically unguessable hard-link name before
    // pathname validation or test/user code can run. The link is an atomic,
    // cross-platform identity binding to the guarded inode: an A-to-B-to-A
    // pathname swap therefore still opens and locks A, never B.
    database.exec('BEGIN IMMEDIATE');
    database.exec('CREATE TABLE IF NOT EXISTS transaction_lock_provenance(epoch TEXT NOT NULL)');
    database.exec('DELETE FROM transaction_lock_provenance');
    database
      .prepare('INSERT INTO transaction_lock_provenance(epoch) VALUES (?)')
      .run(randomBytes(CUSTODY_TOKEN_BYTES).toString('hex'));
    provenance = publishCustodyProvenance(custody.path, guard.identity);
    testHooks?.afterDatabaseOpen?.(canonicalPath, database);
    validateDatabaseIdentity(canonicalPath, custody.path, guard, parentIdentity);
    validatePublishedProvenance(provenance);
    try {
      fs.chmodSync(canonicalPath, 0o600);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
    return {
      custodyPath: custody.path,
      database,
      databasePath: canonicalPath,
      databaseIdentity: guard.identity,
      identityDescriptor: guard.descriptor,
      parentIdentity,
      provenance,
    };
  } catch (error) {
    const cleanupFailures: Failure[] = [];
    if (database) {
      const openedDatabase = database;
      const closeFailure = captureFailure('SQLite lock database close', () =>
        openedDatabase.close()
      );
      if (closeFailure) cleanupFailures.push(closeFailure);
    }
    if (provenance) {
      const published = provenance;
      const provenanceCleanupFailure = captureFailure('SQLite lock provenance cleanup', () =>
        removePublishedProvenance(published)
      );
      if (provenanceCleanupFailure) cleanupFailures.push(provenanceCleanupFailure);
    }
    const descriptorCloseFailure = captureFailure('SQLite lock identity descriptor close', () =>
      fs.closeSync(guard.descriptor)
    );
    if (descriptorCloseFailure) cleanupFailures.push(descriptorCloseFailure);
    if (custody) {
      const custodyPath = custody.path;
      const custodyCleanupFailure = captureFailure('SQLite lock custody cleanup', () =>
        removeDatabaseCustodyLink(custodyPath, guard.identity)
      );
      if (custodyCleanupFailure) cleanupFailures.push(custodyCleanupFailure);
    }
    throwWithCleanupFailures({ context: 'SQLite lock open', error }, cleanupFailures);
  }
}

function isBusy(error: unknown): boolean {
  return /(?:database|database table) is (?:busy|locked)/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

function rollbackAndClose(lock: OpenLock): void {
  try {
    lock.database.exec('ROLLBACK');
  } catch {
    // BEGIN may not have succeeded, or SQLite may already have rolled back.
  }
  closeLockResources(lock);
}

function closeLockResources(lock: OpenLock): void {
  const failures: Failure[] = [];
  const operations: Array<[string, () => void]> = [
    ['SQLite lock database close', () => lock.database.close()],
    ['SQLite lock provenance cleanup', () => removePublishedProvenance(lock.provenance)],
    ['SQLite lock identity descriptor close', () => fs.closeSync(lock.identityDescriptor)],
    [
      'SQLite lock custody cleanup',
      () => removeDatabaseCustodyLink(lock.custodyPath, lock.databaseIdentity),
    ],
  ];
  for (const [context, operation] of operations) {
    const failure = captureFailure(context, operation);
    if (failure) failures.push(failure);
  }
  if (failures.length > 0) throwWithCleanupFailures(failures[0], failures.slice(1));
}

function rollbackAndCloseAfterFailure(lock: OpenLock, context: string, error: unknown): never {
  const primary = { context, error };
  try {
    lock.database.exec('ROLLBACK');
  } catch {
    // BEGIN may not have succeeded, or SQLite may already have rolled back.
  }
  const closeFailure = captureFailure('SQLite lock resource close', () => closeLockResources(lock));
  throwWithCleanupFailures(primary, closeFailure ? [closeFailure] : []);
}

function tryAcquire(databasePath: string, ownershipLostMessage: string): OpenLock | null {
  let lock: OpenLock;
  try {
    lock = openLock(databasePath);
  } catch (error) {
    if (isBusy(error)) return null;
    throw error;
  }
  try {
    // SQLite's OS-backed RESERVED lock is the generation/CAS operation. There
    // is no reclaim rename or unlink: a crashed connection releases the exact
    // kernel lock, while a delayed contender can only begin a later transaction.
    assertPathOwnership(lock, ownershipLostMessage);
    return lock;
  } catch (error) {
    const busy = isBusy(error);
    try {
      rollbackAndClose(lock);
    } catch (cleanupError) {
      throwWithCleanupFailures({ context: 'SQLite lock acquisition', error }, [
        { context: 'SQLite lock database close', error: cleanupError },
      ]);
    }
    if (busy) return null;
    throw error;
  }
}

function commitLock(lock: OpenLock, ownershipLostMessage: string): void {
  assertPathOwnership(lock, ownershipLostMessage);
  lock.database.exec('COMMIT');
}

/**
 * Attempts one non-blocking acquisition and retains SQLite's OS-backed RESERVED lock until
 * release. The returned object owns the exact opened database inode; it never unlinks or
 * reclaims a contender's lock, and a crashed process is released by the kernel.
 */
export function tryRetainSqliteTransactionLock(
  databasePath: string,
  ownershipLostMessage: string
): RetainedSqliteTransactionLock | null {
  const lock = tryAcquire(databasePath, ownershipLostMessage);
  if (!lock) return null;
  let retained: OpenLock | null = lock;
  return {
    databasePath: lock.databasePath,
    assertOwned(): void {
      if (retained !== lock) throw new Error(ownershipLostMessage);
      assertPathOwnership(lock, ownershipLostMessage);
    },
    release(): void {
      if (retained !== lock) return;
      retained = null;
      try {
        commitLock(lock, ownershipLostMessage);
      } catch (error) {
        rollbackAndCloseAfterFailure(lock, 'SQLite retained lock release', error);
      }
      closeLockResources(lock);
    },
  };
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Synchronous callers require the same bounded cross-process protocol.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withSqliteTransactionLockSync<T>(
  databasePath: string,
  operation: () => T,
  options: SqliteTransactionLockOptions
): T {
  const deadline = Date.now() + options.acquireTimeoutMs;
  let lock = tryAcquire(databasePath, options.ownershipLostMessage);
  while (!lock) {
    if (Date.now() >= deadline) throw new Error(options.timeoutMessage);
    sleepSync(Math.min(options.retryIntervalMs, Math.max(1, deadline - Date.now())));
    lock = tryAcquire(databasePath, options.ownershipLostMessage);
  }
  let result: T;
  try {
    result = operation();
    commitLock(lock, options.ownershipLostMessage);
  } catch (error) {
    rollbackAndCloseAfterFailure(lock, 'SQLite lock operation', error);
  }
  closeLockResources(lock);
  return result;
}

export async function withSqliteTransactionLock<T>(
  databasePath: string,
  operation: () => Promise<T>,
  options: SqliteTransactionLockOptions
): Promise<T> {
  const deadline = Date.now() + options.acquireTimeoutMs;
  let lock = tryAcquire(databasePath, options.ownershipLostMessage);
  while (!lock) {
    if (Date.now() >= deadline) throw new Error(options.timeoutMessage);
    await delay(Math.min(options.retryIntervalMs, Math.max(1, deadline - Date.now())));
    lock = tryAcquire(databasePath, options.ownershipLostMessage);
  }
  let result: T;
  try {
    result = await operation();
    commitLock(lock, options.ownershipLostMessage);
  } catch (error) {
    rollbackAndCloseAfterFailure(lock, 'SQLite lock operation', error);
  }
  closeLockResources(lock);
  return result;
}
