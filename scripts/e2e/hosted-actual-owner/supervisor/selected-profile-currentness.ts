import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SelectedPreparedProfile } from './owner-preparation-module';
import { canonicalJson } from './canonical';

function check(value: unknown): asserts value { if (!value) throw new Error('selected_profile_currentness'); }
function identity(stat: BigIntStats) {
  return { device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    uid: String(stat.uid), gid: String(stat.gid) };
}
/** Rewalk from the namespace root on every check. For an absent source the
 * complete existing ancestor chain AND the missing component are retained;
 * replacing an ancestor cannot satisfy a cached "still absent" observation. */
function observe(path: string, expected: string | null | 'directory') {
  check(path.startsWith('/sandbox/') && path.length <= 4096 && !path.includes('\0') && !path.includes('\\'));
  const components = path.split('/').slice(1);
  check(components.every(part => part && part !== '.' && part !== '..'));
  const owned = [openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
  const chain: unknown[] = [identity(fstatSync(owned[0], { bigint: true }))];
  try {
    for (let index = 0; index < components.length; index++) {
      const directory = index < components.length - 1 || expected === 'directory';
      let fd: number;
      try { fd = openSync(`/proc/self/fd/${owned.at(-1)!}/${components[index]}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)); }
      catch (error) {
        check(expected === null && (error as NodeJS.ErrnoException).code === 'ENOENT');
        return canonicalJson({ chain, absent: index });
      }
      owned.push(fd);
      const before = fstatSync(fd, { bigint: true });
      check(before.uid === BigInt(process.getuid!()) && !(before.mode & 0o022n));
      chain.push(identity(before));
      if (directory) { check(before.isDirectory()); continue; }
      check(before.isFile() && before.nlink === 1n && before.size <= 16n * 1024n * 1024n && expected !== null);
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      try {
        while (offset < Number(before.size)) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
          check(count > 0); hash.update(buffer.subarray(0, count)); offset += count;
        }
      } finally { buffer.fill(0); }
      const after = fstatSync(fd, { bigint: true });
      check(hash.digest('hex') === expected && before.dev === after.dev && before.ino === after.ino &&
        before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
        before.nlink === after.nlink && before.mode === after.mode);
      chain.push({ size: String(after.size), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs) });
    }
    check(expected !== null);
    return canonicalJson({ chain, absent: null });
  } finally { for (const fd of owned.reverse()) closeSync(fd); }
}
export function retainSelectedProfileCurrentness(profile: SelectedPreparedProfile) {
  const checks: { path: string; expected: string | null | 'directory'; observed: string }[] = [];
  const add = (path: string, expected: string | null | 'directory') => checks.push({ path, expected, observed: observe(path, expected) });
  for (const path of new Set([profile.profileRootPath, profile.homePath, profile.tmpPath,
    profile.xdgConfigHome, profile.xdgDataHome, profile.xdgCacheHome])) add(path, 'directory');
  add(profile.managedAuthPath, profile.managedAuthFingerprint);
  for (const source of profile.sourceAuthSources ?? []) add(source.path, source.fingerprint);
  return Object.freeze({ assertCurrent() {
    for (const row of checks) check(observe(row.path, row.expected) === row.observed);
  } });
}
