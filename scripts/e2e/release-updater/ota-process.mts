import assert from 'node:assert/strict';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';

import { readAsar } from './archive.mts';
import { processIdentity } from './native-window.mts';

export interface OwnedRoots {
  home: string;
  userData: string;
  root: string;
}

async function mountedAppIdentity(pid: number, roots: OwnedRoots, minimumStart: string) {
  if ((await stat(`/proc/${pid}`).catch(() => null))?.uid !== process.getuid?.()) return null;
  const identity = await processIdentity(pid);
  if (!identity || identity.state === 'Z' || BigInt(identity.start) < BigInt(minimumStart))
    return null;
  const executable = await readlink(`/proc/${pid}/exe`).catch(() => '');
  if (
    !executable.startsWith(path.join(roots.root, 'tmp', '.mount_')) ||
    !executable.endsWith('/agent-teams-ai')
  )
    return null;
  return { identity, executable };
}

export async function ownedApps(roots: OwnedRoots, minimumStart: string) {
  const apps = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const mounted = await mountedAppIdentity(pid, roots, minimumStart);
    if (!mounted) continue;
    const { identity, executable } = mounted;
    const raw = await readFile(`/proc/${pid}/environ`).catch(() => null);
    if (!raw) continue;
    const env = new Map(
      raw
        .toString()
        .split('\0')
        .map((item) => {
          const split = item.indexOf('=');
          return [item.slice(0, split), item.slice(split + 1)];
        })
    );
    if (
      env.get('HOME') !== roots.home ||
      env.get('AGENT_TEAMS_ELECTRON_USER_DATA_DIR') !== roots.userData
    )
      continue;
    const image = env.get('APPIMAGE');
    if (!image || path.dirname(image) !== path.join(roots.root, 'install')) continue;
    const command = (await readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0)))
      .toString()
      .split('\0');
    if (command.some((argument) => argument.startsWith('--type='))) continue;
    apps.push({
      ...identity,
      image,
      executable,
      command,
      roots: {
        home: env.get('HOME'),
        userData: env.get('AGENT_TEAMS_ELECTRON_USER_DATA_DIR'),
        claude: env.get('AGENT_TEAMS_ELECTRON_CLAUDE_ROOT'),
      },
    });
  }
  return apps;
}

export async function proveInstalledApp(
  app: Awaited<ReturnType<typeof ownedApps>>[number],
  expectedVersion: string
) {
  const identity = await processIdentity(app.pid);
  assert.equal(identity?.start, app.start, 'Successor PID was reused');
  const resources = path.join(path.dirname(app.executable), 'resources');
  const sources = await readAsar(path.join(resources, 'app.asar'), ['package.json']);
  const metadata = JSON.parse(sources.get('package.json')!.toString()) as {
    version: string;
    main: string;
  };
  assert.equal(metadata.version, expectedVersion);
  assert.equal(metadata.main, 'dist-electron/main/index.cjs');
  const elf = await readFile(app.executable);
  assert.equal(elf.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(elf[4], 2, '64-bit ELF required');
  assert.equal(elf.readUInt16LE(18), 62, 'Native x64 ELF required');
  return { ...app, resources, metadata, architecture: 'x64' };
}
