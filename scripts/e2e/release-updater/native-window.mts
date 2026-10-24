import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { waitFor } from './cdp.mts';

const execute = promisify(execFile);
interface ProcessIdentity {
  pid: number;
  group: number;
  start: string;
  state: string;
}

export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const directory = `/proc/${pid}`;
    assert.equal(
      (await stat(directory)).uid,
      process.getuid?.(),
      'Process must belong to TEST runner'
    );
    const raw = await readFile(`${directory}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    assert(fields[19] && fields[0], 'Invalid process stat');
    return { pid, group: Number(fields[2]), start: fields[19], state: fields[0] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function groupMembers(owner: ProcessIdentity) {
  const members: ProcessIdentity[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    // Other users' processes are outside this probe's ownership.
    if ((await stat(`/proc/${pid}`).catch(() => null))?.uid !== process.getuid?.()) continue;
    const member = await processIdentity(pid);
    if (member?.group === owner.group && member.state !== 'Z') {
      assert(BigInt(member.start) >= BigInt(owner.start), 'Process group predates owned launch');
      if (member.pid === owner.pid) assert.equal(member.start, owner.start, 'Owned PID was reused');
      members.push(member);
    }
  }
  return members;
}

export async function stopOwnedGroup(owner: ProcessIdentity) {
  assert.equal(owner.group, owner.pid, 'Launch must own a detached process group');
  assert(owner.group > 1 && owner.group !== process.pid);
  const before = await groupMembers(owner);
  if (before.length) {
    try {
      process.kill(-owner.group, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const until = Date.now() + 3000;
  let remaining = await groupMembers(owner);
  while (remaining.length && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = await groupMembers(owner);
  }
  let killed: number[] = [];
  if (remaining.length) {
    // Fresh ownership readback immediately before escalating this group only.
    remaining = await groupMembers(owner);
    if (remaining.length) {
      process.kill(-owner.group, 'SIGKILL');
      killed = remaining.map((member) => member.pid);
    }
    await waitFor(
      async () => ((await groupMembers(owner)).length === 0 ? true : null),
      'owned process group termination',
      3000
    );
  }
  return {
    group: owner.group,
    before: before.map((member) => member.pid),
    sigkill: killed,
    remaining: await groupMembers(owner),
  };
}

export async function captureNativeWindow(owner: ProcessIdentity, output: string) {
  const env = {
    PATH: '/usr/bin:/bin',
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    LC_ALL: 'C',
  };
  const run = (command: string, args: string[]) =>
    execute(command, args, { env, timeout: 10_000, maxBuffer: 1_048_576 });
  const result = await waitFor(
    async () => {
      try {
        const { stdout: tree } = await run('/usr/bin/xwininfo', ['-root', '-tree']);
        const members = await groupMembers(owner);
        for (const line of tree.split('\n')) {
          const match = /^(0x[0-9a-f]+)\s/i.exec(line.trimStart());
          if (!match) continue;
          const id = match[1];
          assert(id);
          const { stdout: property } = await run('/usr/bin/xprop', ['-id', id, '_NET_WM_PID']);
          const pid = Number(/=\s*(\d+)/.exec(property)?.[1]);
          const identity = members.find((member) => member.pid === pid);
          if (!identity) continue;
          const { stdout: info } = await run('/usr/bin/xwininfo', ['-id', id, '-stats']);
          const width = Number(/Width:\s*(\d+)/.exec(info)?.[1]);
          const height = Number(/Height:\s*(\d+)/.exec(info)?.[1]);
          if (
            !/Map State:\s*IsViewable/.test(info) ||
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width < 300 ||
            height < 200
          )
            continue;
          const screenshot = path.join(output, 'native-window.png');
          await run('/usr/bin/import', ['-window', id, screenshot]);
          // A newly mapped Electron window can precede its first renderer paint.
          // Wait for actual captured content while retaining the same PID checks.
          if ((await stat(screenshot)).size <= 1000) continue;
          return { id, identity, width, height, mapState: 'IsViewable', tree, property, info };
        }
        return null;
      } catch (error) {
        // Old Electron windows can disappear between tree enumeration and xprop
        // during an actual updater restart. Retry only this X11 lifecycle race.
        if (
          error instanceof Error &&
          error.message.includes('BadWindow (invalid Window parameter)')
        )
          return null;
        throw error;
      }
    },
    'visible X11 window owned by official AppImage',
    10_000
  );
  const current = await processIdentity(result.identity.pid);
  assert.equal(current?.start, result.identity.start, 'Window owner identity changed');
  assert.equal(current?.group, owner.group);
  const screenshot = path.join(output, 'native-window.png');
  assert((await stat(screenshot)).size > 1000, 'Native X11 screenshot is empty');
  return { ...result, screenshot };
}
