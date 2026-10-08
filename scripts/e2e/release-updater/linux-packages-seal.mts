import assert from 'node:assert/strict';
import { readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';

import { Cdp, waitFor } from './cdp.mts';
import { hashFile } from './inputs.mts';
import { processIdentity } from './native-window.mts';

type Identity = NonNullable<Awaited<ReturnType<typeof processIdentity>>>;
export interface RuntimeLaunch {
  pid: number;
  argv: readonly string[];
  execArgv: readonly string[];
  home?: string;
  profile?: string;
  versions: { electron?: string; chrome?: string; node?: string };
}
export interface PackageLaunchSeal {
  command: readonly string[];
  runtime: RuntimeLaunch;
  home: string;
  userData: string;
  inspectorPort: number;
}
export interface AutomaticLaunchSeal {
  launch: PackageLaunchSeal;
  original: Identity;
  session: number;
  before: readonly number[];
  target: Awaited<ReturnType<typeof hashFile>>;
}
function safeTokens(tokens: readonly string[]) {
  assert(
    tokens.every((token) => token.length > 0 && !/[\s\0]/u.test(token)),
    'Sealed argv cannot contain empty, whitespace or NUL tokens'
  );
}
export function decodeProcCommand(raw: string): string[] | null {
  if (!raw.endsWith('\0')) return null;
  // Strip only the kernel terminator. Empty argv entries must remain visible
  // so exact sealed equality rejects them rather than silently deleting them.
  return raw.slice(0, -1).split('\0');
}
export function packageLaunchSeal(
  command: string[],
  runtime: RuntimeLaunch,
  expected: {
    executable: string;
    home: string;
    userData: string;
    inspectorPort: number;
    rendererPort: number;
  }
): PackageLaunchSeal {
  safeTokens(command);
  safeTokens(runtime.argv);
  safeTokens(runtime.execArgv);
  assert.deepEqual(command, [
    expected.executable,
    `--inspect-brk=127.0.0.1:${expected.inspectorPort}`,
    `--remote-debugging-port=${expected.rendererPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--lang=en-US',
    `--user-data-dir=${expected.userData}`,
  ]);
  assert.equal(runtime.home, expected.home);
  assert.equal(runtime.profile, expected.userData);
  return Object.freeze({
    command: Object.freeze([...command]),
    runtime: Object.freeze({
      ...runtime,
      argv: Object.freeze([...runtime.argv]),
      execArgv: Object.freeze([...runtime.execArgv]),
      versions: Object.freeze({ ...runtime.versions }),
    }),
    home: expected.home,
    userData: expected.userData,
    inspectorPort: expected.inspectorPort,
  });
}
export function exactSealedCommand(command: readonly string[], seal: PackageLaunchSeal) {
  if (command.some((argument) => /(?:^|\s)--(?:type|no-sandbox)(?:[=\s]|$)/u.test(argument)))
    return false;
  return (
    (command.length === 1 && command[0] === seal.command.join(' ')) ||
    (command.length === seal.command.length &&
      command.every((argument, i) => argument === seal.command[i]))
  );
}
export function profileDisposition(
  markers: { HOME?: string; AGENT_TEAMS_ELECTRON_USER_DATA_DIR?: string },
  roots: { home: string; userData: string }
) {
  if (
    (markers.HOME !== undefined && markers.HOME !== roots.home) ||
    (markers.AGENT_TEAMS_ELECTRON_USER_DATA_DIR !== undefined &&
      markers.AGENT_TEAMS_ELECTRON_USER_DATA_DIR !== roots.userData)
  )
    return 'conflict';
  return markers.HOME === roots.home &&
    markers.AGENT_TEAMS_ELECTRON_USER_DATA_DIR === roots.userData
    ? 'kernel-profile'
    : 'provisional';
}
export function assertRuntimeSeal(actual: RuntimeLaunch, seal: PackageLaunchSeal, pid: number) {
  assert.equal(actual.pid, pid);
  assert.equal(actual.home, seal.home);
  assert.equal(actual.profile, seal.userData);
  assert.deepEqual(actual.argv, seal.runtime.argv, 'Original runtime argv changed');
  assert.deepEqual(actual.execArgv, seal.runtime.execArgv, 'Original runtime execArgv changed');
}
async function kernelSnapshot(candidate: Identity, executable: string) {
  const identity = await processIdentity(candidate.pid);
  assert(identity && identity.state !== 'Z');
  assert.equal(identity.start, candidate.start, 'Sealed PID generation changed');
  assert.equal(identity.group, candidate.group);
  assert.equal(await readlink(`/proc/${candidate.pid}/exe`), executable);
  const status = await readFile(`/proc/${candidate.pid}/status`, 'utf8');
  const uid = status
    .split('\n')
    .find((line) => line.startsWith('Uid:'))
    ?.slice(4)
    .trim()
    .split(/\s+/)
    .map(Number);
  assert(
    uid?.length === 4 && uid.every((value) => value === process.getuid?.()),
    'Sealed kernel UID changed'
  );
  for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) {
    const value = new RegExp(`^${field}:\\s+([a-f\\d]+)$`, 'im').exec(status)?.[1];
    assert(value && BigInt(`0x${value}`) === 0n, 'Sealed process has capabilities');
  }
  const raw = await readFile(`/proc/${candidate.pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  assert.equal(fields[19], candidate.start);
  const command = decodeProcCommand(await readFile(`/proc/${candidate.pid}/cmdline`, 'utf8'));
  assert(command, 'Kernel command must retain its final NUL terminator');
  const environment = (await readFile(`/proc/${candidate.pid}/environ`, 'utf8')).split('\0');
  const value = (key: string) =>
    environment.find((item) => item.startsWith(`${key}=`))?.slice(key.length + 1);
  return {
    identity,
    uid,
    session: Number(fields[3]),
    command,
    markers: {
      HOME: value('HOME'),
      AGENT_TEAMS_ELECTRON_USER_DATA_DIR: value('AGENT_TEAMS_ELECTRON_USER_DATA_DIR'),
    },
  };
}
export async function automaticLaunchSeal(
  original: Identity,
  before: number[],
  launch: PackageLaunchSeal,
  target: AutomaticLaunchSeal['target']
): Promise<AutomaticLaunchSeal> {
  const executable = launch.command[0];
  assert(executable);
  const originalKernel = await kernelSnapshot(original, executable);
  assert.equal(launch.runtime.pid, original.pid);
  assert(before.some((pid) => pid === original.pid));
  return Object.freeze({
    launch,
    original: Object.freeze({ ...original }),
    before: Object.freeze([...before]),
    session: originalKernel.session,
    target: Object.freeze({ ...target }),
  });
}
export async function sealedKernelProof(candidate: Identity, seal: AutomaticLaunchSeal) {
  const executable = seal.launch.command[0];
  assert(executable);
  assert(!seal.before.some((pid) => pid === candidate.pid));
  assert(BigInt(candidate.start) > BigInt(seal.original.start));
  assert.equal(
    candidate.group,
    candidate.pid,
    'Original Linux relauncher creates a new process group'
  );
  const kernel = await kernelSnapshot(candidate, executable);
  assert(
    exactSealedCommand(kernel.command, seal.launch),
    'Current kernel command differs from sealed launch'
  );
  assert.notEqual(profileDisposition(kernel.markers, seal.launch), 'conflict');
  // Original relauncher uses new_process_group, not a new session. Capture the
  // real original SID; never assume SID equals either original or successor PID.
  assert.equal(kernel.session, seal.session);
  assert.equal(
    await readlink(`/proc/${candidate.pid}/ns/net`),
    await readlink('/proc/self/ns/net')
  );
  const installed = await stat(executable);
  const payload = await stat(`/proc/${candidate.pid}/exe`);
  assert.equal(payload.dev, installed.dev);
  assert.equal(payload.ino, installed.ino);
  assert.deepEqual(await hashFile(`/proc/${candidate.pid}/exe`), seal.target);
  const after = await stat(executable);
  assert.equal(after.dev, installed.dev);
  assert.equal(after.ino, installed.ino);
  const current = await kernelSnapshot(candidate, executable);
  assert(exactSealedCommand(current.command, seal.launch));
  assert.notEqual(profileDisposition(current.markers, seal.launch), 'conflict');
  return {
    ...current,
    executable,
    device: installed.dev,
    inode: installed.ino,
    payload: seal.target,
  };
}
export async function packagePausedEntry(connection: Cdp, pid: number) {
  await connection.send('Debugger.enable');
  await connection.send('Runtime.runIfWaitingForDebugger');
  const pause = await waitFor(
    () =>
      Promise.resolve(
        (connection.events.find((event) => event.method === 'Debugger.paused')?.params as
          | { callFrames: { callFrameId: string }[] }
          | undefined) ?? null
      ),
    'original packaged app entry'
  );
  const frame = pause.callFrames[0];
  assert(frame);
  const entry = await connection.evaluate<string>('__filename', frame.callFrameId);
  assert(entry.endsWith('/resources/app.asar/dist-electron/main/index.cjs'));
  assert.equal(await connection.evaluate<number>('process.pid', frame.callFrameId), pid);
  return { frame, entry };
}
export async function resumeConfiguredPackage(
  verify: () => Promise<unknown>,
  configure: () => Promise<void>,
  resume: () => Promise<unknown>,
  observe: () => Promise<void>
) {
  await verify();
  await configure();
  await verify();
  await resume();
  await observe();
  await verify();
}
export interface AutomaticFeedProof {
  pid: number;
  start: string;
  events: { type: string; version?: string; message?: string }[];
  statuses: { type: string; error?: string }[];
  installerGets: number;
}
export function assertAutomaticNoUpdate(
  owner: Identity,
  version: string,
  proof: AutomaticFeedProof
) {
  assert.equal(proof.pid, owner.pid, 'No-update belongs to another process');
  assert.equal(proof.start, owner.start, 'No-update process generation changed');
  assert(!proof.events.some((event) => event.type === 'error'), 'Automatic updater reported error');
  assert(
    !proof.statuses.some((status) => status.type === 'error' || status.error),
    'Automatic IPC reported error'
  );
  assert(
    proof.events.some(
      (event) => event.type === 'update-not-available' && event.version === version
    ),
    'Automatic target no-update missing'
  );
  assert(
    proof.statuses.some((status) => status.type === 'not-available'),
    'Actual automatic IPC no-update missing'
  );
  assert.equal(proof.installerGets, 0, 'Automatic target requested an installer');
}
export async function resumeSealedInspector(
  candidate: Identity,
  seal: AutomaticLaunchSeal,
  callbacks: {
    configure: (
      connection: Cdp,
      entry: Awaited<ReturnType<typeof packagePausedEntry>>
    ) => Promise<void>;
    observe: (connection: Cdp) => Promise<void>;
  }
) {
  await sealedKernelProof(candidate, seal);
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${seal.launch.inspectorPort}/json/list`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => null);
    if (!response?.ok) return null;
    return (
      ((await response.json()) as { type: string; webSocketDebuggerUrl: string }[]).find(
        (item) => item.type === 'node' && item.webSocketDebuggerUrl
      ) ?? null
    );
  }, 'automatic successor inherited inspector');
  const connection = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    const entry = await packagePausedEntry(connection, candidate.pid);
    const executable = seal.launch.command[0];
    assert(executable);
    assert.equal(
      entry.entry,
      path.join(path.dirname(executable), 'resources/app.asar/dist-electron/main/index.cjs')
    );
    await resumeConfiguredPackage(
      () => sealedKernelProof(candidate, seal),
      () => callbacks.configure(connection, entry),
      () => connection.send('Debugger.resume'),
      () => callbacks.observe(connection)
    );
    return entry;
  } finally {
    connection.close();
  }
}
