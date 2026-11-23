/** TEST-only physical observations. No signal, provider request, UI input or readiness authority. */
import assert from 'node:assert/strict';
import { constants, closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { clearTimeout, setTimeout } from 'node:timers';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import type { DesktopMetadataBirthWitness } from './desktop-opencode-metadata-lineage.ts';

interface Observation {
  host?: ProcessFact;
  births: readonly ProcessFact[];
  unobservedPids?: readonly number[];
}
export interface DesktopMetadataBirthCensus {
  sample(): void;
  assertHealthy(): void;
  witness(): DesktopMetadataBirthWitness;
  expectOriginalQuit(): void;
  close(): { closed: true; samples: number; failed: boolean; hostObserved: boolean; originalExitObserved: boolean;
    unobservedPids: readonly number[] };
}

/** One synchronous bounded read at a time; close cancels its sole future callback in the same isolate. */
export function createDesktopMetadataBirthCensus(read: (context: { quitExpected: boolean }) => Observation): DesktopMetadataBirthCensus {
  let host: ProcessFact | undefined, failure: unknown, failed = false, closed = false;
  let quitExpected = false, exited = false, samples = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const births = new Map<number, ProcessFact>(), unobserved = new Set<number>();
  const guard = () => { if (failed) throw failure; };
  const sample = () => {
    guard(); assert.equal(closed, false, 'a closed read-only census cannot be restarted');
    try {
      const observed = read({ quitExpected }); samples++;
      assert.ok(observed.births.length <= 128);
      for (const pid of observed.unobservedPids ?? []) unobserved.add(pid);
      assert.ok(unobserved.size <= 128, 'bounded unobserved process candidates; never physical witnesses');
      if (!observed.host) {
        assert.equal(observed.births.length, 0);
        if (host) { assert.equal(quitExpected, true, 'the original Host cannot disappear before original Quit'); exited = true; }
        return;
      }
      assert.equal(exited, false, 'an exited original Host cannot become a new epoch');
      if (host) assert.deepEqual(observed.host, host, 'same actual original metadata Host');
      else host = { ...observed.host };
      for (const birth of observed.births) {
        assert.equal(birth.parentPid, host.pid); assert.equal(birth.groupId, birth.pid);
        assert.match(birth.birth, /^linux-starttime:[1-9]\d*$/u);
        const before = births.get(birth.pid);
        if (before) assert.deepEqual(birth, before, 'a physical PID cannot replace its retained kernel birth');
        else births.set(birth.pid, { ...birth });
      }
      assert.ok(births.size <= 128, 'bounded original metadata and runtime observations');
    } catch (error) { failed = true; failure = error; throw error; }
  };
  const schedule = () => {
    if (closed || failed) return;
    timer = setTimeout(() => {
      timer = undefined;
      try { sample(); } catch { return; } // Sticky failure is surfaced by the existing owner fences.
      schedule();
    }, 25);
    timer.unref();
  };
  sample(); schedule();
  return {
    sample,
    assertHealthy: guard,
    witness() {
      guard(); assert.ok(host, 'one physically captured original Host precedes metadata lineage');
      return { host: { ...host }, births: Array.from(births.values(), row => ({ ...row })) };
    },
    expectOriginalQuit() { guard(); assert.ok(host); quitExpected = true; },
    close() {
      closed = true; if (timer) clearTimeout(timer); timer = undefined;
      return { closed: true, samples, failed, hostObserved: host !== undefined,
        originalExitObserved: exited, unobservedPids: [...unobserved] };
    },
  };
}

function bytes(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const result = Buffer.alloc(maximum + 1); let length = 0;
    while (length < result.length) {
      const count = readSync(fd, result, length, result.length - length, null);
      if (!count) break; length += count;
    }
    assert.ok(length <= maximum, 'bounded original proc observation'); return result.subarray(0, length);
  } finally { closeSync(fd); }
}
const decode = (value: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(value);
function identity(pid: number, read = bytes) {
  const value = decode(read(`/proc/${pid}/stat`, 4096));
  const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u);
  assert.match(fields[19] ?? '', /^[1-9]\d*$/u);
  const parentPid = Number(fields[1]), groupId = Number(fields[2]);
  assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0 && Number.isSafeInteger(groupId) && groupId > 0);
  return { parentPid, groupId, birth: 'linux-starttime:' + fields[19], alive: !['Z', 'X', 'x'].includes(fields[0]!) };
}
const argv = (pid: number, read = bytes) => decode(read(`/proc/${pid}/cmdline`, 128 * 1024)).split('\0').filter(Boolean);
const children = (pid: number, read = bytes) => {
  const value = decode(read(`/proc/${pid}/task/${pid}/children`, 8192)).trim();
  const result = value ? value.split(/\s+/u).map(Number) : [];
  assert.ok(result.length <= 128 && result.every(value => Number.isSafeInteger(value) && value > 1));
  assert.equal(new Set(result).size, result.length); return result;
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Traverse only descendants of the exact captured app group, then retain selected direct Bun births. */
export function createDesktopLinuxMetadataBirthReader(options: {
  group(): number; previousGroup?: number; node: string; hostEntry: string; executable: string; embeddedEntry: string;
}, io: { read(path: string, maximum: number): Buffer; realpath(path: string): string } = {
  read: bytes, realpath: path => realpathSync(path),
}): (context: { quitExpected: boolean }) => Observation {
  let group: number | undefined, anchor: ReturnType<typeof identity> | undefined, host: ProcessFact | undefined;
  const retainedPids = new Set<number>();
  const originalHostExited = new Error('the observed original Host exited during its read');
  const procIdentity = (pid: number) => identity(pid, io.read);
  const procArgv = (pid: number) => argv(pid, io.read);
  const procChildren = (pid: number) => children(pid, io.read);
  const capture = (pid: number, executable: string, expected: readonly string[]): ProcessFact => {
    const before = procIdentity(pid);
    if (!before.alive && host?.pid === pid) throw originalHostExited;
    assert.equal(before.alive, true, 'a physical witness must be captured while alive');
    assert.equal(io.realpath(`/proc/${pid}/exe`), executable);
    assert.deepEqual(procArgv(pid), expected, 'exact selected original executable arguments');
    const after = procIdentity(pid);
    if (!after.alive && host?.pid === pid) {
      assert.deepEqual({ ...after, alive: true }, before); throw originalHostExited;
    }
    assert.equal(after.alive, true);
    assert.deepEqual(after, before, 'the original kernel birth remains current around executable/argv reads');
    return { pid, parentPid: before.parentPid, groupId: before.groupId, birth: before.birth, command: executable };
  };
  return ({ quitExpected }) => {
    assert.equal(process.platform, 'linux');
    const selected = options.group(); assert.ok(Number.isSafeInteger(selected) && selected > 1);
    if (selected === options.previousGroup && group === undefined) return { births: [] };
    if (group === undefined) group = selected;
    assert.equal(selected, group, 'one captured app group per physical metadata epoch');
    if (!host) {
      const currentAnchor = procIdentity(group); assert.equal(currentAnchor.alive, true); assert.equal(currentAnchor.groupId, group);
      if (anchor) assert.deepEqual(currentAnchor, anchor); else anchor = currentAnchor;
      const queue = [group], seen = new Set<number>(), matches: ProcessFact[] = [];
      while (queue.length) {
        const pid = queue.shift()!; assert.ok(!seen.has(pid)); seen.add(pid); assert.ok(seen.size <= 256);
        let selectedHost = false;
        try {
          const before = procIdentity(pid); if (!before.alive || before.groupId !== group) continue;
          const args = procArgv(pid);
          if (args.length === 2 && args[0] === options.node && args[1] === options.hostEntry) {
            selectedHost = true;
            matches.push(capture(pid, options.node, [options.node, options.hostEntry]));
          }
          queue.push(...procChildren(pid));
          assert.deepEqual(procIdentity(pid), before, 'captured ancestry stays current during discovery');
        } catch (error) { if (!missing(error) || selectedHost) throw error; } // No vanished candidate becomes a witness.
      }
      assert.ok(matches.length <= 1, 'one original Host under the captured app ancestry');
      if (!matches.length) return { births: [] };
      host = matches[0]!; assert.equal(host.groupId, group);
    }
    let selectedBunCapture = false;
    try {
      let before: ReturnType<typeof identity>;
      try { before = procIdentity(host.pid); } catch (error) { if (missing(error)) return { births: [] }; throw error; }
      assert.deepEqual({ parentPid: before.parentPid, groupId: before.groupId, birth: before.birth },
        { parentPid: host.parentPid, groupId: host.groupId, birth: host.birth });
      if (!before.alive) return { births: [] };
      assert.deepEqual(capture(host.pid, options.node, [options.node, options.hostEntry]), host);
      const births: ProcessFact[] = [], unobservedPids: number[] = [];
      for (const pid of procChildren(host.pid)) {
        // A retained birth is historical evidence only. Current presence/release is rechecked by the full lineage oracle.
        if (retainedPids.has(pid)) continue;
        let executable: string;
        try { executable = io.realpath(`/proc/${pid}/exe`); }
        catch (error) { if (missing(error)) { unobservedPids.push(pid); continue; } throw error; }
        if (executable !== options.executable) continue;
        selectedBunCapture = true;
        const birth = capture(pid, options.executable, [options.executable, '--no-env-file', '--config=/dev/null',
          '--no-install', options.embeddedEntry]);
        selectedBunCapture = false;
        assert.equal(birth.parentPid, host.pid); assert.equal(birth.groupId, pid); births.push(birth);
      }
      const after = procIdentity(host.pid);
      assert.deepEqual({ ...after, alive: true }, before, 'same captured Host around the original child census');
      if (!after.alive) throw originalHostExited;
      for (const birth of births) retainedPids.add(birth.pid);
      return { host: { ...host }, births, unobservedPids };
    } catch (error) {
      // A fresh same-original Host exit observation during its planned Quit preserves historical births only.
      // The original release oracle still owns all custody and physical absence assertions.
      if (quitExpected && !selectedBunCapture && (missing(error) || error === originalHostExited)) {
        try {
          const after = procIdentity(host.pid);
          assert.deepEqual({ parentPid: after.parentPid, groupId: after.groupId, birth: after.birth },
            { parentPid: host.parentPid, groupId: host.groupId, birth: host.birth });
          if (!after.alive) return { births: [] };
        } catch (again) { if (missing(again)) return { births: [] }; throw again; }
      }
      throw error;
    }
  };
}
