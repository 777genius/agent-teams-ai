import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';

import { assertRootCurrent, descriptorMountId, procFdPath, type RootAnchor } from './anchors';
import {
  CONTRACT_PURPOSE,
  GLOBAL_FINAL_RUN_RECORD,
  canonicalJson,
  exactRecord,
  sha256,
} from './contracts';

const MARKER = '.p3c-sandbox.json';
const DIRECTORIES = Object.freeze([
  'project',
  'home',
  'config',
  'cache',
  'data',
  'state',
  'tmp',
  'run',
  'raw',
  'capture',
  'evidence',
  'stage',
] as const);
const MAX_CLEANUP_ENTRIES = 200_000;
const MAX_CLEANUP_DEPTH = 64;

export interface SandboxIdentity {
  readonly runId: string;
  readonly name: string;
  readonly device: string;
  readonly inode: string;
  readonly mountId: string;
}

export interface DisposableSandbox extends SandboxIdentity {
  readonly parent: RootAnchor;
  readonly handle: FileHandle;
  readonly paths: Readonly<Record<(typeof DIRECTORIES)[number], string>>;
  readonly directoryIdentities: Readonly<
    Record<
      (typeof DIRECTORIES)[number],
      {
        readonly device: string;
        readonly inode: string;
        readonly mountId: string;
      }
    >
  >;
}

export interface CleanupResult {
  readonly disposition: 'removed' | 'preserved';
  readonly runId: string;
  readonly path: string;
  readonly markerVerified: boolean;
  readonly zeroOwnedSurvivors: boolean;
  readonly reason: string | null;
}

async function createPrivateDirectory(
  parent: FileHandle,
  name: string,
  expectedDevice: string,
  expectedMountId: string
): Promise<FileHandle> {
  await mkdir(`${procFdPath(parent)}/${name}`, { mode: 0o700 });
  const handle = await open(
    `${procFdPath(parent)}/${name}`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  const stat = await handle.stat({ bigint: true });
  const expectedUid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.nlink < 2n ||
    Number(stat.mode & 0o777n) !== 0o700 ||
    expectedUid === undefined ||
    stat.uid !== BigInt(expectedUid) ||
    String(stat.dev) !== expectedDevice ||
    (await descriptorMountId(handle)) !== expectedMountId
  ) {
    await handle.close();
    throw new Error('p3c_sandbox_directory_mode');
  }
  return handle;
}

async function writeMarker(
  handle: FileHandle,
  value: SandboxIdentity,
  parent: RootAnchor
): Promise<void> {
  const bytes = Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      purpose: `${CONTRACT_PURPOSE}/sandbox-marker`,
      ...value,
      parentDevice: parent.identity.device,
      parentInode: parent.identity.inode,
    })
  );
  const marker = await open(
    `${procFdPath(handle)}/${MARKER}`,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400
  );
  try {
    await marker.writeFile(bytes);
    await marker.sync();
    const stat = await marker.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      Number(stat.mode & 0o777n) !== 0o400 ||
      Number(stat.size) !== bytes.length ||
      String(stat.dev) !== value.device ||
      (await descriptorMountId(marker)) !== value.mountId
    )
      throw new Error('p3c_sandbox_marker_metadata');
  } finally {
    await marker.close();
  }
}

export async function createSandbox(
  parent: RootAnchor,
  controllerNonce: string
): Promise<DisposableSandbox> {
  if (parent.name !== 'sandboxParent' || !/^[0-9a-f]{64}$/u.test(controllerNonce))
    throw new Error('p3c_sandbox_authority');
  await assertRootCurrent(parent);
  const parentNames = await readdir(procFdPath(parent.handle));
  if (
    parentNames.length > 1 ||
    (parentNames.length === 1 && parentNames[0] !== GLOBAL_FINAL_RUN_RECORD)
  )
    throw new Error('p3c_sandbox_parent_not_empty');
  const runId = sha256(`agent-teams.p3c.run/v1\0${controllerNonce}`);
  const name = `actual-owner-${runId}`;
  const handle = await createPrivateDirectory(
    parent.handle,
    name,
    parent.identity.device,
    parent.pin.mountId
  );
  try {
    const stat = await handle.stat({ bigint: true });
    const identity = Object.freeze({
      runId,
      name,
      device: String(stat.dev),
      inode: String(stat.ino),
      mountId: await descriptorMountId(handle),
    });
    await writeMarker(handle, identity, parent);
    const directoryIdentities = {} as Record<
      (typeof DIRECTORIES)[number],
      { device: string; inode: string; mountId: string }
    >;
    for (const directory of DIRECTORIES) {
      const child = await createPrivateDirectory(
        handle,
        directory,
        identity.device,
        identity.mountId
      );
      try {
        const childStat = await child.stat({ bigint: true });
        directoryIdentities[directory] = Object.freeze({
          device: String(childStat.dev),
          inode: String(childStat.ino),
          mountId: await descriptorMountId(child),
        });
      } finally {
        await child.close();
      }
    }
    await handle.sync();
    await parent.handle.sync();
    const sandbox = Object.freeze({
      ...identity,
      parent,
      handle,
      paths: Object.freeze(
        Object.fromEntries(
          DIRECTORIES.map((directory) => [directory, `${procFdPath(handle)}/${directory}`])
        ) as Record<(typeof DIRECTORIES)[number], string>
      ),
      directoryIdentities: Object.freeze(directoryIdentities),
    });
    await assertSandboxCurrent(sandbox);
    return sandbox;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readMarker(sandbox: DisposableSandbox): Promise<Record<string, unknown>> {
  const handle = await open(
    `${procFdPath(sandbox.handle)}/${MARKER}`,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      Number(before.mode & 0o777n) !== 0o400 ||
      before.size > 4096n
    )
      throw new Error('p3c_sandbox_marker_invalid');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('p3c_sandbox_marker_changed');
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (canonicalJson(parsed) !== bytes.toString('utf8'))
      throw new Error('p3c_sandbox_marker_noncanonical');
    return exactRecord(
      parsed,
      [
        'schemaVersion',
        'purpose',
        'runId',
        'name',
        'device',
        'inode',
        'mountId',
        'parentDevice',
        'parentInode',
      ],
      'sandbox_marker'
    );
  } finally {
    await handle.close();
  }
}

export async function assertSandboxCurrent(
  sandbox: DisposableSandbox,
  pathName = sandbox.name
): Promise<void> {
  await assertRootCurrent(sandbox.parent);
  const descriptor = await sandbox.handle.stat({ bigint: true });
  const pathname = await open(
    `${procFdPath(sandbox.parent.handle)}/${pathName}`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const linked = await pathname.stat({ bigint: true });
    const marker = await readMarker(sandbox);
    const expectedUid = process.getuid?.();
    if (
      !descriptor.isDirectory() ||
      descriptor.nlink < 2n ||
      descriptor.dev !== linked.dev ||
      descriptor.ino !== linked.ino ||
      expectedUid === undefined ||
      descriptor.uid !== BigInt(expectedUid) ||
      String(descriptor.dev) !== sandbox.device ||
      String(descriptor.ino) !== sandbox.inode ||
      Number(descriptor.mode & 0o777n) !== 0o700 ||
      (await descriptorMountId(sandbox.handle)) !== sandbox.mountId ||
      marker.schemaVersion !== 1 ||
      marker.purpose !== `${CONTRACT_PURPOSE}/sandbox-marker` ||
      marker.runId !== sandbox.runId ||
      marker.name !== sandbox.name ||
      marker.device !== sandbox.device ||
      marker.inode !== sandbox.inode ||
      marker.mountId !== sandbox.mountId ||
      marker.parentDevice !== sandbox.parent.identity.device ||
      marker.parentInode !== sandbox.parent.identity.inode
    )
      throw new Error('p3c_sandbox_identity_changed');

    for (const directory of DIRECTORIES) {
      const child = await open(
        `${procFdPath(sandbox.handle)}/${directory}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        const childStat = await child.stat({ bigint: true });
        const pinned = sandbox.directoryIdentities[directory];
        if (
          !childStat.isDirectory() ||
          childStat.nlink < 2n ||
          Number(childStat.mode & 0o777n) !== 0o700 ||
          expectedUid === undefined ||
          childStat.uid !== BigInt(expectedUid) ||
          String(childStat.dev) !== pinned.device ||
          String(childStat.ino) !== pinned.inode ||
          pinned.device !== sandbox.device ||
          (await descriptorMountId(child)) !== pinned.mountId ||
          pinned.mountId !== sandbox.mountId
        )
          throw new Error(`p3c_sandbox_child_identity_changed:${directory}`);
      } finally {
        await child.close();
      }
    }
  } finally {
    await pathname.close();
  }
}

async function deleteContents(
  sandbox: DisposableSandbox,
  directory: FileHandle,
  budget: { remaining: number },
  depth = 0
): Promise<void> {
  if (depth > MAX_CLEANUP_DEPTH) throw new Error('p3c_cleanup_depth');
  const beforeDirectory = await directory.stat({ bigint: true });
  const expectedUid = process.getuid?.();
  if (
    !beforeDirectory.isDirectory() ||
    beforeDirectory.nlink < 2n ||
    Number(beforeDirectory.mode & 0o777n) !== 0o700 ||
    expectedUid === undefined ||
    beforeDirectory.uid !== BigInt(expectedUid) ||
    String(beforeDirectory.dev) !== sandbox.device ||
    (await descriptorMountId(directory)) !== sandbox.mountId
  )
    throw new Error('p3c_cleanup_directory_metadata');
  const names = (await readdir(procFdPath(directory))).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right))
  );
  budget.remaining -= names.length;
  if (budget.remaining < 0) throw new Error('p3c_cleanup_entry_budget');
  for (const name of names) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
      throw new Error('p3c_cleanup_name');
    const path = `${procFdPath(directory)}/${name}`;
    let child: FileHandle | undefined;
    try {
      child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR')
        throw new Error('p3c_cleanup_special_entry');
    }
    if (child) {
      try {
        const stat = await child.stat({ bigint: true });
        if (
          !stat.isDirectory() ||
          stat.nlink < 2n ||
          Number(stat.mode & 0o777n) !== 0o700 ||
          expectedUid === undefined ||
          stat.uid !== BigInt(expectedUid) ||
          String(stat.dev) !== sandbox.device ||
          (await descriptorMountId(child)) !== sandbox.mountId
        )
          throw new Error('p3c_cleanup_directory_metadata');
        await deleteContents(sandbox, child, budget, depth + 1);
      } finally {
        await child.close();
      }
      await rmdir(path);
      continue;
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat({ bigint: true });
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        expectedUid === undefined ||
        stat.uid !== BigInt(expectedUid) ||
        String(stat.dev) !== sandbox.device ||
        (await descriptorMountId(file)) !== sandbox.mountId
      )
        throw new Error('p3c_cleanup_file_metadata');
    } finally {
      await file.close();
    }
    await unlink(path);
  }
  const afterDirectory = await directory.stat({ bigint: true });
  if (beforeDirectory.dev !== afterDirectory.dev || beforeDirectory.ino !== afterDirectory.ino)
    throw new Error('p3c_cleanup_directory_replaced');
}

export async function cleanupSandbox(
  sandbox: DisposableSandbox,
  zeroOwnedSurvivors: boolean
): Promise<CleanupResult> {
  const originalPath = `${sandbox.parent.pin.path}/${sandbox.name}`;
  if (!zeroOwnedSurvivors) {
    return Object.freeze({
      disposition: 'preserved',
      runId: sandbox.runId,
      path: originalPath,
      markerVerified: false,
      zeroOwnedSurvivors: false,
      reason: 'owned_process_drain_unproven',
    });
  }
  try {
    await assertSandboxCurrent(sandbox);
  } catch (error) {
    return Object.freeze({
      disposition: 'preserved',
      runId: sandbox.runId,
      path: originalPath,
      markerVerified: false,
      zeroOwnedSurvivors: true,
      reason: error instanceof Error ? error.message : 'sandbox_identity_unproven',
    });
  }
  const cleanupName = `.cleanup-${sandbox.runId}`;
  let moved = false;
  let markerVerified = false;
  try {
    await rename(
      `${procFdPath(sandbox.parent.handle)}/${sandbox.name}`,
      `${procFdPath(sandbox.parent.handle)}/${cleanupName}`
    );
    moved = true;
    await assertSandboxCurrent(sandbox, cleanupName);
    markerVerified = true;
    await deleteContents(sandbox, sandbox.handle, {
      remaining: MAX_CLEANUP_ENTRIES,
    });
    await sandbox.handle.close();
    await rmdir(`${procFdPath(sandbox.parent.handle)}/${cleanupName}`);
    await sandbox.parent.handle.sync();
    await assertRootCurrent(sandbox.parent);
    const remainingParentNames = await readdir(procFdPath(sandbox.parent.handle));
    if (
      remainingParentNames.length > 1 ||
      (remainingParentNames.length === 1 && remainingParentNames[0] !== GLOBAL_FINAL_RUN_RECORD)
    )
      throw new Error('p3c_cleanup_parent_not_empty');
    return Object.freeze({
      disposition: 'removed',
      runId: sandbox.runId,
      path: originalPath,
      markerVerified: true,
      zeroOwnedSurvivors: true,
      reason: null,
    });
  } catch (error) {
    return Object.freeze({
      disposition: 'preserved',
      runId: sandbox.runId,
      path: `${sandbox.parent.pin.path}/${moved ? cleanupName : sandbox.name}`,
      markerVerified,
      zeroOwnedSurvivors: true,
      reason: error instanceof Error ? error.message : 'sandbox_cleanup_failed',
    });
  }
}
