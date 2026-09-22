import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type DurablePathIdentity, getDurablePathIdentity } from './durablePathIdentity';
import { readBoundedFileHandleUtf8Async } from './durableBoundedFileRead';
import { unlinkDurablePathIfIdentityMatchesAsync } from './durablePathOperationSupport';
import { readProcessStartTimeMs } from './processStartTime';

const WAIT_MS = 10;
const TIMEOUT_MS = 30_000;
const MAX_RESIDUE_ENTRIES = 128;
const MAX_RESIDUE_NAME_BYTES = 32 * 1024;
const MAX_RESIDUE_SCAN_MS = 250;
const MAX_LOCK_RECEIPT_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Receipt { version: 1; nonce: string; pid: number; processStart: string; incarnation: 'portable-start-time-v1'; identity: DurablePathIdentity; fileName: string; parentIdentity: DurablePathIdentity; }
interface Observation { receipt: Receipt; identity: DurablePathIdentity; }
interface Takeover { version: 1; identity: DurablePathIdentity; fileName: string; owner: Pick<Receipt, 'nonce' | 'pid' | 'processStart' | 'incarnation'>; observed: Receipt; }
interface HeldTakeover { readonly path: string; readonly owner: Takeover['owner']; }
interface ResidueScan { readonly entries: readonly string[]; readonly complete: boolean; }

function missing(error: unknown): boolean { const code = (error as NodeJS.ErrnoException).code; return code === 'ENOENT' || code === 'ENOTDIR'; }
async function statContainingDirectory(pathname: string): Promise<fs.Stats> {
  const directory = path.dirname(pathname);
  // A /proc descriptor spelling is itself a symlink, but its target is the
  // already-open directory authority. Do not reject that intentional bridge.
  return /^\/proc\/self\/fd\/\d+(?:\/|$)/.test(directory)
    ? fs.promises.stat(directory)
    : fs.promises.lstat(directory);
}
function trusted(value: unknown): value is DurablePathIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const i = value as Partial<DurablePathIdentity>;
  return Number.isSafeInteger(i.dev) && i.dev > 0 && Number.isSafeInteger(i.ino) && i.ino > 0 && Number.isFinite(i.birthtimeMs) && i.birthtimeMs >= 0;
}
function sameIdentity(a: DurablePathIdentity, b: DurablePathIdentity): boolean { return trusted(a) && trusted(b) && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs; }
function validReceipt(value: unknown, identity: DurablePathIdentity, expectedFileName?: string, expectedParentIdentity?: DurablePathIdentity): value is Receipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Partial<Receipt>;
  return r.version === 1 && typeof r.nonce === 'string' && UUID.test(r.nonce) && Number.isSafeInteger(r.pid) && r.pid > 0 && typeof r.processStart === 'string' && /^\d+$/.test(r.processStart) && r.incarnation === 'portable-start-time-v1' && r.identity !== undefined && sameIdentity(r.identity, identity) && typeof r.fileName === 'string' && r.fileName.length > 0 && r.parentIdentity !== undefined && trusted(r.parentIdentity) && (expectedFileName === undefined || r.fileName === expectedFileName) && (expectedParentIdentity === undefined || sameIdentity(r.parentIdentity, expectedParentIdentity));
}
function same(a: Observation, b: Observation): boolean { return sameIdentity(a.identity, b.identity) && a.receipt.nonce === b.receipt.nonce && a.receipt.pid === b.receipt.pid && a.receipt.processStart === b.receipt.processStart; }
function sameTakeover(a: Takeover, b: Takeover): boolean {
  return a.owner.nonce === b.owner.nonce && a.owner.pid === b.owner.pid &&
    a.owner.processStart === b.owner.processStart && a.owner.incarnation === b.owner.incarnation &&
    a.observed.nonce === b.observed.nonce && a.observed.pid === b.observed.pid &&
    a.observed.processStart === b.observed.processStart && sameIdentity(a.observed.identity, b.observed.identity);
}
async function read(pathname: string, expectedNonce?: string, bindingPath = pathname): Promise<Observation | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stats = await handle.stat(); const identity = getDurablePathIdentity(stats);
    const parentStats = await statContainingDirectory(bindingPath);
    const parentIdentity = getDurablePathIdentity(parentStats);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || !trusted(parentIdentity)) return null;
    if (!stats.isFile() || !trusted(identity)) return null;
    const confirmedParent = await statContainingDirectory(bindingPath);
    if (!confirmedParent.isDirectory() || confirmedParent.isSymbolicLink() ||
      !sameIdentity(getDurablePathIdentity(confirmedParent), parentIdentity)) return null;
    if (stats.size > MAX_LOCK_RECEIPT_BYTES) return null;
    const parsed = JSON.parse(await readBoundedFileHandleUtf8Async(handle, MAX_LOCK_RECEIPT_BYTES)) as unknown;
    return validReceipt(parsed, identity, path.basename(bindingPath), parentIdentity) && (expectedNonce === undefined || parsed.nonce === expectedNonce)
      ? { receipt: parsed, identity } : null;
  } catch (error) { if (missing(error) || error instanceof SyntaxError) return null; throw error; }
  finally { await handle?.close().catch(() => undefined); }
}
async function live(receipt: Pick<Receipt, 'pid' | 'processStart'>): Promise<boolean> {
  try { process.kill(receipt.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  const start = await readProcessStartTimeMs(receipt.pid); return start === null || String(start) === receipt.processStart;
}
async function exclusive(pathname: string, payload: unknown): Promise<DurablePathIdentity> {
  const handle = await fs.promises.open(pathname, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8'); await handle.sync(); return getDurablePathIdentity(await handle.stat()); } finally { await handle.close().catch(() => undefined); }
}
async function unlinkExact(pathname: string, identity: DurablePathIdentity): Promise<boolean> {
  try {
    return await unlinkDurablePathIfIdentityMatchesAsync(pathname, identity);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function takeoverPath(lockPath: string, observed: Observation): string { return `${lockPath}.takeover.${observed.receipt.nonce}`; }
function validTakeover(
  value: unknown,
  identity: DurablePathIdentity,
  expectedLockPath?: string,
  expectedParentIdentity?: DurablePathIdentity,
  expectedFileName?: string
): value is Takeover {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as Partial<Takeover>; const owner = t.owner as Partial<Receipt> | undefined; const observed = t.observed as Partial<Receipt> | undefined;
  return t.version === 1 && t.identity !== undefined && sameIdentity(t.identity, identity) && t.fileName === expectedFileName && !!owner && !!observed && typeof owner.nonce === 'string' && UUID.test(owner.nonce) && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.processStart === 'string' && /^\d+$/.test(owner.processStart) && owner.incarnation === 'portable-start-time-v1' && observed.identity !== undefined && trusted(observed.identity) && validReceipt(observed, observed.identity, expectedLockPath && path.basename(expectedLockPath), expectedParentIdentity) && (!expectedFileName || expectedFileName === `${path.basename(expectedLockPath!)}.takeover.${observed.nonce}`);
}
function getTakeoverLockPath(pathname: string): string | null {
  const match = /^(.*\.takeover\.[0-9a-f-]{36})(?:\.(?:prepare|recovery)\.[0-9a-f-]{36})*$/i.exec(pathname);
  if (!match) return null;
  const marker = '.takeover.';
  const markerIndex = match[1].lastIndexOf(marker);
  return markerIndex < 0 ? null : match[1].slice(0, markerIndex);
}
function getPublishedTakeoverPath(pathname: string): string | null {
  const match = /^(.*\.takeover\.[0-9a-f-]{36})(?:\.(?:prepare|recovery)\.[0-9a-f-]{36})*$/i.exec(pathname);
  return match?.[1] ?? null;
}
async function readTakeover(pathname: string): Promise<Takeover | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const lockPath = getTakeoverLockPath(pathname);
    if (!lockPath) return null;
    handle = await fs.promises.open(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stats = await handle.stat();
    const parentStats = await statContainingDirectory(lockPath);
    const parentIdentity = getDurablePathIdentity(parentStats);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || !trusted(parentIdentity)) return null;
    if (!stats.isFile() || stats.size > MAX_LOCK_RECEIPT_BYTES) return null;
    const confirmedParent = await statContainingDirectory(lockPath);
    if (!confirmedParent.isDirectory() || confirmedParent.isSymbolicLink() || !sameIdentity(getDurablePathIdentity(confirmedParent), parentIdentity)) return null;
    const parsed = JSON.parse(await readBoundedFileHandleUtf8Async(handle, MAX_LOCK_RECEIPT_BYTES)) as unknown;
    return validTakeover(parsed, getDurablePathIdentity(stats), lockPath, parentIdentity, path.basename(getPublishedTakeoverPath(pathname) ?? pathname)) ? parsed : null;
  }
  catch (error) { if (missing(error) || error instanceof SyntaxError) return null; throw error; }
  finally { await handle?.close().catch(() => undefined); }
}
async function detachForeignSafe(pathname: string, expected: Observation): Promise<'removed' | 'missing' | 'changed'> {
  // Claiming through a hard link is no-replace.  Never rename the public
  // spelling into recovery merely to authenticate it: that transition can
  // make a delayed foreign B disappear before restoration runs.
  if (!(await unlinkExact(pathname, expected.identity))) {
    try { await fs.promises.lstat(pathname); return 'changed'; }
    catch (error) { if (missing(error)) return 'missing'; throw error; }
  }
  return 'removed';
}
async function detachTakeoverSafe(pathname: string, expected: Takeover): Promise<'removed' | 'missing' | 'changed'> {
  let stats: fs.Stats;
  try { stats = await fs.promises.lstat(pathname); }
  catch (error) { if (missing(error)) return 'missing'; throw error; }
  const current = await readTakeover(pathname);
  if (!current || !sameTakeover(current, expected)) return 'changed';
  return (await unlinkExact(pathname, getDurablePathIdentity(stats))) ? 'removed' : 'changed';
}
async function removeDeadTakeover(pathname: string): Promise<void> {
  const before = await readTakeover(pathname); if (!before || await live(before.owner)) return;
  await detachTakeoverSafe(pathname, before);
}
async function scanResidues(lockPath: string): Promise<ResidueScan> {
  let directory: fs.Dir;
  try { directory = await fs.promises.opendir(path.dirname(lockPath)); } catch (error) { if (missing(error)) return { entries: [], complete: true }; throw error; }
  const entries: string[] = []; let bytes = 0; const deadline = Date.now() + MAX_RESIDUE_SCAN_MS;
  try {
    const familyPrefix = `${path.basename(lockPath)}.`;
    for await (const entry of directory) {
      // Bounds apply to this lock's namespace only.  An unrelated directory
      // flood must not make the lock's authenticated residues invisible.
      if (!entry.name.startsWith(familyPrefix)) continue;
      const nameBytes = Buffer.byteLength(entry.name);
      if (entries.length >= MAX_RESIDUE_ENTRIES || bytes + nameBytes > MAX_RESIDUE_NAME_BYTES || Date.now() > deadline) return { entries, complete: false };
      entries.push(entry.name); bytes += nameBytes;
    }
    return { entries, complete: true };
  } finally { await directory.close().catch(() => undefined); }
}
async function reclaim(lockPath: string): Promise<void> {
  const scan = await scanResidues(lockPath); if (!scan.complete) return;
  const base = path.basename(lockPath);
  for (const entry of scan.entries) {
    const candidate = path.join(path.dirname(lockPath), entry);
    if (
      entry.startsWith(`${base}.takeover.`) &&
      !entry.includes('.prepare.') &&
      !entry.includes('.recovery.') &&
      !entry.includes('.claim.')
    ) {
      await removeDeadTakeover(candidate);
      continue;
    }
    if (!entry.includes('.prepare.') && !entry.includes('.recovery.') && !entry.includes('.claim.')) continue;
    // Prepare and recovery artifacts are not interchangeable: takeover
    // receipts carry an owner/observed pair, while claim and lock receipts
    // carry a full filesystem identity.  Parse each exact schema before
    // reclaiming it; malformed or foreign lookalikes remain untouched.
    if (entry.startsWith(`${base}.takeover.`)) {
      if (entry.includes('.claim.')) {
        const claim = await read(candidate, undefined, getTakeoverLockPath(candidate) ?? candidate);
        if (claim && !(await live(claim.receipt))) {
          await detachForeignSafe(candidate, claim);
        }
        continue;
      }
      const takeover = await readTakeover(candidate);
      if (takeover && !(await live(takeover.owner))) {
        await detachTakeoverSafe(candidate, takeover);
      }
      continue;
    }
    if (!entry.startsWith(`${base}.prepare.`) && !entry.startsWith(`${base}.recovery.`)) continue;
    const residuePrefix = entry.startsWith(`${base}.prepare.`)
      ? `${base}.prepare.`
      : `${base}.recovery.`;
    const residueNonce = entry.slice(residuePrefix.length);
    const residue = UUID.test(residueNonce) ? await read(candidate, residueNonce, lockPath) : null;
    if (residue && !(await live(residue.receipt))) await detachForeignSafe(candidate, residue);
  }
}
async function hasLiveTakeover(lockPath: string): Promise<boolean> {
  const scan = await scanResidues(lockPath); if (!scan.complete) return true;
  const prefix = `${path.basename(lockPath)}.takeover.`;
  for (const entry of scan.entries) { if (!entry.startsWith(prefix) || entry.includes('.prepare.') || entry.includes('.recovery.')) continue; const t = await readTakeover(path.join(path.dirname(lockPath), entry)); if (t && await live(t.owner)) return true; }
  return false;
}
async function createTakeover(lockPath: string, observed: Observation): Promise<HeldTakeover | null> {
  const start = await readProcessStartTimeMs(process.pid); if (start === null) throw new Error('Cannot acquire durable record lock without process incarnation identity');
  const destination = takeoverPath(lockPath, observed); const temp = `${destination}.prepare.${randomUUID()}`;
  const owner = { nonce: randomUUID(), pid: process.pid, processStart: String(start), incarnation: 'portable-start-time-v1' as const };
  let tempIdentity: DurablePathIdentity | null = null;
  try {
    const handle = await fs.promises.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      tempIdentity = getDurablePathIdentity(await handle.stat());
      const payload: Takeover = { version: 1, identity: tempIdentity, fileName: path.basename(destination), owner, observed: observed.receipt };
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
      if (!sameIdentity(getDurablePathIdentity(await handle.stat()), tempIdentity)) throw new Error('Takeover receipt identity changed before publication');
    } finally { await handle.close().catch(() => undefined); }
    try { await fs.promises.link(temp, destination); return { path: destination, owner }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error; }
  }
  finally { if (tempIdentity) await unlinkExact(temp, tempIdentity); }
}
async function dropOwnTakeover(authority: HeldTakeover): Promise<void> {
  const observed = await readTakeover(authority.path);
  if (!observed || observed.owner.nonce !== authority.owner.nonce || observed.owner.pid !== authority.owner.pid || observed.owner.processStart !== authority.owner.processStart) return;
  await detachTakeoverSafe(authority.path, observed);
}
async function reclaimStale(lockPath: string): Promise<void> {
  const observed = await read(lockPath); if (!observed || await live(observed.receipt)) return;
  const authority = await createTakeover(lockPath, observed); if (!authority) return;
  try {
    const claim = `${authority.path}.claim.${randomUUID()}`;
    let claimIdentity: DurablePathIdentity | null = null;
    try { await fs.promises.link(lockPath, claim); claimIdentity = getDurablePathIdentity(await fs.promises.lstat(claim)); } catch (error) { if (missing(error)) return; throw error; }
    try { const linked = await read(claim, undefined, lockPath); if (linked && same(linked, observed)) await detachForeignSafe(lockPath, observed); }
    finally { if (claimIdentity) await unlinkExact(claim, claimIdentity); }
  } finally { await dropOwnTakeover(authority); }
}
async function acquire(lockPath: string): Promise<{ lockPath: string; receipt: Receipt }> {
  const start = await readProcessStartTimeMs(process.pid); if (start === null) throw new Error('Cannot acquire durable record lock without process incarnation identity');
  const began = Date.now();
  for (;;) {
    await reclaim(lockPath); const nonce = randomUUID(); const temp = `${lockPath}.prepare.${nonce}`;
    let tempIdentity: DurablePathIdentity | null = null;
    try {
      const handle = await fs.promises.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      let receipt: Receipt | null = null;
      try {
        const identity = getDurablePathIdentity(await handle.stat());
        const parentStats = await statContainingDirectory(lockPath);
        const parentIdentity = getDurablePathIdentity(parentStats);
        if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || !trusted(parentIdentity)) throw new Error('Cannot bind durable record lock to its containing directory');
        receipt = { version: 1, nonce, pid: process.pid, processStart: String(start), incarnation: 'portable-start-time-v1', identity, fileName: path.basename(lockPath), parentIdentity };
        await handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
        await handle.sync();
        tempIdentity = getDurablePathIdentity(await handle.stat());
      } finally { await handle.close().catch(() => undefined); }
      if (!receipt) throw new Error('Cannot publish an unbound durable record lock');
      if (!(await hasLiveTakeover(lockPath))) { try { await fs.promises.link(temp, lockPath); return { lockPath, receipt }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    } finally { if (tempIdentity) await unlinkExact(temp, tempIdentity); }
    await reclaimStale(lockPath); if (Date.now() - began >= TIMEOUT_MS) throw new Error('Timed out waiting for durable record lock'); await new Promise<void>((resolve) => setTimeout(resolve, WAIT_MS));
  }
}
async function release(held: { lockPath: string; receipt: Receipt }): Promise<void> {
  const observed = await read(held.lockPath); if (!observed || !same(observed, { receipt: held.receipt, identity: held.receipt.identity })) return;
  const authority = await createTakeover(held.lockPath, observed); if (!authority) return;
  const claim = `${authority.path}.claim.${randomUUID()}`;
  let claimIdentity: DurablePathIdentity | null = null;
  try {
    try {
      await fs.promises.link(held.lockPath, claim);
      claimIdentity = getDurablePathIdentity(await fs.promises.lstat(claim));
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const linked = await read(claim, undefined, held.lockPath);
    if (linked && same(linked, observed)) await detachForeignSafe(held.lockPath, observed);
  } finally {
    if (claimIdentity) await unlinkExact(claim, claimIdentity);
    await dropOwnTakeover(authority);
  }
}

export async function reclaimDurableReservationRecordLockResidues(recordPath: string): Promise<void> { await reclaim(`${recordPath}.lock`); }
export async function withDurableReservationRecordLock<T>(recordPath: string, operation: () => Promise<T>): Promise<T> { const held = await acquire(`${recordPath}.lock`); try { return await operation(); } finally { await release(held); } }
