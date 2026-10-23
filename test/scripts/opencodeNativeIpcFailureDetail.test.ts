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
import { electronTeamPort, nativeCommandMatch } from '../../scripts/e2e/opencode-native-team-port';
import { serializedFunction } from '../../scripts/e2e/release-updater/serialized-function.mts';
import { parseSingleBridgeJsonResult, validateBridgeResultEnvelope } from '../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import { createOpenCodeBridgeClientIdentity, createOpenCodeBridgeHandshakeFailure, OPEN_CODE_HANDSHAKE_MESSAGE_FAMILIES } from '../../src/main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { formatOpenCodeStopCausalSuffix, projectOpenCodeStateChangingFailure, rememberOpenCodeHandshakeFailure } from '../../src/main/services/team/opencode/bridge/OpenCodeStateChangingCausalFailure';
import { redactLaunchFailureArtifactText } from '../../src/main/services/team/TeamLaunchFailureArtifactPack';

const project = (value: string): string =>
  runInNewContext(
    `${serializedFunction(safeIpcFailureDetail)}(${JSON.stringify(value)}, ${serializedFunction(redactLaunchFailureArtifactText)})`
  ) as string;

describe('serialized native IPC failure details', () => {
  it('retains closed snake_case native codes and keeps other long tokens opaque', () => {
    const detail = project(
      'runtime_not_ready: execution_containment_unqualified:private_owner_controller_teams:0 TEST_Opaque_Token_0123456789ABCDEF abcdef0123456789abcdef0123456789'
    );
    expect(detail).toBe(
      'runtime_not_ready: execution_containment_unqualified:private_owner_controller_teams:0 [opaque] [opaque]'
    );
    expect(project(detail)).toBe(detail);
  });
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

it.each([
  { version: '2.0.0', members: ['team-lead', 'alice'] },
  { version: '2.0.32', members: ['team-lead', 'alice', 'bob'] },
])('expired $version readiness still issues one original public Stop and retains its exact rejection', async ({ version, members }) => {
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
      members: members.map((memberId) => ({ memberId, originalSessionId: `ses_${memberId}` })) });
    await expect(verify(() => Promise.resolve({}), resolveProbe, buildPlan, owner, control, spyOn, root,
      'openrouter/TEST-model', version, (_phase: string, facts: Record<string, unknown>) => { reported.push(facts); },
      () => Promise.resolve(), (error: unknown) => { retained.push(error); })).rejects.toBe(primary);
    const readinessDeadline = returned.deadline - 30_000;
    expect(readiness).toEqual([readinessDeadline - 1_000_000]);
    // The expired readiness window never consumes the separate original Stop budget.
    expect(stops).toEqual([{ record: returned, request: { operation: 'stop' }, timeout: 30_000, at: readinessDeadline + 1 }]);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toBe(stopRejection);
    expect(reported.at(-1)).toMatchObject({ launchCalls: 1, ownerReturned: true, memberReady: false,
      memberCount: members.length, readyMemberCount: 0, stopConfirmed: false, cleanupUnknown: true });
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


it('current-only preflight never resolves or starts the floor pin and rejects unknown selections', async () => {
  const source = await readFile('scripts/e2e/opencode-native-windows-preflight.ts', 'utf8');
  const ast = ts.createSourceFile('preflight.ts', source, ts.ScriptTarget.Latest, true);
  const selection = ast.statements.filter((node) =>
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((value) => value.name.getText(ast) === 'versionSelection')) ||
    (ts.isExpressionStatement(node) && node.getText(ast).includes('Unknown Windows preflight version selection')));
  const start = ast.statements.findIndex((node) => node.getText(ast) === 'await preflight();');
  expect(selection).toHaveLength(2);
  expect(start).toBeGreaterThan(0);
  const compiled = ts.transpileModule([...selection, ...ast.statements.slice(start)]
    .map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  for (const mode of [undefined, 'all', 'v2', 'current', 'v1', 'unknown']) {
    const calls: unknown[][] = [], resolved: string[] = [];
    const argv = ['bun', 'preflight.ts', '/TEST-sdk', '/TEST-floor', '/TEST-current', 'openrouter/TEST-model', '/TEST-node'];
    if (mode !== undefined) argv.push(mode);
    const run = compileFunction(`return (async () => { ${compiled} })();`, ['process', 'assert', 'path', 'realpath', 'preflight']);
    const result = run({ argv }, assert, path.posix, async (file: string) => {
      if (mode === 'current') assert.notEqual(file, '/TEST-floor');
      resolved.push(file);
      return file;
    }, async (...args: unknown[]) => { calls.push(args); });
    if (mode === 'v1' || mode === 'unknown') {
      await expect(result).rejects.toThrow('Unknown Windows preflight version selection');
      expect(calls).toEqual([]);
      expect(resolved).toEqual([]);
    } else {
      await result;
      expect(calls).toEqual(mode === 'current'
        ? [[], ['/TEST-current', '2.0.32']]
        : [[], ['/TEST-floor', '2.0.0'], ['/TEST-current', '2.0.32']]);
      expect(resolved).toEqual(mode === 'current' ? ['/TEST-current'] : ['/TEST-floor', '/TEST-current']);
    }
  }
});

it.each([
  ['opencode-native-windows-preflight.ts', 'snapshotStartupFailure'],
  ['opencode-native-windows-full.ts', 'packagedStartupSnapshot'],
])('retains only closed catalog failure facts in the actual %s snapshot', async (file, functionName) => {
  const source = await readFile(path.join('scripts/e2e', file!), 'utf8');
  const ast = ts.createSourceFile(file!, source, ts.ScriptTarget.Latest, true);
  let catalogDeclaration = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'catalogFacts')
      catalogDeclaration = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(catalogDeclaration).not.toBe('');
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const helper = ts.transpileModule(`const ${catalogDeclaration};`, { compilerOptions }).outputText;
  const project = compileFunction(`${helper}\nreturn catalogFacts;`)() as (input: unknown) => unknown;
  const raw = { message: 'PRIVATE_MESSAGE', body: 'PRIVATE_BODY', path: '/PRIVATE_PATH', url: 'https://PRIVATE_URL' };
  for (const phase of ['client-setup', 'info', 'location', 'integration-ready']) {
    for (const reason of ['Transport', 'UnexpectedStatus', 'UnsupportedContentType', 'MalformedResponse', 'SseEventTooLarge']) {
      expect(project({ phase, client: { reason, status: 503, ...raw }, wireCode: 'http_failure', ...raw }))
        .toEqual({ phase, client: { reason, ...(reason === 'UnexpectedStatus' ? { status: 503 } : {}) }, wireCode: 'http_failure' });
    }
  }
  for (const wireCode of ['authority_mismatch', 'unqualified_version', 'deadline', 'disposed', 'capabilities_pending',
    'invalid_input', 'body_limit', 'invalid_response', 'session_missing', 'http_failure', 'media_type',
    'transport_failure', 'cleanup_unknown', 'frame_limit', 'incomplete_stream', 'authority_or_deadline', 'not_submitted'])
    expect(project({ phase: 'info', wireCode, wireStatus: 503 }))
      .toEqual({ phase: 'info', wireCode, ...(wireCode === 'http_failure' ? { wireStatus: 503 } : {}) });
  expect(project({ phase: 'info', wireStatus: 503 })).toEqual({ phase: 'info' });
  for (const wireStatus of [99, 600, 100.5, '503', NaN, Infinity, { ...raw }])
    expect(project({ phase: 'info', wireCode: 'http_failure', wireStatus, ...raw }))
      .toEqual({ phase: 'info', wireCode: 'http_failure' });
  for (const wireStatus of [100, 401, 500, 599])
    expect(project({ phase: 'info', wireCode: 'http_failure', wireStatus, client: { reason: 'Transport', status: wireStatus }, ...raw }))
      .toEqual({ phase: 'info', wireCode: 'http_failure', wireStatus, client: { reason: 'Transport' } });
  const catalog500 = { phase: 'location', wireCode: 'http_failure', wireStatus: 500 };
  const serverFailure = { operation: 'location', kind: 'Fail', tag: 'PlatformError', name: 'Error',
    module: 'FileSystem', method: 'readDirectory', reason: 'PermissionDenied', errno: 'EACCES', sqlCode: 'SQLITE_PERM' };
  expect(project({ ...catalog500, serverFailure: { ...serverFailure, ...raw, causes: [raw] }, ...raw }))
    .toEqual({ ...catalog500, serverFailure });
  for (const kind of ['Fail', 'Die', 'Interrupt', 'unknown'])
    expect(project({ ...catalog500, serverFailure: { operation: 'location', kind } }))
      .toEqual({ ...catalog500, serverFailure: { operation: 'location', kind } });
  const realpathFact = { status: 2, operation: 12, win32: 5, anchorCount: 2, matchingAnchorIndex: 1 };
  for (const realpath of [realpathFact,
    { status: 1, operation: 0, win32: 0, anchorCount: 0, matchingAnchorIndex: -1 },
    { status: 4, operation: 25, win32: 0xffffffff, anchorCount: 4096, matchingAnchorIndex: 4095 }])
    expect(project({ ...catalog500, serverFailure: { ...serverFailure, realpath: { ...realpath, ...raw } } }))
      .toEqual({ ...catalog500, serverFailure: { ...serverFailure, realpath } });
  const invalidRealpath = [null, [], {},
    ...[0, 5, '2', 1.5, NaN, Infinity].map(status => ({ ...realpathFact, status })),
    ...[-1, 26, '12'].map(operation => ({ ...realpathFact, operation })),
    ...[-1, 0x100000000, '5'].map(win32 => ({ ...realpathFact, win32 })),
    ...[-1, 4097, '2'].map(anchorCount => ({ ...realpathFact, anchorCount })),
    ...[-2, 2, '1'].map(matchingAnchorIndex => ({ ...realpathFact, matchingAnchorIndex })),
    { ...realpathFact, anchorCount: 0, matchingAnchorIndex: 0 }];
  for (const realpath of invalidRealpath)
    expect(project({ ...catalog500, serverFailure: { ...serverFailure, realpath } }))
      .toEqual({ ...catalog500, serverFailure });
  const serverEnums = {
    tag: ['PlatformError', 'AppProcessError', 'SqlError', 'SchemaError', 'FileSystem.DirectoryAccessDeniedError',
      'FileSystem.DirectoryNotFoundError', 'PluginModule.LoadError', 'Provider.LoadError'],
    name: ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'AggregateError', 'AbortError'],
    module: ['FileSystem', 'ChildProcess'],
    method: ['access', 'chmod', 'chown', 'copy', 'copyFile', 'glob', 'link', 'makeDirectory', 'readDirectory',
      'readFile', 'readLink', 'realPath', 'rename', 'stat', 'symlink', 'sync', 'truncate', 'utime', 'writeFile',
      'close', 'endStdin', 'identity', 'kill', 'outputLimit', 'readOutput', 'resolve', 'retire', 'spawn', 'status',
      'stdinAlreadyBound', 'unsupportedCommand', 'unsupportedDescriptor', 'unsupportedSignal', 'unsupportedUnref',
      'validateOutput', 'writeStdin'],
    reason: ['BadArgument', 'NotFound', 'PermissionDenied', 'AlreadyExists', 'BadResource', 'Busy', 'Unknown',
      'ConnectionError', 'AuthenticationError', 'AuthorizationError', 'SqlSyntaxError', 'UniqueViolation',
      'ConstraintError', 'DeadlockError', 'SerializationError', 'LockTimeoutError', 'StatementTimeoutError', 'UnknownError'],
    errno: ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'UNKNOWN', 'EIO', 'ENOSYS', 'EBUSY', 'EEXIST', 'ELOOP'],
    sqlCode: ['SQLITE_AUTH', 'SQLITE_PERM', 'SQLITE_CONSTRAINT', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CANTOPEN', 'SQLITE_CONSTRAINT_UNIQUE'],
  };
  for (const [key, allowed] of Object.entries(serverEnums)) {
    for (const value of allowed)
      expect(project({ ...catalog500, serverFailure: { operation: 'location', kind: 'Fail', [key]: value } }))
        .toEqual({ ...catalog500, serverFailure: { operation: 'location', kind: 'Fail', [key]: value } });
    for (const value of ['PRIVATE_VALUE', [], {}, 500])
      expect(project({ ...catalog500, serverFailure: { operation: 'location', kind: 'Fail', [key]: value } }))
        .toEqual({ ...catalog500, serverFailure: { operation: 'location', kind: 'Fail' } });
  }
  for (const invalid of [null, [], {}, { kind: 'Fail' }, { operation: 'location' },
    { operation: 'info', kind: 'Fail' }, { operation: 'location', kind: 'PRIVATE_KIND' }])
    expect(project({ ...catalog500, serverFailure: invalid })).toEqual(catalog500);
  for (const phase of ['client-setup', 'info', 'integration-ready'])
    expect(project({ ...catalog500, phase, serverFailure })).toEqual({ ...catalog500, phase });
  for (const wireCode of ['media_type', 'transport_failure'])
    expect(project({ ...catalog500, wireCode, serverFailure })).toEqual({ phase: 'location', wireCode });
  for (const wireStatus of [401, 499, 501, 599, undefined])
    expect(project({ ...catalog500, wireStatus, serverFailure }))
      .toEqual({ phase: 'location', wireCode: 'http_failure', ...(wireStatus === undefined ? {} : { wireStatus }) });
  for (const status of [99, 600, 100.5, '503', NaN, Infinity])
    expect(project({ phase: 'info', client: { reason: 'UnexpectedStatus', status } }))
      .toEqual({ phase: 'info', client: { reason: 'UnexpectedStatus' } });
  for (const status of [100, 599])
    expect(project({ phase: 'info', client: { reason: 'UnexpectedStatus', status } }))
      .toEqual({ phase: 'info', client: { reason: 'UnexpectedStatus', status } });
  expect(project({ phase: 'info', client: { reason: 'PRIVATE_REASON', status: 503 }, wireCode: 'PRIVATE_CODE', ...raw }))
    .toEqual({ phase: 'info' });
  for (const input of [null, [], { phase: 'PRIVATE_PHASE' }, { phase: ['info'] }]) expect(project(input)).toBeNull();
  let getterCalls = 0;
  const getter = () => { getterCalls++; throw new Error('PRIVATE_GETTER'); };
  expect(project(Object.defineProperty({}, 'phase', { get: getter }))).toBeNull();
  expect(project({ phase: 'info', client: Object.defineProperty({}, 'reason', { get: getter }) }))
    .toEqual({ phase: 'info' });
  expect(project(Object.defineProperty({ phase: 'info' }, 'wireCode', { get: getter })))
    .toEqual({ phase: 'info' });
  expect(project(Object.defineProperty({ phase: 'info', wireCode: 'http_failure' }, 'wireStatus', { get: getter })))
    .toEqual({ phase: 'info', wireCode: 'http_failure' });
  expect(project({ ...catalog500, serverFailure: Object.defineProperty({}, 'operation', { get: getter }) }))
    .toEqual(catalog500);
  expect(project({ ...catalog500, serverFailure: Object.defineProperty({ operation: 'location', kind: 'Fail' }, 'tag', { get: getter }) }))
    .toEqual({ ...catalog500, serverFailure: { operation: 'location', kind: 'Fail' } });
  expect(project({ ...catalog500, serverFailure: { ...serverFailure,
    realpath: Object.defineProperty({ ...realpathFact }, 'status', { get: getter }) } }))
    .toEqual({ ...catalog500, serverFailure });
  expect(project({ ...catalog500, serverFailure: { ...serverFailure,
    realpath: new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('PRIVATE_NESTED_PROXY'); } }) } }))
    .toEqual({ ...catalog500, serverFailure });
  expect(project(new Proxy({}, { getOwnPropertyDescriptor: getter }))).toBeNull();
  expect(getterCalls).toBe(1); // Only the proxy's metadata trap runs; property getters never run.

  const fs = await import('node:fs/promises');
  // The snapshot slices call module-level closed-fact helpers; collect those
  // declarations too so the compiled slice keeps the real script's scope.
  const helperNames = ['closedRawField', 'closedStderrCodes', 'closedStderrEvidence'];
  const helperDeclarations: string[] = [];
  const collectHelper = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && helperNames.includes(node.name.getText(ast)))
      helperDeclarations.push(`const ${node.getText(ast)};`);
    ts.forEachChild(node, collectHelper);
  };
  collectHelper(ast);
  const declarations = [
    ...helperDeclarations,
    ...ast.statements.filter(ts.isFunctionDeclaration)
      .filter(node => functionName === 'snapshotStartupFailure' || node.name?.text === functionName)
      .map(node => node.getText(ast)),
  ].join('\n');
  const compiled = ts.transpileModule(declarations, { compilerOptions }).outputText;
  const snapshot = compileFunction(`${compiled}\nreturn ${functionName};`,
    ['process', 'path', 'realpath', 'lstat', 'open', 'opendir', 'Buffer', 'assert'], {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    })(process, path, realpath, lstat, fs.open, fs.opendir, Buffer, assert) as (...args: unknown[]) => Promise<{ diagnostics: { catalog: unknown }[] }>;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-oc-catalog-')));
  const dataRoot = path.join(root, 'runtime-data');
  const previousRoot = process.env.CLAUDE_MULTIMODEL_DATA_HOME;
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = dataRoot;
  try {
    const directory = path.join(dataRoot, 'opencode/v2/runs', 'a'.repeat(32));
    const diagnostics = path.join(dataRoot, 'opencode/v2/provider-diagnostics');
    await mkdir(directory, { recursive: true });
    await mkdir(diagnostics);
    const binding = { teamId: `test-opencode-${randomUUID()}`, runId: randomUUID(), controllerInstanceId: randomUUID(), ownerId: randomUUID() };
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ binding, state: 'starting', members: [] }));
    await writeFile(path.join(diagnostics, `${randomUUID()}.json`), JSON.stringify({
      schemaVersion: 1, phase: 'execution-host-startup', category: 'run_control_foreign',
      catalog: { phase: 'location', client: { reason: 'UnexpectedStatus', status: 503, ...raw }, wireCode: 'http_failure', wireStatus: 500, serverFailure: { ...serverFailure, realpath: { ...realpathFact, ...raw }, ...raw }, ...raw },
    }));
    const packet = functionName === 'snapshotStartupFailure'
      ? await snapshot({ directory, binding }, 'TEST-session', {}, '/TEST-sdk', [])
      : await snapshot(root, dataRoot, binding.teamId, binding.runId);
    expect(packet.diagnostics).toHaveLength(1);
    expect(packet.diagnostics[0]!.catalog).toEqual({ phase: 'location', client: { reason: 'UnexpectedStatus', status: 503 }, wireCode: 'http_failure', wireStatus: 500, serverFailure: { ...serverFailure, realpath: realpathFact } });
    expect(JSON.stringify(packet)).not.toContain('PRIVATE_');
  } finally {
    if (previousRoot === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME;
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

async function preflightFunction(name: string) {
  const source = await readFile('scripts/e2e/opencode-native-windows-preflight.ts', 'utf8');
  const ast = ts.createSourceFile('preflight.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === name)!;
  const compiled = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return compileFunction(`${compiled}\nreturn ${name};`, ['process'], {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  })(process) as (...args: unknown[]) => Promise<unknown>;
}

it('fresh source CLI reaches only the original unqualified-owner guard and rejects earlier native failures', async () => {
  const verify = await preflightFunction('verifyFreshOriginalOwnerBoundary');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-oc-fresh-owner-')));
  const binding = { teamId: 'TEST-team', runId: 'TEST-run', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' };
  const sdkRoot = path.join(root, 'sdk'), projectPath = path.join(root, 'TEST-project');
  await Promise.all([mkdir(sdkRoot), mkdir(projectPath)]);
  const input = { sdk: sdkRoot, testRoot: root, projectPath, owner: { binding },
    plan: { binding, members: [{ profile: { selection: { model: { providerID: 'openrouter', id: 'TEST-model' } } } }] },
    selectedModel: 'openrouter/TEST-model', client: createOpenCodeBridgeClientIdentity({ appVersion: 'TEST' }), timeoutMs: 12_345 };
  const protocol = { parse: parseSingleBridgeJsonResult, validate: validateBridgeResultEnvelope, failure: createOpenCodeBridgeHandshakeFailure };
  let message = 'run_original_qualification_missing', mismatch = false, calls = 0;
  const run = async (executable: string, args: string[], options: Record<string, unknown>) => {
    calls++;
    expect(executable).toBe(process.execPath);
    expect(args.slice(1, 5)).toEqual(['runtime', 'opencode-command', '--json', '--input']);
    expect(options).toMatchObject({ cwd: sdkRoot, env: process.env, timeout: 37_345, maxBuffer: 65_536 });
    const request = JSON.parse(await readFile(args[5]!, 'utf8'));
    expect(request.command).toBe('opencode.handshake');
    expect(request.cwd).toBe(projectPath); // Original source host cwd remains SDK; envelope selects TEST project.
    expect(request.body).toMatchObject({ expectedRunId: binding.runId, teamId: binding.teamId,
      requiredCommand: 'opencode.sendMessage', expectedCapabilitySnapshotId: null, expectedManifestHighWatermark: null });
    expect(request.body).not.toHaveProperty('prompt');
    expect(request.body).not.toHaveProperty('qualification');
    expect((await lstat(args[5]!)).mode & 0o777).toBe(0o600);
    await writeFile(args[7]!, JSON.stringify({ schemaVersion: 1, requestId: mismatch ? 'TEST-other' : request.requestId,
      command: request.command, completedAt: new Date().toISOString(), durationMs: 0, diagnostics: [], ok: false, error: { kind: 'runtime_not_ready', retryable: false, message } }) + '\n', { flag: 'wx' });
  };
  try {
    await expect(verify(input, protocol, run)).resolves.toBe('qualification_guard_reached');
    message = 'execution_owner_not_private:private_acl_foreign_allow:0 @native:runStateRequest';
    try { await verify(input, protocol, run); throw new Error('TEST expected refusal'); }
    catch (error) { expect(projectOpenCodeStateChangingFailure(error)).toMatchObject({ phase: 'handshake',
      handshakeFailure: { kind: 'runtime_not_ready', sdkCode: 'execution_owner_not_private', nativeOperation: 'runStateRequest', nativeErrno: 0 } }); }
    mismatch = true;
    await expect(verify(input, protocol, run)).rejects.toThrow('TEST fresh owner response invalid');
    expect(calls).toBe(3); // Exactly one process per observation, never a retry.
    await expect(verify({ ...input, plan: { ...input.plan, qualification: {} } }, protocol, run)).rejects.toThrow('TEST fresh owner input invalid');
    const timeout = Object.assign(new Error('TEST timeout'), { killed: true });
    await expect(verify(input, protocol, () => Promise.reject(timeout))).rejects.toBe(timeout);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('retains only closed handshake facts through the owned suffix and serialized delivery snapshot', async () => {
  const error = createOpenCodeBridgeHandshakeFailure({ kind: 'runtime_not_ready', retryable: false,
    message: 'execution_owner_not_private:private_acl_foreign_allow:0 @native:runStateRequest' });
  const facts = projectOpenCodeStateChangingFailure(error);
  const diagnostic = 'opencode_message_delivery_exception: PRIVATE_URL_PATH_BODY' + formatOpenCodeStopCausalSuffix(facts);
  const safeProject = runInNewContext(`(${serializedFunction(projectIpcCausalFailure)})`) as typeof projectIpcCausalFailure;
  expect(safeProject(diagnostic)).toMatchObject({ phase: 'handshake', handshakeFailure: {
    kind: 'runtime_not_ready', sdkCode: 'execution_owner_not_private', nativeOperation: 'runStateRequest', nativeErrno: 0 } });
  const createPort = runInNewContext(`(${serializedFunction(electronTeamPort)})`) as typeof electronTeamPort;
  const api = { teams: { onProvisioningProgress: () => () => undefined,
    getOpenCodeRuntimeDeliveryStatus: async () => ({ diagnostics: [diagnostic] }),
    getData: async () => ({ tasks: [{ id: 'TEST-task' }], members: [] }),
    getTask: async () => ({ id: 'TEST-task', status: 'in_progress', owner: 'alice' }),
    getTaskLogStream: async () => ({ segments: [] }),
    getMessagesPage: async () => ({ messages: [{ to: 'alice', messageId: 'TEST-message',
      taskRefs: [{ taskId: 'TEST-task', teamName: 'test-opencode-handshake' }] }] }) } };
  const port = createPort(api as never, 'test-opencode-handshake', '/TEST-project', nativeCommandMatch, safeProject);
  const snapshot = await port.getOpenCodeRuntimeDeliveryStatus('TEST-message');
  expect(snapshot?.causalFailure).toMatchObject({ handshakeFailure: facts.handshakeFailure });
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_URL_PATH_BODY');
  await port.getData();
  const taskSnapshot = await port.getSafeTaskFailureSnapshot('TEST-task', 'alice');
  expect(taskSnapshot.deliveries).toEqual([expect.objectContaining({ causalFailure: snapshot?.causalFailure })]);
  expect(JSON.stringify(taskSnapshot)).not.toContain('PRIVATE_URL_PATH_BODY');
  for (const message of ['execution_owner_not_private:secret:4294967296 @native:runStateRequest',
    'unknown_secret_code @native:runStateRequest', 'execution_owner_not_private @native:unknownSecret',
    'prefix execution_owner_not_private @native:runStateRequest', 'C:/private/token body=secret']) {
    const packet = projectOpenCodeStateChangingFailure(createOpenCodeBridgeHandshakeFailure({ kind: 'runtime_not_ready', retryable: false, message }));
    expect(packet.handshakeFailure?.nativeOperation).toBeUndefined();
    expect(JSON.stringify(packet)).not.toMatch(/secret|private\/token|body=/);
  }
  const getter = vi.fn(() => { throw new Error('TEST foreign getter'); });
  const foreign = Object.defineProperty({ kind: 'runtime_not_ready' }, 'message', { get: getter });
  expect(() => createOpenCodeBridgeHandshakeFailure(foreign as never)).not.toThrow();
  expect(getter).not.toHaveBeenCalled();
  const trap = vi.fn(() => { throw new Error('TEST proxy trap'); });
  expect(() => createOpenCodeBridgeHandshakeFailure(new Proxy({}, { getOwnPropertyDescriptor: trap }) as never)).not.toThrow();
  expect(trap).not.toHaveBeenCalled();
  expect(safeProject({ phase: 'handshake', handshakeFailure: { kind: 'runtime_not_ready',
    sdkCode: 'UNKNOWN_PRIVATE', nativeOperation: 'runStateRequest', raw: 'PRIVATE' } })?.handshakeFailure)
    .toEqual({ kind: 'runtime_not_ready' });
});

it('carries closed lock facts of a held handshake lock into the serialized cause', () => {
  const error = createOpenCodeBridgeHandshakeFailure({ kind: 'provider_error', retryable: true,
    message: 'OpenCode lock operation failed [code=ELOCKED, lock=host-registry.json.lock]',
    details: { lockCode: 'ELOCKED', lockCategory: 'registry' } });
  const packet = projectOpenCodeStateChangingFailure(error);
  expect(packet.handshakeFailure).toMatchObject({ kind: 'provider_error',
    lockCode: 'ELOCKED', lockCategory: 'registry', messageShape: 'lock_operation' });
  const message = 'team_stop_unconfirmed:stop_failed' + formatOpenCodeStopCausalSuffix(packet);
  const safeProject = runInNewContext(`(${serializedFunction(projectIpcCausalFailure)})`) as typeof projectIpcCausalFailure;
  expect(safeProject(message)?.handshakeFailure).toMatchObject({ kind: 'provider_error',
    lockCode: 'ELOCKED', lockCategory: 'registry', messageShape: 'lock_operation' });
  expect(JSON.stringify(safeProject(message))).not.toContain('host-registry');
});

it('classifies deterministic handshake rejections into closed message families and digests', () => {
  const family = (text: string, details?: Record<string, unknown>) =>
    projectOpenCodeStateChangingFailure(
      createOpenCodeBridgeHandshakeFailure({
        kind: 'provider_error',
        retryable: true,
        message: text,
        ...(details ? { details } : {}),
      })
    ).handshakeFailure;
  expect(family('OpenCode confirmed stop authority mismatch')).toMatchObject({
    kind: 'provider_error',
    messageShape: 'unclassified',
    messageFamily: 'stop_authority_mismatch',
    messageDigest: /^[a-f0-9]{12}$/,
  });
  expect(family('OpenCode lifecycle selected lane authority is unavailable')?.messageFamily).toBe(
    'lane_authority_unavailable'
  );
  expect(
    family('OpenCode lifecycle stored run authority mismatch; another run is active')?.messageFamily
  ).toBe('run_authority_conflict');
  expect(
    family('OpenCode selected session runtime process changed (expected pid=1, actual pid=2)')
      ?.messageFamily
  ).toBe('runtime_process_changed');
  expect(
    family('OpenCode lock operation failed [code=ELOCKED, lock=host-registry.json.lock]', {
      lockCode: 'ELOCKED',
      lockCategory: 'registry',
    })?.messageFamily
  ).toBe('lock_operation');
  expect(family('fetch failed at TLS handshake')?.messageFamily).toBe('unclassified');
  const first = family('OpenCode lifecycle selected lane authority is unavailable');
  expect(family('OpenCode lifecycle selected lane authority is unavailable')?.messageDigest).toBe(
    first?.messageDigest
  );
  expect(
    family('OpenCode lifecycle selected run authority is unavailable')?.messageDigest
  ).not.toBe(first?.messageDigest);
  const packet = family('C:/private/token body=secret-value');
  expect(JSON.stringify(packet)).not.toMatch(/private|secret/);
  expect(packet).toMatchObject({ messageDigest: /^[a-f0-9]{12}$/ });
  const owned = projectOpenCodeStateChangingFailure(
    createOpenCodeBridgeHandshakeFailure({
      kind: 'provider_error',
      retryable: true,
      message: 'OpenCode confirmed stop authority mismatch',
    })
  );
  const message = 'team_stop_unconfirmed:stop_failed' + formatOpenCodeStopCausalSuffix(owned);
  const safeProject = runInNewContext(
    `(${serializedFunction(projectIpcCausalFailure)})`
  ) as typeof projectIpcCausalFailure;
  expect(safeProject(message)?.handshakeFailure).toMatchObject({
    kind: 'provider_error',
    messageFamily: 'stop_authority_mismatch',
    messageDigest: /^[a-f0-9]{12}$/,
  });
});

it('keeps every classified handshake family distinct and through the serialized e2e projection', () => {
  const safeProject = runInNewContext(
    `(${serializedFunction(projectIpcCausalFailure)})`
  ) as typeof projectIpcCausalFailure;
  const roundTrip = (text: string) =>
    safeProject(
      'team_stop_unconfirmed:stop_failed' +
        formatOpenCodeStopCausalSuffix(
          projectOpenCodeStateChangingFailure(
            createOpenCodeBridgeHandshakeFailure({
              kind: 'provider_error',
              retryable: true,
              message: text,
            })
          )
        )
    )?.handshakeFailure?.messageFamily;
  // An earlier catch-all prefix would shadow a later family; a family missing
  // from the e2e allowlist would silently vanish from the proof artifact.
  for (const [family, prefix] of OPEN_CODE_HANDSHAKE_MESSAGE_FAMILIES)
    expect([prefix, roundTrip(`${prefix} TEST-suffix`)]).toEqual([prefix, family]);
  expect(roundTrip('fetch failed at TLS handshake')).toBe('unclassified');
  expect(roundTrip('OpenCode lifecycle authority requires teamId and laneId')).toBe(
    'lifecycle_identifiers_required'
  );
  expect(roundTrip('OpenCode lifecycle authority requires runId')).toBe('run_identity_required');
});

it('drops a message family that is not a closed token even behind a widening cast', () => {
  const error = new Error('TEST handshake failure');
  rememberOpenCodeHandshakeFailure(error, {
    kind: 'provider_error',
    messageFamily: 'C:/private/token body=secret-value' as never,
  });
  const facts = projectOpenCodeStateChangingFailure(error).handshakeFailure;
  expect(facts).toEqual({ kind: 'provider_error' });
  expect(formatOpenCodeStopCausalSuffix(projectOpenCodeStateChangingFailure(error))).not.toMatch(
    /private|secret/
  );
});

it.each(['current-pass', 'current-fail', 'floor'] as const)(
  '%s preserves original Stop after readiness and the one fresh-owner observation', async (scenario) => {
    const source = await readFile('scripts/e2e/opencode-native-windows-preflight.ts', 'utf8');
    const ast = ts.createSourceFile('preflight.ts', source, ts.ScriptTarget.Latest, true);
    const declaration = ast.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'verifyProbePreparation')!;
    const compiled = ts.transpileModule(declaration.getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    // Model filesystem custody only in this unit: production DLL assertions run unchanged.
    const fakeFs = `export async function lstat(path) {
      if (path.endsWith('/opencode/v2')) throw Object.assign(new Error('TEST absent'),{code:'ENOENT'});
      return {isDirectory:()=>!path.endsWith('.dll'),isFile:()=>path.endsWith('.dll'),isSymbolicLink:()=>false,nlink:1,dev:1,ino:1};
    }
    export async function readdir(){return ['native-realpath-11111111-1111-1111-1111-111111111111'];}
    export async function open(){throw Object.assign(new Error('TEST locked'),{code:'EPERM'});}
    export async function rename(){throw Object.assign(new Error('TEST locked'),{code:'EPERM'});}`;
    const fsModule = await import('data:text/javascript,' + encodeURIComponent(fakeFs));
    const injected = compiled.replace("import('node:fs/promises')", 'Promise.resolve(fakeFs)');
    const verify = compileFunction(`${injected}\nreturn verifyProbePreparation;`, ['process', 'fakeFs'], {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    })({ env: { CLAUDE_MULTIMODEL_DATA_HOME: '/TEST-data' } }, fsModule) as (...args: unknown[]) => Promise<unknown>;
    const roster = scenario === 'floor' ? ['team-lead', 'alice'] : ['team-lead', 'alice', 'bob'];
    const teamId = 'TEST-execution-probe-' + 'a'.repeat(32);
    const binding = { teamId, runId: 'TEST-run', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' };
    const returned = { binding, deadline: Date.now() + 280_000 };
    const owner = { launchExplicitOpenCodeV2Run: (_plan: unknown): Promise<unknown> => Promise.resolve(returned) };
    const events: string[] = [], stops: unknown[] = [], reports: Record<string, unknown>[] = [];
    const primary = createOpenCodeBridgeHandshakeFailure({ kind: 'runtime_not_ready', retryable: false, message: 'run_control_config_identity' });
    const buildPlan = () => Promise.resolve({ binding, deadline: returned.deadline, members: roster.map(memberId => ({
      memberId, originalSessionId: 'ses_' + memberId, profile: { env: { TMPDIR: '/TEST-temp' } } })) });
    const control = { OPEN_CODE_V2_RUN_INITIALIZATION_MS: 120_000,
      awaitOpenCodeV2RunMemberReadiness: async (_owner: unknown, target: { memberId: string }) => {
        events.push(target.memberId); return { runtimePid: 100 + roster.indexOf(target.memberId) };
      },
      requestOpenCodeV2Run: async (record: unknown, request: unknown, timeout: number) => {
        stops.push({ record, request, timeout }); events.push('stop');
        return { kind: 'stop', state: 'stopped', ownerRetired: true, members: roster.map((memberId, index) => ({
          memberId, errors: [], cleanup: { scopeClosed: true, processRetired: true, descendantsRetired: true, pid: 100 + index } })) };
      } };
    const spyOn = (target: typeof owner, key: 'launchExplicitOpenCodeV2Run') => {
      const original = target[key]; return { mockImplementation: (fn: typeof original) => { target[key] = fn; },
        mockRestore: () => { target[key] = original; } };
    };
    const fresh = vi.fn(async (record: unknown, _plan: unknown, timeout: number) => {
      events.push('fresh'); expect(record).toBe(returned); expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(120_000); expect(timeout + 55_000).toBeLessThanOrEqual(returned.deadline - Date.now() + 10);
      if (scenario === 'current-fail') throw primary;
      return 'qualification_guard_reached';
    });
    const promise = verify(async () => ({}), () => owner.launchExplicitOpenCodeV2Run({ members: [{}],
      executionProbe: { memberId: 'probe', prepared: {} }, binding: { teamId }, deadline: returned.deadline }),
    buildPlan, owner, control, spyOn, '/TEST-project', 'openrouter/TEST-model', scenario === 'floor' ? '2.0.0' : '2.0.32',
    (_phase: string, facts: Record<string, unknown>) => reports.push(facts), async () => undefined, () => undefined, fresh);
    if (scenario === 'current-fail') await expect(promise).rejects.toBe(primary);
    else await expect(promise).resolves.toMatchObject({ physicalStopConfirmed: true, modelSubmissionAttempted: false,
      freshOriginalOwnerBoundary: scenario === 'floor' ? 'not_checked' : 'qualification_guard_reached' });
    expect(events).toEqual([...roster, ...(scenario === 'floor' ? [] : ['fresh']), 'stop']);
    expect(fresh).toHaveBeenCalledTimes(scenario === 'floor' ? 0 : 1);
    expect(stops).toEqual([{ record: returned, request: { operation: 'stop' }, timeout: 30_000 }]);
    expect(reports.at(-1)).toMatchObject({ stopConfirmed: true, cleanupUnknown: false });
  }
);

it('retains returned send failures as dispatch facts through serialized task and FULL proof round trips', async () => {
  const project = runInNewContext(`(${serializedFunction(projectIpcCausalFailure)})`) as typeof projectIpcCausalFailure;
  const diagnostic = 'error:runtime_not_ready: OpenCode message bridge failed: execution_owner_not_private:private_acl_foreign_allow:0 @native:runStateRequest';
  const projected = project(diagnostic);
  expect(projected).toMatchObject({ phase: 'dispatch', bridgeFailure: {
    kind: 'runtime_not_ready', sdkCode: 'execution_owner_not_private', nativeOperation: 'runStateRequest' } });
  expect(projected).not.toHaveProperty('handshakeFailure');
  const createPort = runInNewContext(`(${serializedFunction(electronTeamPort)})`) as typeof electronTeamPort;
  const teamName = 'test-opencode-returned';
  const api = { teams: { onProvisioningProgress: () => () => undefined,
    getOpenCodeRuntimeDeliveryStatus: async () => ({ diagnostics: [diagnostic], reason: diagnostic,
      attempted: true, accepted: false, responseState: 'not_observed', ledgerStatus: 'failed_terminal' }),
    getData: async () => ({ tasks: [{ id: 'TEST-task' }], members: [] }),
    getTask: async () => ({ id: 'TEST-task', status: 'in_progress', owner: 'alice' }),
    getTaskLogStream: async () => ({ segments: [] }),
    getMessagesPage: async () => ({ messages: [{ to: 'alice', messageId: 'TEST-message',
      taskRefs: [{ taskId: 'TEST-task', teamName }] }] }) } };
  const port = createPort(api as never, teamName, '/TEST-project', nativeCommandMatch, project);
  await port.getData();
  const task = await port.getSafeTaskFailureSnapshot('TEST-task', 'alice');
  const proof = JSON.parse(JSON.stringify({ taskFailureSnapshot: { unavailable: false, tasks: [task] } }));
  expect(proof.taskFailureSnapshot.tasks[0].deliveries[0]).toMatchObject({
    reasonCode: 'runtime_not_ready', responseState: 'not_observed', causalFailure: projected });
  expect(JSON.stringify(proof)).not.toContain('OpenCode message bridge failed');
  // FULL stores these already-sanitized task snapshots directly under the inferred port type.
  const full = await readFile('scripts/e2e/opencode-native-windows-full.ts', 'utf8');
  expect(full).toContain("app.call('getSafeTaskFailureSnapshot', id, owner, commandExpectations.get(id))");
  expect(full).toContain('proof.taskFailureSnapshot = { unavailable: false, tasks };');
  for (const value of [
    'error:runtime_not_ready: OpenCode message bridge failed: PRIVATE_TOKEN',
    'prefix ' + diagnostic, diagnostic + '\nPRIVATE_BODY', diagnostic + ' C:/PRIVATE_PATH',
    'error:runtime_not_ready: OpenCode message bridge failed: execution_owner_not_private:stage:4294967296',
    'error:PRIVATE_KIND: OpenCode message bridge failed: execution_owner_not_private',
    'error:runtime_not_ready: OpenCode message bridge failed: execution_owner_not_private @native:PRIVATE_UNKNOWN',
    'error:runtime_not_ready: OpenCode message bridge failed: ' + 'a'.repeat(1024),
  ]) expect(project(value)).toBeNull();
});

it.each(['valid', 'foreign-run', 'foreign-team', 'wrong-state', 'wrong-message', 'getter', 'rejected', 'event'] as const)(
  'observes retained Stop %s once without issuing actions or accepting another run', async (scenario) => {
    const teamName = 'test-opencode-retained', runId = 'TEST-original-run';
    let receive: ((event: unknown, value: unknown) => void) | undefined;
    const error = 'OpenCode team did not confirm stop: error:runtime_not_ready: OpenCode stop bridge failed: run_deadline_expired';
    const retained: Record<string, unknown> = { teamName, runId, state: 'failed',
      message: 'OpenCode team stop failed', error, path: 'PRIVATE_PATH', token: 'PRIVATE_TOKEN' };
    if (scenario === 'foreign-run') retained.runId = 'TEST-replacement';
    if (scenario === 'foreign-team') retained.teamName = 'test-opencode-other';
    if (scenario === 'wrong-state') retained.state = 'ready';
    if (scenario === 'wrong-message') retained.message = 'Other failure';
    const getter = vi.fn(() => { throw new Error('TEST getter'); });
    if (scenario === 'getter') Object.defineProperty(retained, 'error', { get: getter });
    const status = vi.fn(async () => {
      if (scenario === 'rejected') throw new Error('PRIVATE_FAILURE');
      return retained;
    });
    const stop = vi.fn(async () => undefined);
    const api = { config: { addCustomProjectPath: async () => undefined }, teams: {
      onProvisioningProgress: (callback: typeof receive) => { receive = callback; return () => undefined; },
      createTeam: async () => ({ runId }), getProvisioningStatus: status, stop,
    } };
    const createPort = runInNewContext(`(${serializedFunction(electronTeamPort)})`) as typeof electronTeamPort;
    const port = createPort(api as never, teamName, '/TEST-project', nativeCommandMatch);
    await port.createTeam({ teamName, cwd: '/TEST-project', providerId: 'opencode' } as never);
    if (scenario === 'event') receive!(undefined, retained);
    const snapshot = await port.getSafeStopFailure();
    expect(snapshot.observed).toBe(scenario === 'valid' || scenario === 'event' || scenario === 'getter');
    expect(status).toHaveBeenCalledTimes(scenario === 'event' ? 0 : 1);
    if (scenario !== 'event') expect(status).toHaveBeenCalledWith(runId);
    expect(stop).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    if (scenario === 'valid' || scenario === 'event') expect(snapshot).toMatchObject({
      diagnosticCodes: ['runtime_not_ready'], originalStopReasons: ['stop_not_confirmed'],
      bridgeFailure: 'reports_stop_failure_wrapper' });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_PATH|PRIVATE_TOKEN|PRIVATE_FAILURE|run_deadline_expired/);
  }
);

it('projects the exact additional source-owned send guards including case-sensitive field guards', () => {
  const project = runInNewContext(`(${serializedFunction(projectIpcCausalFailure)})`) as typeof projectIpcCausalFailure;
  const codes = ['cancelled', 'delivery_identity_conflict', 'delivery_journal_unknown', 'delivery_lock_foreign', 'delivery_root_invalid', 'delivery_submission_changed', 'execution_contract_invalid', 'invalid_file_part', 'invalid_model', 'invalid_operation', 'invalid_operation_deadline', 'missing_deliveryAttemptId', 'missing_laneId', 'missing_memberName', 'missing_messageId', 'missing_runId', 'missing_teamId', 'missing_text', 'original_input_conflict', 'original_input_unknown', 'permission_observation_unknown', 'run_already_owned', 'run_binding_conflict', 'run_operation_unknown', 'run_readiness_changed', 'run_readiness_unknown', 'run_source_unqualified', 'stop_original_target_changed', 'store_unknown', 'timeout', 'transcript_authority_conflict', 'unsupported_v1_input', 'visible_reply_conflict'];
  for (const sdkCode of codes) {
    expect(project('error:runtime_not_ready: OpenCode message bridge failed: ' + sdkCode))
      .toMatchObject({ phase: 'dispatch', bridgeFailure: { kind: 'runtime_not_ready', sdkCode } });
  }
  expect(project('error:runtime_not_ready: OpenCode message bridge failed: missing_deliveryattemptid')).toBeNull();
  expect(project('error:internal_error: OpenCode message bridge failed: delivery_lock_foreign')).toBeNull();
});

it('retains only exact existing V2 cleanup and member Stop codes from the same-run failure', async () => {
  const teamName = 'test-opencode-v2-stop', runId = 'TEST-original';
  const header = 'OpenCode team did not confirm stop: warning:opencode_v2_cleanup_unknown: Physical cleanup remains unverified; retained tombstones forbid send/relaunch.';
  let error = header + '; alice: tombstone_unknown; cancel_or_interrupt_unknown; readers_unknown; physical_cleanup_unknown; run_tombstone_unknown (no recorded host pid to verify)';
  const api = { config: { addCustomProjectPath: async () => undefined }, teams: {
    onProvisioningProgress: () => () => undefined, createTeam: async () => ({ runId }),
    getProvisioningStatus: async () => ({ runId, teamName, state: 'failed', message: 'OpenCode team stop failed', error }),
  } };
  const createPort = runInNewContext(`(${serializedFunction(electronTeamPort)})`) as typeof electronTeamPort;
  const port = createPort(api as never, teamName, '/TEST-project', nativeCommandMatch);
  await port.createTeam({ teamName, cwd: '/TEST-project', providerId: 'opencode' } as never);
  expect((await port.getSafeStopFailure()).diagnosticCodes).toEqual(['opencode_v2_cleanup_unknown',
    'tombstone_unknown', 'cancel_or_interrupt_unknown', 'readers_unknown', 'physical_cleanup_unknown', 'run_tombstone_unknown']);
  error = header + '; team-lead: stop unconfirmed; bob: physical_cleanup_unknown (host process still alive: pid 123, 456)';
  expect((await port.getSafeStopFailure()).diagnosticCodes).toEqual(['opencode_v2_cleanup_unknown', 'physical_cleanup_unknown']);
  for (const foreign of ['PRIVATE prefix ' + header, header + '; alice: PRIVATE_UNKNOWN',
    header + '; PRIVATE_ACTOR: physical_cleanup_unknown', header + ' PRIVATE_TOKEN']) {
    error = foreign;
    const snapshot = await port.getSafeStopFailure();
    expect(snapshot.diagnosticCodes).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_|123|456/);
  }
});
