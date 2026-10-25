/** No Electron package, real credentials or prompts: real native startup, MCP and physical stop. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyOpenCodeRuntimeBinaryEnv } from '../../src/main/services/runtime/openCodeRuntimeBinaryEnv';
import { prepareNativeDesktopEnvironment } from './opencode-native-desktop-environment';

type ReadinessExecutor = (
  input: unknown,
  executeV1: (input: unknown) => Promise<unknown>
) => Promise<unknown>;

function safeSourceGateFailure(error: unknown, nativeFailures?: WeakMap<object, string>): { reason: string; errno: string | null; primaryNativeOperation: string; causal: unknown } {
  const row = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message = typeof row.message === 'string' ? row.message : '';
  const localReasons: Record<string, string> = {
    'TEST fresh owner budget exhausted': 'fresh_owner_budget_exhausted',
    'TEST fresh owner qualification guard bypassed': 'fresh_owner_guard_bypassed',
    'TEST fresh owner response invalid': 'fresh_owner_response_invalid',
    'TEST fresh owner output invalid': 'fresh_owner_output_invalid',
    'TEST fresh owner input invalid': 'fresh_owner_input_invalid',
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
  // Traverse only retained original failures. No message, stack, path or raw native DTO crosses this boundary.
  const categories = new Set(['execution_native_command_environment_alias', 'execution_native_command_output_limit', 'execution_native_command_stdin_unknown',
    'run_control_accept_timeout', 'run_control_accept_unknown', 'run_control_connect_unknown', 'run_control_connection_limit',
    'run_control_frame_invalid', 'run_control_frame_oversize', 'run_control_frame_utf8', 'run_control_held_identity', 'run_control_held_inputs',
    'run_control_hmac_unknown', 'run_control_image_changed', 'run_control_image_hash', 'run_control_listen_unknown', 'run_control_owner_identity',
    'run_control_package_peer_identity', 'run_control_parent_birth', 'run_control_path_alias', 'run_control_peer_identity', 'run_control_pipe_name',
    'run_control_pipe_security', 'run_control_read_unknown', 'run_control_write_partial', 'run_control_write_unknown',
    'run_state_acl_unknown', 'run_state_challenge_changed', 'run_state_challenge_unknown', 'run_state_record_collision', 'run_state_record_encoding',
    'run_state_record_name', 'run_state_record_read', 'run_state_record_size', 'run_state_record_temporary', 'run_state_record_unknown', 'run_state_record_write',
    'execution_containment_identity_mismatch', 'execution_database_alias', 'run_control_config_budget',
    'run_control_config_identity', 'run_control_endpoint_changed', 'run_control_parent_join', 'run_control_selection_budget',
    'run_control_selection_changed', 'run_control_selection_missing', 'run_controller_config_unknown', 'run_controller_inbox_unknown',
    'run_process_appcontainer', 'run_state_absent', 'run_state_endpoint_changed', 'run_state_endpoint_missing', 'run_state_held_inputs',
    'run_state_identity_changed', 'run_state_missing', 'run_state_record_absent', 'run_state_record_changed', 'run_state_start_changed', 'run_state_unknown',
    'run_acquisition_timeout', 'run_initialization_timeout', 'run_stopped', 'cancelled', 'execution_path_alias', 'timeout', 'run_control_process_identity', 'provider_missing', 'provider_key_method_unsupported', 'provider_existing_credentials_unsupported',
  'provider_catalog_scope_changed', 'provider_catalog_location_changed', 'provider_integration_changed', 'provider_credential_identity_changed',
  'provider_owned_connection_unknown', 'provider_active_connection_changed', 'provider_auth_publication_changed', 'provider_auth_publication_unknown',
  'provider_selected_model_missing', 'provider_original_connect_unknown', 'provider_original_execution_pending', 'provider_execution_target_changed',
  'provider_saved_proof_changed', 'provider_saved_proof_unqualified', 'provider_physical_cleanup_unknown', 'provider_mutation_unknown',
  'provider_response_invalid', 'provider_authority_changed', 'provider_directory_changed', 'provider_rollback_peer_changed',
  'provider_rollback_publication_changed', 'provider_rollback_unknown', 'provider_rollback_publication_unknown',
  'run_control_timeout', 'run_control_disconnected', 'run_control_changed', 'run_control_foreign', 'run_control_invalid',
  'run_control_frame_too_large', 'run_owner_stale', 'run_process_unknown', 'run_process_changed',
  'run_deadline_expired', 'run_control_client_budget_exhausted',
  'run_control_connect_busy_timeout_expired', 'run_control_connect_idle_expired',
  'run_control_connect_no_listener_expired', 'run_state_wall_deadline_expired',
  'run_readiness_changed', 'run_readiness_unknown', 'run_operation_unknown',
  'run_controller_mcp_unknown', 'execution_http_transport_unknown',
  'execution_selected_auth_required', 'execution_selected_auth_unbound', 'execution_selected_auth_changed',
  'execution_selected_auth_missing', 'execution_selected_auth_unsupported', 'execution_selected_auth_location_changed',
  'execution_selected_auth_provider_unknown', 'execution_selected_auth_existing_or_unsupported',
  'execution_selected_auth_readback_unknown', 'execution_selected_auth_profile_changed',
  'execution_selected_oauth_readback_unknown', 'execution_selected_oauth_recovery_required', 'execution_selected_oauth_windows_unqualified',
  'execution_selected_oauth_provider_unknown', 'execution_selected_oauth_integration_unknown',
  'execution_selected_oauth_connection_unknown', 'execution_selected_oauth_model_unknown',
  'execution_lease_not_owned', 'execution_host_unavailable', 'execution_containment_unqualified', 'execution_invalid_response', 'execution_identity_mismatch', 'execution_identity_unknown',
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
  'execution_owner_path_invalid', 'execution_owner_record_invalid', 'execution_owner_prepared_invalid', 'execution_owner_prepared_purpose_invalid',
  'execution_owner_read_only', 'execution_owner_unknown', 'execution_owner_write_through_pending', 'probe_store_foreign', 'probe_store_invalid', 'probe_source_changed', 'probe_cached_target_changed', 'probe_controller_state_foreign', 'probe_plan_invalid', 'probe_original_owner_changed', 'probe_physical_cleanup_unknown', 'probe_observation_unknown', 'probe_failure_invalid', 'execution_owner_platform_pending', 'execution_profile_owned', 'run_selected_auth_changed', 'run_source_symlink', 'run_source_budget']);
  const stages = new Set(['accept', 'close', 'connect', 'listen', 'process_alive', 'process_alive_wait', 'read', 'write',
    'record_create', 'record_open', 'run_state_record_rename', 'command_stdin_complete', 'command_stdin_wait', 'command_stdin_write',
    'identity', 'run_namespace_open', 'run_state_directory', 'shared_acl_mutex_ace_role',
    'shared_acl_mutex_control', 'shared_acl_mutex_mask', 'shared_acl_mutex_owner',
    'alias_predicate', 'assert_mapping', 'assert_stopped', 'assert_broker', 'retire_broker_state', 'retire_broker_write', 'retire_job', 'retire_wait', 'retire_io_join',
  'retire_main_exit', 'retire_owned_pair', 'retire_commands', 'retire_receipt', 'retire_grants',
  'retire_grants_dll', 'retire_grants_roots', 'retire_grants_metadata', 'process_birth', 'process_image_path', 'process_image_open', 'process_birth_changed',
  'process_alive', 'process_alive_wait', 'process_alive_held_bun', 'process_alive_package_peer', 'process_alive_peer', 'process_alive_peer_parent',
  'shared_acl_mutex_descriptor', 'shared_acl_mutex_create', 'shared_acl_mutex_security',
  'shared_acl_mutex_encoding', 'shared_acl_mutex_authority', 'shared_acl_mutex_wait', 'shared_acl_mutex',
  'owner_archive_nt_rename', 'owner_canonical_open', 'owner_directory_create',
  'owner_directory_open', 'owner_identity_links', 'owner_identity_reparse',
  'owner_identity_type', 'owner_metadata_cleanup', 'owner_metadata_open',
  'owner_metadata_publish', 'owner_parent_duplicate', 'owner_prepared_create',
  'owner_verification_open', 'private_acl_foreign_allow', 'private_acl_owner',
  'private_acl_owner_run_data_root', 'private_acl_owner_run_leaf', 'private_acl_owner_run_opencode',
  'private_acl_owner_run_runs', 'private_acl_owner_run_v2', 'private_image_open',
  'private_image_protected_dacl', 'private_dll_owner', 'private_owner_acquire', 'private_owner_cohort',
  'private_owner_controller_tasks', 'private_owner_controller_teams', 'private_owner_discover_selection',
  'private_owner_reserve_selection', 'private_owner_selected_selection',
      'private_readonly_root', 'private_writable_root', 'private_protected_root',
      'ancestor_metadata_control', 'ancestor_metadata_foreign', 'ancestor_metadata_group', 'ancestor_metadata_member', 'ancestor_metadata_open', 'ancestor_metadata_owner', 'ancestor_metadata_ace', 'ancestor_metadata_descriptor', 'ancestor_metadata_security', 'ancestor_metadata_package', 'ancestor_metadata_read', 'ancestor_metadata_changed', 'ancestor_metadata_cleanup_unproven', 'ancestor_metadata_intent', 'ancestor_metadata_acl_size', 'ancestor_metadata_acl', 'ancestor_metadata_write', 'ancestor_metadata_identity', 'ancestor_metadata_pin',
  'shared_readonly_security', 'shared_readonly_acl', 'shared_readonly_owner', 'shared_readonly_file',
      'shared_readonly_control', 'shared_readonly_ace', 'shared_readonly_package', 'shared_readonly_foreign_write',
      'shared_readonly_grant_open', 'shared_readonly_grant_read', 'shared_readonly_grant_merge', 'shared_readonly_grant_write',
      'shared_readonly_owner_changed', 'shared_readonly_control_changed', 'shared_readonly_foreign_changed', 'shared_readonly_member_missing']);
  const operations = new Set(['identity', 'assertLive', 'launch', 'send', 'retire', 'selfImageCustody',
    'ownerOpenDirectory', 'ownerPreparePrivateDirectory', 'ownerAssertDirectory', 'ownerCloseDirectory',
    'ownerValidateSelectedProfile', 'ownerSelectConfig', 'ownerInspectProfileConfig', 'ownerArchive',
    'ownerCreatePreparedDatabase', 'ownerWritePreparedConfig', 'ownerWritePreparedAuth', 'ownerReadMetadata', 'ownerWriteMetadata',
    'ownerReadRecord', 'ownerWriteExclusive', 'runStateAcquire', 'runStateSelect', 'runStateDiscover',
    'runStateReserve', 'runStateReadRecord', 'runStateWriteRecord', 'runStateReadStop', 'runStateOwnerRetired',
    'runStateProcessIdentity', 'runStateValidateEndpoint', 'runStateRequest', 'runStateListen',
    'runStateRespond', 'runStatePoisonConnection', 'runStateClose', 'runStateReadControllerInbox']);
  const boundaries = new Set(['private_directories_close', 'private_directory_broker_close', 'prepared_member_close',
    'probe_store_open', 'probe_store_close', 'probe_guard_close', 'probe_release', 'native_artifact_close']);
  const failures: { parent: number | null; role: string; category: string; boundary: string | null;
    nativeOperation: string; native: { stage: string; nativeCode: number; nativeStatus: number | null } | null;
    privateDirectoryIndex: number | null; errno: string | null }[] = [];
  const pending: { value: unknown; parent: number | null; role: string; depth: number }[] = [
    { value: error, parent: null, role: 'primary', depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let truncated = false;
  while (pending.length) {
    const next = pending.shift()!;
    if (next.value && typeof next.value === 'object' && seen.has(next.value)) continue;
    if (next.depth > 4 || failures.length === 16) { truncated = true; continue; }
    const original = next.value && typeof next.value === 'object' ? next.value as Record<string, unknown> : {};
    if (next.value && typeof next.value === 'object') seen.add(next.value);
    const text = typeof original.message === 'string' ? original.message : '';
    const match = /^([a-z_]{1,96})(?::([a-z_][a-z_0-9]{0,63}):(0|[1-9][0-9]{0,9}))?(?::private_dir_([0-9]{1,2}))?$/.exec(text);
    const category = match && categories.has(match[1]!) ? match[1]! : 'unclassified';
    const nativeCode = match?.[3] === undefined ? -1 : Number(match[3]);
    const operation = next.value && typeof next.value === 'object'
      ? nativeFailures?.get(next.value) ?? original.nativeOperation : undefined;
    const boundary = typeof original.cleanupBoundary === 'string' && boundaries.has(original.cleanupBoundary)
      ? original.cleanupBoundary : null;
    const index = failures.length;
    failures.push({ parent: next.parent, role: next.role, category, boundary,
      nativeOperation: typeof operation === 'string' && operations.has(operation) ? operation : 'unknown',
      native: category !== 'unclassified' && match?.[2] && stages.has(match[2]) &&
        Number.isSafeInteger(nativeCode) && nativeCode >= 0 && nativeCode <= 0xffffffff
        ? { stage: match[2], nativeCode, nativeStatus: Number.isSafeInteger(original.nativeStatus) &&
          Number(original.nativeStatus) >= 0 && Number(original.nativeStatus) <= 0xffffffff ? Number(original.nativeStatus) : null } : null,
      privateDirectoryIndex: category !== 'unclassified' && match?.[4] !== undefined && Number(match[4]) < 64 ? Number(match[4]) : null,
      errno: errnos.find(value => value === original.code) ?? null });
    if (boundary && text === 'cleanup_unknown' && typeof original.primaryFailure === 'boolean' && Array.isArray(original.errors)) {
      if (original.errors.length > 16) truncated = true;
      for (let i = 0; i < Math.min(16, original.errors.length); i++)
        pending.push({ value: original.errors[i], parent: index, role: i === 0 && original.primaryFailure ? 'primary' : 'cleanup', depth: next.depth + 1 });
    }
    if (original.cause !== undefined)
      pending.push({ value: original.cause, parent: index, role: boundary && original.primaryFailure === false ? 'cleanup' : 'cause', depth: next.depth + 1 });
  }
  return { reason, errno: errnos.find((value) => value === row.code) ?? null,
    primaryNativeOperation: error && typeof error === 'object' ? nativeFailures?.get(error) ?? 'unknown' : 'unknown', causal: { failures, truncated } };
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

// One fresh process observes the original owner without qualification or dispatch.
async function verifyFreshOriginalOwnerBoundary(
  input: { sdk: string; testRoot: string; projectPath: string; owner: unknown; plan: unknown;
    selectedModel: string; client: unknown; timeoutMs: number },
  protocol: {
    parse: typeof import('../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract').parseSingleBridgeJsonResult;
    validate: typeof import('../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract').validateBridgeResultEnvelope;
    failure: typeof import('../../src/main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient').createOpenCodeBridgeHandshakeFailure;
  },
  execute?: (executable: string, args: string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number;
  }) => Promise<unknown>
): Promise<'qualification_guard_reached'> {
  const { randomUUID } = await import('node:crypto');
  const { lstat, open, realpath, writeFile } = await import('node:fs/promises');
  const { join, basename } = await import('node:path');
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('TEST fresh owner input invalid');
    return value as Record<string, unknown>;
  };
  const owner = record(input.owner), plan = record(input.plan);
  const binding = record(owner.binding), plannedBinding = record(plan.binding);
  const member = Array.isArray(plan.members) ? record(plan.members[0]) : {};
  const model = record(record(record(member.profile).selection).model);
  if (!/^TEST-oc-/.test(basename(input.testRoot)) || await realpath(input.testRoot) !== input.testRoot ||
      typeof binding.teamId !== 'string' || !binding.teamId.startsWith('TEST-') ||
      !['teamId', 'runId', 'controllerInstanceId', 'ownerId'].every(key =>
        typeof binding[key] === 'string' && binding[key] === plannedBinding[key]) ||
      plan.qualification !== undefined || owner.qualification !== undefined ||
      typeof model.providerID !== 'string' || typeof model.id !== 'string' ||
      `${model.providerID}/${model.id}` !== input.selectedModel ||
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 120_000)
    throw new Error('TEST fresh owner input invalid');
  const requestId = 'TEST-fresh-owner-' + randomUUID();
  const request = join(input.testRoot, requestId + '.input.json');
  const output = join(input.testRoot, requestId + '.output.json');
  const envelope = { schemaVersion: 1 as const, requestId, command: 'opencode.handshake' as const,
    cwd: input.projectPath, startedAt: new Date().toISOString(), timeoutMs: input.timeoutMs,
    body: { client: input.client, requiredCommand: 'opencode.sendMessage', expectedRunId: binding.runId,
      teamId: binding.teamId, expectedCapabilitySnapshotId: null, expectedManifestHighWatermark: null,
      selectedModel: input.selectedModel, laneId: 'primary' } };
  if (await lstat(output).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  })) throw new Error('TEST fresh owner output invalid');
  await writeFile(request, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
  if (!execute) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    execute = promisify(execFile);
  }
  // Same outer launch environment and pinned Bun image; no per-member profile environment.
  await execute(process.execPath, [join(input.sdk, 'src/entrypoints/cli.tsx'), 'runtime',
    'opencode-command', '--json', '--input', request, '--output', output], {
    cwd: input.sdk, env: process.env, timeout: input.timeoutMs + 25_000, maxBuffer: 65_536,
  });
  const before = await lstat(output);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65_536 ||
      await realpath(output) !== output) throw new Error('TEST fresh owner output invalid');
  const handle = await open(output, 'r');
  let payload: string;
  try {
    const held = await handle.stat();
    if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size)
      throw new Error('TEST fresh owner output invalid');
    const bytes = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await lstat(output), heldAfter = await handle.stat();
    if (bytesRead !== before.size || bytesRead > 65_536 || after.isSymbolicLink() ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        heldAfter.size !== before.size || heldAfter.nlink !== 1)
      throw new Error('TEST fresh owner output invalid');
    payload = bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
  const parsed = protocol.parse(payload);
  if (!parsed.ok || !protocol.validate(parsed.value, envelope).ok)
    throw new Error('TEST fresh owner response invalid');
  if (!parsed.value.ok && parsed.value.error.kind === 'runtime_not_ready' &&
      parsed.value.error.message === 'run_original_qualification_missing') return 'qualification_guard_reached';
  if (!parsed.value.ok) throw protocol.failure(parsed.value.error);
  throw new Error('TEST fresh owner qualification guard bypassed');
}

// Intercept only the final launch return: the real owner and native member start
// once, then retire before resolveProbe can mark submitted or call send.
async function verifyProbePreparation(
  inspect: (input: unknown) => Promise<unknown>,
  resolveProbe: (input: unknown, selection: unknown, run: boolean,
    options: { unattendedTeam: boolean }) => Promise<unknown>,
  buildPlan: (selection: unknown, body: Record<string, unknown>, controllerInstanceId: string) => Promise<unknown>,
  owner: { launchExplicitOpenCodeV2Run: (plan: unknown) => Promise<unknown> },
  control: {
    OPEN_CODE_V2_RUN_INITIALIZATION_MS: number;
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
  projectPath: string, selectedModel: string, pin: { version: string; wire: 'floor' | 'current' },
  report: (phase: 'owner_launch' | 'member_readiness' | 'fresh_original_owner' | 'physical_stop', facts: {
    launchCalls: number; ownerReturned: boolean; memberReady: boolean; memberCount: number; readyMemberCount: number;
    stopConfirmed: boolean; cleanupUnknown: boolean; freshOriginalOwnerBoundary: string;
  }) => void,
  snapshot: (record: unknown, session: string, plan: unknown, timing: 'before_stop' | 'after_stop') => Promise<void>,
  stopFailure: (error: unknown) => void = () => undefined,
  freshBoundary?: (owner: unknown, plan: unknown, timeoutMs: number) => Promise<'qualification_guard_reached'>
) {
  const envelope = {
    schemaVersion: 1, requestId: 'TEST-source-probe-startup',
    command: 'opencode.readiness', cwd: projectPath,
    // Cold source graph preparation shares this one supported caller budget
    // with native startup; owner/readiness/stop retain their production limits.
    startedAt: new Date().toISOString(), timeoutMs: 300_000,
    body: { selectedModel, requireExecutionProbe: true },
  };
  const selection = await inspect(envelope);
  const { randomUUID } = await import('node:crypto');
  const roster = pin.wire === 'floor' ? ['team-lead', 'alice'] : pin.wire === 'current' ? ['team-lead', 'alice', 'bob'] : [];
  if (!roster.length) throw new Error('TEST probe preparation plan invalid');
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
  const facts = { launchCalls: 0, ownerReturned: false, memberReady: false, memberCount: roster.length, readyMemberCount: 0,
    stopConfirmed: false, cleanupUnknown: false, freshOriginalOwnerBoundary: 'not_checked' };
  const boundary = spyOn(owner, 'launchExplicitOpenCodeV2Run');
  try {
    boundary.mockImplementation(async (value) => {
      boundaryCalls++;
      const original = record(value), probe = record(original.executionProbe), originalBinding = record(original.binding);
      if (boundaryCalls !== 1 || !Array.isArray(original.members) || original.members.length !== 1 ||
          probe.memberId !== 'probe' || !probe.prepared || typeof originalBinding.teamId !== 'string' ||
          !/^TEST-execution-probe-[a-f0-9]{32}$/.test(originalBinding.teamId) || !Number.isFinite(original.deadline))
        throw new Error('TEST probe preparation plan invalid');
      // The resolver created this fresh TEST team/tasks namespace, but has not
      // reserved or launched an owner. Build each cohort profile originally;
      // never copy a sealed profile or replay the resolver's single-member plan.
      const planValue = await buildPlan(selection, { teamId: originalBinding.teamId, teamName: originalBinding.teamId,
        runId: randomUUID(), laneId: 'primary', selectedModel, effort: 'default',
        members: roster.map(name => ({ name, prompt: 'Wait for app task delivery. This startup check submits no model input.' })) }, randomUUID());
      const plan = record(planValue), members = Array.isArray(plan.members) ? plan.members.map(record) : [];
      if (members.length !== roster.length || members.some((member, index) => member.memberId !== roster[index] ||
          typeof member.originalSessionId !== 'string') || new Set(members.map(member => member.originalSessionId)).size !== members.length ||
          !Number.isFinite(plan.deadline) || Number(original.deadline) - Date.now() <= 30_000)
        throw new Error('TEST probe preparation plan invalid');
      // Shorten only this original, unlaunched plan to the existing probe budget.
      plan.deadline = Math.min(Number(plan.deadline), Number(original.deadline));
      const readyPids = new Map<unknown, number>();
      const capture = async (timing: 'before_stop' | 'after_stop') => {
        for (const member of members) await snapshot(returnedOwner, String(member.originalSessionId), planValue, timing);
      };
      let returnedOwner: unknown, primary: unknown, cleanupFailure: unknown;
      let phase: 'owner_launch' | 'member_readiness' | 'fresh_original_owner' | 'physical_stop' = 'owner_launch';
      const update = () => report(phase, { ...facts });
      try {
        facts.launchCalls++; update();
        const launchedOwner = await originalLaunch(planValue); // Exactly one original call, never a reserved-plan replay.
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
        const readinessDeadline = Math.min(Date.now() + control.OPEN_CODE_V2_RUN_INITIALIZATION_MS, current.deadline - 30_000);
        if (readinessDeadline <= Date.now()) throw new Error('TEST probe readiness budget exhausted');
        let readinessFailure: unknown, readinessFailed = false;
        // Read members one at a time so status exchanges never queue behind each
        // other with already-running deadlines.
        for (const member of members) {
        try {
        const readinessMs = Math.floor(readinessDeadline - Date.now());
        if (readinessMs <= 0) throw new Error('TEST probe readiness budget exhausted');
        const ready = await control.awaitOpenCodeV2RunMemberReadiness(returnedOwner, {
          memberId: String(member.memberId), originalSessionId: String(member.originalSessionId),
          selectedModel, selectedVariant: 'default', pin: pin.version,
        }, readinessMs);
        if (!ready) throw new Error('TEST probe member not ready');
        const memberStatus = record(ready);
        if (typeof memberStatus.runtimePid !== 'number' || !Number.isSafeInteger(memberStatus.runtimePid) ||
            memberStatus.runtimePid <= 0) throw new Error('TEST probe member not ready');
        readyPids.set(member.memberId, memberStatus.runtimePid);
        facts.readyMemberCount = readyPids.size; update();
        } catch (error) { readinessFailed = true; readinessFailure ??= error; }
        }
        if (readinessFailed) throw readinessFailure;
        facts.memberReady = readyPids.size === members.length; update();
        if (pin.wire === 'current') {
          phase = 'fresh_original_owner'; update();
          // Charge both the CLI watchdog/drain margin and original public Stop inside this deadline.
          const freshMs = Math.min(120_000, Math.floor(current.deadline - Date.now() - 30_000 - 25_000));
          if (!freshBoundary || freshMs <= 0) throw new Error('TEST fresh owner budget exhausted');
          facts.freshOriginalOwnerBoundary = await freshBoundary(returnedOwner, planValue, freshMs); update();
        }
      } catch (error) {
        primary = error;
        try { await capture('before_stop'); }
        catch { /* Preserve the original failure and always attempt its public stop. */ }
      }
      finally {
        if (returnedOwner) {
          const primaryPhase = phase;
          phase = 'physical_stop'; update();
          try {
            const stopped = record(await control.requestOpenCodeV2Run(returnedOwner, { operation: 'stop' }, 30_000));
            const retired = Array.isArray(stopped.members) ? stopped.members.map(record) : [];
            const complete = retired.length === members.length && new Set(retired.map(member => member.memberId)).size === members.length &&
              members.every(member => {
                const stoppedMember = retired.find(value => value.memberId === member.memberId);
                if (!stoppedMember || stoppedMember.cleanup === null || stoppedMember.cleanup === undefined) return false;
                const cleanup = record(stoppedMember.cleanup);
                return Array.isArray(stoppedMember.errors) && stoppedMember.errors.length === 0 &&
                  cleanup.scopeClosed === true && cleanup.processRetired === true && cleanup.descendantsRetired === true &&
                  (!readyPids.has(member.memberId) || cleanup.pid === readyPids.get(member.memberId));
              });
            if (stopped.kind !== 'stop' || stopped.state !== 'stopped' || stopped.ownerRetired !== true || !complete) {
              cleanupFailure = new Error('TEST probe physical stop unconfirmed');
              facts.cleanupUnknown = true;
            } else facts.stopConfirmed = true;
          } catch (error) {
            // Retain the exact public Stop rejection for its closed projection;
            // a primary readiness failure must not hide why Stop was not proven.
            cleanupFailure = error; facts.cleanupUnknown = true; stopFailure(error);
          }
          update();
          if (primary !== undefined) { phase = primaryPhase; update(); }
        } else { facts.cleanupUnknown = true; update(); } // Partial launch has no returned authority to invent or replay.
      }
      if (primary !== undefined || cleanupFailure !== undefined) {
        try { await capture('after_stop'); } catch { /* Preserve original failure. */ }
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
      authenticatedMemberReady: facts.memberReady, memberCount: roster.length, authenticatedMemberCount: facts.readyMemberCount, physicalStopConfirmed: facts.stopConfirmed,
      freshOriginalOwnerBoundary: facts.freshOriginalOwnerBoundary, modelSubmissionAttempted: false };
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
assert.equal(process.versions.bun, '1.4.3');
// <sdk> <v2-binary> <model> <controller-node> <newest-v2-pin>; the pin comes from the selected
// runtime registry (scripts/e2e/opencode-native-windows-pins.ts).
assert(process.argv.length === 7, 'Windows preflight arguments invalid');
const currentPin = process.argv[6]!;
assert(/^2\.\d+\.\d+$/.test(currentPin), 'Resolved Windows V2 pin invalid');
const selectedModel = process.argv[4]!;
assert(/^openrouter\/[a-zA-Z0-9_./:~-]+$/.test(selectedModel), 'Explicit TEST selected model required for native startup, including source-only; no model prompts are submitted');
const mcpNode = await realpath(path.resolve(process.argv[5]!));
const mcpEntry = await realpath(path.resolve('mcp-server/dist/index.js'));
const sdk = await realpath(path.resolve(process.argv[2]!));
const resourcesPath = await realpath(path.resolve('resources'));
// The desktop's real wrapper must be present so this gate exercises its binary projection.
await realpath(path.join(resourcesPath, 'runtime', 'opencode-console', 'opencode.exe'));
async function preflight(binary?: string, pin?: { version: string; wire: 'floor' | 'current' }) {
  const desktop = await prepareNativeDesktopEnvironment();
  if (binary) {
    desktop.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = binary;
    applyOpenCodeRuntimeBinaryEnv(desktop.env, binary, { platform: 'win32', resourcesPath });
  }
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
let publicStopFailure = null;
let freshHandshakeFailure = null;
let exitCode = 0;
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
 const { inspectOpenCodeV2SourceAvailability, buildOpenCodeV2InternalRunPlan } = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2LaunchPlan.ts')).href)});
 const runOwner = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2RunOwner.ts')).href)});
 const { resolveOpenCodeV2ExecutionProbe } = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2ExecutionProbe.ts')).href)});
 const { spyOn } = await import('bun:test');
 const control = await import(${JSON.stringify(moduleUrl)});
 const freshProtocol = await import(${JSON.stringify(pathToFileURL(path.resolve('src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts')).href)});
 const freshClient = await import(${JSON.stringify(pathToFileURL(path.resolve('src/main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient.ts')).href)});
 const freshCausal = await import(${JSON.stringify(pathToFileURL(path.resolve('src/main/services/team/opencode/bridge/OpenCodeStateChangingCausalFailure.ts')).href)});
 preparation = await (${verifyProbePreparation.toString()})(inspectOpenCodeV2SourceAvailability,
   resolveOpenCodeV2ExecutionProbe, buildOpenCodeV2InternalRunPlan, runOwner, control, spyOn, ${JSON.stringify(desktop.projectPath)},
   ${JSON.stringify(selectedModel)}, ${JSON.stringify(pin)},
   (phase, facts) => { stage=phase; startupFacts=facts; },
   // A plain V2 process has no native sandbox state to snapshot; the stage and facts name the failure.
   async () => {}, (error) => { publicStopFailure = error; },
   async (owner, plan, timeoutMs) => {
     try { return await (${verifyFreshOriginalOwnerBoundary.toString()})({
       sdk:${JSON.stringify(sdk)},testRoot:${JSON.stringify(desktop.root)},projectPath:${JSON.stringify(desktop.projectPath)},
       owner,plan,timeoutMs,selectedModel:${JSON.stringify(selectedModel)},
       client:freshClient.createOpenCodeBridgeClientIdentity({appVersion:'TEST-source-preflight'})
     }, {parse:freshProtocol.parseSingleBridgeJsonResult,validate:freshProtocol.validateBridgeResultEnvelope,
       failure:freshClient.createOpenCodeBridgeHandshakeFailure}); }
     catch (error) { freshHandshakeFailure = freshCausal.ownedOpenCodeHandshakeFailure(error) ?? null; throw error; }
   });
 // False readiness also opens the store: run it only AFTER the cold preparation.
 stage='readiness';
 await (${verifyModelFreeReadiness.toString()})(executeSelectedOpenCodeBridgeCommandEnvelope,
   executeOpenCodeBridgeCommandEnvelope,${JSON.stringify(desktop.projectPath)},${JSON.stringify(pin?.version)},${JSON.stringify(selectedModel)});`
     : ''
 }
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:true,stage,preparation,startupFacts,version:${JSON.stringify(pin?.version ?? null)}}));
} catch (error) {
 const missing = /^readiness_file_missing:(owner_discovery|source_availability|execution_probe)$/.exec(error?.message ?? '');
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:false,stage,freshHandshakeFailure,startupFacts,
   code:missing||(stage==='probe-controller-state'&&error?.code==='ENOENT')?'readiness_file_missing':'source_gate_unknown',role:missing?.[1]??'unknown',
   publicStopFailure:publicStopFailure===null?null:(${safeSourceGateFailure.toString()})(publicStopFailure),
   ...(${safeSourceGateFailure.toString()})(error)}));
 exitCode = 1;
}
process.exit(exitCode);`;
  // Windows CreateProcess caps the quoted command line at 32767 UTF-16 units.
  // Keep the complete generated source in this fresh TEST root instead.
  const childScript = path.join(desktop.root, 'source-preflight-child.mjs');
  await writeFile(childScript, script, { flag: 'wx', mode: 0o600 });
  let output = '';
  let code = 0;
  let childFailure = 'unclassified';
  try {
    ({ stdout: output } = await promisify(execFile)(process.execPath, [childScript], {
      cwd: sdk,
      env: {
        ...desktop.env,
        OPENROUTER_API_KEY: 'TEST-noncredential',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpEntry,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: mcpNode,
        // Desktop's bridge projects getClaudeBasePath() after the Electron override.
        AGENT_TEAMS_MCP_CLAUDE_DIR: desktop.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT,
      },
      timeout: binary ? 330_000 : 45_000,
      maxBuffer: 65_536,
    }));
  } catch (error: unknown) {
    code = 1;
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string')
      output = error.stdout;
    const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    childFailure = ['E2BIG', 'ENAMETOOLONG', 'ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT'].find((value) => value === failure.code) ??
      (typeof failure.stderr === 'string' && /\bSyntaxError:/.test(failure.stderr) ? 'child_syntax_error' :
        typeof failure.stderr === 'string' && /\bReferenceError:/.test(failure.stderr) ? 'child_reference_error' : 'unclassified');
  }
  const receipts = output.split(/\r?\n/).filter((line) => line.startsWith('TEST_SOURCE_GATE='));
  if (receipts.length === 0) console.log(JSON.stringify({ scope: 'desktop TEST source child',
    ok: false, stage: 'child_startup', reason: childFailure }));
  assert.equal(receipts.length, 1, 'Source preflight receipt unavailable');
  const receipt: unknown = JSON.parse(receipts[0]!.slice('TEST_SOURCE_GATE='.length));
  assert(receipt && typeof receipt === 'object' && 'ok' in receipt);
  console.log(
    JSON.stringify({ scope: 'desktop TEST setup -> native startup/MCP/physical stop without prompts', ...receipt })
  );
  assert.equal(code, 0, 'Source discovery gate failed; do not package or submit model tasks');
}
await preflight();
const binary = process.argv[3]!;
assert(path.isAbsolute(binary));
await preflight(await realpath(binary), { version: currentPin, wire: 'current' });
