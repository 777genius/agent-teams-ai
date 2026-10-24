import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertOwnedCdpListener, command, processTable } from './desktop-backend-observations.ts';
import type { UiCdpPort } from './desktop-team-ui-smoke.ts';
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const tick = () => new Promise<void>((done) => setTimeout(done, 100));
export const desktopNativeProviderArtifact = Object.freeze({
  path: 'vendor/provider-migration/typed-quality-validation-v2/agent-teams-provider-implementations-0.0.0.tgz',
  sha256: 'dad39edf2f02a23ae68768722b5bba2e7beddf2125ae79d0bacb4e8b303d1dce',
});
export async function verifyDesktopNativeStopArtifact(
  repo: string, selected = desktopNativeProviderArtifact
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
  assert.ok(Array.isArray(selection.members) && selection.members.length === 1);
  const memberId = object(selection.members[0]).memberId;
  assert.equal(typeof memberId, 'string');
  const configuration = {
    members: [{ memberId, model: 'claude-opus-4-6', effort: 'medium', fastMode: false,
      permissions: options.manualPermissions ? 'manual' : 'bypass', context: 'model-default' }],
  };
  const start = await invokeSetup('team.launch.start', 'TEST-explicit-sandbox-setup-launch', {
    launchId: selection.launchId,
    rosterRevision: selection.rosterRevision,
    configuration,
  });
  evidence.nativeLaunchResponse = start;
  assert.equal(start.ok, true, `TEST configured launch response: ${JSON.stringify(start)}`);
  if (options.returnAt === 'opening') {
    assert.ok(fixture.root, 'exact TEST Runtime store for pending-open observation');
    const deadline = Date.now() + 45_000;
    do {
      const sessions: Record<string, unknown>[] = await readDesktopNativeStopSessions(fixture.root).catch(error => {
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
        const table = processTable();
        const hosts = table.filter(row => row.pgid === group && command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
        assert.equal(hosts.length, 1);
        const hostPid = hosts[0]!.pid;
        const nativeChildren = table.filter(row => row.ppid === hostPid && command(row.pid).startsWith(executable));
        if (nativeChildren.length) {
          assert.equal(nativeChildren.length, 1);
          evidence.nativeSetup = { scope: 'Explicit TEST setup returned during actual native open; no input',
            configuration, status: 'opening', launch: selection, session, nativeChildren,
            nativeExecutableSha256: await fileDigest(executable) };
          return { hostPid, nativeChildren };
        }
      }
      await tick();
    } while (Date.now() < deadline);
    throw new Error('No actual pending native open observed; no launch or Quit retry');
  }
  const readyDeadline = Date.now() + 45_000;
  let ready = object(start.value);
  while (ready.status !== 'ready' && Date.now() < readyDeadline) {
    await tick();
    const progress = await invokeSetup('team.launch.read', 'TEST-setup-progress', {});
    evidence.nativeLaunchProgressResponse = progress;
    assert.equal(progress.ok, true, `TEST launch progress refused: ${JSON.stringify(progress)}`);
    ready = object(progress.value);
  }
  assert.equal(ready.status, 'ready');
  assert.equal(ready.ready, 1);
  const table = processTable();
  const hosts = table.filter(
    (row) => row.pgid === group && command(row.pid) === `${fixture.node} ${fixture.hostEntry}`
  );
  assert.equal(hosts.length, 1);
  const hostPid = hosts[0]!.pid;
  const nativeChildren = table.filter(
    (row) => row.ppid === hostPid && command(row.pid).startsWith(executable)
  );
  assert.equal(
    nativeChildren.length,
    1,
    'one captured actual Claude SDK child before ordinary Stop'
  );
  evidence.nativeSetup = {
    scope: 'Explicit selected model/effort setup via actual app IPC; ordinary launch UI is not qualified',
    configuration,
    status: 'ready',
    launch: ready,
    nativeChildren,
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
    const files = entries.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry.name));
    assert.ok(entries.length <= 512 && files.length <= 256);
    const unknown = entries.filter(entry => {
      if (/^[a-f0-9]{64}\.json$/.test(entry.name) || /^\.tmp\.[a-f0-9-]{36}$/.test(entry.name))
        return !entry.isFile();
      // The controller publishes these finite lock sidecars while writing the
      // atomic session record. They are never interpreted as Runtime sessions.
      if (/^member\.lock(?:\.candidate-[1-9]\d*-[a-f0-9-]{36})?$/.test(entry.name))
        return !entry.isFile();
      if (/^member\.lock-transition-v2(?:\.candidate-[1-9]\d*-[a-f0-9-]{36})?$/.test(entry.name))
        return !entry.isDirectory();
      return true;
    }).map(entry => entry.name);
    assert.deepEqual(unknown, [], 'Unexpected Runtime namespace entries');
    for (const file of files)
      sessions.push(object(JSON.parse(await readFile(join(selected, file.name), 'utf8'))));
  }
  return sessions;
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
