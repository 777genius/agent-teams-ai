import { listRuntimeProcessTableForCurrentPlatform } from '@features/tmux-installer/main';
import { getAppDataBasePath } from '@main/utils/pathDecoder';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SPEC_FILE = 'bootstrap.json';
const OWNER_FILE = '.agent-teams-bootstrap-owner.json';

interface SpecOwner {
  version: 1;
  kind: 'agent-teams-bootstrap';
  ownerPid: number;
  specFile: typeof SPEC_FILE;
  consumerPid?: number;
}

function profilePrefix(): string {
  const scope = createHash('sha256').update(path.resolve(getAppDataBasePath())).digest('hex');
  return `agent-teams-bootstrap-${scope.slice(0, 16)}-`;
}

function privateOwned(stat: fs.Stats, directory = false): boolean {
  return (
    (directory ? stat.isDirectory() : stat.isFile()) &&
    !stat.isSymbolicLink() &&
    (process.platform === 'win32' ||
      ((stat.mode & 0o777) === (directory ? 0o700 : 0o600) && stat.uid === process.getuid?.()))
  );
}

function isPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

async function inspectOwnedSpec(filePath: string): Promise<{
  directory: string;
  directoryStat: fs.Stats;
  markerPath: string;
  markerStat: fs.Stats;
  owner: SpecOwner;
} | null> {
  const directory = path.dirname(filePath);
  if (
    !path.isAbsolute(filePath) ||
    path.basename(filePath) !== SPEC_FILE ||
    !path.basename(directory).startsWith(profilePrefix()) ||
    path.dirname(directory) !== path.resolve(os.tmpdir())
  )
    return null;
  try {
    const directoryStat = await fs.promises.lstat(directory);
    if (!privateOwned(directoryStat, true)) return null;
    if (
      (await fs.promises.realpath(directory)) !==
      path.join(await fs.promises.realpath(os.tmpdir()), path.basename(directory))
    )
      return null;
    const markerPath = path.join(directory, OWNER_FILE);
    const markerStat = await fs.promises.lstat(markerPath);
    if (!privateOwned(markerStat) || markerStat.size > 1024) return null;
    const owner = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as SpecOwner;
    if (
      owner.version !== 1 ||
      owner.kind !== 'agent-teams-bootstrap' ||
      owner.specFile !== SPEC_FILE ||
      !isPid(owner.ownerPid) ||
      (owner.consumerPid !== undefined && !isPid(owner.consumerPid))
    )
      return null;
    const specStat = await fs.promises.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (specStat && !privateOwned(specStat)) return null;
    return { directory, directoryStat, markerPath, markerStat, owner };
  } catch {
    return null;
  }
}

function pidMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Private one-shot file. The runtime leases ownership before reading and consumes it immediately. */
export async function writeOwnedBootstrapSpecFile(serializedSpec: string): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), profilePrefix()));
  const filePath = path.join(directory, SPEC_FILE);
  const markerPath = path.join(directory, OWNER_FILE);
  try {
    await fs.promises.chmod(directory, 0o700);
    const owner: SpecOwner = {
      version: 1,
      kind: 'agent-teams-bootstrap',
      ownerPid: process.pid,
      specFile: SPEC_FILE,
    };
    await fs.promises.writeFile(markerPath, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    await fs.promises.writeFile(filePath, serializedSpec, { mode: 0o600, flag: 'wx' });
    return filePath;
  } catch (error) {
    // Only these exact paths in our newly-created directory belong to this failed write.
    await fs.promises.unlink(filePath).catch(() => {});
    await fs.promises.unlink(markerPath).catch(() => {});
    await fs.promises.rmdir(directory).catch(() => {});
    throw error;
  }
}

/** Never delete an arbitrary CLI spec or interfere with a leased live consumer. */
export async function removeOwnedBootstrapSpecFile(filePath: string | null): Promise<void> {
  if (!filePath) return;
  const owned = await inspectOwnedSpec(filePath);
  if (!owned || (owned.owner.consumerPid && pidMayBeAlive(owned.owner.consumerPid))) return;
  const current = await inspectOwnedSpec(filePath);
  if (
    !current ||
    current.directoryStat.ino !== owned.directoryStat.ino ||
    current.directoryStat.dev !== owned.directoryStat.dev ||
    current.markerStat.ino !== owned.markerStat.ino ||
    (current.owner.consumerPid && pidMayBeAlive(current.owner.consumerPid))
  )
    return;
  await fs.promises.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fs.promises.unlink(owned.markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fs.promises.rmdir(owned.directory).catch(() => {});
}

/** Startup-only, profile-scoped orphan recovery. Failed process observation preserves files. */
export async function cleanupOrphanedDeterministicBootstrapSpecs(
  observeProcesses: () => Promise<readonly { pid: number; command: string }[]> = () =>
    listRuntimeProcessTableForCurrentPlatform({ bypassCache: true })
): Promise<void> {
  const entries = await fs.promises.readdir(os.tmpdir(), { withFileTypes: true });
  const candidates = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(profilePrefix())
  );
  if (!candidates.length) return;
  const processes = await observeProcesses();
  for (const entry of candidates) {
    const specPath = path.join(os.tmpdir(), entry.name, SPEC_FILE);
    const owned = await inspectOwnedSpec(specPath);
    if (!owned || pidMayBeAlive(owned.owner.ownerPid)) continue;
    if (owned.owner.consumerPid && pidMayBeAlive(owned.owner.consumerPid)) continue;
    // Also protect a launched consumer before it has acquired its marker lease.
    if (processes.some((row) => row.command.includes(specPath))) continue;
    await removeOwnedBootstrapSpecFile(specPath);
  }
}
