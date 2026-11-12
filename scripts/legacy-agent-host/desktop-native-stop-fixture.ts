import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertOwnedCdpListener, command, processTable } from './desktop-backend-observations.ts';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import type { UiCdpPort } from './desktop-team-ui-smoke.ts';
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const tick = () => new Promise<void>((done) => setTimeout(done, 100));
export const desktopNativeProviderArtifact = Object.freeze({
  path: 'vendor/provider-migration/opencode-v2-host-c8e81cce/agent-teams-provider-implementations-0.0.0.tgz',
  sha256: '0101298ac680448a4dec6b60c40e297a13caa484d453c47cb4a9c957e4ebbba8',
});
export async function verifyDesktopNativeStopArtifact(
  repo: string,
  selected = desktopNativeProviderArtifact
): Promise<void> {
  const archive = join(repo, selected.path);
  assert.equal(await fileDigest(archive), selected.sha256);
  const providerRoot = await realpath(
    join(repo, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations')
  );
  const entries = execFileSync('/usr/bin/tar', ['-tf', archive], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((path) => /^package\/dist\/.+\.js$/.test(path));
  assert.ok(entries.length > 0);
  for (const path of entries) {
    assert.ok(!path.includes('..'));
    assert.deepEqual(
      await readFile(join(providerRoot, path.slice('package/'.length))),
      execFileSync('/usr/bin/tar', ['-xOf', archive, path])
    );
  }
}

export async function prepareDesktopNativeStop(options: {
  cdp: UiCdpPort;
  fixture: { handleId: string; node: string; hostEntry: string; root?: string };
  group: number;
  evidence: Record<string, unknown>;
  executable: string;
  provider?: 'opencode';
  manualPermissions?: boolean;
  returnAt?: 'opening';
}) {
  const { cdp, fixture, group, evidence, executable } = options;
  assert.ok(executable);
  const invokeSetup = async (operation: string, commandId: string, payload: unknown) => {
    assertOwnedCdpListener(group);
    return object(
      await cdp!.evaluate(
        `window.electronAPI.agentBackend.invoke(${JSON.stringify({ handle: { handleId: fixture.handleId }, commandId, operation, payload })})`
      )
    );
  };
  const read = await invokeSetup('team.launch.read', 'TEST-setup-read', {});
  assert.equal(
    read.ok,
    true,
    `TEST launch read refused: ${String(read.code)}/${String(read.outcome)}`
  );
  const selection = object(read.value);
  const groupChats = process.env.LEGACY_DESKTOP_GROUP_CHATS === '1';
  const expectedMembers = groupChats ? 2 : 1;
  assert.ok(Array.isArray(selection.members) && selection.members.length === expectedMembers);
  const memberIds = selection.members.map((value) => {
    const id = object(value).memberId;
    assert.ok(typeof id === 'string' && id.length > 0);
    return id;
  });
  if (groupChats) {
    assert.deepEqual([...memberIds].sort(), ['alice-id', 'bob-id']);
    assert.equal(
      options.returnAt,
      undefined,
      'two-ready-actor proof does not qualify pending-open Quit'
    );
  }
  const memberId = memberIds[0]!;
  const configuration = {
    members: memberIds.map((memberId) => ({
      memberId,
      model: options.provider === 'opencode' ? 'TEST-local/TEST-model' : 'claude-opus-4-6',
      ...(options.provider === 'opencode' ? {} : { effort: 'medium', fastMode: false, context: 'model-default' }),
      permissions: options.manualPermissions ? 'manual' : 'bypass',
    })),
  };
  if (options.provider === 'opencode') {
    assertOwnedCdpListener(group);
    const response = object(await cdp.evaluate(
      `window.electronAPI.runtimeProviderManagement.loadModels(${JSON.stringify({
        runtimeId: 'opencode', providerId: 'TEST-local', projectPath: null,
      })})`
    ));
    assert.equal(response.error, undefined, 'actual native catalog is ready before Runtime allocation');
    assert.equal(response.runtimeId, 'opencode');
    const catalog = object(response.models);
    assert.equal(catalog.providerId, 'TEST-local');
    assert.ok(Array.isArray(catalog.models) && catalog.models.some(value =>
      object(value).modelId === 'TEST-model' && object(value).providerId === 'TEST-local'));
  }
  const metadata = options.provider === 'opencode' ? readDesktopNativeHostProcesses(fixture) : undefined;
  if (metadata) {
    assert.equal(metadata.host.groupId, group, 'metadata belongs to the captured TEST Host');
    assert.equal(metadata.children.length, 1, 'capture metadata before Runtime allocation');
    assert.ok(command(metadata.children[0]!.pid).startsWith(executable));
  }
  const observeNative = () => {
    if (metadata) {
      const current = readDesktopNativeHostProcesses(fixture);
      const runtime = separateDesktopOpenCodeRuntimeChildren(metadata, current,
        current.children.length === 1 ? 0 : 1);
      return { hostPid: current.host.pid, nativeChildren: runtime.map(child => ({
        pid: child.pid, ppid: child.parentPid, pgid: child.groupId,
      })) };
    }
    const table = processTable();
    const hosts = table.filter(row => row.pgid === group &&
      command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
    assert.equal(hosts.length, 1);
    const hostPid = hosts[0]!.pid;
    return { hostPid, nativeChildren: table.filter(row =>
      row.ppid === hostPid && command(row.pid).startsWith(executable)) };
  };
  const readinessMs = options.provider === 'opencode' ? 180_000 : 45_000;
  const start = await invokeSetup('team.launch.start', 'TEST-explicit-sandbox-setup-launch', {
    launchId: selection.launchId,
    rosterRevision: selection.rosterRevision,
    configuration,
  });
  evidence.nativeLaunchResponse = start;
  assert.equal(start.ok, true, `TEST configured launch response: ${JSON.stringify(start)}`);
  if (options.returnAt === 'opening') {
    assert.ok(fixture.root, 'exact TEST Runtime store for pending-open observation');
    const deadline = Date.now() + readinessMs;
    do {
      const sessions: Record<string, unknown>[] = await readDesktopNativeStopSessions(
        fixture.root
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      assert.ok(sessions.length <= 1, 'one exact pending native Runtime');
      const session: Record<string, unknown> | undefined = sessions[0];
      if (session) {
        assert.equal(object(session.binding).runId, selection.launchId);
        assert.equal(object(session.binding).memberId, memberId);
        assert.equal(session.phase, 'opening', 'ready/held is not pending-open Quit acceptance');
        assert.equal(session.nativeReady, false);
        assert.equal(session.sealed, false);
        assert.deepEqual(session.inputs, []);
        const { hostPid, nativeChildren } = observeNative();
        if (nativeChildren.length) {
          assert.equal(nativeChildren.length, 1);
          evidence.nativeSetup = {
            scope: 'Explicit TEST setup returned during actual native open; no input',
            configuration,
            status: 'opening',
            launch: selection,
            session,
            nativeChildren,
            ...(metadata ? { metadataBeforeLaunch: metadata } : {}),
            nativeExecutableSha256: await fileDigest(executable),
          };
          return { hostPid, nativeChildren };
        }
      }
      await tick();
    } while (Date.now() < deadline);
    throw new Error('No actual pending native open observed; no launch or Quit retry');
  }
  const readyDeadline = Date.now() + readinessMs;
  let ready = object(start.value);
  while (ready.status !== 'ready' && Date.now() < readyDeadline) {
    await tick();
    const progress = await invokeSetup('team.launch.read', 'TEST-setup-progress', {});
    evidence.nativeLaunchProgressResponse = progress;
    assert.equal(progress.ok, true, `TEST launch progress refused: ${JSON.stringify(progress)}`);
    ready = object(progress.value);
  }
  assert.equal(ready.status, 'ready');
  assert.equal(ready.ready, expectedMembers);
  const { hostPid, nativeChildren } = observeNative();
  assert.equal(
    nativeChildren.length,
    expectedMembers,
    'exact captured actual native actors before ordinary Stop'
  );
  evidence.nativeSetup = {
    scope:
      'Explicit selected model/effort setup via actual app IPC; ordinary launch UI is not qualified',
    configuration,
    status: 'ready',
    launch: ready,
    nativeChildren,
    ...(metadata ? { metadataBeforeLaunch: metadata } : {}),
    nativeExecutableSha256: await fileDigest(executable),
  };
  return { hostPid, nativeChildren };
}

/** Read only the actual two-level Runtime store; no Host/RPC/native continuation. */
export async function readDesktopNativeStopSessions(
  root: string
): Promise<Record<string, unknown>[]> {
  const directory = join(root, 'hoststore/runtime-sessions');
  const namespaces = await readdir(directory, { withFileTypes: true });
  assert.ok(
    namespaces.length <= 16 &&
      namespaces.every((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
  );
  const sessions: Record<string, unknown>[] = [];
  for (const namespace of namespaces) {
    const selected = join(directory, namespace.name);
    const entries = await readdir(selected, { withFileTypes: true });
    const files = entries.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry.name));
    assert.ok(entries.length <= 512 && files.length <= 256);
    const unknown = entries
      .filter((entry) => {
        if (/^[a-f0-9]{64}\.json$/.test(entry.name) || /^\.tmp\.[a-f0-9-]{36}$/.test(entry.name))
          return !entry.isFile();
        // The controller publishes these finite lock sidecars while writing the
        // atomic session record. They are never interpreted as Runtime sessions.
        if (/^member\.lock(?:\.candidate-[1-9]\d*-[a-f0-9-]{36})?$/.test(entry.name))
          return !entry.isFile();
        if (/^member\.lock-transition-v2(?:\.candidate-[1-9]\d*-[a-f0-9-]{36})?$/.test(entry.name))
          return !entry.isDirectory();
        return true;
      })
      .map((entry) => entry.name);
    assert.deepEqual(unknown, [], 'Unexpected Runtime namespace entries');
    for (const file of files)
      sessions.push(object(JSON.parse(await readFile(join(selected, file.name), 'utf8'))));
  }
  return sessions;
}

/** Read-only observations; original Host custody remains the only process owner. */
export function readDesktopNativeHostProcesses(fixture: { node: string; hostEntry: string }): {
  host: ProcessFact;
  children: ProcessFact[];
} {
  const table = processFacts();
  const hosts = table.filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  assert.equal(hosts.length, 1, 'one exact TEST Host executable');
  const host = hosts[0]!;
  return { host, children: table.filter(row => row.parentPid === host.pid) };
}

export function separateDesktopOpenCodeRuntimeChildren(
  original: ReturnType<typeof readDesktopNativeHostProcesses>,
  current: ReturnType<typeof readDesktopNativeHostProcesses>,
  expectedRuntimeCount: 0 | 1
): ProcessFact[] {
  assert.equal(original.children.length, 1, 'metadata identity was captured before Runtime allocation');
  assert.deepEqual(current.host, original.host, 'same original Host birth identity');
  const metadata = original.children[0]!;
  assert.deepEqual(current.children.find(row => row.pid === metadata.pid), metadata,
    'same original metadata child, without PID reuse or replacement');
  const runtimes = current.children.filter(row => row.pid !== metadata.pid);
  assert.equal(runtimes.length, expectedRuntimeCount, 'only the expected original Runtime children');
  for (const child of runtimes) assert.equal(child.command, metadata.command, 'same selected Bun executable');
  return runtimes;
}

/** Capture before failure cleanup, so a later Quit cannot be mistaken for UI Stop. */
export function captureDesktopNativeStopPresence(setup: unknown) {
  const children = object(setup).nativeChildren;
  assert.ok(Array.isArray(children));
  const captured = children.map((child) => Number(object(child).pid));
  assert.ok(captured.every((pid) => Number.isSafeInteger(pid) && pid > 1));
  const current = processTable();
  return {
    phase: 'before guarded failure Quit',
    capturedPids: captured,
    presentPids: captured.filter((pid) => current.some((row) => row.pid === pid)),
  };
}
