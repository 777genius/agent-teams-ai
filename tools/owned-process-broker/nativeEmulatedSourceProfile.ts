/** TEST immutable A/B selections; every runnable image is pinned Node or the original Windows broker. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { runtimeMemberProfileSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { providerManagementProfileSchema } from '../../packages/legacy-agent-host/dist/management/profile.js';
import { fileHash } from './nativeEmulatedProfile';

import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { DesktopBackendDescriptor } from '../../src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor';
import type { SelectedHostProfile } from '../../src/features/agent-backend/main/infrastructure/selectedHostProfile';

export type EmulatedSourceProvider = 'codex' | 'claude' | 'opencode';
export const finiteSourceProbe = 'Reply only OK. Do not use tools, access files or run commands.';

async function endpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return `http://127.0.0.1:${address.port}`;
}

export async function prepareEmulatedSourceProfile(sandbox: string, broker: string,
  provider: EmulatedSourceProvider) {
  assert.equal(process.platform, 'win32');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  const selectedRoot = join(sandbox, `TEST-desktop-backend-${provider}${randomUUID().replaceAll('-', '')}`);
  mkdirSync(selectedRoot);
  const root = realpathSync.native(selectedRoot);
  for (const name of ['workspace', 'storage', 'bin', 'host-home', 'host-tmp']) mkdirSync(join(root, name));
  const workspace = join(root, 'workspace'), peerRoot = join(root, `TEST-peer-${provider}-scope`);
  for (const name of ['', 'home', 'tmp', 'config', 'data', 'cache']) mkdirSync(join(peerRoot, name));
  const node = realpathSync.native(process.execPath), systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot && /^[A-Za-z]:\\/.test(systemRoot));
  const peerNames = provider === 'claude' ? ['claudeProviderPeer.mjs'] : ['providerPeer.mjs', 'providerDesktopPeer.mjs'];
  const helpers = peerNames.map(name => {
    const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
    assert.equal(realpathSync(path), path); return { path, sha256: fileHash(path) };
  });
  if (provider === 'opencode') {
    const path = fileURLToPath(new URL('../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeMcpPolicyPlugin.js', import.meta.url));
    assert.equal(realpathSync(path), path); helpers.push({ path, sha256: fileHash(path) });
  }
  const entries = join(root, 'source-entries.ndjson'), effects = join(peerRoot, 'effects.ndjson');
  const versions = { A: provider === 'codex' ? '0.162.0' : provider === 'claude' ? '2.1.34' : '1.19.4',
    B: provider === 'codex' ? '0.162.0' : provider === 'claude' ? '2.1.34' : '1.19.4' };
  const images = {} as Record<'A' | 'B', { path: string; sha256: string; entry: { path: string; sha256: string } }>;
  for (const source of ['A', 'B'] as const) {
    const entry = join(root, 'bin', `TEST-source-${source}.mjs`);
    const output = provider === 'codex' ? `codex-cli ${versions[source]}`
      : provider === 'claude' ? `${versions[source]} (Claude Code)` : versions[source];
    const code = `import assert from 'node:assert/strict';
import {constants as bufferConstants} from 'node:buffer';
import {createHash} from 'node:crypto';import {appendFileSync,closeSync,fstatSync,openSync,readFileSync,readSync,realpathSync} from 'node:fs';
// Fresh Node 24 readFileSync bytes and owned-fd behavior, without retaining the whole image.
function selfDigest(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  let size = 0, offset = 0, closeAttempted = false;
  try {
    let info;
    try { info = fstatSync(fd); } catch {
      throw new TypeError("Cannot read properties of undefined (reading '1')");
    }
    size = info.isFile() ? Number(info.size) : 0;
    if (size > 2 ** 31 - 1) throw Object.assign(
      new RangeError('File size (' + size + ') is greater than 2 GiB'), {code: 'ERR_FS_FILE_TOO_LARGE'});
    let buffer;
    try { buffer = Buffer.allocUnsafe(size === 0 ? 8192 : Math.min(size, 512 * 1024)); } catch (error) {
      if (size === 0) {
        closeAttempted = true;
        try { closeSync(fd); } catch { /* Preserve the original allocation refusal. */ }
      }
      throw error;
    }
    do {
      const count = readSync(fd, buffer, 0, size === 0 ? buffer.length : Math.min(buffer.length, size - offset), null);
      if (!count) break;
      hash.update(buffer.subarray(0, count)); offset += count;
    } while (size === 0 || offset < size);
  } finally { if (!closeAttempted) closeSync(fd); }
  if (size === 0 && offset > bufferConstants.MAX_LENGTH) Buffer.concat([Buffer.alloc(0)], offset);
  return hash.digest('hex');
}
assert.equal(realpathSync.native(process.execPath),${JSON.stringify(node)});
assert.equal(selfDigest(process.execPath),${JSON.stringify(fileHash(node))});
const argv=process.argv.slice(2);
const fact={provider:${JSON.stringify(provider)},source:${JSON.stringify(source)},pid:process.pid,parentPid:process.ppid};
if(argv.length===1&&argv[0]==='--version'){
  assert.equal(Object.keys(process.env).some(key=>key.startsWith('TEST_')),false);
  assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.BUN_OPTIONS,undefined);
  appendFileSync(${JSON.stringify(entries)},JSON.stringify({...fact,event:'version'})+'\\n');
  process.stdout.write(${JSON.stringify(output + '\n')});
}else{
  assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER,'1');assert.equal(process.env.TEST_EMULATED_WINDOWS_PROVIDER,undefined);
  assert.ok(process.env.TEST_PEER_ROLE==='runtime'||process.env.TEST_PEER_ROLE==='management');
  for(const source of ${JSON.stringify(helpers)}){assert.equal(realpathSync(source.path),source.path);assert.equal(createHash('sha256').update(readFileSync(source.path)).digest('hex'),source.sha256)}
  appendFileSync(${JSON.stringify(entries)},JSON.stringify({...fact,event:'peer',role:process.env.TEST_PEER_ROLE})+'\\n');
  await import(${JSON.stringify(pathToFileURL(helpers[0]!.path).href)});
}
`;
    writeFileSync(entry, code, { flag: 'wx' });
    const wrapper = join(root, 'bin', `TEST source ${source}.cmd`);
    writeFileSync(wrapper, provider === 'codex'
      ? `@echo off\r\nset "_prog=node"\r\n"%_prog%" "${entry}" %*\r\n`
      : `@echo off\r\n"${node}" "${entry}" %*\r\n`, { flag: 'wx' });
    images[source] = { path: realpathSync(wrapper), sha256: fileHash(wrapper), entry: { path: entry, sha256: fileHash(entry) } };
  }
  assert.notEqual(images.A.sha256, images.B.sha256); assert.notEqual(images.A.entry.sha256, images.B.entry.sha256);
  const windowsBroker = { path: broker, sha256: fileHash(broker), arch: process.arch,
    protocol: 1 as const, capability: 'service-scopes-v1' as const };
  const environment = (role: 'runtime' | 'management'): Record<string, string> => ({
    HOME: join(peerRoot, 'home'), USERPROFILE: join(peerRoot, 'home'),
    TMPDIR: join(peerRoot, 'tmp'), TEMP: join(peerRoot, 'tmp'), TMP: join(peerRoot, 'tmp'),
    XDG_CONFIG_HOME: join(peerRoot, 'config'), XDG_DATA_HOME: join(peerRoot, 'data'), XDG_CACHE_HOME: join(peerRoot, 'cache'),
    SystemRoot: systemRoot, PATH: [dirname(node), join(systemRoot, 'System32')].join(';'),
    ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: join(peerRoot, 'config') }
      : provider === 'codex' ? { CODEX_HOME: join(peerRoot, 'config') } : {}),
    TEST_EMULATED_DESKTOP_PROVIDER: '1', TEST_PEER_SCENARIO: 'desktop-ui-v1', TEST_PEER_PROVIDER: provider,
    TEST_PEER_ROLE: role, TEST_DESKTOP_PEER_ROOT: peerRoot, TEST_DESKTOP_PEER_WORKSPACE: workspace, TEST_PEER_EFFECTS: effects,
    ...(provider !== 'claude' ? { TEST_PEER_HELPER_SHA256: helpers[1]!.sha256 } : {}),
    ...(provider === 'opencode' ? {
      TEST_PEER_MCP_POLICY_SHA256: helpers[2]!.sha256,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled',
        model: 'test-provider/TEST-model', small_model: 'test-provider/TEST-model', provider: { 'test-provider': {
          npm: '@ai-sdk/openai-compatible', name: 'TEST provider',
          options: { baseURL: 'http://127.0.0.1:19999/TEST-no-network', apiKey: 'TEST-LOCALHOST-ONLY' },
          models: { 'TEST-model': { name: 'TEST model', limit: { context: 4096, output: 1024 },
            variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } } } } } },
        agent: { build: { mode: 'primary' } }, compaction: { auto: false } }),
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_TELEMETRY: '1', OPENCODE_DISABLE_SHARE: '1',
    } : {}),
  });
  const nonce = randomUUID(), ownerId = `TEST-source-${provider}-${nonce}`, contextId = 'TEST-source-context';
  const providerId = provider === 'claude' ? 'anthropic' : provider, model = provider === 'claude' ? 'sonnet' : 'TEST-model';
  const savedSettings: NonNullable<TeamHostProfile['teams'][number]['savedSettings']> = {
    cwd: workspace, providerId, model: provider === 'opencode' ? 'test-provider/TEST-model' : model,
    prompt: '', skipPermissions: false, syncModelsWithLead: true,
    ...(provider === 'claude' ? { effort: 'low' as const, fastMode: 'off' as const } : {}) };
  const teams = (['A', 'B'] as const).map((source): TeamHostProfile['teams'][number] => {
    const binding = { backendId: ownerId, teamId: `TEST-source-team-${source}`, teamName: `test-source-team-${source.toLowerCase()}` };
    const scope = { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: binding.teamId,
      runId: `TEST-source-run-${source}`, memberId: 'human', generation: '1' };
    return { binding, scope, savedSettings,
      members: [{ memberId: 'alice-id', name: 'alice', role: 'lead' as const,
        delivery: { ...binding, runId: scope.runId, memberId: 'alice-id', generation: '1' } }],
      grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'message.write', 'admin'] },
        { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write'] }] };
  });
  const members = await Promise.all(teams.map(async team => runtimeMemberProfileSchema.parse({
    provider, teamId: team.binding.teamId, memberId: 'alice-id', principalId: 'alice-session',
    sessionId: randomUUID(), generation: 1, configRevision: 'TEST-source-seed-runtime',
    cwd: workspace, model, accountBinding: 'TEST-no-vendor-account',
    executable: { path: images.A.path, sha256: images.A.sha256 }, windowsBroker, environment: environment('runtime'),
    ...(provider === 'claude' ? { configNamespace: 'custom-directory', nativeTools: ['Read', 'Write', 'AskUserQuestion'], autoAllowedTools: [],
      nativeOptions: { permissionMode: 'default', settingSources: [], effort: 'low', fastMode: false } }
      : provider === 'codex' ? { protocolRevision: '0.162.0', nativeOptions: { approvalPolicy: 'on-request', sandbox: 'read-only' } }
      : { protocolRevision: '1.19.4', mcpPolicyPlugin: { ...helpers[2]! },
        endpoint: await endpoint(), nativeOptions: { providerId: 'test-provider', agent: 'build', toolApprovalMode: 'manual' } }),
    limits: { queuedInputs: 2, inputBytes: 65536, outputBytes: 1_000_000, outputEvents: 1500, pendingInteractions: 4, timeoutMs: 90000 },
  })));
  const management = providerManagementProfileSchema.parse({ provider, profileId: `TEST-source-${provider}-management`,
    configRevision: 'TEST-source-management-1', accountBinding: 'TEST-no-vendor-account', cwd: workspace,
    executable: { path: images.A.path, sha256: images.A.sha256 }, windowsBroker, environment: environment('management'),
    timeoutMs: 15000, modelProbeTimeoutMs: 30000,
    ...(provider === 'claude' ? { sdkRevision: '0.3.305', configNamespace: 'custom-directory', settingSources: [] }
      : provider === 'codex' ? { protocolRevision: '0.162.0' } : { endpoint: await endpoint() }),
  });
  const cli = realpathSync(fileURLToPath(new URL('../../packages/legacy-agent-host/dist/cli.js', import.meta.url)));
  const hostEntry = join(root, 'TEST-source-host.mjs');
  const diagnosticPins = ['owned-process/HostWindowsLaunch', 'composition/prepareTeamModelReadiness',
    'diagnostics/modelReadinessTiming', 'composition/createRuntimeMemberProviderFactory',
    'management/ModelProbeOwner', 'composition/projectRuntimeMember', 'adapters/providers/OpenCodeMemberProvider', 'adapters/providers/CodexMemberProvider']
    .flatMap(name => (['src', 'dist'] as const).map(directory => {
      const path = fileURLToPath(new URL(`../../packages/legacy-agent-host/${directory}/${name}${directory === 'src' ? '.ts' : '.js'}`, import.meta.url));
      assert.equal(realpathSync(path), path); return { path, sha256: fileHash(path) };
    }));
  const refusals = join(root, 'TEST-first-refusals.ndjson'); writeFileSync(refusals, '', { mode: 0o600, flag: 'wx' });
  const runtimeProjectionLedger = join(root, 'TEST-runtime-projections.json');
  writeFileSync(hostEntry, `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto'; import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { channel } from 'node:diagnostics_channel';
for (const pin of ${JSON.stringify(diagnosticPins.filter(pin => pin.path.endsWith('.js')))}) { assert.equal(realpathSync(pin.path), pin.path); assert.equal(createHash('sha256').update(readFileSync(pin.path)).digest('hex'), pin.sha256); }
function validateSourceRefusal(value, persisted) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  assert.ok(Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => 'value' in row));
  const hash = raw => typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw), clock = raw => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0;
  const fields = { native: 'capability phase reason dispatched staged rootCaptured deadlineExpired checkSite',
    consumer: 'actionDigest groupDigest bindingDigest consumerId phase reason cutoff observedAt currentCalls',
    'opencode-open': 'bindingDigest phase reason',
    reference: 'commandDigest contextDigest phase reason probeCutoff probeNow scopeCutoff scopeNow preparationCutoff preparationNow', limit: '' };
  assert.ok(typeof value.kind === 'string' && Object.hasOwn(fields, value.kind));
  const keys = fields[value.kind]; assert.ok(typeof keys === 'string'); assert.deepEqual(Object.keys(value).sort(), ['kind', ...keys.split(' ').filter(Boolean), ...(persisted ? ['ordinal'] : [])].sort());
  if (persisted) assert.ok(typeof value.ordinal === 'number' && Number.isInteger(value.ordinal) && value.ordinal >= 1 && value.ordinal <= 65); if (value.kind === 'limit') { assert.equal(persisted, true); return; }
  assert.ok(typeof value.phase === 'string' && typeof value.reason === 'string');
  if (value.kind === 'native') {
    assert.ok(typeof value.capability === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.capability));
    assert.ok('capture staging allocate launch-chunk launch-commit post-commit prepare post-prepare resume'.split(' ').includes(value.phase));
    assert.ok('sealed current-false current-threw launch-deadline refused unknown result-mismatch preparation-failed'.split(' ').includes(value.reason));
    assert.ok(['dispatched', 'staged', 'rootCaptured'].every(key => typeof value[key] === 'boolean'));
    assert.equal(value.deadlineExpired, value.reason === 'launch-deadline' ? true : null);
    assert.ok(value.checkSite === null || ['before-owner', 'after-owner', 'request-builder', 'after-reply'].includes(value.checkSite));
    if (value.checkSite !== null) assert.ok(value.phase === 'resume' && ['sealed', 'current-false', 'current-threw', 'launch-deadline'].includes(value.reason));
  } else if (value.kind === 'opencode-open') {
    assert.ok(hash(value.bindingDigest)); assert.equal(value.reason, 'threw');
    assert.ok('configuration server-launch native-ready startup-authority startup-configuration startup-delay session-authority session-create driver-readiness'.split(' ').includes(value.phase));
  } else {
    assert.ok(value.reason === 'held' || value.reason === 'threw'); const consumer = value.kind === 'consumer';
    if (consumer) {
      const timing = value.currentCalls;
      assert.ok(timing && typeof timing === 'object' && !Array.isArray(timing) && [Object.prototype, null].includes(Object.getPrototypeOf(timing)));
      assert.ok(Object.getOwnPropertySymbols(timing).length === 0 && Object.values(Object.getOwnPropertyDescriptors(timing)).every(row => 'value' in row));
      assert.deepEqual(Object.keys(timing).sort(), ['count', 'lastMs', 'maxMs', 'totalMs', 'truncated', ...(Object.hasOwn(timing, 'regions') ? ['regions'] : [])].sort());
      assert.ok(clock(timing.count) && timing.count <= 4096 && clock(timing.totalMs) && clock(timing.maxMs) && timing.maxMs <= timing.totalMs);
      assert.equal(typeof timing.truncated, 'boolean');
      assert.ok(timing.lastMs === null || clock(timing.lastMs) && timing.lastMs <= timing.maxMs);
      if (timing.count === 0) assert.ok(timing.totalMs === 0 && timing.maxMs === 0 && timing.lastMs === null);
      else if (!timing.truncated) assert.notEqual(timing.lastMs, null);
      if (Object.hasOwn(timing, 'regions')) {
        const regions = timing.regions;
        assert.ok(regions && typeof regions === 'object' && !Array.isArray(regions) && [Object.prototype, null].includes(Object.getPrototypeOf(regions)));
        assert.ok(Object.getOwnPropertySymbols(regions).length === 0 && Object.values(Object.getOwnPropertyDescriptors(regions)).every(row => 'value' in row));
        const authorityParts = Object.hasOwn(regions, 'referenceAccountProviderCount');
        assert.ok(!authorityParts || Object.hasOwn(regions, 'referenceAccountCount'));
        const names = ['initialAuthority', 'readConsumer', 'reference', 'finalAuthority',
          ...(Object.hasOwn(regions, 'referenceAccountCount') ? ['referenceAccount', 'referenceAccountAuthority'] : []),
          ...(authorityParts ? ['referenceAccountProvider', 'referenceAccountAllocation'] : [])];
        assert.deepEqual(Object.keys(regions).sort(), names.flatMap(name => [name + 'Count', name + 'Ms']).sort());
        for (const name of names) {
          const count = regions[name + 'Count'], milliseconds = regions[name + 'Ms'];
          assert.ok(clock(count) && count <= timing.count && clock(milliseconds) && (count !== 0 || milliseconds === 0));
        }
      }
    }
    assert.ok((consumer ? ['actionDigest', 'groupDigest', 'bindingDigest', 'consumerId'] : ['commandDigest', 'contextDigest']).every(key => hash(value[key])));
    assert.ok((consumer ? 'initial-authority read-consumer identity continuation requirements cutoff reference equality final-authority' :
      'read inspect admission target scope retired completion probe-expiry scope-cutoff preparation-expiry origin purpose readiness account projection').split(' ').includes(value.phase));
    for (const [cutoff, now] of consumer ? [['cutoff', 'observedAt']] : [['probeCutoff', 'probeNow'], ['scopeCutoff', 'scopeNow'], ['preparationCutoff', 'preparationNow']])
      assert.ok(value[cutoff] === null ? value[now] === null : clock(value[cutoff]) && clock(value[now]));
  }
}
const ledger = ${JSON.stringify(refusals)}, references = new Set(); let count = 0, bytes = 0, disabled = false;
const reserve = Buffer.byteLength(JSON.stringify({ kind: 'limit', ordinal: 65 }) + '\\n');
try {
  const stat = lstatSync(ledger); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536);
  const existing = readFileSync(ledger, 'utf8'); bytes = Buffer.byteLength(existing); assert.ok(bytes + reserve <= 65536); assert.ok(existing === '' || existing.endsWith('\\n'));
  const retained = existing === '' ? [] : existing.slice(0, -1).split('\\n').map(line => JSON.parse(line)); assert.ok(retained.length <= 65);
  for (const [index, value] of retained.entries()) {
    validateSourceRefusal(value, true); assert.equal(value.ordinal, index + 1);
    if (value.kind === 'limit') { assert.equal(index, retained.length - 1); disabled = true; continue; }
    assert.ok(index < 64); count++;
    if (value.kind === 'reference') { const key = value.commandDigest + ':' + value.contextDigest; assert.equal(references.has(key), false); references.add(key); }
  }
} catch { disabled = true; }
channel('agent-teams.legacy-host.first-refusal').subscribe(value => { try {
  if (disabled) return; validateSourceRefusal(value, false);
  const pair = value.kind === 'reference' ? value.commandDigest + ':' + value.contextDigest : null;
  if (pair !== null && references.has(pair)) return;
  const line = JSON.stringify({ ...value, ordinal: count + 1 }) + '\\n';
  if (count >= 64 || bytes + Buffer.byteLength(line) + reserve > 65536) {
    appendFileSync(ledger, JSON.stringify({ kind: 'limit', ordinal: count + 1 }) + '\\n'); disabled = true; return;
  }
  appendFileSync(ledger, line); bytes += Buffer.byteLength(line); count++;
  if (pair !== null) references.add(pair);
} catch { disabled = true; } });
const projectionLedger = ${JSON.stringify(runtimeProjectionLedger)};
const codexContexts = [], codexEvents = [], codexStates = [], codexViews = new Map(); let codexUnknown = false, codexTimed = false;
const codexReject = () => { codexUnknown = true; codexContexts.length = 0; codexEvents.length = 0; codexStates.length = 0; codexViews.clear(); };
const codexTuple = (value, fields) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.getOwnPropertySymbols(value).length === 0);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assert.deepEqual(Object.keys(descriptors).sort(), [...fields].sort());
  assert.ok(Object.values(descriptors).every(row => 'value' in row));
  return fields.map(key => descriptors[key].value);
};
try { channel('agent-teams.legacy-host.codex-readiness').subscribe(value => { try {
  if (codexUnknown) return;
  const timed = Object.hasOwn(value, 'timing');
  const [schemaVersion, bindingDigest, sourceId, sourceRevision, sequence, invocation, operation, phase, result, rawTiming] = codexTuple(value,
    ['schemaVersion', 'bindingDigest', 'sourceId', 'sourceRevision', 'sequence', 'invocation', 'operation', 'phase', 'result', ...(timed ? ['timing'] : [])]);
  assert.equal(schemaVersion, timed ? 2 : 1);
  assert.ok([bindingDigest, sourceId, sourceRevision].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)));
  assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= 64 && Number.isInteger(invocation) && invocation >= 1 && invocation <= 16);
  assert.ok(['open', 'catalog', 'readiness'].includes(operation) && ['before-await', 'after-await', 'returned', 'threw'].includes(phase));
  assert.ok(phase === 'returned' ? operation !== 'open' && typeof result === 'boolean' : result === null);
  const identity = [bindingDigest, sourceId, sourceRevision];
  let contextIndex = codexContexts.findIndex(row => row.every((value, index) => value === identity[index]));
  if (contextIndex < 0) {
    assert.ok(codexContexts.length < 4); contextIndex = codexContexts.length;
    codexContexts.push(identity); codexStates.push({ sequence: 0, invocations: new Map(), schemaVersion, timing: [] });
  }
  const state = codexStates[contextIndex]; assert.equal(sequence, state.sequence + 1);
  assert.equal(schemaVersion, state.schemaVersion);
  let timing;
  if (timed) {
    assert.ok(Array.isArray(rawTiming) && Object.getOwnPropertySymbols(rawTiming).length === 0);
    const descriptors = Object.getOwnPropertyDescriptors(rawTiming);
    assert.deepEqual(Object.keys(descriptors), [...Array.from({ length: 10 }, (_, index) => String(index)), 'length']);
    assert.ok(Object.values(descriptors).every(row => 'value' in row));
    assert.equal(descriptors.length.value, 10);
    timing = Array.from({ length: 10 }, (_, index) => descriptors[index].value);
    assert.ok(timing.every(number => Number.isSafeInteger(number) && number >= 0 && number <= 999999));
    for (const index of [1, 4, 7]) {
      assert.ok(timing[index] <= 4096 && timing[index + 2] <= timing[index + 1]);
      if (timing[index] === 0) assert.ok(timing[index + 1] === 0 && timing[index + 2] === 0);
      if (state.timing.length && timing[index] === state.timing[index])
        assert.ok(timing[index + 1] === state.timing[index + 1] && timing[index + 2] === state.timing[index + 2]);
    }
    assert.ok(timing.every((number, index) => !state.timing.length || number >= state.timing[index]));
    state.timing = timing; codexTimed = true;
  }
  const prior = state.invocations.get(invocation);
  if (phase === 'before-await') {
    assert.equal(prior, undefined); assert.equal(invocation, state.invocations.size + 1);
  } else {
    assert.ok(prior && prior[0] === operation);
    assert.ok(phase === 'after-await' ? prior[1] === 'before-await'
      : phase === 'returned' ? prior[1] === 'after-await'
      : prior[1] === 'before-await' || prior[1] === 'after-await');
  }
  assert.ok(codexEvents.length < 64);
  state.sequence = sequence; state.invocations.set(invocation, [operation, phase]);
  codexEvents.push([contextIndex, sequence, invocation, operation, phase, result, ...(timed ? [timing] : [])]);
} catch { codexReject(); } }); } catch { codexReject(); }
try { channel('agent-teams.legacy-host.runtime-projection').subscribe(value => { try {
  if (codexUnknown) return;
  const tuple = codexTuple(value, ['viewDigest', 'bindingMatches', 'recordReady', 'providerReady', 'ownerCurrent', 'nativeReady']);
  assert.ok(typeof tuple[0] === 'string' && /^[a-f0-9]{64}$/.test(tuple[0]));
  assert.equal(typeof tuple[1], 'boolean'); assert.equal(typeof tuple[5], 'boolean');
  for (let index = 2; index <= 4; index++)
    assert.ok(tuple.slice(1, index).every(value => value === true) ? typeof tuple[index] === 'boolean' : tuple[index] === null);
  assert.equal(tuple[5], tuple.slice(1, 5).every(value => value === true));
  assert.ok(codexViews.has(tuple[0]) || codexViews.size < 4); codexViews.set(tuple[0], codexEvents.length);
} catch { codexReject(); } }); } catch { codexReject(); }
try { process.once('exit', () => { try {
  const value = codexUnknown ? { schemaVersion: 1, status: 'unknown', reason: 'invalid-overflow-or-observer-failure' }
    : { schemaVersion: codexTimed ? 2 : 1, status: 'observed', contexts: codexContexts, events: codexEvents, views: [...codexViews] };
  const raw = JSON.stringify(value);
  writeFileSync(projectionLedger + '.codex-readiness', Buffer.byteLength(raw) <= 8192 ? raw :
    '{"schemaVersion":1,"status":"unknown","reason":"invalid-overflow-or-observer-failure"}', { mode: 0o600, flag: 'wx' });
} catch { /* A missing separate ledger remains unknown; preserve the original exit listener. */ } }); } catch { codexReject(); }
const runtimeProjectionRows = new Map(); let projectionUnknown = false, projectionRefusal = 'invalid';
channel('agent-teams.legacy-host.runtime-projection').subscribe(value => { try {
  if (projectionUnknown) return;
  projectionRefusal = 'invalid';
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.getOwnPropertySymbols(value).length === 0);
  const fields = ['viewDigest', 'bindingMatches', 'recordReady', 'providerReady', 'ownerCurrent', 'nativeReady'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assert.deepEqual(Object.keys(descriptors).sort(), [...fields].sort());
  assert.ok(Object.values(descriptors).every(row => 'value' in row));
  const tuple = fields.map(key => descriptors[key].value);
  assert.ok(typeof tuple[0] === 'string' && /^[a-f0-9]{64}$/.test(tuple[0]));
  assert.equal(typeof tuple[1], 'boolean'); assert.equal(typeof tuple[5], 'boolean');
  for (let index = 2; index <= 4; index++)
    assert.ok(tuple.slice(1, index).every(value => value === true) ? typeof tuple[index] === 'boolean' : tuple[index] === null);
  assert.equal(tuple[5], tuple.slice(1, 5).every(value => value === true));
  const prior = runtimeProjectionRows.get(tuple[0]);
  if (prior !== undefined) { projectionRefusal = 'conflict'; assert.equal(tuple[5], prior[5]); }
  else { projectionRefusal = 'capacity'; assert.ok(runtimeProjectionRows.size < 4); }
  runtimeProjectionRows.set(tuple[0], tuple);
} catch { projectionUnknown = true; runtimeProjectionRows.clear(); } });
process.once('exit', () => { try {
  const value = projectionUnknown ? { status: 'unknown', reason: projectionRefusal } : { status: 'observed', rows: [...runtimeProjectionRows.values()] };
  const raw = JSON.stringify(value);
  writeFileSync(projectionLedger, Buffer.byteLength(raw) <= 512 ? raw : '{"status":"unknown","reason":"byte-budget"}', { mode: 0o600, flag: 'wx' });
} catch { /* Missing exit evidence remains unknown; never replace an earlier Host ledger. */ } });
await import(${JSON.stringify(pathToFileURL(cli).href)});
`, { flag: 'wx' });
  const profile: TeamHostProfile = { schemaVersion: 1, principalId: 'human', processCustody: { kind: 'main-windows-v1' },
    owner: { ownerId, revision: 'TEST-1', storageRoot: join(root, 'storage'), profileId: `TEST-source-profile-${nonce}`,
      protocolVersion: 1, buildId: 'TEST-source-emulated', nodeSha256: fileHash(node), hostEntrySha256: fileHash(hostEntry) },
    creation: { contextIds: [contextId] }, teams, runtime: { members, providerTemplates: [structuredClone(members[0]!)] },
    management: [management] };
  const profilePath = join(root, 'TEST-source-profile.json');
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
  readTeamHostProfile(profilePath, fileHash(profilePath));
  const host: SelectedHostProfile = { profileId: profile.owner.profileId, nodeExecutable: node, nodeVersion: process.version,
    nodeSha256: fileHash(node), hostEntry: realpathSync.native(hostEntry), hostEntrySha256: fileHash(hostEntry), expectedBuildId: profile.owner.buildId,
    cwd: root, env: { HOME: join(root, 'host-home'), TMPDIR: join(root, 'host-tmp'), TEMP: join(root, 'host-tmp'),
      TMP: join(root, 'host-tmp'), SystemRoot: systemRoot, PATH: [dirname(node), join(systemRoot, 'System32')].join(';'),
      LEGACY_AGENT_HOST_PROFILE_PATH: profilePath, LEGACY_AGENT_HOST_PROFILE_SHA256: fileHash(profilePath) },
    startupTimeoutMs: 10000, requestTimeoutMs: 15000, writeTimeoutMs: 5000, shutdownTimeoutMs: 1000 };
  const owner = { ownerId, revision: profile.owner.revision };
  const descriptor: DesktopBackendDescriptor = { schemaVersion: 1, defaultOwner: owner,
    owners: [{ ...owner, storageRoot: profile.owner.storageRoot, profile: host }],
    handles: teams.map(team => ({ handleId: team.binding.teamId, owner, contextId, label: team.binding.teamName,
      members: [{ memberId: 'alice-id', label: 'alice' }], scope: team.scope })),
    creation: { owner, contextIds: [contextId] },
    management: [{ runtimeId: provider, owner, contextId, projectPath: workspace,
      profileId: management.profileId, configRevision: management.configRevision }] };
  const descriptorPath = join(root, 'TEST-source-descriptor.json');
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
  const ownSources = ['nativeEmulatedSourceProfile.ts', 'nativeEmulatedSourceScenario.ts', 'nativeEmulatedProviderGate.ts',
    'nativeEmulatedProfile.ts', 'nativeGateContext.ts', 'nativeGateEvents.ts', 'nativeEmulatedSourceReadiness.ts', 'nativeEmulatedSourceCold.ts'].map(name => fileURLToPath(new URL(name, import.meta.url)));
  const pins = [...new Set([node, broker, cli, hostEntry, profilePath, descriptorPath, ...ownSources,
    ...helpers.map(value => value.path), ...diagnosticPins.map(value => value.path), ...Object.values(images).flatMap(value => [value.path, value.entry.path])])]
    .map(path => ({ path, sha256: fileHash(path) }));
  return { root, workspace, provider, providerId, model, profile, host, entries, effects, images, versions, pins, refusals, runtimeProjectionLedger,
    descriptorSelection: { path: descriptorPath, sha256: fileHash(descriptorPath) } };
}
