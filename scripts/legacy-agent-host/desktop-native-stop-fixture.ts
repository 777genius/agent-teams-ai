import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { assertOwnedCdpListener, command, processTable } from './desktop-backend-observations.ts';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import type { UiCdpPort } from './desktop-team-ui-smoke.ts';
export {
  readNativeProviderArtifact as readDesktopNativeProviderArtifact,
  verifyNativeProviderArtifact as verifyDesktopNativeStopArtifact,
} from '../../packages/legacy-agent-host/tests/fixtures/native-provider-artifact.ts';
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const tick = () => new Promise<void>((done) => setTimeout(done, 100));

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
  if (options.provider === 'opencode') assert.ok(fixture.root);
  const globalMetadata = options.provider === 'opencode'
    ? await captureDesktopOpenCodeGlobalMetadata(cdp, { ...fixture, root: fixture.root! }, group,
      () => assertOwnedCdpListener(group)) : undefined;
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
      model: options.provider === 'opencode' ? 'test-local/TEST-model' : 'claude-opus-4-6',
      ...(options.provider === 'opencode' ? {} : { effort: 'medium', fastMode: false, context: 'model-default' }),
      permissions: options.manualPermissions ? 'manual' : 'bypass',
    })),
  };
  if (options.provider === 'opencode') {
    assert.ok(fixture.root, 'the original Composer has an exact TEST workspace');
    assertOwnedCdpListener(group);
    const response = object(await cdp.evaluate(
      `window.electronAPI.runtimeProviderManagement.loadModels(${desktopJsLiteral({
        runtimeId: 'opencode', providerId: 'test-local', projectPath: join(fixture.root, 'workspace'),
      })})`
    ));
    assert.equal(response.error, undefined, 'actual native catalog is ready before Runtime allocation');
    assert.equal(response.runtimeId, 'opencode');
    const catalog = object(response.models);
    assert.equal(catalog.providerId, 'test-local');
    assert.equal(catalog.catalogState, 'fresh', 'the original Composer project catalog is fresh');
    assert.ok(Array.isArray(catalog.models));
    const model = catalog.models.find(value =>
      object(value).modelId === 'test-local/TEST-model' && object(value).providerId === 'test-local');
    assert.ok(model);
    if (process.env.LEGACY_DESKTOP_CHAT_ATTACHMENTS === '1') {
      const inputs = object(model).declaredInputModalities;
      assert.ok(Array.isArray(inputs) && inputs.includes('image'),
        'the actual native catalog declares image input before the original Composer is used');
    }
  }
  const selectedMetadata = globalMetadata ? await captureDesktopOpenCodeProjectMetadata(
    { ...fixture, root: fixture.root! }, group, globalMetadata) : undefined;
  const metadata = selectedMetadata?.captured, metadataSources = selectedMetadata?.metadataSources;
  if (metadata) assert.equal(metadata.host.groupId, group, 'metadata belongs to the captured TEST Host');
  const observeNative = () => {
    if (metadata) {
      const current = readDesktopNativeHostProcesses(fixture, group);
      const runtime = separateDesktopOpenCodeRuntimeChildren(metadata, current,
        current.children.length === metadata.children.length ? 0 : 1);
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
            ...(metadata ? { metadataBeforeLaunch: metadata, metadataSources } : {}),
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
    ...(metadata ? { metadataBeforeLaunch: metadata, metadataSources } : {}),
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
export function readDesktopNativeHostProcesses(fixture: { node: string; hostEntry: string }, group: number): {
  host: ProcessFact;
  children: ProcessFact[];
} {
  assert.ok(Number.isSafeInteger(group) && group > 0, 'original captured Desktop group');
  const table = processFacts();
  const hosts = table.filter(row => row.groupId === group && command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  assert.equal(hosts.length, 1, 'one exact TEST Host in the original captured Desktop group');
  const host = hosts[0]!;
  return { host, children: table.filter(row => row.parentPid === host.pid) };
}

export function separateDesktopOpenCodeRuntimeChildren(
  original: ReturnType<typeof readDesktopNativeHostProcesses>,
  current: ReturnType<typeof readDesktopNativeHostProcesses>,
  expectedRuntimeCount: 0 | 1
): ProcessFact[] {
  assert.ok(original.children.length === 1 || original.children.length === 2,
    'only original global or global/project metadata captures are qualified');
  assert.deepEqual(current.host, original.host, 'same original Host birth identity');
  assert.equal(new Set(original.children.map(child => child.pid)).size, original.children.length);
  for (const metadata of original.children)
    assert.deepEqual(current.children.find(row => row.pid === metadata.pid), metadata,
      'each original metadata child retains its birth identity without replacement');
  const runtimes = current.children.filter(row => !original.children.some(child => child.pid === row.pid));
  assert.equal(runtimes.length, expectedRuntimeCount, 'only the expected original Runtime children');
  for (const child of runtimes) assert.equal(child.command, original.children[0]!.command, 'same selected Bun executable');
  return runtimes;
}

type MetadataSource = { sourceId: string; revision: string; profileId: string; configRevision: string;
  scope: 'global' | 'project'; projectPath: string | null };
type MetadataFixture = { root: string; node: string; hostEntry: string };
type GlobalMetadata = { captured: ReturnType<typeof readDesktopNativeHostProcesses>;
  source: MetadataSource; runtimeDigest: string };

/** Actual source-derived profile IDs, not the descriptor's common seed profile. */
async function readDesktopOpenCodeMetadataSource(root: string, projectPath: string | null): Promise<MetadataSource> {
  const json = async (path: string) => object(JSON.parse(await readFile(join(root, path), 'utf8')));
  const descriptor = await json('desktop-descriptor.json'), profile = await json('host-profile.json');
  assert.ok(Array.isArray(descriptor.management) && Array.isArray(profile.management));
  const selections = descriptor.management.map(object).filter(row =>
    row.runtimeId === 'opencode' && row.projectPath === projectPath);
  assert.equal(selections.length, 1);
  const selection = selections[0]!, owner = object(profile.owner);
  assert.deepEqual(selection.owner, { ownerId: owner.ownerId, revision: owner.revision });
  const native = profile.management.map(object).filter(row => row.provider === 'opencode' &&
    row.profileId === selection.profileId && row.configRevision === selection.configRevision);
  assert.equal(native.length, 1);
  const index = await json('hoststore/runtime-sources/index.json');
  assert.ok(Array.isArray(index.records) && Array.isArray(index.current));
  const records = index.records.map(object), current = index.current.map(object);
  const matches = records.filter(record => {
    const grant = object(record.grant);
    return current.some(pointer => pointer.sourceId === grant.targetId && pointer.revision === record.revision) &&
      grant.ownerId === owner.ownerId && grant.ownerRevision === owner.revision &&
      grant.contextId === selection.contextId && grant.projectPath === projectPath &&
      grant.runtimeId === 'opencode' && grant.profileId === selection.profileId &&
      grant.configRevision === selection.configRevision;
  });
  assert.equal(matches.length, 1, 'one original current publication for the actual selected scope');
  const selected = matches[0]!, grant = object(selected.grant), candidate = object(selected.candidate);
  assert.deepEqual(candidate.executable, native[0]!.executable);
  const scope = projectPath === null ? 'global' : 'project';
  assert.equal(object(candidate.openCodeConfiguration).scope, scope);
  assert.match(String(grant.targetId), /^[a-f0-9]{64}$/);
  assert.match(String(selected.revision), /^[a-f0-9]{64}$/);
  return { sourceId: String(grant.targetId), revision: String(selected.revision),
    profileId: 'runtime-source:' + selected.revision, configRevision: 'runtime-source:' + selected.revision,
    scope, projectPath };
}

async function metadataOnlyRuntimeDigest(root: string): Promise<string> {
  const sessions = await readDesktopNativeStopSessions(root);
  assert.ok(sessions.every(row => row.phase === 'closed' && row.custody === 'released'),
    'metadata correlation never overlaps a live, opening or uncertain Runtime');
  const directory = join(root, 'hoststore/management-commands');
  const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.ok(names.length <= 128);
  for (const name of names) {
    const receipt = object(JSON.parse(await readFile(join(directory, name), 'utf8')));
    assert.equal(receipt.resourceHeld, false, 'no probe, verification or credential child remains held');
    if (receipt.kind === 'model.probe')
      assert.ok(['completed', 'cancelled'].includes(String(receipt.phase)),
        'every original no-tool probe has finished its native close');
  }
  return runtimeDigest(sessions);
}

/** Before project selection, observe one actual global catalog child through the existing read-only IPC. */
export async function captureDesktopOpenCodeGlobalMetadata(cdp: UiCdpPort, fixture: MetadataFixture,
  group: number, assertOwnedRenderer: () => void): Promise<GlobalMetadata> {
  assertOwnedRenderer();
  const response = object(await cdp.evaluate(
    `window.electronAPI.runtimeProviderManagement.loadModels(${desktopJsLiteral({
      runtimeId: 'opencode', providerId: 'test-local', projectPath: null,
    })})`
  ));
  assertOwnedRenderer();
  assert.equal(response.error, undefined); assert.equal(response.runtimeId, 'opencode');
  const catalog = object(response.models);
  assert.equal(catalog.providerId, 'test-local'); assert.equal(catalog.catalogState, 'fresh');
  assert.ok(Array.isArray(catalog.models) &&
    catalog.models.map(object).some(model => model.modelId === 'test-local/TEST-model'));
  const source = await readDesktopOpenCodeMetadataSource(fixture.root, null);
  const captured = readDesktopNativeHostProcesses(fixture, group);
  assert.equal(captured.children.length, 1,
    'capture one global child before the first project catalog; early extra allocation is not adopted');
  assert.equal(captured.children[0]!.command, process.env.OPENCODE_V2_EMBEDDED_BUN);
  return { captured, source, runtimeDigest: await metadataOnlyRuntimeDigest(fixture.root) };
}

/** Preserve global birth and correlate the sole new child with the successful project-scoped read. */
export async function captureDesktopOpenCodeProjectMetadata(fixture: MetadataFixture, group: number,
  global: GlobalMetadata) {
  const sources = [await readDesktopOpenCodeMetadataSource(fixture.root, null),
    await readDesktopOpenCodeMetadataSource(fixture.root, join(fixture.root, 'workspace'))];
  assert.deepEqual(sources[0], global.source, 'global selection did not change while project metadata loaded');
  assert.equal(await metadataOnlyRuntimeDigest(fixture.root), global.runtimeDigest,
    'catalog/preflight did not create or alter a Runtime');
  const captured = readDesktopNativeHostProcesses(fixture, group);
  assert.deepEqual(captured.host, global.captured.host);
  assert.equal(captured.children.length, 2, 'one retained global and one new project metadata child');
  const original = global.captured.children[0]!;
  assert.deepEqual(captured.children.find(row => row.pid === original.pid), original);
  const added = captured.children.filter(row => row.pid !== original.pid);
  assert.equal(added.length, 1); assert.equal(added[0]!.command, original.command);
  const metadataSources = sources.map((source, index) => ({
    ...source, process: index === 0 ? original : added[0]!,
  }));
  assertDesktopOpenCodeMetadataSources(metadataSources, captured);
  return { captured, metadataSources };
}

/** Retained source/profile and birth pairs are immutable evidence, never signal authority. */
export function assertDesktopOpenCodeMetadataSources(value: unknown, captured: unknown): void {
  assert.ok(Array.isArray(value) && value.length === 2);
  const rows = value.map(object);
  assert.deepEqual(rows.map(row => row.scope), ['global', 'project']);
  assert.equal(rows[0]!.projectPath, null);
  assert.ok(typeof rows[1]!.projectPath === 'string' && rows[1]!.projectPath.length > 0);
  for (const row of rows) {
    assert.match(String(row.sourceId), /^[a-f0-9]{64}$/);
    assert.match(String(row.revision), /^[a-f0-9]{64}$/);
    assert.equal(row.profileId, 'runtime-source:' + row.revision);
    assert.equal(row.configRevision, row.profileId);
    const child = object(row.process);
    assert.ok(Number.isSafeInteger(child.pid) && Number(child.pid) > 1);
    assert.ok(typeof child.birth === 'string' && child.birth.length > 0);
  }
  const physical = object(captured);
  assert.ok(Array.isArray(physical.children));
  assert.deepEqual(rows.map(row => row.process).sort((a, b) => Number(object(a).pid) - Number(object(b).pid)),
    [...physical.children].sort((a, b) => Number(object(a).pid) - Number(object(b).pid)),
    'source owner witnesses retain exactly the captured physical children');
  assert.notEqual(rows[0]!.sourceId, rows[1]!.sourceId);
  assert.notEqual(rows[0]!.profileId, rows[1]!.profileId);
  assert.notEqual(object(rows[0]!.process).pid, object(rows[1]!.process).pid);
  assert.equal(object(rows[0]!.process).parentPid, object(rows[1]!.process).parentPid);
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
