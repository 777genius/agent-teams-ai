import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type CreateArtifactFile = 'team-meta' | 'members-meta' | 'config';

interface FileSnapshot {
  raw: Buffer | null;
  fingerprint: string;
  identity: string | null;
}

interface DirectorySnapshot {
  existed: boolean;
  identity: string | null;
}

export interface CreateArtifactRollbackResult {
  status: 'rolled-back' | 'retained';
  retained: string[];
  errors: string[];
}

export interface TeamProvisioningCreateArtifactTransaction {
  ensureDirectory(directoryPath: string): Promise<void>;
  recordFileWrite(file: CreateArtifactFile): Promise<void>;
  rollbackIfOwned(): Promise<CreateArtifactRollbackResult>;
}

export interface BeginCreateArtifactTransactionInput {
  attemptId: string;
  teamName: string;
  teamDir: string;
  tasksDir: string;
}

export type BeginCreateArtifactTransaction = (
  input: BeginCreateArtifactTransactionInput
) => Promise<TeamProvisioningCreateArtifactTransaction>;

function fingerprint(raw: Buffer | null): string {
  return createHash('sha256')
    .update(
      raw === null ? Buffer.from('missing\0') : Buffer.concat([Buffer.from('present\0'), raw])
    )
    .digest('hex');
}

async function readRegularFileSnapshot(filePath: string): Promise<FileSnapshot> {
  let before: fs.Stats;
  try {
    before = await fs.promises.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: null, fingerprint: fingerprint(null), identity: null };
    }
    throw error;
  }
  if (!before.isFile()) {
    throw new Error(`Refusing to snapshot non-regular launch artifact: ${filePath}`);
  }
  const raw = await fs.promises.readFile(filePath);
  const after = await fs.promises.lstat(filePath);
  const beforeIdentity = `${before.dev}:${before.ino}`;
  const afterIdentity = `${after.dev}:${after.ino}`;
  if (!after.isFile() || beforeIdentity !== afterIdentity || before.size !== after.size) {
    throw new Error(`Launch artifact changed while its identity was captured: ${filePath}`);
  }
  return { raw, fingerprint: fingerprint(raw), identity: afterIdentity };
}

async function readDirectorySnapshot(directoryPath: string): Promise<DirectorySnapshot> {
  try {
    const stat = await fs.promises.lstat(directoryPath);
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to use non-directory launch artifact root: ${directoryPath}`);
    }
    return { existed: true, identity: `${stat.dev}:${stat.ino}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { existed: false, identity: null };
    }
    throw error;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CreateArtifactCompareAndSwapMismatchError extends Error {
  constructor() {
    super('create artifact compare-and-swap mismatch');
    this.name = 'CreateArtifactCompareAndSwapMismatchError';
  }
}

export class FileSystemCreateArtifactTransaction
  implements TeamProvisioningCreateArtifactTransaction
{
  private readonly priorFiles = new Map<CreateArtifactFile, FileSnapshot>();
  private readonly ownedFiles = new Map<CreateArtifactFile, FileSnapshot>();
  private readonly priorDirectories = new Map<string, DirectorySnapshot>();
  private readonly ownedDirectories = new Map<string, string>();
  private rollbackPromise: Promise<CreateArtifactRollbackResult> | null = null;

  private constructor(
    readonly attemptId: string,
    readonly teamName: string,
    private readonly teamDir: string,
    private readonly tasksDir: string
  ) {}

  static async begin(
    input: BeginCreateArtifactTransactionInput
  ): Promise<FileSystemCreateArtifactTransaction> {
    const transaction = new FileSystemCreateArtifactTransaction(
      input.attemptId,
      input.teamName,
      input.teamDir,
      input.tasksDir
    );
    for (const file of ['team-meta', 'members-meta', 'config'] as const) {
      transaction.priorFiles.set(file, await readRegularFileSnapshot(transaction.filePath(file)));
    }
    for (const directoryPath of [input.teamDir, input.tasksDir]) {
      transaction.priorDirectories.set(
        directoryPath,
        await readDirectorySnapshot(directoryPath)
      );
    }
    return transaction;
  }

  async ensureDirectory(directoryPath: string): Promise<void> {
    if (!this.priorDirectories.has(directoryPath)) {
      throw new Error(`Directory is outside the create artifact manifest: ${directoryPath}`);
    }
    await fs.promises.mkdir(directoryPath, { recursive: true });
    const current = await readDirectorySnapshot(directoryPath);
    const prior = this.priorDirectories.get(directoryPath)!;
    if (!prior.existed && current.identity) {
      this.ownedDirectories.set(directoryPath, current.identity);
    }
  }

  async recordFileWrite(file: CreateArtifactFile): Promise<void> {
    const snapshot = await readRegularFileSnapshot(this.filePath(file));
    if (snapshot.raw === null) {
      throw new Error(`Launch artifact write did not materialize ${file}`);
    }
    this.ownedFiles.set(file, snapshot);
  }

  rollbackIfOwned(): Promise<CreateArtifactRollbackResult> {
    this.rollbackPromise ??= this.rollback();
    return this.rollbackPromise;
  }

  private filePath(file: CreateArtifactFile): string {
    const fileName =
      file === 'team-meta'
        ? 'team.meta.json'
        : file === 'members-meta'
          ? 'members.meta.json'
          : 'config.json';
    return path.join(this.teamDir, fileName);
  }

  private async rollback(): Promise<CreateArtifactRollbackResult> {
    const retained: string[] = [];
    const errors: string[] = [];
    for (const file of ['config', 'members-meta', 'team-meta'] as const) {
      const owned = this.ownedFiles.get(file);
      if (!owned) continue;
      try {
        const current = await readRegularFileSnapshot(this.filePath(file));
        if (
          current.identity !== owned.identity ||
          current.fingerprint !== owned.fingerprint ||
          current.raw === null ||
          !current.raw.equals(owned.raw!)
        ) {
          retained.push(file);
          continue;
        }
        const prior = this.priorFiles.get(file)!;
        if (prior.raw === null) {
          await this.removeOwnedFileCas(file, owned);
        } else {
          await atomicWriteAsync(this.filePath(file), prior.raw, {
            beforeCommit: async () => {
              const recheck = await readRegularFileSnapshot(this.filePath(file));
              if (
                recheck.identity !== owned.identity ||
                recheck.raw === null ||
                !recheck.raw.equals(owned.raw!)
              ) {
                throw new CreateArtifactCompareAndSwapMismatchError();
              }
            },
          });
        }
      } catch (error) {
        if (error instanceof CreateArtifactCompareAndSwapMismatchError) retained.push(file);
        else errors.push(`${file}: ${describeError(error)}`);
      }
    }

    // Task contents are never enumerated, copied, or recursively removed. Only a root
    // created by this attempt may be removed, and only while it is still the same empty inode.
    for (const directoryPath of [this.tasksDir, this.teamDir]) {
      const ownedIdentity = this.ownedDirectories.get(directoryPath);
      if (!ownedIdentity) continue;
      try {
        const current = await readDirectorySnapshot(directoryPath);
        if (!current.existed) continue;
        if (current.identity !== ownedIdentity) {
          retained.push(path.basename(directoryPath));
          continue;
        }
        await fs.promises.rmdir(directoryPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') retained.push(path.basename(directoryPath));
        else errors.push(`${path.basename(directoryPath)}: ${describeError(error)}`);
      }
    }
    return {
      status: retained.length === 0 && errors.length === 0 ? 'rolled-back' : 'retained',
      retained,
      errors,
    };
  }

  private async removeOwnedFileCas(file: CreateArtifactFile, owned: FileSnapshot): Promise<void> {
    const filePath = this.filePath(file);
    const attemptFence = createHash('sha256').update(this.attemptId).digest('hex').slice(0, 16);
    const quarantinePath = path.join(
      this.teamDir,
      `.${path.basename(filePath)}.${attemptFence}.${randomUUID()}.rollback-cas`
    );
    try {
      await fs.promises.rename(filePath, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const quarantined = await readRegularFileSnapshot(quarantinePath);
    if (
      quarantined.identity === owned.identity &&
      quarantined.raw !== null &&
      quarantined.raw.equals(owned.raw!)
    ) {
      await fs.promises.unlink(quarantinePath);
      return;
    }

    // The path changed between the read fence and rename. Restore the moved file
    // without overwriting a still-newer writer; a hard-link publish is atomic and
    // fails closed when another file already occupies the canonical path.
    try {
      await fs.promises.link(quarantinePath, filePath);
      await fs.promises.unlink(quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    throw new CreateArtifactCompareAndSwapMismatchError();
  }
}

export const beginFileSystemCreateArtifactTransaction: BeginCreateArtifactTransaction = (input) =>
  FileSystemCreateArtifactTransaction.begin({
    ...input,
    attemptId: input.attemptId || randomUUID(),
  });
