/** No Electron package, real credentials or prompts: real native startup, MCP and physical stop. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
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
    'TEST probe startup response invalid': 'probe_startup_response_invalid',
    'TEST probe startup binding changed': 'probe_startup_binding_changed',
    'TEST probe readiness budget exhausted': 'probe_readiness_budget_exhausted',
    'TEST probe member not ready': 'probe_member_not_ready',
    'TEST probe physical stop unconfirmed': 'probe_physical_stop_unconfirmed',
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
  expectedVersion: string,
  selectedModel: string
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
        body: { selectedModel, requireExecutionProbe: false },
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

// Diagnostic observation only: never substitutes for authenticated stop or retirement.
async function snapshotStartupFailure(value: unknown, session: string): Promise<unknown> {
  const row = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const one = (v: unknown, choices: readonly string[]) => choices.find((item) => item === v) ?? 'unclassified';
  const collect = async () => {
    const fs = await import('node:fs/promises'), paths = await import('node:path');
    const run = row(value), binding = row(run.binding), root = process.env.CLAUDE_MULTIMODEL_DATA_HOME;
    const keys = ['teamId', 'runId', 'controllerInstanceId', 'ownerId'];
    if (!root || typeof run.directory !== 'string' || !keys.every((key) => typeof binding[key] === 'string'))
      return { observation: 'unavailable' };
    const directory = run.directory, runs = paths.join(root, 'opencode', 'v2', 'runs');
    if (paths.dirname(directory) !== runs || !/^[a-f0-9]{32}$/.test(paths.basename(directory)))
      return { observation: 'unavailable' };
    const same = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino;
    const read = async (parent: string, name: string, limit: number, presence = false): Promise<Record<string, unknown>> => {
      try {
        const parentBefore = await fs.lstat(parent, { bigint: true });
        if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() || await fs.realpath(parent) !== parent)
          return { observation: 'unavailable' };
        const file = paths.join(parent, name), before = await fs.lstat(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit) || await fs.realpath(file) !== file)
          return { observation: 'unavailable' };
        const handle = await fs.open(file, 'r');
        try {
          if (!same(before, await handle.stat({ bigint: true }))) return { observation: 'unavailable' };
          const bytes = Buffer.alloc(limit + 1), result = await handle.read(bytes, 0, bytes.length, 0);
          const after = await handle.stat({ bigint: true });
          if (result.bytesRead > limit || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
              !same(before, after) || !same(before, await fs.lstat(file, { bigint: true })) ||
              !same(parentBefore, await fs.lstat(parent, { bigint: true }))) return { observation: 'unavailable' };
          return presence ? { observation: 'present' } : { observation: 'read', data: row(JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'))) };
        } finally { await handle.close(); }
      } catch (error: unknown) {
        return { observation: row(error).code === 'ENOENT' ? 'missing' : 'unavailable' };
      }
    };
    const bound = async (name: string) => {
      const result = await read(directory, name, 65536), data = row(result.data);
      return result.observation !== 'read' ? result : keys.every((key) => row(data.binding)[key] === binding[key])
        ? { observation: 'bound', data } : { observation: 'foreign' };
    };
    const state = await bound('state.json'), operation = await bound('operation-failure.json'), stop = await bound('stop.json');
    const stateData = row(state.data), failure = row(operation.data), receipt = row(row(stop.data).receipt);
    const codes = ['mutable_readback', 'run_operation_timeout', 'run_not_active', 'run_control_disconnected', 'run_control_timeout',
      'run_owner_stale', 'run_process_unknown', 'execution_owner_unknown', 'cleanup_unknown', 'execution_timeout',
      'terminal_cut_unknown', 'session_selection_changed', 'execution_profile_changed', 'execution_selected_auth_changed'];
    // Exact closed producer categories; do not classify arbitrary error text here.
    const providerCodes = ['provider_missing', 'provider_key_method_unsupported', 'provider_existing_credentials_unsupported',
  'provider_catalog_scope_changed', 'provider_catalog_location_changed', 'provider_integration_changed', 'provider_credential_identity_changed',
  'provider_owned_connection_unknown', 'provider_active_connection_changed', 'provider_auth_publication_changed', 'provider_auth_publication_unknown',
  'provider_selected_model_missing', 'provider_original_connect_unknown', 'provider_original_execution_pending', 'provider_execution_target_changed',
  'provider_saved_proof_changed', 'provider_saved_proof_unqualified', 'provider_physical_cleanup_unknown', 'provider_mutation_unknown',
  'provider_response_invalid', 'provider_authority_changed', 'provider_directory_changed', 'provider_rollback_peer_changed',
  'provider_rollback_publication_changed', 'provider_rollback_unknown', 'provider_rollback_publication_unknown',
  'run_control_timeout', 'run_control_disconnected', 'run_control_changed', 'run_control_foreign', 'run_control_invalid',
  'run_control_frame_too_large', 'run_owner_stale', 'run_process_unknown', 'run_process_changed',
  'run_deadline_expired', 'run_readiness_changed', 'run_readiness_unknown', 'run_operation_unknown',
  'execution_selected_auth_required', 'execution_selected_auth_unbound', 'execution_selected_auth_changed',
  'execution_selected_auth_missing', 'execution_selected_auth_unsupported', 'execution_selected_auth_location_changed',
  'execution_selected_auth_provider_unknown', 'execution_selected_auth_existing_or_unsupported',
  'execution_selected_auth_readback_unknown', 'execution_selected_auth_profile_changed',
  'execution_selected_oauth_readback_unknown', 'execution_selected_oauth_recovery_required', 'execution_selected_oauth_windows_unqualified',
  'execution_selected_oauth_provider_unknown', 'execution_selected_oauth_integration_unknown',
  'execution_selected_oauth_connection_unknown', 'execution_selected_oauth_model_unknown',
  'execution_lease_not_owned', 'execution_host_unavailable', 'execution_invalid_response', 'execution_identity_mismatch',
  'execution_profile_changed', 'execution_graph_changed', 'execution_graph_incomplete', 'execution_graph_dependency_missing',
  'execution_timeout', 'execution_owner_unknown', 'cleanup_unknown', 'selection_mismatch', 'authority_mismatch',
  'graph_mismatch', 'identity_mismatch', 'unqualified_version', 'invalid_response', 'invalid_model',
  'http_failure', 'transport_failure', 'media_type', 'deadline', 'authority_or_deadline', 'disposed', 'provider_operation_unknown',
  'execution_cancelled', 'execution_containment_dll_identity', 'execution_containment_filesystem_denied',
  'execution_containment_helper_closed', 'execution_containment_helper_failed', 'execution_containment_helper_identity',
  'execution_containment_launcher_denied', 'execution_containment_pipe_denied', 'execution_containment_profile_denied',
  'execution_containment_unavailable', 'execution_native_command_unknown', 'execution_native_stdio_owner_unknown',
  'execution_native_timeout', 'execution_native_unknown', 'execution_owner_alias',
  'execution_owner_archive_identity_mismatch', 'execution_owner_archive_path_mismatch', 'execution_owner_archive_reopen_identity_mismatch',
  'execution_owner_archive_unknown', 'execution_owner_local_volume_required', 'execution_owner_metadata_budget',
  'execution_owner_metadata_changed', 'execution_owner_metadata_invalid', 'execution_owner_metadata_missing',
  'execution_owner_metadata_purpose_invalid', 'execution_owner_not_private', 'execution_owner_ntfs_required',
  'execution_owner_path_invalid', 'execution_owner_prepared_invalid', 'execution_owner_prepared_purpose_invalid',
  'execution_owner_read_only', 'execution_owner_unknown', 'execution_owner_write_through_pending'];
    const nativeStages = [
  'owner_archive_nt_rename', 'owner_canonical_open', 'owner_directory_create',
  'owner_directory_open', 'owner_identity_links', 'owner_identity_reparse',
  'owner_identity_type', 'owner_metadata_cleanup', 'owner_metadata_open',
  'owner_metadata_publish', 'owner_parent_duplicate', 'owner_prepared_create',
  'owner_verification_open', 'private_acl_foreign_allow', 'private_acl_owner',
  'private_acl_owner_run_data_root', 'private_acl_owner_run_leaf', 'private_acl_owner_run_opencode',
  'private_acl_owner_run_runs', 'private_acl_owner_run_v2', 'private_image_open',
  'private_image_protected_dacl', 'private_owner_acquire', 'private_owner_cohort',
  'private_owner_controller_tasks', 'private_owner_controller_teams', 'private_owner_discover_selection',
  'private_owner_reserve_selection', 'private_owner_selected_selection',
      'private_readonly_root', 'private_writable_root', 'private_protected_root'];
    const members = (v: unknown) => Array.isArray(v) ? v.slice(0, 2).map((item) => {
      const member = row(item), bootstrap = row(member.bootstrap), cleanup = row(member.cleanup);
      return { memberMatches: member.memberId === 'probe', state: one(member.state, ['accepted', 'unknown', 'rejected']),
        originalSessionMatches: member.originalSessionId === session, runtimeSessionMatches: member.runtimeSessionId === session,
        opencodeSessionMatches: member.opencodeSessionId === session, bootstrapVerified: bootstrap.verified === true,
        missingNativeMessageID: bootstrap.missingNativeMessageID === true, scopeClosed: cleanup.scopeClosed === true,
        processRetired: cleanup.processRetired === true, descendantsRetired: cleanup.descendantsRetired === true,
        errors: Array.isArray(member.errors) ? member.errors.slice(0, 8).map((code) => one(code,
          ['tombstone_unknown', 'cancel_or_interrupt_unknown', 'readers_unknown', 'physical_cleanup_unknown', 'run_tombstone_unknown'])) : [] };
    }) : [];
    const diagnostics = [], diagnosticRoot = paths.join(root, 'opencode', 'v2', 'provider-diagnostics');
    try {
      const listing = await fs.opendir(diagnosticRoot);
      try { for await (const entry of listing) {
        if (!/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
        const result = await read(diagnosticRoot, entry.name, 16384), data = row(result.data), native = row(data.native);
        const nativeStage = nativeStages.find((stage) => stage === native.stage);
        const nativeFailure = nativeStage && typeof native.nativeCode === 'number' && Number.isSafeInteger(native.nativeCode) &&
          native.nativeCode >= 0 && native.nativeCode <= 0xffffffff ? { stage: nativeStage, nativeCode: native.nativeCode } : null;
        diagnostics.push({ observation: result.observation, phase: one(data.phase, ['execution-host-startup', 'run-owner-initialization']),
          category: one(data.category, providerCodes), native: nativeFailure, startupReason: data.startup === undefined ? null : one(row(data.startup).reason, ['timeout', 'failed']), startupStage: data.startup === undefined ? null : one(row(data.startup).stage,
            ['waiting-for-prepare', 'profile-validation', 'native-validation', 'graph-validation', 'runtime-import', 'server-start', 'effect-import', 'selected-oauth-import', 'scope-acquisition', 'ready-identity']),
          initializationPhase: data.initialization === undefined ? null : one(row(data.initialization).phase, ['MCP-connect', 'MCP-readback', 'controller-tools', 'probe-authority']),
          acquisitionLastPhase: data.acquisition === undefined ? null : one(
            row(Array.isArray(row(data.acquisition).history) ? (row(data.acquisition).history as unknown[]).at(-1) : null).phase,
            ['preparing', 'delivery-resolved', 'profile-validated', 'native-validated', 'graph-validated', 'resolution-prepared',
              'controller-prepared', 'prepared', 'mapping', 'child-bound', 'start-sent', 'ready', 'catalog-ready', 'auth-ready', 'selection-ready']) });
        if (diagnostics.length === 4) break;
      } } finally { await listing.close().catch(() => {}); }
    } catch { /* Diagnostic absence is not evidence of process retirement. */ }
    return { observation: 'snapshot_only', state: { observation: state.observation,
      state: one(stateData.state, ['starting', 'active', 'stopping', 'stopped', 'cleanup_unknown']), members: members(stateData.members) },
      operation: { observation: operation.observation, operation: one(failure.operation,
        ['send', 'observe', 'transcript', 'permissions', 'permissionReply', 'mcp', 'status', 'probeEvidence', 'stop']), category: one(failure.category, codes) },
      stop: { observation: stop.observation, state: one(receipt.state, ['stopped', 'cleanup_unknown']), ownerRetired: receipt.ownerRetired === true, members: members(receipt.members) },
      tombstone: (await read(directory, 'tombstone.json', 65536, true)).observation,
      orphan: (await read(directory, 'orphan.json', 65536, true)).observation, diagnostics };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([collect().catch(() => ({ observation: 'unavailable' })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ observation: 'timeout' }), 2000); })]); }
  finally { clearTimeout(timer); }
}

// Intercept only the final launch return: the real owner and native member start
// once, then retire before resolveProbe can mark submitted or call send.
async function verifyProbePreparation(
  inspect: (input: unknown) => Promise<unknown>,
  resolveProbe: (input: unknown, selection: unknown, run: boolean,
    options: { unattendedTeam: boolean }) => Promise<unknown>,
  owner: { launchExplicitOpenCodeV2Run: (plan: unknown) => Promise<unknown> },
  control: {
    awaitOpenCodeV2RunMemberReadiness(record: unknown, target: {
      memberId: string; originalSessionId: string; selectedModel: string;
      selectedVariant: string; pin: string;
    }, timeout: number): Promise<unknown>;
    requestOpenCodeV2Run(record: unknown, request: { operation: 'stop' }, timeout: number): Promise<unknown>;
  },
  spyOn: (target: typeof owner, key: 'launchExplicitOpenCodeV2Run') => {
    mockImplementation(fn: (plan: unknown) => Promise<never>): void;
    mockRestore(): void;
  },
  projectPath: string, selectedModel: string, expectedVersion: string,
  report: (phase: 'owner_launch' | 'member_readiness' | 'physical_stop', facts: {
    launchCalls: number; ownerReturned: boolean; memberReady: boolean;
    stopConfirmed: boolean; cleanupUnknown: boolean;
  }) => void,
  snapshot: (record: unknown, session: string) => Promise<void>
) {
  const envelope = {
    schemaVersion: 1, requestId: 'TEST-source-probe-startup',
    command: 'opencode.readiness', cwd: projectPath,
    startedAt: new Date().toISOString(), timeoutMs: 120_000,
    body: { selectedModel, requireExecutionProbe: true },
  };
  const selection = await inspect(envelope);
  const { lstat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dataRoot = process.env.CLAUDE_MULTIMODEL_DATA_HOME;
  if (!dataRoot) throw new Error('TEST cold namespace exists');
  const existing = await lstat(join(dataRoot, 'opencode', 'v2')).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) throw new Error('TEST cold namespace exists');
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('TEST probe startup response invalid');
    return value as Record<string, unknown>;
  };
  const sentinel = new Error('TEST model-free startup and physical stop complete');
  const originalLaunch = owner.launchExplicitOpenCodeV2Run;
  let boundaryCalls = 0;
  const facts = { launchCalls: 0, ownerReturned: false, memberReady: false,
    stopConfirmed: false, cleanupUnknown: false };
  const boundary = spyOn(owner, 'launchExplicitOpenCodeV2Run');
  try {
    boundary.mockImplementation(async (value) => {
      boundaryCalls++;
      const plan = record(value), probe = record(plan.executionProbe);
      if (boundaryCalls !== 1 || !Array.isArray(plan.members) || plan.members.length !== 1 ||
          probe.memberId !== 'probe' || !probe.prepared)
        throw new Error('TEST probe preparation plan invalid');
      const member = record(plan.members[0]);
      if (member.memberId !== 'probe' || typeof member.originalSessionId !== 'string')
        throw new Error('TEST probe preparation plan invalid');
      let returnedOwner: unknown, readyPid: number | undefined, primary: unknown, cleanupFailure: unknown;
      let phase: 'owner_launch' | 'member_readiness' | 'physical_stop' = 'owner_launch';
      const update = () => report(phase, { ...facts });
      try {
        facts.launchCalls++; update();
        const launchedOwner = await originalLaunch(value); // Exactly one original call, never a reserved-plan replay.
        const current = record(launchedOwner), binding = record(current.binding);
        const expectedBinding = record(plan.binding);
        if (!['teamId', 'runId', 'controllerInstanceId', 'ownerId'].every((key) =>
          typeof expectedBinding[key] === 'string' && binding[key] === expectedBinding[key]))
          throw new Error('TEST probe startup binding changed');
        returnedOwner = launchedOwner; // Only the exact returned binding can authorize this TEST stop.
        facts.ownerReturned = true;
        phase = 'member_readiness'; update();
        if (typeof current.deadline !== 'number' || !Number.isFinite(current.deadline))
          throw new Error('TEST probe startup response invalid');
        // Leave the existing 30s public stop budget inside the original probe deadline.
        const readinessMs = Math.min(90_000, current.deadline - Date.now() - 30_000);
        if (readinessMs <= 0) throw new Error('TEST probe readiness budget exhausted');
        const ready = await control.awaitOpenCodeV2RunMemberReadiness(returnedOwner, {
          memberId: 'probe', originalSessionId: member.originalSessionId,
          selectedModel, selectedVariant: 'default', pin: expectedVersion,
        }, Math.floor(readinessMs));
        if (!ready) throw new Error('TEST probe member not ready');
        const memberStatus = record(ready);
        if (typeof memberStatus.runtimePid !== 'number' || !Number.isSafeInteger(memberStatus.runtimePid) ||
            memberStatus.runtimePid <= 0) throw new Error('TEST probe member not ready');
        readyPid = memberStatus.runtimePid;
        facts.memberReady = true; update();
      } catch (error) { primary = error; }
      finally {
        if (returnedOwner) {
          const primaryPhase = phase;
          phase = 'physical_stop'; update();
          try {
            const stopped = record(await control.requestOpenCodeV2Run(returnedOwner, { operation: 'stop' }, 30_000));
            const members = stopped.members;
            const stoppedMember = Array.isArray(members) && members.length === 1 ? record(members[0]) : null;
            const cleanup = stoppedMember?.cleanup ? record(stoppedMember.cleanup) : null;
            if (stopped.kind !== 'stop' || stopped.state !== 'stopped' || stopped.ownerRetired !== true ||
                stoppedMember?.memberId !== 'probe' || !Array.isArray(stoppedMember.errors) ||
                stoppedMember.errors.length !== 0 || !cleanup || cleanup.scopeClosed !== true ||
                cleanup.processRetired !== true || cleanup.descendantsRetired !== true ||
                (readyPid !== undefined && cleanup.pid !== readyPid)) {
              cleanupFailure = new Error('TEST probe physical stop unconfirmed');
              facts.cleanupUnknown = true;
            } else facts.stopConfirmed = true;
          } catch (error) { cleanupFailure = error; facts.cleanupUnknown = true; }
          update();
          if (primary !== undefined) { phase = primaryPhase; update(); }
        } else { facts.cleanupUnknown = true; update(); } // Partial launch has no returned authority to invent or replay.
      }
      if (returnedOwner && (primary !== undefined || cleanupFailure !== undefined)) {
        try { await snapshot(returnedOwner, member.originalSessionId); } catch { /* Preserve original failure. */ }
      }
      if (primary !== undefined) throw primary;
      if (cleanupFailure !== undefined) throw cleanupFailure;
      if (!facts.memberReady || !facts.stopConfirmed) throw new Error('TEST probe physical stop unconfirmed');
      throw sentinel; // resolveProbe never reaches submitted=true or send.
    });
    let caught: unknown;
    try { await resolveProbe(envelope, selection, true, { unattendedTeam: true }); }
    catch (error) { caught = error; }
    if (caught !== sentinel) throw caught ?? new Error('TEST probe launch boundary not reached');
    if (boundaryCalls !== 1 || facts.launchCalls !== 1 || !facts.stopConfirmed)
      throw new Error('TEST probe launch boundary count invalid');
    return { modelFreeStartupOnly: true, ownerLaunchCalls: facts.launchCalls,
      authenticatedMemberReady: facts.memberReady, physicalStopConfirmed: facts.stopConfirmed,
      modelSubmissionAttempted: false };
  } finally { boundary.mockRestore(); }
}

async function verifySelectedControllerRoot(
  inspect: (input: unknown) => Promise<unknown>,
  projectPath: string,
  expectedClaudeRoot: string,
  selectedModel: string
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
      body: { selectedModel },
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
assert.equal(process.argv.length, 7);
const selectedModel = process.argv[5]!;
assert(/^openrouter\/[a-zA-Z0-9_./:-]+$/.test(selectedModel), 'Explicit TEST selected model required');
const mcpNode = await realpath(path.resolve(process.argv[6]!));
const mcpEntry = await realpath(path.resolve('mcp-server/dist/index.js'));
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
let startupFacts = null;
let startupFailureState = null;
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
   selectedModel:${JSON.stringify(selectedModel)}, env:process.env});
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
 await (${verifySelectedControllerRoot.toString()})(inspectOpenCodeV2LaunchSelection,${JSON.stringify(desktop.projectPath)},${JSON.stringify(desktop.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT)},${JSON.stringify(selectedModel)});
 stage='probe-preparation';
 const { inspectOpenCodeV2SourceAvailability } = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2LaunchPlan.ts')).href)});
 const runOwner = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2RunOwner.ts')).href)});
 const { resolveOpenCodeV2ExecutionProbe } = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2ExecutionProbe.ts')).href)});
 const { spyOn } = await import('bun:test');
 const control = await import(${JSON.stringify(moduleUrl)});
 preparation = await (${verifyProbePreparation.toString()})(inspectOpenCodeV2SourceAvailability,
   resolveOpenCodeV2ExecutionProbe, runOwner, control, spyOn, ${JSON.stringify(desktop.projectPath)},
   ${JSON.stringify(selectedModel)}, ${JSON.stringify(expectedVersion)},
   (phase, facts) => { stage=phase; startupFacts=facts; },
   async (record, session) => { startupFailureState = await (${snapshotStartupFailure.toString()})(record, session); });
 // False readiness also opens the store: run it only AFTER the cold preparation.
 stage='readiness';
 await (${verifyModelFreeReadiness.toString()})(executeSelectedOpenCodeBridgeCommandEnvelope,
   executeOpenCodeBridgeCommandEnvelope,${JSON.stringify(desktop.projectPath)},${JSON.stringify(expectedVersion)},${JSON.stringify(selectedModel)});`
     : ''
 }
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:true,stage,preparation,startupFacts,version:${JSON.stringify(expectedVersion ?? null)}}));
 process.exit(0);
} catch (error) {
 const missing = /^readiness_file_missing:(owner_discovery|source_availability|execution_probe)$/.exec(error?.message ?? '');
 const match = /^execution_owner_not_private:(private_acl_owner(?:_run_(?:data_root|opencode|v2|runs|leaf))?):[0-9]{1,10}(?::private_dir_([0-9]{1,2}))?$/.exec(error?.message ?? '');
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:false,stage,startupFacts,startupFailureState,
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
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: mcpNode,
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
    JSON.stringify({ scope: 'desktop TEST setup -> native startup/MCP/physical stop without prompts', ...receipt })
  );
  assert.equal(code, 0, 'Source discovery gate failed; do not package or submit model tasks');
}
await preflight();
for (const [index, version] of ['2.0.0', '2.0.21'].entries()) {
  const binary = process.argv[index + 3]!;
  assert(path.isAbsolute(binary));
  await preflight(await realpath(binary), version as '2.0.0' | '2.0.21');
}
