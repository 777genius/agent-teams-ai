import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileFunction, constants, runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

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
      launches: unknown[],
      statuses?: unknown[]
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
      const profileRoot = path.join(root, 'opencode/v2/profiles', 'a'.repeat(16) + '-' + randomUUID());
      const stdioRoot = path.join(profileRoot, '.opencode-v2-execution-owner', 'native-stdio-' + randomUUID());
      await mkdir(stdioRoot, { recursive: true });
      await writeFile(path.join(stdioRoot, 'main.stderr'), [
        'error: Cannot read file "C:\\TEST-sdk\\": EPERM',
        'error: Cannot find module "@opencode/client-v2-floor" from "C:\\TEST-private\\entry.ts"',
        JSON.stringify({ event: 'opencode-v2-startup', stage: 'runtime-import',
          cause: 'execution_graph_dependency_missing', reason: 'failed', errno: 'ENOENT',
          operation: 'open', errorName: 'Error', elapsedMs: 123 }),
      ].join('\n'));
      const stdioPacket = await snapshot({ directory, binding }, 'TEST-session', {
        members: [{ originalSessionId: 'TEST-session', profile: { root: profileRoot } }],
      }, 'C:\\TEST-sdk', []) as unknown as { stdio: {
        kind: string; errorKinds: string[]; errorLine: string; moduleTargetRole: string;
        readTargetKind?: string; childStartup: { stage: string; cause: string };
      } };
      expect(stdioPacket.stdio).toMatchObject({ kind: 'module_resolution',
        errorKinds: ['access_denied', 'module_resolution'], moduleTargetRole: '@opencode/client-v2-floor',
        childStartup: { stage: 'runtime-import', cause: 'execution_graph_dependency_missing' } });
      expect(stdioPacket.stdio.readTargetKind).toBeUndefined();
      expect(stdioPacket.stdio.errorLine).toContain('Cannot find module');
      expect(stdioPacket.stdio.errorLine.length).toBeLessThanOrEqual(256);
      expect(stdioPacket.stdio.errorKinds.length).toBeLessThanOrEqual(9);
      expect(JSON.stringify(stdioPacket.stdio)).not.toMatch(/TEST-private|TEST-sdk|entry\.ts/);

      // Execute the actual passive observer and project its private captures through
      // the actual snapshot. No new status request or product authority is invented.
      const statuses: unknown[] = [];
      let reply: unknown;
      let forwarded = 0;
      const module = { createWindowsNativeBroker: () => ({ request: async () => { forwarded += 1; return reply; } }) };
      const observed = compileFunction(`${compiled}
        const spyOn = (target, key) => ({ mockImplementation(fn) { target[key] = fn; }, mockRestore() {} });
        observeNativeBrokerFailures(module, spyOn, new WeakMap(), [], statuses);
        return module.createWindowsNativeBroker(null);`, ['module', 'statuses'])(module, statuses) as {
          request(operation: string, input: unknown): Promise<unknown>;
        };
      const nonce = 'b'.repeat(64), endpoint = 'c'.repeat(64);
      const member = { memberId: 'TEST-member', laneId: 'TEST-lane', originalSessionId: 'TEST-session',
        opencodeSessionId: 'TEST-session', runtimeSessionId: 'TEST-session', profileEpoch: 'TEST-epoch',
        profileRoot, pin: '2.0.21', state: 'unknown', bootstrap: null,
        initialization: { phase: 'bootstrap-before-log', elapsedMs: 123 },
        secret: 'EPRIVATE_TOKEN', selectedModel: 'PRIVATE_MODEL' };
      const input = { endpointHash: endpoint, payload: { protocol: 1, nonce, endpoint, binding, request: { operation: 'status' } } };
      const statusReply = (members: unknown[], responseNonce = nonce) => ({ response: {
        nonce: responseNonce, endpoint, result: { kind: 'status', state: 'starting', members },
      } });
      reply = statusReply([member], 'd'.repeat(64));
      expect(await observed.request('runStateRequest', input)).toBe(reply);
      expect(statuses).toHaveLength(0);
      reply = statusReply([member]);
      expect(await observed.request('runStateRequest', input)).toBe(reply);
      expect(forwarded).toBe(2);
      const livePlan = { members: [{ memberId: member.memberId, laneId: member.laneId,
        originalSessionId: 'TEST-session', profile: { root: profileRoot, epoch: member.profileEpoch }, native: { version: member.pin } }] };
      const liveSnapshot = async (plan = livePlan) => await snapshot({ directory, binding }, 'TEST-session', plan, 'C:\\TEST-sdk', [], statuses) as unknown as {
        liveStatus: { observation: string; initialization: unknown; firstObservedAcceptedElapsedMs: number | null; bootstrapVerified: boolean };
      };
      expect((await liveSnapshot()).liveStatus).toMatchObject({ observation: 'existing_status_response',
        initialization: { phase: 'bootstrap-before-log', elapsedMs: 123 }, bootstrapVerified: false, firstObservedAcceptedElapsedMs: null });
      reply = statusReply([{ ...member, state: 'accepted', bootstrap: null }]);
      await observed.request('runStateRequest', input);
      const accepted = (await liveSnapshot()).liveStatus.firstObservedAcceptedElapsedMs;
      expect(accepted).toBeGreaterThanOrEqual(0);
      expect((await liveSnapshot()).liveStatus.bootstrapVerified).toBe(false);
      const lastStarting = (await liveSnapshot()).liveStatus as unknown as { lastStartingInitialization: { phase: string; elapsedMs: number; observedElapsedMs: number } };
      expect(lastStarting.lastStartingInitialization).toMatchObject({ phase: 'bootstrap-before-log', elapsedMs: 123 });
      for (const state of ['stopping', 'active']) {
        reply = statusReply([{ ...member, state: 'accepted', initialization: undefined }]);
        (reply as { response: { result: { state: string } } }).response.result.state = state;
        await observed.request('runStateRequest', input);
        const packet = (await liveSnapshot()).liveStatus as unknown as { state: string; initialization: unknown; observedElapsedMs: number; lastStartingInitialization: unknown };
        expect(packet).toMatchObject({ state, initialization: null, lastStartingInitialization: lastStarting.lastStartingInitialization });
        expect(packet.observedElapsedMs).toBeGreaterThanOrEqual(lastStarting.lastStartingInitialization.observedElapsedMs);
      }
      reply = statusReply([{ ...member, state: 'accepted', bootstrap: { verified: true, missingNativeMessageID: true }, initialization: { phase: 'EPRIVATE_TOKEN', elapsedMs: 86400001 } }]);
      await observed.request('runStateRequest', input);
      expect((await liveSnapshot()).liveStatus).toMatchObject({ initialization: null, firstObservedAcceptedElapsedMs: accepted });
      expect((await liveSnapshot({ members: [{ ...livePlan.members[0]!, profile: { root: 'FOREIGN', epoch: member.profileEpoch } }] })).liveStatus.observation).toBe('unavailable');
      reply = statusReply([0, 1, 2].map(index => ({ ...member, memberId: `TEST-extra-${index}` })));
      await observed.request('runStateRequest', input);
      expect(statuses).toHaveLength(3);
      reply = { get response() { throw new Error('PRIVATE_GETTER'); } };
      expect(await observed.request('runStateRequest', input)).toBe(reply);
      expect(forwarded).toBe(8);
      expect(JSON.stringify((await liveSnapshot()).liveStatus)).not.toMatch(/PRIVATE|TEST-session|TEST-member|TEST-lane|TEST-epoch|profileRoot|nonce|endpoint/);

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
      const initialization = { phase: 'MCP-connect', elapsedMs: 30_041, ownerElapsedMs: 150,
        history: [{ phase: 'bootstrap-before-log', elapsedMs: 9 }, { phase: 'MCP-connect', elapsedMs: 40 }],
        commands: { starts: 1, firstFailedOperation: 'commandRead',
          operations: [{ operation: 'commandStart', requests: 2, failures: 0, replyFailures: 0, maxLatencyMs: 7, pending: 1,
            oldestPendingAgeMs: 107, oldestPendingStage: 'native' }, { operation: 'commandRead', requests: 3, failures: 1,
            replyFailures: 1, maxLatencyMs: 7, pending: 0, oldestPendingAgeMs: null, oldestPendingStage: null }],
          commands: [{ startOffsetMs: -5, startLatencyMs: 7, stdin: 'pipe', stdinBytes: 120, stdoutBytes: 0, stderrBytes: 42,
            stdoutEof: false, stderrEof: false, running: true, exitCode: null, failedOperation: 'commandRead' }] } };
      const owner = async (value: unknown) => {
        await writeFile(diagnostic, JSON.stringify({ schemaVersion: 1, phase: 'run-owner-initialization',
          category: 'invalid_response', initialization: value }));
        return (await snapshot({ directory, binding }, 'TEST-session', {}, '/TEST-sdk', [])).diagnostics[0] as unknown as Record<string, unknown>;
      };
      expect(await owner(initialization)).toMatchObject({ phase: 'run-owner-initialization', initializationPhase: 'MCP-connect',
        initializationElapsedMs: 30_041, initializationOwnerElapsedMs: 150, initializationHistory: initialization.history,
        initializationCommands: initialization.commands });
      expect(await owner({ phase: 'bootstrap-after-log', elapsedMs: 1 })).toMatchObject({ initializationPhase: 'bootstrap-after-log',
        initializationElapsedMs: 1, initializationOwnerElapsedMs: null, initializationHistory: [], initializationCommands: null });
      const hostile = await owner({ ...initialization, phase: 'PRIVATE-TEST-phase', ownerElapsedMs: -1,
        history: [initialization.history[1], initialization.history[0]],
        commands: { ...initialization.commands, operations: [{ ...initialization.commands.operations[0], oldestPendingStage: 'PRIVATE-TEST-stage', pending: -1 }],
          commands: [{ ...initialization.commands.commands[0], stdin: 'PRIVATE-TEST-stdin', failedOperation: 'PRIVATE-TEST-operation', stdoutBytes: -1 }] } });
      expect(hostile).toMatchObject({ initializationPhase: 'unclassified', initializationOwnerElapsedMs: null, initializationHistory: [],
        initializationCommands: { operations: [{ oldestPendingStage: 'unclassified', pending: null }],
          commands: [{ stdin: 'unclassified', failedOperation: 'unclassified', stdoutBytes: null }] } });
      expect(await owner({ ...initialization, commands: { ...initialization.commands, raw: 'PRIVATE-TEST-raw' } }))
        .toMatchObject({ initializationPhase: 'MCP-connect', initializationCommands: null });
      expect(JSON.stringify(hostile)).not.toContain('PRIVATE-TEST');
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

it('expired readiness still issues one original public Stop and retains its exact rejection', async () => {
  const source = await readFile('scripts/e2e/opencode-native-windows-preflight.ts', 'utf8');
  const ast = ts.createSourceFile('preflight.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.filter(ts.isFunctionDeclaration)
    .find((node) => node.name?.text === 'verifyProbePreparation')!;
  const compiled = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const verify = compileFunction(`${compiled}\nreturn verifyProbePreparation;`, ['process'], {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  })(process) as (...args: unknown[]) => Promise<unknown>;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-expired-readiness-stop-')));
  const previousRoot = process.env.CLAUDE_MULTIMODEL_DATA_HOME;
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root;
  let now = 1_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const teamId = `TEST-execution-probe-${'a'.repeat(32)}`;
    const binding = { teamId, runId: 'TEST-run', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' };
    const returned = { binding, deadline: now + 290_000 };
    const owner: { launchExplicitOpenCodeV2Run: (plan: unknown) => Promise<unknown> } = {
      launchExplicitOpenCodeV2Run: () => Promise.resolve(returned),
    };
    const readiness: number[] = [], stops: { record: unknown; request: unknown; timeout: number; at: number }[] = [];
    const reported: Record<string, unknown>[] = [], retained: unknown[] = [];
    const primary = new Error('run_deadline_expired');
    const stopRejection = Object.assign(new Error('execution_native_unknown'), { nativeOperation: 'runStateRequest' });
    const control = {
      OPEN_CODE_V2_RUN_INITIALIZATION_MS: 300_000,
      awaitOpenCodeV2RunMemberReadiness: (_record: unknown, _target: unknown, timeout: number) => {
        readiness.push(timeout); now += timeout + 1; return Promise.reject(primary);
      },
      requestOpenCodeV2Run: (record: unknown, request: unknown, timeout: number) => {
        stops.push({ record, request, timeout, at: now }); return Promise.reject(stopRejection);
      },
    };
    const spyOn = (target: typeof owner, key: 'launchExplicitOpenCodeV2Run') => {
      const original = target[key];
      return { mockImplementation: (fn: typeof original) => { target[key] = fn; },
        mockRestore: () => { target[key] = original; } };
    };
    const resolveProbe = () => owner.launchExplicitOpenCodeV2Run({ members: [{}], deadline: now + 295_000,
      executionProbe: { memberId: 'probe', prepared: {} }, binding: { teamId } });
    const buildPlan = () => Promise.resolve({ binding, deadline: now + 290_000,
      members: ['team-lead', 'alice'].map((memberId) => ({ memberId, originalSessionId: `ses_${memberId}` })) });
    await expect(verify(() => Promise.resolve({}), resolveProbe, buildPlan, owner, control, spyOn, root,
      'openrouter/TEST-model', '2.0.0', (_phase: string, facts: Record<string, unknown>) => { reported.push(facts); },
      () => Promise.resolve(), (error: unknown) => { retained.push(error); })).rejects.toBe(primary);
    const readinessDeadline = returned.deadline - 30_000;
    expect(readiness).toEqual([readinessDeadline - 1_000_000]);
    // The expired readiness window never consumes the separate original Stop budget.
    expect(stops).toEqual([{ record: returned, request: { operation: 'stop' }, timeout: 30_000, at: readinessDeadline + 1 }]);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toBe(stopRejection);
    expect(reported.at(-1)).toMatchObject({ launchCalls: 1, ownerReturned: true, memberReady: false,
      readyMemberCount: 0, stopConfirmed: false, cleanupUnknown: true });
  } finally {
    clock.mockRestore();
    if (previousRoot === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME;
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

it('native broker trace keeps closed exchange facts, helper exit and broker liveness at Stop entry', async () => {
  const source = await readFile('scripts/e2e/opencode-native-windows-preflight.ts', 'utf8');
  const ast = ts.createSourceFile('preflight.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.filter(ts.isFunctionDeclaration)
    .find((node) => node.name?.text === 'observeNativeBrokerFailures')!;
  const compiled = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const { EventEmitter } = await import('node:events');
  const events = new EventEmitter();
  let ended = false;
  const reply = { value: 'PRIVATE_REPLY' };
  const timeout = new Error('execution_native_timeout'), unknown = new Error('execution_native_unknown');
  const broker = {
    events, ended: () => ended,
    request: (...args: [operation: string, input?: unknown, deadline?: number]): Promise<unknown> => {
      const [operation] = args;
      if (operation === 'runStateReadStop') throw unknown;
      return operation === 'runStateProcessIdentity' ? Promise.reject(timeout) : Promise.resolve(reply);
    },
  };
  const module = { createWindowsNativeBroker: () => broker };
  const failures = new WeakMap<object, string>(), trace: Record<string, unknown>[] = [];
  const observed = compileFunction(`${compiled}
    const spyOn = (target, key) => ({ mockImplementation(fn) { target[key] = fn; }, mockRestore() {} });
    observeNativeBrokerFailures(module, spyOn, failures, [], [], trace);
    return module.createWindowsNativeBroker(null);`, ['module', 'failures', 'trace'])(module, failures, trace) as typeof broker;
  const deadline = Date.now() + 5_000;
  expect(await observed.request('runStateValidateEndpoint', { endpointHash: 'PRIVATE_HASH' }, deadline)).toBe(reply);
  await expect(observed.request('runStateProcessIdentity', { pid: 1 }, deadline)).rejects.toBe(timeout);
  ended = true;
  events.emit('close', 0);
  // The real broker rejects an ended helper synchronously, before any promise exists.
  expect(() => observed.request('runStateReadStop', { endpointHash: 'PRIVATE_HASH' }, deadline + 25_000)).toThrow(unknown);
  expect(failures.get(unknown)).toBe('runStateReadStop');
  expect(trace.map(({ kind, operation, outcome, sync, endedAtCall, exitCode }) =>
    ({ kind, operation, outcome, sync, endedAtCall, exitCode }))).toEqual([
    { kind: 'request', operation: 'runStateValidateEndpoint', outcome: 'ok', sync: false, endedAtCall: false, exitCode: undefined },
    { kind: 'request', operation: 'runStateProcessIdentity', outcome: 'execution_native_timeout', sync: false, endedAtCall: false, exitCode: undefined },
    { kind: 'helper_close', operation: undefined, outcome: undefined, sync: undefined, endedAtCall: undefined, exitCode: 0 },
    { kind: 'request', operation: 'runStateReadStop', outcome: 'execution_native_unknown', sync: true, endedAtCall: true, exitCode: undefined },
  ]);
  expect(trace.at(-1)!.budgetMs).toBeGreaterThan(29_000);
  expect(trace.at(-1)!.budgetMs).toBeLessThanOrEqual(30_000);
  for (let index = 0; index < 30; index++) await observed.request('runStateValidateEndpoint', {}, deadline);
  expect(trace).toHaveLength(24);
  expect(JSON.stringify(trace)).not.toMatch(/PRIVATE/);
});
