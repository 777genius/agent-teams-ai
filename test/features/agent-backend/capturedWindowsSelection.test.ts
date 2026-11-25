// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { applyLaunchConfiguration, buildOpenCodeCoordinationConfig, buildOpenCodeCoordinationEnvironment,
  buildOpenCodeManagementEnvironment, captureWindowsLauncher, RetainedWindowsCustody, runtimeMemberProfileSchema,
  selectOpenCodeCoordinationProvider, teamModelProbeProfile, windowsLaunchSpec } from '@agent-teams/legacy-agent-host/owned-process';
import { expect, it, vi } from 'vitest';

import { createCodexMemberProvider } from '../../../packages/legacy-agent-host/dist/adapters/providers/CodexMemberProvider.js';
import { OpenCodeManagementHost } from '../../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeManagementHost.js';
import { createOpenCodeMemberProvider } from '../../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeMemberProvider.js';
import { captureMainWindowsCustody } from '../../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody';

import type { MemberProviderContext } from '../../../packages/legacy-agent-host/dist/adapters/providers/MemberProvider.js';
import type { RuntimeMemberProfile } from '../../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import type { SelectedHostProfile } from '../../../src/features/agent-backend/main/infrastructure/selectedHostProfile';
import type { NativeProcessProfile } from '@agent-teams/legacy-agent-host/owned-process';
import type { PathLike, ReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

type CustodyOptions = ConstructorParameters<typeof RetainedWindowsCustody>[0];
const inspection = vi.hoisted(() => ({
  options: undefined as CustodyOptions | undefined,
  paths: new Map<string, string>(),
  opened: [] as FileHandle[],
  streams: new Map<string, ReadStream>(),
  duringRead: undefined as ((path: string, stream: ReadStream) => void) | undefined,
}));

// Observe the original constructor callback; no native port or provider process is created.
vi.mock('@agent-teams/legacy-agent-host/owned-process', async importOriginal => {
  const original = await importOriginal<typeof import('@agent-teams/legacy-agent-host/owned-process')>();
  return { ...original,
    RetainedWindowsCustody: class extends original.RetainedWindowsCustody {
      constructor(options: CustodyOptions) { super(options); inspection.options = options; }
    },
    verifyStagedBroker: (...args: Parameters<typeof original.verifyStagedBroker>) => {
      args[0] = inspection.paths.get(args[0]) ?? args[0];
      return original.verifyStagedBroker(...args);
    },
  };
});


// Extend the existing closed pathname projection for genuine synchronous V1 namespace/plugin reads.
// All descriptors, private bytes, hashes and native-profile lexical checks remain original.
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  const canonical = (read: typeof original.realpathSync.native, args: Parameters<typeof original.realpathSync>) => {
    const selected = args[0];
    if (typeof selected === 'string') args[0] = inspection.paths.get(selected) ?? selected;
    const value = read(...args);
    return selected !== args[0] && value === args[0] ? selected : value;
  };
  return { ...original,
    realpathSync: Object.assign((...args: Parameters<typeof original.realpathSync>) => canonical(original.realpathSync, args),
      { native: (...args: Parameters<typeof original.realpathSync>) => canonical(original.realpathSync.native, args) }),
    lstatSync: (...args: Parameters<typeof original.lstatSync>) => {
      if (typeof args[0] === 'string') args[0] = inspection.paths.get(args[0]) ?? args[0];
      return original.lstatSync(...args);
    },
    statSync: (...args: Parameters<typeof original.statSync>) => {
      if (typeof args[0] === 'string') args[0] = inspection.paths.get(args[0]) ?? args[0];
      return original.statSync(...args);
    },
    openSync: (...args: Parameters<typeof original.openSync>) => {
      if (typeof args[0] === 'string') args[0] = inspection.paths.get(args[0]) ?? args[0];
      return original.openSync(...args);
    },
  };
});
vi.mock('node:path', async importOriginal => {
  const original = await importOriginal<typeof import('node:path')>();
  return { ...original,
    isAbsolute: (path: string) => inspection.paths.has(path) ? original.win32.isAbsolute(path) : original.isAbsolute(path),
    resolve: (...paths: string[]) => paths.length === 1 && inspection.paths.has(paths[0]!)
      ? original.win32.resolve(...paths) : original.resolve(...paths),
    parse: (path: string) => inspection.paths.has(path) ? original.win32.parse(path) : original.parse(path),
  };
});

// Translate only the closed TEST Windows names to real private files on this runner. Schema,
// captured profile, launcher, broker manifest and all file identity/hash checks remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const local = (path: PathLike): PathLike => typeof path === 'string'
    ? inspection.paths.get(path) ?? path : path;
  return { ...original,
    lstat: (...args: Parameters<typeof original.lstat>) => {
      args[0] = local(args[0]); return original.lstat(...args);
    },
    realpath: async (...args: Parameters<typeof original.realpath>) => {
      const selected = args[0]; args[0] = local(selected);
      const result = await original.realpath(...args);
      return selected !== args[0] && result === args[0] ? selected : result;
    },
    stat: (...args: Parameters<typeof original.stat>) => {
      args[0] = local(args[0]); return original.stat(...args);
    },
    open: async (...args: Parameters<typeof original.open>) => {
      const selected = args[0]; args[0] = local(selected);
      const file = await original.open(...args);
      if (typeof selected === 'string' && inspection.paths.has(selected)) {
        inspection.opened.push(file);
        const readStream = file.createReadStream.bind(file);
        file.createReadStream = options => {
          const stream = readStream(options), iterator = stream[Symbol.asyncIterator]();
          const next = iterator.next.bind(iterator);
          let first = true;
          iterator.next = async (...values) => {
            const chunk = await next(...values);
            if (!chunk.done && first) {
              first = false; inspection.duringRead?.(selected, stream);
            }
            return chunk;
          };
          stream[Symbol.asyncIterator] = () => iterator;
          inspection.streams.set(selected, stream);
          return stream;
        };
      }
      return file;
    },
  };
});

it('Main admits each finite process-backed provider without requiring a Claude member', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-windows-selection-')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const path = join(root, 'profile.json');
  const selected = (members: unknown[] | undefined, management: unknown[] = []): SelectedHostProfile => {
    const bytes = JSON.stringify({ processCustody: { kind: 'main-windows-v1' },
      ...(members ? { runtime: { members, providerTemplates: [] } } : {}), management });
    writeFileSync(path, bytes);
    return { profileId: 'TEST-profile', nodeExecutable: process.execPath, nodeVersion: process.version,
      nodeSha256: 'a'.repeat(64), hostEntry: path, hostEntrySha256: 'b'.repeat(64),
      expectedBuildId: 'TEST-build', cwd: root,
      env: { LEGACY_AGENT_HOST_PROFILE_PATH: path,
        LEGACY_AGENT_HOST_PROFILE_SHA256: createHash('sha256').update(bytes).digest('hex') },
      startupTimeoutMs: 1000, requestTimeoutMs: 1000, writeTimeoutMs: 1000, shutdownTimeoutMs: 1000 };
  };
  const member = (provider: string, nativeGeneration?: string) => ({
    provider, ...(nativeGeneration ? { nativeGeneration } : {}), cwd: 'C:\\TEST\\workspace',
    environment: {}, executable: { path: 'C:\\TEST\\provider.exe', sha256: 'c'.repeat(64) },
    windowsBroker: { path: 'C:\\TEST\\broker.exe', sha256: 'd'.repeat(64), arch: process.arch,
      protocol: 1, capability: 'service-scopes-v1' },
  });
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    for (const provider of ['claude', 'codex', 'opencode']) {
      expect(captureMainWindowsCustody(selected([member(provider)]))).toBeInstanceOf(RetainedWindowsCustody);
      expect(captureMainWindowsCustody(selected(undefined, [member(provider)]))).toBeInstanceOf(RetainedWindowsCustody);
    }
    for (const unsupported of [member('unknown'), member('opencode', 'v2'), member('opencode', 'v3'),
      { ...member('codex'), provider: { toString: () => 'codex' } }]) {
      expect(() => captureMainWindowsCustody(selected([unsupported]))).toThrow('Captured Main custody unavailable');
    }
    const captured = selected([member('codex')]);
    writeFileSync(path, '{}');
    expect(() => captureMainWindowsCustody(captured)).toThrow('Invalid host profile');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    rmSync(root, { recursive: true, force: true });
  }
});


for (const outcome of ['intact', 'changed-tail', 'replaced-during-read', 'read-error'] as const) {
  it(`Main streaming verification keeps full-file and descriptor guarantees: ${outcome}`, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'TEST-windows-stream-')));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const providerPath = join(root, 'provider.exe'), brokerPath = join(root, 'owned-process-broker.exe');
    const selectedProvider = 'C:\\TEST\\provider.exe', selectedBroker = 'C:\\TEST\\owned-process-broker.exe';
    const providerBytes = Buffer.alloc(2 * 1024 * 1024 + 41, 0x61);
    providerBytes.write('TEST complete executable tail', providerBytes.length - 29);
    const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    const executableSha256 = digest(providerBytes), brokerBytes = Buffer.alloc(128);
    brokerBytes.write('MZ'); brokerBytes.writeUInt32LE(64, 60); brokerBytes.write('PE\0\0', 64);
    brokerBytes.writeUInt16LE(process.arch === 'x64' ? 0x8664 : 0xaa64, 68);
    const broker = { path: selectedBroker, sha256: digest(brokerBytes), arch: process.arch as 'x64' | 'arm64',
      protocol: 1 as const, capability: 'service-scopes-v1' as const };
    const path = join(root, 'profile.json');
    const bytes = JSON.stringify({ processCustody: { kind: 'main-windows-v1' }, runtime: { members: [{
      provider: 'codex', cwd: 'C:\\TEST\\workspace', environment: {},
      executable: { path: selectedProvider, sha256: executableSha256 }, windowsBroker: broker,
    }] } });
    const profile: SelectedHostProfile = { profileId: 'TEST-stream', nodeExecutable: process.execPath,
      nodeVersion: process.version, nodeSha256: 'a'.repeat(64), hostEntry: path, hostEntrySha256: 'b'.repeat(64),
      expectedBuildId: 'TEST-build', cwd: root, env: { LEGACY_AGENT_HOST_PROFILE_PATH: path,
        LEGACY_AGENT_HOST_PROFILE_SHA256: digest(bytes) }, startupTimeoutMs: 1000, requestTimeoutMs: 1000,
      writeTimeoutMs: 1000, shutdownTimeoutMs: 1000 };
    const failure = Object.assign(new Error('TEST read error'), { code: 'EIO' });
    let observedRead = false;
    try {
      writeFileSync(providerPath, providerBytes); writeFileSync(brokerPath, brokerBytes); writeFileSync(path, bytes);
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({ schema: 2, protocol: 1, platform: 'win32',
        arch: process.arch, file: 'owned-process-broker.exe', sha256: broker.sha256, capability: 'service-scopes-v1' }));
      inspection.paths.set(selectedProvider, providerPath); inspection.paths.set(selectedBroker, brokerPath);
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(captureMainWindowsCustody(profile)).toBeInstanceOf(RetainedWindowsCustody);
      if (outcome === 'changed-tail') {
        const changed = Buffer.from(providerBytes);
        changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
        writeFileSync(providerPath, changed);
      }
      inspection.duringRead = (selected, stream) => {
        if (selected !== selectedProvider) return;
        observedRead = true;
        if (outcome === 'replaced-during-read') {
          renameSync(providerPath, join(root, 'original-provider.exe'));
          writeFileSync(providerPath, providerBytes); // Same SHA, different pathname identity while the original FD is open.
        } else if (outcome === 'read-error') stream.destroy(failure);
      };
      const verification = inspection.options!.verifyLaunch({ executable: selectedProvider,
        commandLine: '"C:\\TEST\\provider.exe"', cwd: root, environment: [] }, executableSha256, broker,
      { capability: 'TEST-stream-root', phase: 'prepare' });
      if (outcome === 'intact') await expect(verification).resolves.toBeUndefined();
      else if (outcome === 'read-error') await expect(verification).rejects.toBe(failure);
      else await expect(verification).rejects.toThrow('Captured Main custody unavailable');
      expect(observedRead).toBe(true);
      expect(inspection.opened).toHaveLength(2);
      expect(inspection.opened.every(file => file.fd === -1)).toBe(true);
      if (outcome !== 'read-error') expect(inspection.streams.get(selectedProvider)?.bytesRead).toBe(providerBytes.length);
    } finally {
      inspection.duringRead = undefined; inspection.paths.clear(); inspection.streams.clear();
      inspection.options = undefined;
      Object.defineProperty(process, 'platform', platform);
      try { await Promise.all(inspection.opened.splice(0).map(file => file.close())); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
}


function constructedProfile(build: (capture: (value: NativeProcessProfile) => never) => unknown) {
  const reached = new Error('TEST reached actual constructor before native work');
  let selected: NativeProcessProfile | undefined;
  expect(() => build(value => { selected = value; throw reached; })).toThrow(reached);
  if (!selected) throw new Error('TEST constructor did not provide its profile');
  return selected;
}

function memberContext(profile: RuntimeMemberProfile): MemberProviderContext {
  return {
    profile, request: { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: profile.sessionId,
      generation: 1, configRevision: profile.configRevision, requiredCapabilities: ['text', 'tools'] },
    endpoint: { url: 'http://127.0.0.1:14322/mcp/' + 'e'.repeat(32), bearerToken: 't'.repeat(43),
      binding: { backendId: 'TEST-owner', teamId: profile.teamId, teamName: 'test-team',
        runId: 'TEST-run', memberId: profile.memberId, generation: '1' }, revoke() {}, async close() {} },
    connection: { execute() { throw new Error('TEST no Team mutation'); }, lookup: () => undefined,
      getTask() { throw new Error('TEST no Task read'); }, listTasks: () => [] },
    instructions: 'TEST original instructions', isCurrent: () => true, canAllocate: () => true,
    readCheckpoint: async () => undefined, onProgress() {},
  };
}

function environmentFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'TEST-main-environment-')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const executable = { path: 'C:\\TEST\\provider.exe', sha256: hash('TEST inert provider') };
  const brokerBytes = Buffer.alloc(128);
  brokerBytes.write('MZ'); brokerBytes.writeUInt32LE(64, 60); brokerBytes.write('PE\0\0', 64);
  brokerBytes.writeUInt16LE(process.arch === 'x64' ? 0x8664 : 0xaa64, 68);
  const broker = { path: 'C:\\TEST\\owned-process-broker.exe', sha256: hash(brokerBytes),
    arch: process.arch as 'x64' | 'arm64', protocol: 1 as const, capability: 'service-scopes-v1' as const };
  const file = (selected: string, name: string, bytes: string | Buffer) => {
    const path = join(root, name); writeFileSync(path, bytes); inspection.paths.set(selected, path); return path;
  };
  file(executable.path, 'provider.exe', 'TEST inert provider');
  file(broker.path, 'owned-process-broker.exe', brokerBytes);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ schema: 2, protocol: 1, platform: 'win32',
    arch: process.arch, file: 'owned-process-broker.exe', sha256: broker.sha256, capability: 'service-scopes-v1' }));
  const environment: Record<string, string> = { PATH: 'C:\\TEST\\tools', TEST_IMMUTABLE: 'A = Ω',
    NODE_OPTIONS: '--conditions=TEST-captured' };
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    const path = join(root, key); mkdirSync(path);
    environment[key] = 'C:\\TEST\\' + key; inspection.paths.set(environment[key], path);
  }
  const hostEntry = join(root, 'dist/cli.js'), pluginPath = join(root, 'dist/adapters/providers/OpenCodeMcpPolicyPlugin.js');
  mkdirSync(join(root, 'dist/adapters/providers'), { recursive: true });
  const hostBytes = readFileSync(new URL('../../../packages/legacy-agent-host/dist/cli.js', import.meta.url));
  const pluginBytes = readFileSync(new URL('../../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeMcpPolicyPlugin.js', import.meta.url));
  writeFileSync(hostEntry, hostBytes); writeFileSync(pluginPath, pluginBytes);
  const privatePin = { path: 'C:\\TEST\\private-plugin.js', sha256: hash(pluginBytes) };
  file(privatePin.path, 'private-plugin.js', pluginBytes);
  const plugin = { path: pluginPath, sha256: hash(pluginBytes) };
  const member = (provider: 'claude' | 'codex' | 'opencode') => runtimeMemberProfileSchema.parse({
    provider, executable, windowsBroker: broker, cwd: environment.HOME, environment: { ...environment,
      ...(provider === 'opencode' ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['TEST preserved'],
        plugin: [], agent: { build: { prompt: 'TEST agent prompt' }, audit: { prompt: 'TEST untouched agent' } },
        provider: { 'TEST-provider': { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'TEST-key' },
          models: { 'TEST-model': { name: 'TEST model' } } } } }) } : {}) },
    teamId: 'TEST-team', memberId: provider + '-alice', principalId: 'TEST-member', sessionId: 'TEST-session-' + provider,
    generation: 1, configRevision: 'TEST-config', accountBinding: 'TEST-account', model: 'TEST-model',
    limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 65536, outputEvents: 100, pendingInteractions: 2, timeoutMs: 1000 },
    ...(provider === 'claude' ? { nativeTools: [], autoAllowedTools: [] } :
      provider === 'codex' ? { protocolRevision: '0.162.0', nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' } } :
        { protocolRevision: '1.19.4', endpoint: 'http://127.0.0.1:14321', nativeOptions: { providerId: 'TEST-provider', agent: 'build' } }),
  });
  const capture = (members: RuntimeMemberProfile[], custom = false) => {
    const path = join(root, 'profile.json');
    const bytes = JSON.stringify({ processCustody: { kind: 'main-windows-v1' }, runtime: { members } });
    writeFileSync(path, bytes);
    const entry = custom ? file('C:\\TEST\\unused-wrapper', 'wrapper.js', hostBytes) : hostEntry;
    const profile: SelectedHostProfile = { profileId: 'TEST-environment', nodeExecutable: process.execPath,
      nodeVersion: process.version, nodeSha256: 'a'.repeat(64), hostEntry: entry, hostEntrySha256: hash(hostBytes),
      expectedBuildId: 'TEST-build', cwd: root, env: { LEGACY_AGENT_HOST_PROFILE_PATH: path,
        LEGACY_AGENT_HOST_PROFILE_SHA256: hash(bytes) }, startupTimeoutMs: 1000, requestTimeoutMs: 1000,
      writeTimeoutMs: 1000, shutdownTimeoutMs: 1000 };
    expect(captureMainWindowsCustody(profile)).toBeInstanceOf(RetainedWindowsCustody);
    const verify = inspection.options!.verifyLaunch;
    return (selected: NativeProcessProfile, phase: 'prepare' | 'resume', env = selected.environment) => {
      const launcher = captureWindowsLauncher(selected);
      const spec = windowsLaunchSpec(selected, [], launcher);
      return verify({ ...spec, environment: Object.entries(env).map(([key, value]) => key + '=' + value) },
        launcher.executable.sha256, broker, { capability: 'TEST-original-environment', phase });
    };
  };
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  return { member, capture, plugin, pluginPath, pluginBytes, privatePin,
    coordinationPaths() {
      const root = mkdtempSync(join(inspection.paths.get(environment.XDG_DATA_HOME!)!, 'agent-teams-coordination-'));
      const directory = (name: string) => {
        const path = join(root, name), selected = environment.XDG_DATA_HOME + '\\' + basename(root) + '\\' + name;
        mkdirSync(path); inspection.paths.set(selected, path); return selected;
      };
      return { home: directory('home'), config: directory('config'), data: directory('data'),
        cache: directory('cache'), state: directory('state') };
    },
    async close() {
      inspection.duringRead = undefined; inspection.paths.clear(); inspection.streams.clear(); inspection.options = undefined;
      Object.defineProperty(process, 'platform', platform);
      try { await Promise.all(inspection.opened.splice(0).map(file => file.close())); }
      finally { rmSync(root, { recursive: true, force: true }); }
    },
  };
}

it('Main checks complete captured environments and selects either original recipe sharing the same image', async () => {
  const f = environmentFixture();
  try {
    const codex = f.member('codex'), claude = f.member('claude');
    const second = { ...codex, memberId: 'second', sessionId: 'TEST-second',
      environment: { ...codex.environment, TEST_IMMUTABLE: 'B = Ω' } };
    const firstMember = constructedProfile(createProcess => createCodexMemberProvider(memberContext(codex), { createProcess }));
    const secondMember = constructedProfile(createProcess => createCodexMemberProvider(memberContext(second), { createProcess }));
    const verify = f.capture([codex, second, claude]);
    for (const phase of ['prepare', 'resume'] as const) {
      for (const value of [claude, codex, firstMember, second, secondMember])
        await expect(verify(value, phase)).resolves.toBeUndefined();
      await expect(verify(firstMember, phase, Object.fromEntries(Object.entries(firstMember.environment).reverse())))
        .resolves.toBeUndefined();
      const { TEST_IMMUTABLE: _omitted, ...missing } = firstMember.environment;
      for (const env of [missing,
        { ...firstMember.environment, TEST_IMMUTABLE: 'uncaptured' },
        { ...firstMember.environment, TEST_ADDED: 'injected' },
        { ...firstMember.environment, NODE_OPTIONS: '--require=TEST-other-loader' },
        { ...firstMember.environment, NODE_PATH: 'C:\\TEST\\injected' },
        { ...firstMember.environment, Path: firstMember.environment.PATH! }])
        await expect(verify(firstMember, phase, env)).rejects.toThrow('Captured Main custody unavailable');
    }
  } finally { await f.close(); }
});

it('Main admits actual V1 policy construction and member-derived management without relaxing preserved config', async () => {
  const f = environmentFixture();
  try {
    const base = f.member('opencode');
    if (base.provider !== 'opencode') throw new Error('TEST V1 recipe');
    const selected = { ...base, capturedMcpServers: {
      docs: { type: 'stdio' as const, command: 'TEST-docs', args: ['TEST argument'], env: { TEST_PRIVATE: 'captured' } },
      remote: { type: 'http' as const, url: 'https://example.invalid/selected', headers: { Authorization: 'TEST-private' } },
    }, mcpPolicyPlugin: f.plugin };
    const actual = constructedProfile(createProcess => createOpenCodeMemberProvider(memberContext(selected), { createProcess }));
    const management = teamModelProbeProfile(base);
    if (management.provider !== 'opencode') throw new Error('TEST management recipe');
    const probe = constructedProfile(createProcess => new OpenCodeManagementHost(management,
      { canAllocate: () => true, isCurrent: () => true }, { createProcess }));
    const model = { providerId: 'TEST-provider', modelId: 'TEST-model' };
    const provider = selectOpenCodeCoordinationProvider({ npm: '@ai-sdk/openai-compatible',
      models: { 'TEST-model': { name: 'TEST model' } }, options: { apiKey: 'TEST-private' } }, model);
    if (!provider) throw new Error('TEST coordination provider');
    const isolated = buildOpenCodeCoordinationEnvironment(management.environment, f.coordinationPaths());
    const coordination = buildOpenCodeCoordinationConfig(management, model, provider,
      { url: 'http://127.0.0.1:14322/coordination', bearerToken: 'c'.repeat(43) });
    const coordinated = { ...management, environment: buildOpenCodeManagementEnvironment(isolated, coordination,
      { password: 'p'.repeat(43), witnessAgent: 'management_' + 'a'.repeat(24), witness: 'w'.repeat(43), coordination: true }) };
    const verify = f.capture([base]);
    const config: Record<string, unknown> = JSON.parse(actual.environment.OPENCODE_CONFIG_CONTENT!);
    const mcp: Record<string, unknown> = JSON.parse(JSON.stringify(config.mcp));
    for (const phase of ['prepare', 'resume'] as const) {
      await expect(verify(actual, phase)).resolves.toBeUndefined();
      await expect(verify(probe, phase)).resolves.toBeUndefined();
      await expect(verify(coordinated, phase)).resolves.toBeUndefined();
      for (const changed of [{ ...config, TEST_unknown_native_field: true },
        { ...config, instructions: ['TEST changed preserved subtree'] },
        { ...config, mcp: { ...mcp, docs: { type: 'local', command: ['TEST-docs'], enabled: true, unsupported: true } } }])
        await expect(verify(actual, phase, { ...actual.environment, OPENCODE_CONFIG_CONTENT: JSON.stringify(changed) }))
          .rejects.toThrow('Captured Main custody unavailable');
    }
    const substitute = constructedProfile(createProcess => createOpenCodeMemberProvider(
      memberContext({ ...selected, mcpPolicyPlugin: f.privatePin }), { createProcess }));
    for (const phase of ['prepare', 'resume'] as const)
      await expect(verify(substitute, phase)).rejects.toThrow('Captured Main custody unavailable');
    writeFileSync(f.pluginPath, Buffer.concat([f.pluginBytes, Buffer.from('\n// TEST changed')]));
    for (const phase of ['prepare', 'resume'] as const)
      await expect(verify(actual, phase)).rejects.toThrow('Captured Main custody unavailable');
  } finally { await f.close(); }
});

for (const unavailable of ['unknown-layout', 'missing-default'] as const) {
  it('unavailable default plugin leaves original non-policy families admitted: ' + unavailable, async () => {
    const f = environmentFixture();
    try {
      const base = f.member('opencode');
      if (base.provider !== 'opencode') throw new Error('TEST V1 recipe');
      const legacy = { ...base, memberId: 'legacy-alice', sessionId: 'TEST-legacy', protocolRevision: '1.18.35' as const };
      const policy = constructedProfile(createProcess => createOpenCodeMemberProvider(memberContext({
        ...base, capturedMcpServers: {}, mcpPolicyPlugin: f.plugin }), { createProcess }));
      const ordinary = constructedProfile(createProcess => createOpenCodeMemberProvider(memberContext(legacy), { createProcess }));
      const management = teamModelProbeProfile(base);
      if (management.provider !== 'opencode') throw new Error('TEST management recipe');
      const probe = constructedProfile(createProcess => new OpenCodeManagementHost(management,
        { canAllocate: () => true, isCurrent: () => true }, { createProcess }));
      const codex = f.member('codex'), claude = f.member('claude');
      if (unavailable === 'missing-default') rmSync(f.pluginPath);
      const verify = f.capture([base, legacy, codex, claude], unavailable === 'unknown-layout');
      writeFileSync(f.pluginPath, f.pluginBytes); // A later appearance cannot create a default pin for this owner.
      for (const phase of ['prepare', 'resume'] as const) {
        for (const selected of [base, ordinary, probe, codex, claude])
          await expect(verify(selected, phase)).resolves.toBeUndefined();
        await expect(verify(policy, phase)).rejects.toThrow('Captured Main custody unavailable');
      }
    } finally { await f.close(); }
  });
}

it('a custom Host keeps its independently captured explicit private plugin pin', async () => {
  const f = environmentFixture();
  try {
    const base = f.member('opencode');
    if (base.provider !== 'opencode') throw new Error('TEST V1 recipe');
    const original = { ...base, mcpPolicyPlugin: f.privatePin };
    const actual = constructedProfile(createProcess => createOpenCodeMemberProvider(memberContext({
      ...original, capturedMcpServers: { selected: { type: 'sse', url: 'https://example.invalid/original' } } }), { createProcess }));
    const verify = f.capture([original], true);
    for (const phase of ['prepare', 'resume'] as const) await expect(verify(actual, phase)).resolves.toBeUndefined();
    rmSync(inspection.paths.get(f.privatePin.path)!);
    for (const phase of ['prepare', 'resume'] as const)
      await expect(verify(actual, phase)).rejects.toThrow('Captured Main custody unavailable');
  } finally { await f.close(); }
});

it('actual V1 bare-model and permission choices remain admitted when native qualification exceeds 256 characters', async () => {
  const f = environmentFixture();
  try {
    const seed = f.member('opencode');
    if (seed.provider !== 'opencode') throw new Error('TEST V1 recipe');
    const providerId = 'p'.repeat(100), model = 'm'.repeat(200);
    const config = JSON.parse(seed.environment.OPENCODE_CONFIG_CONTENT!);
    const base = runtimeMemberProfileSchema.parse({ ...seed,
      nativeOptions: { ...seed.nativeOptions, providerId },
      environment: { ...seed.environment, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config,
        provider: { [providerId]: { npm: '@ai-sdk/openai-compatible',
          models: { 'TEST-model': { name: 'original' }, [model]: { name: 'selected' } } } } }) } });
    const verify = f.capture([base]);
    for (const permissions of ['manual', 'bypass'] as const) {
      const selected = applyLaunchConfiguration(base, { model, permissions });
      const actual = constructedProfile(createProcess => createOpenCodeMemberProvider(memberContext(selected), { createProcess }));
      expect(JSON.parse(actual.environment.OPENCODE_CONFIG_CONTENT!).agent.build.model).toBe(providerId + '/' + model);
      for (const phase of ['prepare', 'resume'] as const) await expect(verify(actual, phase)).resolves.toBeUndefined();
    }
  } finally { await f.close(); }
});
