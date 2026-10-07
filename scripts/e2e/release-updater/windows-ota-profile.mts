import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath, rmdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { inheritedWindowsEnvironment } from './windows-powershell.mts';

export interface PhysicalProfile {
  home: string;
  roaming: string;
  local: string;
}
export interface ProfileOwnership {
  root: string;
  physical: PhysicalProfile;
  links: { link: string; target: string; created: boolean }[];
}
const legacyNames = [
  'agent-teams-ai',
  'Agent Teams AI',
  'Agent Teams UI',
  'Claude Agent Teams UI',
  'claude-agent-teams-ui',
  'claude-devtools',
  'claude-code-context',
];
export async function absent(file: string) {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

// Explorer's NSIS force-run inherits the real OS profile. Own only previously
// absent, exact app directories there; preserve default resolution through links.
export async function ownPhysicalProfile(
  root: string,
  physical: PhysicalProfile,
  evidence: string
) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert(path.basename(root).startsWith('TEST-updater-windows-'));
  assert.equal(os.homedir().toLowerCase(), physical.home.toLowerCase());
  for (const [name, directory] of [
    ['USERPROFILE', physical.home],
    ['APPDATA', physical.roaming],
    ['LOCALAPPDATA', physical.local],
  ]) {
    assert(name && directory && path.isAbsolute(directory));
    assert.equal(inheritedWindowsEnvironment(name)?.toLowerCase(), directory.toLowerCase());
    assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase());
  }
  for (const directory of [physical.roaming, physical.local])
    for (const name of legacyNames)
      assert(await absent(path.join(directory, name)), `Physical profile already contains ${name}`);
  for (const name of ['.claude', '.codex', '.claude.json', '.claude.json.backup'])
    assert(
      await absent(path.join(physical.home, name)),
      `Physical profile already contains ${name}`
    );
  const owned: ProfileOwnership = {
    root,
    physical,
    links: [
      {
        link: path.join(physical.roaming, 'agent-teams-ai'),
        target: path.join(root, 'user-data'),
        created: false,
      },
      {
        link: path.join(physical.local, 'agent-teams-ai-updater'),
        target: path.join(root, 'cache'),
        created: false,
      },
      {
        link: path.join(physical.home, '.claude'),
        target: path.join(root, 'claude'),
        created: false,
      },
      {
        link: path.join(physical.home, '.codex'),
        target: path.join(root, 'codex'),
        created: false,
      },
    ],
  };
  const manifest = path.join(evidence, 'profile-ownership.json');
  await writeFile(manifest, JSON.stringify(owned, null, 2), { flag: 'wx' });
  for (const entry of owned.links) {
    assert(await absent(entry.link), 'Physical profile changed before link creation');
    await mkdir(entry.target);
    await writeFile(
      path.join(entry.target, 'TEST-owner.json'),
      JSON.stringify({ root, link: entry.link }),
      { flag: 'wx' }
    );
    await symlink(entry.target, entry.link, 'junction');
    entry.created = true;
    await writeFile(manifest, JSON.stringify(owned, null, 2));
    assert.equal((await realpath(entry.link)).toLowerCase(), entry.target.toLowerCase());
  }
  return owned;
}

export async function releasePhysicalProfile(owned: ProfileOwnership) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert(
    path.isAbsolute(owned.root) && path.basename(owned.root).startsWith('TEST-updater-windows-')
  );
  const allowed = new Map([
    [path.join(owned.physical.roaming, 'agent-teams-ai'), path.join(owned.root, 'user-data')],
    [path.join(owned.physical.local, 'agent-teams-ai-updater'), path.join(owned.root, 'cache')],
    [path.join(owned.physical.home, '.claude'), path.join(owned.root, 'claude')],
    [path.join(owned.physical.home, '.codex'), path.join(owned.root, 'codex')],
  ]);
  for (const entry of owned.links) {
    assert.equal(allowed.get(entry.link), entry.target, 'Unexpected physical profile cleanup path');
    if (await absent(entry.link)) continue;
    assert((await lstat(entry.link)).isSymbolicLink(), 'Retain changed profile directory');
    assert.equal((await realpath(entry.link)).toLowerCase(), entry.target.toLowerCase());
    const marker = JSON.parse(
      await readFile(path.join(entry.target, 'TEST-owner.json'), 'utf8')
    ) as { root: string; link: string };
    assert.deepEqual(marker, { root: owned.root, link: entry.link });
    // RemoveDirectory removes a junction itself, without traversing its target.
    await rmdir(entry.link);
  }
}

export function appEnvironment(
  physical: PhysicalProfile,
  root: string,
  systemRoot: string
): NodeJS.ProcessEnv {
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: path.parse(systemRoot).root.slice(0, 2),
    PATH: path.join(systemRoot, 'System32'),
    HOME: physical.home,
    USERPROFILE: physical.home,
    APPDATA: physical.roaming,
    LOCALAPPDATA: physical.local,
    TEMP: root,
    TMP: root,
    ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
    NODE_ENV: 'production',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
  };
}
