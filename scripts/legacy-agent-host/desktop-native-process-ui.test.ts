import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForNativeProcessServices } from './desktop-native-process-model.ts';
import { prepareControlledProcessFixture } from './desktop-controlled-process-fixture.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { desktopProcessOwnerExpression, readDesktopProcessData } from './desktop-native-process-ui.ts';

const selection = 'TEST-owner', id = 'TEST-process';
const original = { id, processRef: 'TEST-original-ref', observation: 'same-live', canTerminate: true };
const stopped = { id, processRef: 'TEST-stopped-ref', observation: 'absent', stoppedAt: '2026-10-29T00:00:00Z', canTerminate: false };
function observe(candidates: Record<string, unknown>[], reference: string | null) {
  const fibers = candidates.map(process => ({ memoizedProps: { teamName: selection, processes: [process] }, alternate: null, return: null }));
  const node = { __reactFiber$test: { ...fibers[0], alternate: fibers[1], return: fibers[2] }, querySelectorAll: () => [] };
  return Function('document', 'return ' + desktopProcessOwnerExpression(selection, id, reference))({ querySelector: () => node });
}
const wireOriginal = { ...original, pid: 123, label: 'TEST original', registeredAt: '2026-10-29T00:00:00Z',
  processRef: 'p1:TEST-process:' + 'a'.repeat(64) };
const wireStopped = { ...wireOriginal, observation: 'absent', canTerminate: false, stoppedAt: stopped.stoppedAt };
const wireNeighbor = { ...wireOriginal, id: 'TEST-neighbor', pid: 456, processRef: 'p1:TEST-neighbor:' + 'b'.repeat(64) };
function packedReadFixture(processes: unknown[] = [wireOriginal]) {
  const binding = { handle: { handleId: 'TEST-packed-owner' }, label: 'TEST owner',
    ownerResourceRef: 'a'.repeat(64), teamResourceRef: '00000000-0000-5000-8000-000000000001',
    members: [{ memberId: 'TEST-member', label: 'TEST member' }] };
  const snapshot = { state: 'ready', bindings: [binding] };
  const state = { before: structuredClone(snapshot), after: structuredClone(snapshot),
    reply: { ok: true, value: processes } as unknown, connections: 0, ids: 0 };
  const requests: unknown[] = [];
  const window = { electronAPI: { agentBackend: {
    getConnections: async () => structuredClone(++state.connections === 1 ? state.before : state.after),
    invoke: async (request: unknown) => { requests.push(request); return state.reply; },
  } } };
  const location = { href: 'file:///TEST/resources/app.asar/out/renderer/index.html' };
  return { state, requests, selection: 'host-team:TEST-packed-owner',
    packed: { rendererUrl: location.href, bindingJson: JSON.stringify(binding) },
    cdp: { evaluate: async (expression: string): Promise<unknown> =>
      Function('window', 'location', 'crypto', 'return ' + expression)(
        window, location, { randomUUID: () => 'TEST-read-' + ++state.ids }) },
  };
}
test('post-Stop observer continues past stale original and pending alternate to fresh stopped props', () => {
  const pending = { ...stopped, pendingStop: { native: 'accepted' } };
  assert.deepEqual(observe([original, pending, stopped], null)?.process, stopped);
  assert.equal(observe([original, pending, { ...stopped, observation: 'unknown' }], null), null);
  return (async () => {
    const captured = packedReadFixture([wireStopped, wireNeighbor]);
    assert.deepEqual(await readDesktopProcessData(captured.cdp, captured.selection, captured.packed),
      { processes: [wireStopped, wireNeighbor], readRoute: 'packaged-public-process-list' });
    assert.equal(captured.state.connections, 2);
    assert.deepEqual(captured.requests, [{ handle: { handleId: 'TEST-packed-owner' },
      commandId: 'TEST-read-1', operation: 'process.list', payload: {} }]);
    const sourceData = { teamName: captured.selection, processes: [wireOriginal, wireNeighbor] };
    const expressions: string[] = [];
    assert.equal(await readDesktopProcessData({ evaluate: async expression => {
      expressions.push(expression); return sourceData;
    } }, captured.selection), sourceData);
    assert.deepEqual(expressions, [
      '(async()=>{const {api}=await import(\'/api/index.ts\');return await api.teams.getData("host-team:TEST-packed-owner");})()',
    ]);
  })();
});
test('initial original-ref observation remains exact and cannot select a replacement ref', () => {
  assert.deepEqual(observe([stopped, original], original.processRef)?.process, original);
  assert.equal(observe([stopped], original.processRef), null);
  return (async () => {
    for (const refusal of ['foreign', 'ambiguous']) {
      const captured = packedReadFixture();
      if (refusal === 'foreign') captured.state.before.bindings[0]!.ownerResourceRef = 'f'.repeat(64);
      else captured.state.before.bindings.push(structuredClone(captured.state.before.bindings[0]!));
      await assert.rejects(readDesktopProcessData(captured.cdp, captured.selection, captured.packed), /binding changed/);
      assert.equal(captured.requests.length, 0);
      assert.equal(captured.state.connections, 1);
    }
    const changed = packedReadFixture();
    changed.state.after.bindings[0]!.ownerResourceRef = 'f'.repeat(64);
    await assert.rejects(readDesktopProcessData(changed.cdp, changed.selection, changed.packed), /binding changed/);
    assert.equal(changed.requests.length, 1);
    assert.equal(changed.state.connections, 2);
    const refused = packedReadFixture();
    refused.state.reply = { ok: false, code: 'hold', outcome: 'unknown' };
    await assert.rejects(readDesktopProcessData(refused.cdp, refused.selection, refused.packed), /read refused/);
    assert.equal(refused.requests.length, 1);
    const duplicate = packedReadFixture([wireOriginal, { ...wireOriginal }]);
    await assert.rejects(readDesktopProcessData(duplicate.cdp, duplicate.selection, duplicate.packed), /Duplicate process identity/);
    assert.equal(duplicate.requests.length, 1);
  })();
});
test('background acceptance waits for atomic service publication without masking corrupt readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-service-readiness-'));
  const path = join(root, 'services.json');
  const services = { primary: { role: 'primary', nonce: 'TEST-primary', pid: 123, port: 1234, url: 'http://127.0.0.1:1234/TEST-primary' },
    neighbor: { role: 'neighbor', nonce: 'TEST-neighbor', pid: 456, port: 5678, url: 'http://127.0.0.1:5678/TEST-neighbor' } };
  let reads = 0;
  const publication = delay(100).then(async () => {
    await writeFile(path + '.pending', JSON.stringify(services), { flag: 'wx' });
    await rename(path + '.pending', path);
  });
  try {
    const actual = await waitForNativeProcessServices(async () => {
      reads++;
      return JSON.parse(await readFile(path, 'utf8')) as typeof services;
    });
    assert.deepEqual(actual, services);
    assert.ok(reads >= 2, 'initial missing publication was observed');
    await writeFile(path, '{');
    let invalidReads = 0;
    await assert.rejects(waitForNativeProcessServices(async () => {
      invalidReads++;
      return JSON.parse(await readFile(path, 'utf8')) as typeof services;
    }), SyntaxError);
    assert.equal(invalidReads, 1, 'present but invalid evidence is never retried');
    await assert.rejects(waitForNativeProcessServices(async () => {
      await readFile(join(root, 'never-published'));
      return services;
    }, 25), /did not publish before the deadline/);
  } finally { await publication; await rm(root, { recursive: true, force: true }); }
});

test('captured no-provider Processes fixture rejects mixed inputs before allocating and seeds no Runtime', {
  skip: process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH === undefined && 'requires the isolated Processes lane original native artifact capture',
}, async (t) => {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const repo = await realpath(join(import.meta.dirname, '../..'));
  const pnpm = process.env.LEGACY_DESKTOP_PNPM_PATH!;
  const originalPath = process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH!, originalSha = process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256!;
  const source = JSON.parse(await readFile(originalPath, 'utf8'));
  assert.equal(source.kind, 'TEST-controlled-process-no-provider-v1');
  assert.equal(await fileDigest(originalPath), originalSha);
  const root = await mkdtemp(join(tmpdir(), 'TEST-process-input-validation-'));
  t.after(async () => {
    process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH = originalPath;
    process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = originalSha;
    await rm(root, { recursive: true, force: true });
  });
  for (const [index, capture] of [
    { ...source, kind: 'unselected' },
    { ...source, claude: { path: '/TEST-never-executed', sha256: 'a'.repeat(64) } },
    { ...source, node: { ...source.node, extra: true } },
    { ...source, corepack: { ...source.corepack, extra: true } },
  ].entries()) {
    const path = join(root, `capture-${index}.json`);
    await writeFile(path, JSON.stringify(capture), { flag: 'wx', mode: 0o600 });
    process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH = path;
    process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = await fileDigest(path);
    await assert.rejects(prepareControlledProcessFixture(repo, pnpm), { code: 'ERR_ASSERTION' });
  }
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH = originalPath;
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = '0'.repeat(64);
  await assert.rejects(prepareControlledProcessFixture(repo, pnpm), { code: 'ERR_ASSERTION' });
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = originalSha;
  const fixture = await prepareControlledProcessFixture(repo, pnpm);
  t.after(async () => { await fixture.controlledProcess.cleanup(); await rm(fixture.root, { recursive: true, force: true }); });
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8'));
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8'));
  assert.equal(profile.runtime, undefined); assert.equal(profile.management, undefined);
  assert.equal(descriptor.management, undefined);
  assert.ok(profile.teams.every((team: { members: { delivery?: unknown }[] }) => team.members.every(member => member.delivery === undefined)));
  await assert.rejects(lstat(join(fixture.root, 'hoststore/runtime-sessions')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(fixture.root, 'workspace/process-primary.json')), { code: 'ENOENT' });
  assert.equal(fixture.controlledProcess.proof.captureKind, source.kind);
  assert.equal(fixture.controlledProcess.proof.providersConfigured, false);
  assert.equal(fixture.controlledProcess.proof.status, 'INCOMPLETE', 'preparation does not claim actual process/UI qualification');
});

test('Windows outage membership requires both original process owners in one renderer sample', async () => {
  const source = await readFile(new URL('../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8');
  const start = "  'genuine closed Host read marker with separate controls', remaining());\n";
  const end = "\n\n  assertHostBirths();\n  begin('one-explicit-same-Main-Retry', 10000);";
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const from = source.indexOf(start) + start.length, to = source.indexOf(end, from);
  assert(to > from);
  const execute = Function('assert', 'ui', 'original', 'processOwner', 'remaining', 'object',
    'return (async () => {' + source.slice(from, to) + '\n})();');
  const selectedStart = 'const processOwner = (row, stopped = false) =>';
  const selectedEnd = '\nconst readProcesses = async () => {';
  assert.equal(source.split(selectedStart).length, 2); assert.equal(source.split(selectedEnd).length, 2);
  const selectedFrom = source.indexOf(selectedStart), selectedTo = source.indexOf(selectedEnd, selectedFrom);
  assert(selectedTo > selectedFrom);
  const selectedTeam = 'TEST-original-owner-qualified-team';
  const processOwner = Function('desktopProcessOwnerExpression', 'selection',
    source.slice(selectedFrom, selectedTo) + '\nreturn processOwner;')(desktopProcessOwnerExpression, selectedTeam);
  const rows = [
    { id: 'TEST-primary', processRef: 'TEST-original-primary' },
    { id: 'TEST-neighbor', processRef: 'TEST-original-neighbor' },
  ];
  const object = (value: unknown) => {
    assert(value && typeof value === 'object' && !Array.isArray(value)); return value;
  };
  const unavailable = new Error('TEST original remaining observation allowance exhausted');
  const frame = (processes: typeof rows, teamName = selectedTeam) => ({ processes, teamName });
  const observe = (
    frames: (ReturnType<typeof frame> | Error)[],
    { guardError, remainingError }: { guardError?: Error; remainingError?: Error } = {}
  ) => {
    let waits = 0, reads = 0, checks = 0, remainingReads = 0;
    return {
      run: () => execute(assert, {
        waitRead: async (expression: string, label: string, budget: number): Promise<unknown> => {
          waits++;
          assert.equal(label, 'original rows retained during outage'); assert.equal(budget, 7500);
          for (let sample = 0; sample < frames.length; sample++) {
            checks++;
            if (guardError) throw guardError;
            const current = frames[Math.min(reads++, frames.length - 1)]; assert(current);
            if (current instanceof Error) throw current;
            const section = { querySelectorAll: () => [],
              __reactFiber$TEST: { memoizedProps: { ...current, isTeamAlive: false }, alternate: null, return: null } };
            const document = { querySelector: (selector: string) => {
              assert.equal(selector, '[data-section-id="processes"]'); return section;
            } };
            const value = Function('document', 'return ' + expression)(document);
            if (value) return value;
          }
          throw unavailable;
        },
      }, { rows }, processOwner, () => {
        remainingReads++;
        if (remainingError) throw remainingError;
        return 7500;
      }, object),
      counts: () => ({ waits, reads, checks, remainingReads }),
    };
  };

  // The old two waits accepted primary from one sample and neighbor from another.
  const separate = observe([frame([rows[0]!]), frame([rows[1]!])]);
  await assert.rejects(separate.run(), error => error === unavailable);
  assert.deepEqual(separate.counts(), { waits: 1, reads: 2, checks: 2, remainingReads: 1 });
  const together = observe([frame(rows)]);
  await together.run();
  assert.deepEqual(together.counts(), { waits: 1, reads: 1, checks: 1, remainingReads: 1 });
  const laterTogether = observe([frame([rows[0]!]), frame([rows[1]!]), frame(rows)]);
  await laterTogether.run();
  assert.deepEqual(laterTogether.counts(), { waits: 1, reads: 3, checks: 3, remainingReads: 1 });

  for (const invalid of [
    frame(rows, 'TEST-foreign-owner-qualified-team'),
    frame([{ ...rows[0]!, id: 'TEST-wrong-id' }, rows[1]!]),
    frame([{ ...rows[0]!, processRef: 'TEST-replacement-ref' }, rows[1]!]),
    frame([rows[0]!, rows[0]!, rows[1]!]),
    frame([]),
  ]) await assert.rejects(observe([invalid]).run(), error => error === unavailable);
  const guard = new Error('TEST original owner changed'), cutoff = new Error('TEST original phase expired');
  const blocked = observe([frame(rows)], { guardError: guard });
  await assert.rejects(blocked.run(), error => error === guard);
  assert.deepEqual(blocked.counts(), { waits: 1, reads: 0, checks: 1, remainingReads: 1 });
  const expired = observe([frame(rows)], { remainingError: cutoff });
  await assert.rejects(expired.run(), error => error === cutoff);
  assert.deepEqual(expired.counts(), { waits: 0, reads: 0, checks: 0, remainingReads: 1 });
  const evaluation = new Error('TEST original renderer evaluation failed');
  await assert.rejects(observe([evaluation]).run(), error => error === evaluation);
});
