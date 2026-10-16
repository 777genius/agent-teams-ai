import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileFunction, constants, runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { projectIpcCausalFailure, safeIpcFailureDetail } from '../../scripts/e2e/opencode-native-desktop-host';
import { serializedFunction } from '../../scripts/e2e/release-updater/serialized-function.mts';
import { redactLaunchFailureArtifactText } from '../../src/main/services/team/TeamLaunchFailureArtifactPack';

const project = (value: string): string =>
  runInNewContext(
    `${serializedFunction(safeIpcFailureDetail)}(${JSON.stringify(value)}, ${serializedFunction(redactLaunchFailureArtifactText)})`
  ) as string;

describe('serialized native IPC failure details', () => {
  it('keeps original prelaunch primary and all cleanup native facts through real aggregate identities', async () => {
    const source = await readFile(
      path.resolve('scripts/e2e/opencode-native-windows-preflight.ts'),
      'utf8'
    );
    const ast = ts.createSourceFile('preflight.ts', source, ts.ScriptTarget.Latest, true);
    const declaration = ast.statements
      .filter(ts.isFunctionDeclaration)
      .find((node) => node.name?.text === 'safeSourceGateFailure')!;
    const compiled = ts.transpileModule(declaration.getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const project = compileFunction(`${compiled}\nreturn safeSourceGateFailure;`)() as (
      error: unknown,
      failures?: WeakMap<object, string>
    ) => { causal: { failures: Record<string, unknown>[]; truncated: boolean } };
    const primary = new Error('execution_owner_not_private:private_acl_owner:5:private_dir_2');
    const directory = Object.assign(
      new Error('execution_native_unknown:owner_metadata_cleanup:6'),
      {
        nativeOperation: 'ownerCloseDirectory',
        nativeStatus: 0xc0000022,
        path: 'C:\\TEST-secret',
        sid: 'S-1-5-TEST',
      }
    );
    const broker = new Error('cleanup_unknown');
    const closed = Object.assign(
      new AggregateError([directory, broker], 'cleanup_unknown', { cause: directory }),
      { cleanupBoundary: 'probe_store_close', primaryFailure: false }
    );
    const outer = Object.assign(
      new AggregateError([primary, closed], 'cleanup_unknown', { cause: primary }),
      { cleanupBoundary: 'probe_release', primaryFailure: true }
    );
    const originals = new WeakMap<object, string>([[primary, 'ownerAssertDirectory']]);
    const before = Object.getOwnPropertyDescriptors(primary);
    const packet = project(outer, originals).causal;
    expect(packet.truncated).toBe(false);
    expect(packet.failures).toHaveLength(5);
    expect(packet.failures[1]).toMatchObject({
      parent: 0,
      role: 'primary',
      category: 'execution_owner_not_private',
      nativeOperation: 'ownerAssertDirectory',
      native: { stage: 'private_acl_owner', nativeCode: 5 },
      privateDirectoryIndex: 2,
    });
    expect(packet.failures[2]).toMatchObject({
      parent: 0,
      role: 'cleanup',
      boundary: 'probe_store_close',
    });
    expect(packet.failures[3]).toMatchObject({
      parent: 2,
      role: 'cleanup',
      nativeOperation: 'ownerCloseDirectory',
      native: { stage: 'owner_metadata_cleanup', nativeCode: 6, nativeStatus: 0xc0000022 },
    });
    expect(packet.failures[4]).toMatchObject({
      parent: 2,
      role: 'cleanup',
      category: 'cleanup_unknown',
    });
    expect(Object.getOwnPropertyDescriptors(primary)).toEqual(before);
    expect(JSON.stringify(packet)).not.toMatch(/TEST-secret|S-1-5|stack|message/);
    const unknown = Object.assign(new Error('TEST-secret:untrusted:5'), {
      nativeOperation: 'TEST-secret',
      code: 'TEST-secret',
    });
    expect(project(unknown).causal.failures[0]).toMatchObject({
      category: 'unclassified',
      nativeOperation: 'unknown',
      native: null,
      errno: null,
    });
    for (const [message, stage, nativeCode] of [
      ['cleanup_unknown:close:995', 'close', 995],
      ['execution_owner_not_private:private_acl_owner_run_v2:5', 'private_acl_owner_run_v2', 5],
      ['run_control_connect_unknown:connect:5', 'connect', 5],
    ] as const)
      expect(project(new Error(message)).causal.failures[0]).toMatchObject({
        native: { stage, nativeCode },
      });
    expect(
      project(new Error('execution_native_unknown:arbitrary_stage_123:5')).causal.failures[0]
    ).toMatchObject({ native: null });
    const many = Object.assign(
      new AggregateError(
        Array.from({ length: 30 }, () => new Error('cleanup_unknown')),
        'cleanup_unknown'
      ),
      { cleanupBoundary: 'probe_store_close', primaryFailure: false }
    );
    expect(project(many).causal.truncated).toBe(true);
    expect(project(many).causal.failures).toHaveLength(16);
    let deep: Error = new Error('cleanup_unknown');
    for (let i = 0; i < 7; i++) deep = new Error('cleanup_unknown', { cause: deep });
    expect(project(deep).causal.truncated).toBe(true);
    expect(project(deep).causal.failures).toHaveLength(5);
  });

  it('keeps actual target ACL projection bounded and strips raw paths, SIDs and extra fields', async () => {
    const source = await readFile(
      path.resolve('scripts/e2e/opencode-native-windows-preflight.ts'),
      'utf8'
    );
    const ast = ts.createSourceFile('preflight.ts', source, ts.ScriptTarget.Latest, true);
    let projector = '';
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'targetAclFacts')
        projector = node.initializer!.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(projector).not.toBe('');
    const compiled = ts.transpileModule(`const project = ${projector};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const metadata = {
      relativeDepth: 0,
      pathSha256: 'a'.repeat(64),
      fileIdSha256: 'b'.repeat(64),
      type: 'file',
      symbolicLink: false,
      nlink: 2,
    };
    const project = compileFunction(`${compiled}\nreturn project;`, ['chain', 'principals', 'row'])(
      [{ ...metadata, path: 'C:\\TEST-private\\LICENSE' }],
      ['current_user'],
      (value: unknown) => (value && typeof value === 'object' ? value : {})
    ) as (input: unknown) => unknown;
    const ace = { sidSha256: 'c'.repeat(64), kind: 'AccessAllowed', mask: 0xffffffff, flags: 255 };
    const input = [
      {
        relativeDepth: 0,
        reparsePoint: false,
        control: 0x8004,
        ownerClass: 'current_user',
        nullDacl: false,
        aces: [{ ...ace, sid: 'S-1-15-2-TEST', rawPath: 'C:\\TEST-private' }],
        rawSddl: 'TEST-private',
      },
    ];
    expect(project(input)).toEqual([
      {
        ...metadata,
        reparsePoint: false,
        control: 0x8004,
        ownerClass: 'current_user',
        nullDacl: false,
        aces: [ace],
      },
    ]);
    expect(JSON.stringify(project(input))).not.toMatch(/TEST-private|S-1-15|rawSddl/);
    for (const change of [
      { control: 65536 },
      { control: -1 },
      { relativeDepth: 1 },
      { reparsePoint: 'false' },
      { aces: Array.from({ length: 65 }, () => ace) },
      { aces: [{ ...ace, mask: 0x100000000 }] },
      { aces: [{ ...ace, sidSha256: 'raw-SID' }] },
    ]) {
      expect(() => project([{ ...input[0], ...change }])).toThrow(
        'TEST target ACL response invalid'
      );
    }
    expect(() => project([])).toThrow('TEST target ACL response invalid');
    expect(() => project([...input, ...input])).toThrow('TEST target ACL response invalid');
  });

  it('preserves complete validated acquisition timing from the actual serialized preflight snapshot', async () => {
    const source = await readFile(
      path.resolve('scripts/e2e/opencode-native-windows-preflight.ts'),
      'utf8'
    );
    const ast = ts.createSourceFile('preflight.ts', source, ts.ScriptTarget.Latest, true);
    const declarations = ast.statements
      .filter(ts.isFunctionDeclaration)
      .map((node) => node.getText(ast))
      .join('\n');
    const compiled = ts.transpileModule(declarations, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const snapshot = compileFunction(`${compiled}\nreturn snapshotStartupFailure;`, ['process'], {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    })(process) as (
      value: unknown,
      session: string,
      plan: unknown,
      sdkRoot: string,
      launches: unknown[]
    ) => Promise<{
      diagnostics: {
        category: string;
        acquisitionElapsedMs: number | null;
        acquisitionHistory: { phase: string; elapsedMs: number }[];
        acquisitionLastPhase: string | null;
        startupStage: string | null;
        cleanupPhase: string;
        cleanupNativePhase: string;
        cleanupElapsedMs: number | null;
      }[];
    }>;
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-acquisition-timing-')));
    const previousRoot = process.env.CLAUDE_MULTIMODEL_DATA_HOME;
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root;
    try {
      const directory = path.join(root, 'opencode/v2/runs', 'a'.repeat(32));
      const diagnostics = path.join(root, 'opencode/v2/provider-diagnostics');
      await mkdir(directory, { recursive: true });
      await mkdir(diagnostics);
      const binding = {
        teamId: 'TEST-acquisition',
        runId: randomUUID(),
        controllerInstanceId: randomUUID(),
        ownerId: randomUUID(),
      };
      await writeFile(
        path.join(directory, 'state.json'),
        JSON.stringify({ binding, state: 'starting', members: [] })
      );
      const diagnostic = path.join(diagnostics, `${randomUUID()}.json`);
      const project = async (
        acquisition: unknown,
        category = 'execution_timeout',
        startup?: unknown,
        cleanup?: unknown
      ) => {
        await writeFile(
          diagnostic,
          JSON.stringify({
            schemaVersion: 1,
            phase: 'execution-host-startup',
            category,
            acquisition,
            ...(startup === undefined ? {} : { startup }),
            ...(cleanup === undefined ? {} : { cleanup }),
          })
        );
        return (await snapshot({ directory, binding }, 'TEST-session', {}, '/TEST-sdk', []))
          .diagnostics[0]!;
      };
      const cleanup = { phase: 'kernel-retirement', nativePhase: 'retire_grants_roots', elapsedMs: 22_002,
        rawPath: 'PRIVATE-TEST-cleanup-secret', memberId: 'PRIVATE-TEST-original-member' };
      const live = await project(undefined, 'timeout', undefined, cleanup);
      expect(live).toMatchObject({ cleanupPhase: 'kernel-retirement', cleanupNativePhase: 'retire_grants_roots', cleanupElapsedMs: 22_002 });
      expect(JSON.stringify(live)).not.toContain('PRIVATE-TEST');
      for (const phase of ['owner-release', 'retained-roots', 'plan-close'])
        expect(await project(undefined, 'timeout', undefined, { ...cleanup, phase })).toMatchObject({ cleanupPhase: phase, cleanupNativePhase: 'unclassified' });
      for (const phase of ['PRIVATE-TEST-secret', ['kernel-retirement']])
        expect(await project(undefined, 'timeout', undefined, { ...cleanup, phase })).toMatchObject({ cleanupPhase: 'unclassified', cleanupNativePhase: 'unclassified' });
      expect(await project(undefined, 'timeout', undefined, { ...cleanup, nativePhase: 'PRIVATE-TEST-secret', elapsedMs: -1 })).toMatchObject({ cleanupPhase: 'kernel-retirement', cleanupNativePhase: 'unclassified', cleanupElapsedMs: null });
      const phases = [
        'preparing',
        'delivery-resolved',
        'profile-validated',
        'native-validated',
        'graph-validated',
        'resolution-prepared',
        'controller-prepared',
        'prepared',
        'mapping',
        'child-bound',
        'start-sent',
        'ready',
        'catalog-ready',
        'auth-ready',
        'selection-ready',
      ];
      const timing = {
        elapsedMs: 180_004,
        history: [
          { phase: 'preparing', elapsedMs: 0 },
          { phase: 'prepared', elapsedMs: 9400 },
          { phase: 'start-sent', elapsedMs: 140_100 },
        ],
      };
      expect(await project(timing)).toMatchObject({
        acquisitionElapsedMs: timing.elapsedMs,
        acquisitionHistory: timing.history,
        acquisitionLastPhase: 'start-sent',
      });
      expect(
        (
          await project(timing, 'execution_timeout', {
            reason: 'timeout',
            stage: 'waiting-for-activation',
            elapsedMs: 120_006,
          })
        ).startupStage
      ).toBe('waiting-for-activation');
      for (const category of [
        'run_acquisition_timeout',
        'run_initialization_timeout',
        'run_stopped',
        'cancelled',
      ])
        expect((await project(timing, category)).category).toBe(category);
      expect((await project(timing, 'PRIVATE-TEST-unknown')).category).toBe('unclassified');
      expect(await project({ elapsedMs: 0, history: [timing.history[0]] })).toMatchObject({
        acquisitionElapsedMs: 0,
        acquisitionHistory: [timing.history[0]],
      });
      const all = phases.map((phase, elapsedMs) => ({ phase, elapsedMs }));
      expect(await project({ elapsedMs: 86_400_000, history: all })).toMatchObject({
        acquisitionElapsedMs: 86_400_000,
        acquisitionHistory: all,
        acquisitionLastPhase: 'selection-ready',
      });
      for (const acquisition of [
        null,
        [],
        { ...timing, rawPath: 'PRIVATE-TEST-secret' },
        { ...timing, elapsedMs: -1 },
        { ...timing, elapsedMs: 86_400_001 },
        { ...timing, elapsedMs: 1.5 },
        { ...timing, elapsedMs: '180004' },
        { ...timing, history: [] },
        { ...timing, history: [...all, all[0]] },
        { ...timing, history: [{ phase: 'start-sent', elapsedMs: 0 }] },
        { ...timing, history: [{ phase: 'preparing', elapsedMs: 1 }] },
        { ...timing, history: [timing.history[0], timing.history[0]] },
        { ...timing, history: [timing.history[0], { phase: 'start-sent', elapsedMs: 180_005 }] },
        { ...timing, history: [timing.history[0], { phase: 'unlisted-secret', elapsedMs: 1 }] },
        {
          ...timing,
          history: [
            timing.history[0],
            { phase: { toString: 'PRIVATE-TEST-secret' }, elapsedMs: 1 },
          ],
        },
        {
          ...timing,
          history: [
            timing.history[0],
            { phase: 'prepared', elapsedMs: 5 },
            { phase: 'start-sent', elapsedMs: 4 },
          ],
        },
        {
          ...timing,
          history: [
            timing.history[0],
            { phase: 'start-sent', elapsedMs: 1, token: 'PRIVATE-TEST-secret' },
          ],
        },
      ]) {
        const actual = await project(acquisition);
        expect(actual).toMatchObject({
          acquisitionElapsedMs: null,
          acquisitionHistory: [],
          acquisitionLastPhase: null,
        });
        expect(JSON.stringify(actual)).not.toMatch(/PRIVATE-TEST|unlisted-secret/);
      }
    } finally {
      if (previousRoot === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME;
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['data_root', 'opencode', 'v2', 'runs', 'leaf'])(
    'preserves only the closed native owner role %s',
    (role) => {
      const detail = project(
        `execution_owner_not_private:private_acl_owner_run_${role}:0 /PRIVATE-TEST/path`
      );
      expect(detail).toContain(`[owner role: ${role === 'data_root' ? 'data' : role}]`);
      expect(detail).not.toContain('PRIVATE-TEST');
      expect(project(detail)).toBe(detail);
      expect(project('execution_owner_not_private:private_acl_owner_run_secret:0')).not.toContain(
        '[owner role:'
      );
    }
  );
  it.each(['"', "'", '`'])('redacts truncated and escaped %s arguments', (quote) => {
    for (const tail of [
      ' '.repeat(17_000) + quote,
      ' '.repeat(16_300) + '\\',
      '\\' + quote + ' '.repeat(17_000),
    ]) {
      const detail = project(`Rejected argument: ${quote}confidential-value${tail}`);
      expect(detail).toBe('Rejected argument: [argument]');
      expect(project(detail)).toBe(detail);
    }
  });

  it.each(['"', "'", '`'])('redacts word-prefixed %s arguments', (quote) => {
    expect(project(`Rejected argument: b${quote}confidential-value${quote}`)).toBe(
      'Rejected argument: b[argument]'
    );
    expect(project(`Rejected argument: b${quote}confidential-value${' '.repeat(17_000)}`)).toBe(
      'Rejected argument: b[argument]'
    );
  });

  it('bounds the output', () => {
    expect(project('failure '.repeat(3_000)).length).toBeLessThanOrEqual(500);
  });

  it('does not expose quoted arguments after contractions', () => {
    const detail = project("couldn't resolve module 'confidential-value'");
    expect(detail).not.toContain('confidential-value');
    expect(project(detail)).toBe(detail);
  });

  it('redacts provider keys and absolute paths before transport', () => {
    const detail = project(
      `ENOENT: open "C:\\PRIVATE-TEST\\private.txt" OPENROUTER_API_KEY=sk-or-v1-${'a'.repeat(64)}`
    );
    expect(detail).toContain('ENOENT');
    expect(detail).not.toContain('PRIVATE-TEST');
    expect(detail).not.toContain('sk-or-v1-');
    expect(project('EACCES: mkdir \\\\PRIVATE-SERVER\\PRIVATE-SHARE')).not.toContain('PRIVATE');
    expect(project('EPERM: open /PRIVATE-USER/secret')).not.toContain('PRIVATE');
  });
});


it('projects lifecycle causal facts before crossing CDP and rejects raw foreign details', () => {
  const raw = { phase: 'dispatch', errno: 'ENOENT', cleanupErrno: 'EACCES',
    reason: 'Bridge handshake identity hash mismatch',
    sourceFrame: { source: 'OpenCodeBridgeCommandClient.ts', line: 123, column: 4, path: 'C:\\TEST-secret' },
    message: 'secret-token', stack: 'private stack', headers: { Authorization: 'private' } };
  const packet = runInNewContext(`(${serializedFunction(projectIpcCausalFailure)})(${JSON.stringify(raw)})`);
  expect(packet).toEqual({ phase: 'dispatch', errno: 'ENOENT', cleanupErrno: 'EACCES',
    reason: 'Bridge handshake identity hash mismatch',
    sourceFrame: { source: 'OpenCodeBridgeCommandClient.ts', line: 123, column: 4 } });
  expect(JSON.stringify(packet)).not.toMatch(/TEST-secret|secret-token|private|Authorization/);
  expect(projectIpcCausalFailure({ ...raw, phase: 'raw-private-phase' })).toBeNull();
  expect(projectIpcCausalFailure({ ...raw, errno: 'EPRIVATE_TOKEN', reason: 'private reason',
    sourceFrame: { source: 'private.ts', line: 0, column: 999999 } })).toMatchObject({ errno: null, reason: null, sourceFrame: null });
});


it('actual renderer IPC catch transports only the closed causal packet', async () => {
  const source = await readFile('scripts/e2e/opencode-native-desktop-host.ts', 'utf8');
  const ast = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
  let arrow: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'start'
      && node.initializer && ts.isArrowFunction(node.initializer)) arrow = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(arrow).toBeDefined();
  const compiled = ts.transpileModule(`const start=${arrow!.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const original = Object.assign(new Error('team_stop_unconfirmed:stop_failed:internal_error'), {
    details: { causalFailure: { phase: 'lease_release', errno: 'EIO', reason: null,
      sourceFrame: null, raw: 'secret-token' }, secret: 'private' },
  });
  // Electron contextBridge reconstructs Error and drops custom properties.
  const snapshot = original.details.causalFailure;
  const reconstructed = new Error(original.message + '\nOPENCODE_STOP_CAUSE_V1=' + JSON.stringify(snapshot));
  const state = { calls: {} as Record<string, Record<string, unknown>>, port: {
    stop: async () => { throw reconstructed; },
  } };
  const start = compileFunction(`${compiled}return start;`, ['window'])({ __opencodeNativeProof: state });
  start('owned-call', 'stop', [], [], safeIpcFailureDetail,
    redactLaunchFailureArtifactText, projectIpcCausalFailure);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(state.calls['owned-call']).toMatchObject({ state: 'failed', causalFailure: {
    phase: 'lease_release', errno: 'EIO', reason: null, sourceFrame: null,
  } });
  expect(JSON.stringify(state.calls)).not.toMatch(/secret-token|private|details|stack/);
  expect(original.details.secret).toBe('private');
});


it('accepts only the bounded final Stop causal suffix with its original error prefix', () => {
  const packet = { phase: 'dispatch', errno: 'ENOENT', reason: null, sourceFrame: null };
  const marker = '\nOPENCODE_STOP_CAUSE_V1=';
  expect(projectIpcCausalFailure('team_stop_unconfirmed:stop_failed' + marker + JSON.stringify(packet)))
    .toMatchObject(packet);
  for (const value of ['foreign' + marker + JSON.stringify(packet),
    'team_stop_unconfirmed:x' + marker + '{',
    'team_stop_unconfirmed:x' + marker + JSON.stringify(packet) + '\nforeign',
    'team_stop_unconfirmed:x' + marker + 'x'.repeat(2049)])
    expect(projectIpcCausalFailure(value)).toBeNull();
});


it('actual bundled verifier hashes every file with at most eight readers and drains failures', async () => {
  const source = await readFile('scripts/e2e/opencode-native-windows-full.ts', 'utf8');
  const ast = ts.createSourceFile('full.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.filter(ts.isFunctionDeclaration)
    .find((node) => node.name?.text === 'bundledRuntime')!;
  const compiled = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-runtime-hash-')));
  try {
    const base = path.join(root, 'resources/runtime');
    await mkdir(base, { recursive: true });
    const executable = path.join(root, 'app.exe');
    await writeFile(executable, 'TEST-app');
    const sdkSha = 'a'.repeat(40);
    const files: Record<string, string> = {};
    for (const [name, bytes] of [['COMMIT_SHA', sdkSha], ['claude-multimodel.exe', 'TEST-cli'],
      ...Array.from({ length: 18 }, (_, index) => [`file-${index}.txt`, `TEST-content-${index}`])]) {
      await writeFile(path.join(base, name), bytes);
      files[name] = createHash('sha256').update(bytes).digest('hex');
    }
    const manifest = path.join(root, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ sdkSha, files }));
    let active = 0, maximum = 0, claimed = 0;
    let fail: Error | null = null;
    const verify = compileFunction(`let preproofStage;const preproofFacts={};
      const BUNDLED_MANIFEST_MAX_BYTES=33554432,BUNDLED_MANIFEST_MAX_ENTRIES=131072;
      ${compiled};return bundledRuntime;`, ['assert', 'path', 'lstat', 'realpath', 'readFile', 'createHash', 'createReadStream'])(
      assert, path, async (file: string) => {
        if (file !== manifest) { claimed++; if (fail && file.endsWith('COMMIT_SHA')) throw fail; }
        return lstat(file);
      }, realpath, readFile, createHash, (file: string) => {
        const stream = createReadStream(file);
        active++; maximum = Math.max(maximum, active);
        stream.once('close', () => { active--; });
        return stream;
      }
    ) as (executable: string, manifest: string) => Promise<{runtimeDigests: Record<string, string>}>;
    const result = await verify(executable, manifest);
    expect(result.runtimeDigests).toEqual(files);
    expect(Object.keys(result.runtimeDigests)).toEqual(Object.keys(files));
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    claimed = 0;
    fail = new Error('TEST-original-read-error');
    await expect(verify(executable, manifest)).rejects.toBe(fail);
    expect(claimed).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    fail = null;
    await writeFile(path.join(base, 'file-0.txt'), 'TAMPER');
    await expect(verify(executable, manifest)).rejects.toThrow('Bundled runtime byte mismatch');
    expect(active).toBe(0);
    await rm(path.join(base, 'file-0.txt'));
    await symlink(path.join(base, 'file-1.txt'), path.join(base, 'file-0.txt'));
    await expect(verify(executable, manifest)).rejects.toThrow();
    expect(active).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
