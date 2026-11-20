import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { command, processTable } from './desktop-backend-observations.ts';
import type { DesktopV2ManagementFixture } from './desktop-opencode-v2-management-fixture.ts';
import type { DesktopV2ManagementStep } from './desktop-opencode-v2-management-model.ts';

async function birth(pid: number): Promise<string | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u);
    assert.match(fields[19] ?? '', /^\d+$/u);
    return fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Read-only original Host child census; executable paths never grant signal authority. */
export function observeDesktopV2ManagementProcesses(group: number, fixture: DesktopV2ManagementFixture) {
  const selected = fixture.v2Management;
  const children: { pid: number; ppid: number; pgid: number; birth: string; executableSha256: string; dataRoot: string; role: string }[] = [];
  const unobservedCandidates: (Pick<(typeof children)[number], 'pid' | 'ppid' | 'pgid' | 'birth'> &
    { readonly reason: 'unobserved-executable' })[] = [];
  const probes: { step: DesktopV2ManagementStep; pid: number; birth: string; dataRoot: string; absentAfterReceipt: boolean }[] = [];
  let host: { pid: number; birth: string } | undefined;
  return {
    children, probes, unobservedCandidates,
    hostPid: () => host?.pid,
    hostIdentity: () => host ? { ...host } : undefined,
    async observe(step?: DesktopV2ManagementStep) {
      const table = processTable();
      const hosts = table.filter(row => row.pgid === group && command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
      assert.equal(hosts.length, 1, 'one original captured Host owns management');
      const pid = hosts[0]!.pid, started = await birth(pid);
      assert.ok(started);
      if (!host) host = { pid, birth: started };
      assert.deepEqual({ pid, birth: started }, host, 'management stays on the original Host');
      const observed: typeof children = [];
      for (const child of table.filter(row => row.ppid === pid)) {
        const started = await birth(child.pid);
        if (!started) continue;
        const candidate = unobservedCandidates.find(value => value.pid === child.pid);
        if (candidate) assert.equal(started, candidate.birth, 'an unobserved candidate keeps its original birth');
        let executable: string, args: string[], dataRoot: string;
        let executableObserved = false;
        try {
          executable = await realpath(`/proc/${child.pid}/exe`);
          executableObserved = true;
          args = (await readFile(`/proc/${child.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
          const data = (await readFile(`/proc/${child.pid}/environ`, 'utf8')).split('\0').filter(value => value.startsWith('XDG_DATA_HOME='));
          assert.equal(data.length, 1); dataRoot = data[0]!.slice('XDG_DATA_HOME='.length);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            const after = await birth(child.pid);
            if (after === undefined) continue;
            if (!executableObserved && after === started &&
                !children.some(value => value.pid === child.pid && value.birth === started)) {
              // An unknown executable is neither a native witness nor evidence of exit.
              // Retain its original identity for the separate final absence check.
              if (!candidate) {
                assert.ok(unobservedCandidates.length < 32, 'finite original unobserved management candidates');
                unobservedCandidates.push(Object.freeze({ ...child, birth: started, reason: 'unobserved-executable' }));
              }
              continue;
            }
          }
          throw error;
        }
        if (await birth(child.pid) !== started) continue;
        assert.equal(executable, selected.selection.bunPath, 'only the selected OpenCode Bun child may run');
        assert.deepEqual(args, [executable, '--no-env-file', '--config=/dev/null', '--no-install', selected.childEntry]);
        assert.equal(child.pgid, child.pid, 'original detached native custody group');
        assert.equal(dirname(dataRoot), selected.management.environment.XDG_DATA_HOME);
        const role = /^agent-teams-v2-(probe|catalog|key)-/u.exec(basename(dataRoot))?.[1];
        assert.ok(role, 'native namespace belongs to the captured management operation');
        if (!children.some(value => value.pid === child.pid && value.birth === started)) {
          assert.equal(await fileDigest(executable), selected.selection.bunSha256);
          if (await birth(child.pid) !== started) continue;
          children.push({ ...child, birth: started, executableSha256: selected.selection.bunSha256, dataRoot, role });
          assert.ok(children.length <= 32, 'finite original management children');
        }
        observed.push(children.find(value => value.pid === child.pid && value.birth === started)!);
      }
      if (step) {
        const actual = observed.filter(child => child.role === 'probe');
        assert.equal(actual.length, 1, 'the model response waits for the one original native probe child');
        assert.ok(!probes.some(value => value.step === step));
        const original = actual[0]!;
        assert.ok(!probes.some(value => value.pid === original.pid && value.birth === original.birth));
        probes.push({ step, pid: original.pid, birth: original.birth, dataRoot: original.dataRoot, absentAfterReceipt: false });
      } else {
        for (const probe of probes) {
          assert.notEqual(await birth(probe.pid), probe.birth, 'each original durable receipt retired its native probe');
          probe.absentAfterReceipt = true;
        }
      }
    },
    async remaining() {
      const result: ((typeof children)[number] | (typeof unobservedCandidates)[number])[] = [];
      for (const child of children) if (await birth(child.pid) === child.birth) result.push(child);
      // The candidate may have been reparented. Only this exact original birth matters,
      // and an already qualified same-birth child is covered by the existing read above.
      for (const candidate of unobservedCandidates) if (
        !children.some(child => child.pid === candidate.pid && child.birth === candidate.birth) &&
        await birth(candidate.pid) === candidate.birth
      ) result.push(candidate);
      return result;
    },
  };
}
