/** No Electron package, real credentials, model calls or tasks: exact desktop TEST setup -> SDK discovery. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyOpenCodeRuntimeBinaryEnv } from '../../src/main/services/runtime/openCodeRuntimeBinaryEnv';
import { prepareNativeDesktopEnvironment } from './opencode-native-desktop-environment';
import { protectWindowsTestDirectory } from './opencode-native-test-auth';

type ReadinessExecutor = (
  input: unknown,
  executeV1: (input: unknown) => Promise<unknown>
) => Promise<unknown>;

function safeSourceGateFailure(error: unknown): { reason: string; errno: string | null } {
  const row = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message = typeof row.message === 'string' ? row.message : '';
  const localReasons: Record<string, string> = {
    'TEST readiness response invalid': 'readiness_response_invalid',
    'TEST model-free readiness refused': 'model_free_readiness_refused',
    'TEST model-free readiness contract changed': 'model_free_readiness_contract_changed',
    'TEST selected controller invalid': 'selected_controller_invalid',
    'TEST selected controller state invalid': 'selected_controller_state_invalid',
    'TEST selected controller root differs from desktop context':
      'selected_controller_root_changed',
    'TEST startup cleanup did not complete': 'startup_cleanup_incomplete',
    'TEST startup cleanup did not drain its empty registry': 'startup_cleanup_not_drained',
    'TEST unexpected run owner': 'unexpected_run_owner',
    'TEST probe preparation plan invalid': 'probe_preparation_plan_invalid',
    'TEST probe launch boundary not reached': 'probe_launch_boundary_not_reached',
    'TEST probe launch boundary count invalid': 'probe_launch_boundary_count_invalid',
    'TEST cold namespace exists': 'TESTcold_namespace_exists',
  };
  // Only bounded machine tokens or fixed local labels cross the diagnostic boundary.
  const reason =
    message.length <= 120 &&
    message === message.trim() &&
    /^[a-z][a-z0-9_]*(?::[a-z0-9_]+){0,3}$/.test(message)
      ? message
      : Object.hasOwn(localReasons, message)
        ? localReasons[message]!
        : 'unclassified';
  const errnos = [
    'ENOENT',
    'EACCES',
    'EPERM',
    'EEXIST',
    'ENOTDIR',
    'ELOOP',
    'ETIMEDOUT',
    'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  ];
  return { reason, errno: errnos.find((value) => value === row.code) ?? null };
}

// Serialized after TypeScript transpilation; no ambient closure or credentials.
async function verifyModelFreeReadiness(
  execute: ReadinessExecutor,
  executeV1: (input: unknown) => Promise<unknown>,
  projectPath: string,
  expectedVersion: string
) {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('TEST readiness response invalid');
    return value as Record<string, unknown>;
  };
  const readiness = record(
    await execute(
      {
        schemaVersion: 1,
        requestId: 'TEST-source-readiness',
        command: 'opencode.readiness',
        cwd: projectPath,
        startedAt: new Date().toISOString(),
        timeoutMs: 120_000,
        body: { selectedModel: 'openrouter/TEST-model', requireExecutionProbe: false },
      },
      executeV1
    )
  );
  if (readiness.ok !== true) {
    const error = record(readiness.error);
    throw new Error(
      typeof error.message === 'string' ? error.message : 'TEST model-free readiness refused'
    );
  }
  const data = record(readiness.data),
    availability = record(data.sourceAvailability);
  if (
    data.opencodeVersion !== expectedVersion ||
    data.state !== 'model_unavailable' ||
    data.launchAllowed !== false ||
    data.executionProof !== null ||
    availability.sourceOnly !== true ||
    typeof availability.installedGraphFiles !== 'number' ||
    availability.installedGraphFiles <= 0
  )
    throw new Error('TEST model-free readiness contract changed');
}

// Only the final owner-launch boundary is replaced. Store, native filesystem,
// selected auth/controller and complete member-plan preparation stay genuine.
async function verifyProbePreparation(
  inspect: (input: unknown) => Promise<unknown>,
  resolveProbe: (input: unknown, selection: unknown, run: boolean,
    options: { unattendedTeam: boolean }) => Promise<unknown>,
  owner: { launchExplicitOpenCodeV2Run: (plan: unknown) => Promise<unknown> },
  spyOn: (target: typeof owner, key: 'launchExplicitOpenCodeV2Run') => {
    mockImplementation(fn: (plan: unknown) => Promise<never>): void;
    mockRestore(): void;
  },
  projectPath: string
) {
  const envelope = {
    schemaVersion: 1, requestId: 'TEST-source-probe-preparation',
    command: 'opencode.readiness', cwd: projectPath,
    startedAt: new Date().toISOString(), timeoutMs: 120_000,
    body: { selectedModel: 'openrouter/TEST-model', requireExecutionProbe: true },
  };
  const selection = await inspect(envelope);
  const { lstat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dataRoot = process.env.CLAUDE_MULTIMODEL_DATA_HOME;
  if (!dataRoot) throw new Error('TEST cold namespace exists');
  const existing = await lstat(join(dataRoot, 'opencode', 'v2')).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (existing) throw new Error('TEST cold namespace exists');
  const sentinel = new Error('TEST probe preparation reached launch boundary');
  let boundaryCalls = 0;
  let preparedPlan: unknown;
  const boundary = spyOn(owner, 'launchExplicitOpenCodeV2Run');
  try {
    boundary.mockImplementation(async (value) => {
      boundaryCalls++;
      const plan = value as { members?: { memberId?: string }[];
        executionProbe?: { memberId?: string; prepared?: unknown } };
      if (boundaryCalls !== 1 || plan.members?.length !== 1 ||
          plan.members[0]?.memberId !== 'probe' ||
          plan.executionProbe?.memberId !== 'probe' || !plan.executionProbe.prepared)
        throw new Error('TEST probe preparation plan invalid');
      preparedPlan = value;
      // Never invoke the original: no run owner/server/session/model can start.
      throw sentinel;
    });
    let caught: unknown;
    try { await resolveProbe(envelope, selection, true, { unattendedTeam: true }); }
    catch (error) { caught = error; }
    if (caught !== sentinel) throw caught ?? new Error('TEST probe launch boundary not reached');
    if (boundaryCalls !== 1) throw new Error('TEST probe launch boundary count invalid');
    return { preparationOnly: true, interceptedOwnerLaunches: boundaryCalls, plan: preparedPlan };
  } finally { boundary.mockRestore(); }
}

async function reservePreparedProbe(
  value: unknown,
  reserve: (dataRoot: string, binding: Record<string, string>, sourceHash: string,
    profiles: unknown[]) => Promise<string>,
  hash: (files: { path: string; sha256: string }[]) => string
) {
  const prepared = value as { preparationOnly?: boolean; interceptedOwnerLaunches?: number;
    plan?: { dataRoot?: string; binding?: Record<string, string>;
      source?: { files?: { path: string; sha256: string }[] };
      members?: { profile?: unknown }[] } };
  const plan = prepared?.plan;
  if (prepared?.preparationOnly !== true || prepared.interceptedOwnerLaunches !== 1 ||
      !plan || typeof plan.dataRoot !== 'string' || !plan.binding ||
      !Array.isArray(plan.source?.files) || !Array.isArray(plan.members) ||
      plan.members.length !== 1 || !plan.members[0]?.profile)
    throw new Error('TEST probe preparation plan invalid');
  await reserve(plan.dataRoot, plan.binding, hash(plan.source.files),
    plan.members.map((member) => member.profile));
  // A retained TEST start fence only; subprocess exit supplies broker stdio EOF.
  // No owner launch, execution proof or measured physical-retirement claim.
  return { preparationOnly: true, interceptedOwnerLaunches: 1, runControlReservedOnly: true };
}

async function verifySelectedControllerRoot(
  inspect: (input: unknown) => Promise<unknown>,
  projectPath: string,
  expectedClaudeRoot: string
) {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('TEST selected controller invalid');
    return value as Record<string, unknown>;
  };
  const selection = record(
    await inspect({
      schemaVersion: 1,
      requestId: 'TEST-source-controller',
      command: 'opencode.readiness',
      cwd: projectPath,
      startedAt: new Date().toISOString(),
      timeoutMs: 120_000,
      body: { selectedModel: 'openrouter/TEST-model' },
    })
  );
  const controller = record(selection.controller);
  const localClaude =
    controller.type === 'local'
      ? record(controller.environment).AGENT_TEAMS_MCP_CLAUDE_DIR
      : undefined;
  if (controller.type !== 'local' || localClaude !== expectedClaudeRoot)
    throw new Error('TEST selected controller root differs from desktop context');
  if (typeof localClaude === 'string') {
    const { lstat, realpath } = await import('node:fs/promises');
    const stat = await lstat(localClaude);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(localClaude)) !== localClaude
    )
      throw new Error('TEST selected controller state invalid');
  }
}

assert.equal(process.platform, 'win32');
assert.equal(process.versions.bun, '1.3.11');
assert.equal(process.argv.length, 5);
const sdk = await realpath(path.resolve(process.argv[2]!));
const resourcesPath = await realpath(path.resolve('resources'));
// The desktop's real wrapper must be present so this gate exercises its binary projection.
await realpath(path.join(resourcesPath, 'runtime', 'opencode-console', 'opencode.exe'));
async function preflight(binary?: string, expectedVersion?: '2.0.0' | '2.0.21') {
  const desktop = await prepareNativeDesktopEnvironment();
  if (binary) {
    desktop.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = binary;
    applyOpenCodeRuntimeBinaryEnv(desktop.env, binary, { platform: 'win32', resourcesPath });
  }
  // Match the packaged Windows scenario exactly: root protection follows child creation.
  await protectWindowsTestDirectory(desktop.root);
  // The read-only receipt requires a named/versioned package for each selected
  // controller entry. This isolated stub qualifies SDK readiness, not real MCP integration.
  const mcpRoot = path.join(desktop.root, 'TEST-source-controller');
  await mkdir(mcpRoot, { mode: 0o700 });
  await writeFile(
    path.join(mcpRoot, 'package.json'),
    JSON.stringify({ name: 'TEST-source-controller', version: '1.0.0' }),
    { flag: 'wx', mode: 0o600 }
  );
  const mcpEntry = path.join(mcpRoot, 'TEST-never-launch-mcp.mjs');
  await writeFile(mcpEntry, "throw new Error('Source gate must not launch MCP');\n", {
    flag: 'wx',
    mode: 0o600,
  });
  const moduleUrl = pathToFileURL(
    path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2RunControl.ts')
  ).href;
  const profileModuleUrl = pathToFileURL(
    path.join(sdk, 'src/services/opencode/OpenCodeProfileManager.ts')
  ).href;
  const authModuleUrl = pathToFileURL(
    path.join(sdk, 'src/services/opencode/OpenCodeAuthStore.ts')
  ).href;
  const handlerModuleUrl = pathToFileURL(
    path.join(sdk, 'src/services/opencode/OpenCodeBridgeCommandHandler.ts')
  ).href;
  const selectedBridgeModuleUrl = pathToFileURL(
    path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2TeamBridge.ts')
  ).href;
  const script = `
let stage='startup-cleanup';
let preparation = null;
try {
 const { executeOpenCodeBridgeCommandEnvelope } = await import(${JSON.stringify(handlerModuleUrl)});
 const { executeSelectedOpenCodeBridgeCommandEnvelope } = await import(${JSON.stringify(selectedBridgeModuleUrl)});
 const cleanup = await executeSelectedOpenCodeBridgeCommandEnvelope({
   schemaVersion:1, requestId:'TEST-source-startup-cleanup',
   command:'opencode.cleanupStartupHosts', cwd:${JSON.stringify(desktop.projectPath)},
   startedAt:new Date().toISOString(), timeoutMs:20_000,
   body:{deadlineUnixMs:Date.now()+20_000,mode:'stale',reason:'TEST-source-preflight'}
 }, executeOpenCodeBridgeCommandEnvelope);
 if (cleanup?.ok !== true) throw new Error(typeof cleanup?.error?.message === 'string'
   ? cleanup.error.message : 'TEST startup cleanup did not complete');
 if (cleanup.data?.remaining !== 0 || cleanup.data?.startupCleanup?.completion !== 'drained')
   throw new Error('TEST startup cleanup did not drain its empty registry');
 stage='seed-sdk-auth';
 const { OpenCodeProfileManager, resolveOpenCodeProfileScope } = await import(${JSON.stringify(profileModuleUrl)});
 const manager = new OpenCodeProfileManager();
 const { upsertOpenCodeApiAuthCredential } = await import(${JSON.stringify(authModuleUrl)});
 await upsertOpenCodeApiAuthCredential({authPath:manager.getGlobalAuthPath(),
   providerId:'openrouter',apiKey:'TEST-noncredential'});
 stage='resolve-scope';
 const profileScope = await resolveOpenCodeProfileScope({
   projectPath:${JSON.stringify(desktop.projectPath)}, purpose:'launch_runtime',
   selectedModel:'openrouter/TEST-model', env:process.env});
 stage='prepare-profile';
 await manager.prepareProfile(${JSON.stringify(desktop.projectPath)},
   {profileScope,includeAppMcp:false,includeManagedSubscriptionPlugins:false});
 stage='discover';
 const { discoverOpenCodeV2Run } = await import(${JSON.stringify(moduleUrl)});
 const owner = await discoverOpenCodeV2Run(process.env.CLAUDE_MULTIMODEL_DATA_HOME,
   ${JSON.stringify(desktop.teamName)}, 'TEST-source-preflight');
 if (owner !== null) throw new Error('TEST unexpected run owner');
 ${
   binary
     ? `stage='probe-controller-state';
 const { inspectOpenCodeV2LaunchSelection } = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2LaunchPlan.ts')).href)});
 await (${verifySelectedControllerRoot.toString()})(inspectOpenCodeV2LaunchSelection,${JSON.stringify(desktop.projectPath)},${JSON.stringify(desktop.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT)});
 stage='probe-preparation';
 const { inspectOpenCodeV2SourceAvailability } = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2LaunchPlan.ts')).href)});
 const runOwner = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2RunOwner.ts')).href)});
 const { resolveOpenCodeV2ExecutionProbe } = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2ExecutionProbe.ts')).href)});
 const { spyOn } = await import('bun:test');
 const prepared = await (${verifyProbePreparation.toString()})(inspectOpenCodeV2SourceAvailability,
   resolveOpenCodeV2ExecutionProbe, runOwner, spyOn, ${JSON.stringify(desktop.projectPath)});
 stage='run_control_reserve';
 const { reserveRunControlDirectory } = await import(${JSON.stringify(moduleUrl)});
 const { executionHash } = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/execution/OpenCodeV2ExecutionContracts.ts')).href)});
 preparation = await (${reservePreparedProbe.toString()})(prepared, reserveRunControlDirectory,
   executionHash);
 // False readiness also opens the store: run it only AFTER the cold preparation.
 stage='readiness';
 await (${verifyModelFreeReadiness.toString()})(executeSelectedOpenCodeBridgeCommandEnvelope,
   executeOpenCodeBridgeCommandEnvelope,${JSON.stringify(desktop.projectPath)},${JSON.stringify(expectedVersion)});`
     : ''
 }
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:true,stage,preparation,version:${JSON.stringify(expectedVersion ?? null)}}));
 process.exit(0);
} catch (error) {
 const missing = /^readiness_file_missing:(owner_discovery|source_availability|execution_probe)$/.exec(error?.message ?? '');
 const match = /^execution_owner_not_private:(private_acl_owner(?:_run_(?:data_root|opencode|v2|runs|leaf))?):[0-9]{1,10}(?::private_dir_([0-9]{1,2}))?$/.exec(error?.message ?? '');
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:false,stage,
   code:match?'execution_owner_not_private':missing||(stage==='probe-controller-state'&&error?.code==='ENOENT')?'readiness_file_missing':'source_gate_unknown',role:match?.[1]??missing?.[1]??'unknown',privateDirectoryIndex:match?.[2]??null,
   ...(${safeSourceGateFailure.toString()})(error)}));
 process.exit(1);
}`;
  let output = '';
  let code = 0;
  try {
    ({ stdout: output } = await promisify(execFile)(process.execPath, ['-e', script], {
      cwd: sdk,
      env: {
        ...desktop.env,
        OPENROUTER_API_KEY: 'TEST-noncredential',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpEntry,
        // Desktop's bridge projects getClaudeBasePath() after the Electron override.
        AGENT_TEAMS_MCP_CLAUDE_DIR: desktop.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT,
      },
      timeout: binary ? 150_000 : 45_000,
      maxBuffer: 65_536,
    }));
  } catch (error: unknown) {
    code = 1;
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string')
      output = error.stdout;
  }
  const receipts = output.split(/\r?\n/).filter((line) => line.startsWith('TEST_SOURCE_GATE='));
  assert.equal(receipts.length, 1, 'Source preflight receipt unavailable');
  const receipt: unknown = JSON.parse(receipts[0]!.slice('TEST_SOURCE_GATE='.length));
  assert(receipt && typeof receipt === 'object' && 'ok' in receipt);
  console.log(
    JSON.stringify({ scope: 'desktop TEST setup -> real SDK native discovery', ...receipt })
  );
  assert.equal(code, 0, 'Source discovery gate failed; do not package or submit model tasks');
}
await preflight();
for (const [index, version] of ['2.0.0', '2.0.21'].entries()) {
  const binary = process.argv[index + 3]!;
  assert(path.isAbsolute(binary));
  await preflight(await realpath(binary), version as '2.0.0' | '2.0.21');
}
