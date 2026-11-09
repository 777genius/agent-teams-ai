import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseCpuTimeMs,
  parseUnixResourceRows,
  parseWindowsResourceRows,
  stableOwnedResources,
  summarizePhase,
} from './startup-resources.mjs';

describe('isolated provider startup resource census', () => {
  it('parses portable OS cumulative CPU times and RSS units', () => {
    assert.equal(parseCpuTimeMs('01:02'), 62_000);
    assert.equal(parseCpuTimeMs('01:02:03'), 3_723_000);
    assert.equal(parseCpuTimeMs('2-01:02:03.50'), 176_523_500);
    assert.throws(() => parseCpuTimeMs('01:99'), /Invalid/);
    assert.deepEqual(parseUnixResourceRows(' 123 2048 00:00:01 opencode\n'), [
      { pid: 123, rssBytes: 2097152, cpuTimeMs: 1000, name: 'opencode' },
    ]);
    assert.deepEqual(parseWindowsResourceRows('\uFEFF{"pid":1,"rssBytes":4096,"cpuTimeMs":10.5,"name":"opencode.exe"}'), [
      { pid: 1, rssBytes: 4096, cpuTimeMs: 10.5, name: 'opencode.exe' },
    ]);
  });

  it('never attributes reused or vanished PIDs to the owned session', () => {
    const owned = [{ pid: 10, birth: 'A' }, { pid: 20, birth: 'B' }, { pid: 30, birth: 'C' }];
    const raw = [10, 20, 30].map((pid) => ({
      pid, rssBytes: 1024, cpuTimeMs: 500, name: 'opencode',
    }));
    const stable = stableOwnedResources(owned, raw, [
      { pid: 10, birth: 'A' }, { pid: 20, birth: 'changed' },
    ]);
    assert.deepEqual(stable.map((row) => row.pid), [10]);
    const result = summarizePhase('post-startup-idle', 3, stable, [
      { pid: 10, birth: 'A', cpuTimeMs: 200 },
    ], 5000);
    assert.equal(result.ownedProcessCount, 3);
    assert.equal(result.resourceSampledProcessCount, 1);
    assert.equal(result.cpuTimeMsSurvivorsDelta, 300);
    assert.equal(result.comparableSurvivorCount, 1);
    assert.equal(result.cliNamedAliveLowerBound, 1);
    assert(!JSON.stringify(result).includes('birth'));
    assert(!JSON.stringify(result).includes('opencode'));
  });

  it('rejects invalid resource numbers rather than recording a false zero', () => {
    assert.throws(() => parseUnixResourceRows('999 bad 00:01 opencode'), /Invalid/);
    assert.throws(() => parseWindowsResourceRows('{"pid":1,"rssBytes":-1,"cpuTimeMs":0,"name":"x"}'), /Invalid/);
    assert.throws(() => summarizePhase('wrong', 0, [], [], 0));
  });
});
