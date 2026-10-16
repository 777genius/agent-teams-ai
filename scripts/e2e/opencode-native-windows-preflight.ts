/** No Electron package, real credentials or prompts: real native startup, MCP and physical stop. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyOpenCodeRuntimeBinaryEnv } from '../../src/main/services/runtime/openCodeRuntimeBinaryEnv';
import { prepareNativeDesktopEnvironment } from './opencode-native-desktop-environment';
import { protectWindowsTestDirectory } from './opencode-native-test-auth';

type ReadinessExecutor = (
  input: unknown,
  executeV1: (input: unknown) => Promise<unknown>
) => Promise<unknown>;

function safeSourceGateFailure(error: unknown, nativeFailures?: WeakMap<object, string>): { reason: string; errno: string | null; primaryNativeOperation: string; causal: unknown } {
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
    'TEST private DLL profile invalid': 'private_dll_profile_invalid',
    'TEST private DLL leaf invalid': 'private_dll_leaf_invalid',
    'TEST private DLL custody invalid': 'private_dll_custody_invalid',
    'TEST private DLL mutation admitted': 'private_dll_mutation_admitted',
    'TEST private DLL custody changed': 'private_dll_custody_changed',
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
  'run_deadline_expired', 'run_readiness_changed', 'run_readiness_unknown', 'run_operation_unknown',
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

// Observe rejection identity only; no request data, error text, or history is retained.
function observeNativeBrokerFailures(
  module: { createWindowsNativeBroker(artifact: unknown): {
    request(operation: string, input?: Readonly<Record<string, unknown>>, deadline?: number, signal?: AbortSignal): Promise<unknown>;
  } },
  spyOn: (target: typeof module, key: 'createWindowsNativeBroker') => {
    mockImplementation(fn: typeof module.createWindowsNativeBroker): void; mockRestore(): void;
  },
  failures: WeakMap<object, string>,
  launches: unknown[]
) {
  const operations = new Set(['identity', 'assertLive', 'launch', 'send', 'retire', 'selfImageCustody',
    'ownerOpenDirectory', 'ownerPreparePrivateDirectory', 'ownerAssertDirectory', 'ownerCloseDirectory',
    'ownerValidateSelectedProfile', 'ownerSelectConfig', 'ownerInspectProfileConfig', 'ownerArchive',
    'ownerCreatePreparedDatabase', 'ownerWritePreparedConfig', 'ownerWritePreparedAuth', 'ownerReadMetadata', 'ownerWriteMetadata',
    'ownerReadRecord', 'ownerWriteExclusive', 'runStateAcquire', 'runStateSelect', 'runStateDiscover',
    'runStateReserve', 'runStateReadRecord', 'runStateWriteRecord', 'runStateReadStop', 'runStateOwnerRetired',
    'runStateProcessIdentity', 'runStateValidateEndpoint', 'runStateRequest', 'runStateListen',
    'runStateRespond', 'runStatePoisonConnection', 'runStateClose', 'runStateReadControllerInbox']);
  const originalFactory = module.createWindowsNativeBroker;
  const observer = spyOn(module, 'createWindowsNativeBroker');
  observer.mockImplementation(function (this: unknown, artifact) {
    const broker = Reflect.apply(originalFactory, this, [artifact]);
    let launch: Record<string, unknown> | undefined;
    const descriptors = Object.getOwnPropertyDescriptors(broker), request = broker.request;
    if (!descriptors.request || typeof request !== 'function') throw new Error('TEST native broker shape invalid');
    descriptors.request = { ...descriptors.request, value: function (...args: Parameters<typeof request>) {
      const rejected = (error: unknown): never => {
        if (error && typeof error === 'object') {
          const operation = operations.has(args[0]) ? args[0] : 'unknown', previous = failures.get(error);
          failures.set(error, previous && previous !== operation ? 'unknown' : operation);
        }
        throw error;
      };
      try { return Reflect.apply(request, broker, args).then((result) => {
        // Retain only this TEST launch's selected roots and validated prepare
        // anchors. Never retain the launch environment or alter an RPC result.
        try {
          const input = args[1], value = input?.value;
          if (args[0] === 'launch' && input) launch = {
            entry: input.entry, cwd: input.cwd, executable: input.executable,
            nonce: input.nonce, leaseOwnerId: input.leaseOwnerId,
            readOnlyRoots: input.readOnlyRoots, writableRoots: input.writableRoots,
          };
          if (args[0] === 'send' && launch && value && typeof value === 'object' &&
              'type' in value && value.type === 'prepare' && 'nonce' in value && value.nonce === launch.nonce &&
              'leaseOwnerId' in value && value.leaseOwnerId === launch.leaseOwnerId &&
              'realpathAnchors' in value && launches.length < 8) {
            launches.push(structuredClone({ ...launch, realpathAnchors: value.realpathAnchors }));
          }
        } catch { /* Diagnostic capture cannot change launch or transport semantics. */ }
        return result;
      }, rejected); }
      catch (error) { return rejected(error); }
    } };
    return Object.freeze(Object.create(Object.getPrototypeOf(broker), descriptors)) as typeof broker;
  });
  return observer;
}

// Parent joins only exact immutable graph rows to the actual native launch.
// All paths remain local; receipts contain fixed roles, indices and hashes.
async function graphFailureCoverage(value: unknown, planValue: unknown, launches: unknown[], sdkRoot: string, ownerValue: unknown): Promise<unknown> {
  const row = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
  const integer = (v: unknown, minimum: number, maximum: number): v is number => Number.isSafeInteger(v) && Number(v) >= minimum && Number(v) <= maximum;
  const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const failure = row(value), realpath = row(failure.realpath);
  if (!keys(failure, ['index', 'total', 'pathSha256', 'contentSha256', 'readPhase', 'realpath']) || (failure.readPhase !== 'realpath' && failure.readPhase !== 'hash') ||
      !integer(failure.total, 1, 65536) || !integer(failure.index, 0, failure.total - 1) || !hash(failure.pathSha256) || !hash(failure.contentSha256) ||
      (failure.realpath !== undefined && (!keys(realpath, ['status', 'operation', 'win32', 'anchorCount', 'matchingAnchorIndex']) ||
        !integer(realpath.status, 1, 4) || !integer(realpath.operation, 0, 25) || !integer(realpath.win32, 0, 0xffffffff) ||
        !integer(realpath.anchorCount, 0, 4096) || !integer(realpath.matchingAnchorIndex, -1, realpath.anchorCount - 1)))) return undefined;
  const packet = { index: failure.index, total: failure.total, pathSha256: failure.pathSha256, contentSha256: failure.contentSha256, readPhase: failure.readPhase,
    ...(failure.realpath === undefined ? {} : { realpath: { status: realpath.status, operation: realpath.operation, win32: realpath.win32,
      anchorCount: realpath.anchorCount, matchingAnchorIndex: realpath.matchingAnchorIndex } }) };
  try {
    const p = await import('node:path'), { createHash } = await import('node:crypto'), { pathToFileURL } = await import('node:url');
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const plan = row(planValue), members = plan.members, owner = row(ownerValue);
    if (!Array.isArray(members) || members.length < 1 || members.length > 3) throw new Error();
    const selectedMembers = members.map(row).filter(member => row(member.profile).root === owner.profileRoot);
    if (selectedMembers.length !== 1) return { ...packet, coverage: { observation: 'owner_unavailable' } };
    const member = selectedMembers[0]!, native = row(member.native), profile = row(member.profile), source = row(plan.source), files = row(native.graph).files;
    if (!Array.isArray(files) || files.length !== failure.total || typeof source.entryPath !== 'string') throw new Error();
    const sorted = files.map(row).sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0), target = sorted[failure.index]!;
    if (typeof target.path !== 'string' || digest(target.path) !== failure.pathSha256 || target.sha256 !== failure.contentSha256)
      return { ...packet, coverage: { observation: 'graph_row_mismatch' } };
    const { resolveOpenCodeV2ExecutionDelivery } = await import(pathToFileURL(p.join(sdkRoot, 'src/services/opencode/host/OpenCodeV2ExecutionDelivery.ts')).href);
    const delivery = await resolveOpenCodeV2ExecutionDelivery(pathToFileURL(source.entryPath).href, 'execution');
    if (delivery.entrySha256 !== native.entrySha256) throw new Error();
    if (owner.schema !== 1 || owner.generation !== 'v2' || owner.profileRoot !== profile.root || owner.databasePath !== profile.databasePath ||
        owner.profileEpoch !== profile.epoch || owner.graphSha256 !== row(native.graph).sha256)
      return { ...packet, coverage: { observation: 'owner_unavailable' } };
    const matching = launches.map(row).filter(launch => launch.entry === delivery.entryPath && launch.cwd === profile.directory &&
      launch.executable === row(native.bun).path && launch.nonce === owner.hostInstanceId && launch.leaseOwnerId === owner.leaseOwnerId);
    if (matching.length !== 1) return { ...packet, coverage: { observation: 'launch_unavailable' } };
    const launch = matching[0]!, receipt = row(launch.realpathAnchors), anchors = receipt.anchors;
    const readOnlyRoots = launch.readOnlyRoots, writableRoots = launch.writableRoots;
    const rootPath = (v: unknown): v is string => typeof v === 'string' && p.win32.isAbsolute(v) && v.length <= 32767 && !v.includes('\0');
    if (!Array.isArray(readOnlyRoots) || !Array.isArray(writableRoots) || readOnlyRoots.length + writableRoots.length > 4096 ||
        !readOnlyRoots.every(rootPath) || !writableRoots.every(rootPath) || !Array.isArray(anchors) || anchors.length < 1 || anchors.length > 4096 || receipt.nonce !== launch.nonce) throw new Error();
    const expected = new Set([...readOnlyRoots.map(root => `readOnly:${root}`), ...writableRoots.map(root => `writable:${root}`)]);
    const held = anchors.map(row);
    if (held.length !== expected.size || held.some(anchor => (anchor.kind !== 'readOnly' && anchor.kind !== 'writable') || !rootPath(anchor.admittedPath) ||
        !rootPath(anchor.dosPath) || p.win32.relative(anchor.admittedPath, anchor.dosPath) !== '' || !expected.delete(`${anchor.kind}:${anchor.admittedPath}`)) || expected.size !== 0) throw new Error();
    const contains = (root: string, leaf: string) => { const relative = p.win32.relative(root, leaf); return relative === '' || relative !== '..' && !relative.startsWith('..\\') && !p.win32.isAbsolute(relative); };
    const depth = (root: string, leaf: string) => p.win32.relative(root, leaf).split('\\').filter(Boolean).length;
    const covering = held.map((anchor, index) => ({ anchor, index })).filter(({ anchor }) => contains(String(anchor.dosPath), String(target.path)));
    const first = covering[0];
    let longest = first;
    for (const entry of covering) if (!longest || String(entry.anchor.dosPath).length > String(longest.anchor.dosPath).length) longest = entry;
    const selected = longest?.anchor, roots = selected?.kind === 'writable' ? writableRoots : readOnlyRoots;
    const metadataOnlyResolutionAncestors = [];
    for (let ancestor = p.win32.dirname(target.path); p.win32.dirname(ancestor) !== ancestor; ancestor = p.win32.dirname(ancestor)) {
      if (p.win32.basename(ancestor).toLowerCase() === 'node_modules' && !held.some(anchor => contains(String(anchor.dosPath), ancestor)) &&
          held.some(anchor => contains(ancestor, String(anchor.dosPath))) && metadataOnlyResolutionAncestors.length < 16)
        metadataOnlyResolutionAncestors.push({ pathSha256: digest(ancestor), relativeDepth: depth(ancestor, target.path) });
    }
    return { ...packet, coverage: { observation: 'matched', readOnlyRootCount: readOnlyRoots.length, writableRootCount: writableRoots.length,
      contentRole: selected?.kind ?? 'none', rootIndex: selected ? roots.indexOf(String(selected.admittedPath)) : null,
      rootPathSha256: selected ? digest(String(selected.dosPath)) : null, relativeDepth: selected ? depth(String(selected.dosPath), target.path) : null,
      anchorCount: held.length, firstAnchorIndex: first?.index ?? -1, longestAnchorIndex: longest?.index ?? -1,
      childAnchorCountMatches: failure.realpath === undefined ? null : realpath.anchorCount === held.length,
      childFirstAnchorMatches: failure.realpath === undefined ? null : realpath.matchingAnchorIndex === (first?.index ?? -1), metadataOnlyResolutionAncestors } };
  } catch { return { ...packet, coverage: { observation: 'unavailable' } }; }
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

// Raw ACL shape observation only; never effective-access or native authority.
async function snapshotReadOnlyAcl(planValue: unknown, resolveDelivery: (location: string, child: 'execution') => Promise<{ root: string }>): Promise<unknown> {
  const deadline = Date.now() + 8000;
  let phase = 'plan';
  const unavailable = (reason: string) => ({ observation: 'unavailable', phase, reason });
  const work = async () => {
    const row = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    const p = await import('node:path'), fs = await import('node:fs/promises'), { createHash } = await import('node:crypto'), { pathToFileURL } = await import('node:url'), { execFile } = await import('node:child_process');
    const plan = row(planValue), source = row(plan.source), members = plan.members;
    if (typeof source.entryPath !== 'string' || !Array.isArray(members) || members.length < 1 || members.length > 3) return unavailable('plan_invalid');
    const native = row(row(members[0]).native), files = row(native.graph).files, bun = row(native.bun);
    if (!Array.isArray(files) || files.length > 65536 || typeof bun.path !== 'string' || typeof native.executablePath !== 'string') return unavailable('plan_invalid');
    phase = 'delivery';
    const delivery = await resolveDelivery(pathToFileURL(source.entryPath).href, 'execution');
    // This public license was the exact failed immutable graph row. Inspect only
    // matching bytes; post-stop metadata is not evidence of grants at failure.
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const licenseSha256 = '5b3af80f317313a8b8c227b0c8bffae67728cfec1786137b0553e625f2affec9';
    const licensePath = p.join(p.dirname(delivery.root), 'TEST-native-source', 'node_modules', '.pnpm',
      '@borewit+text-codec@0.2.1', 'node_modules', '@borewit', 'text-codec', 'LICENSE.txt');
    const selected = files.map(row).filter(file => file.path === licensePath && file.sha256 === licenseSha256);
    const chain: { path: string; relativeDepth: number; pathSha256: string; type: string; symbolicLink: boolean; nlink: number; fileIdSha256: string }[] = [];
    let targetObservation = 'graph_row_unavailable';
    if (selected.length === 1) {
      targetObservation = 'bytes_unavailable';
      try {
        const before = await fs.lstat(licensePath, { bigint: true });
        if (before.isFile() && !before.isSymbolicLink() && before.size === 1082n && digest(await fs.readFile(licensePath)) === licenseSha256) {
          const after = await fs.lstat(licensePath, { bigint: true });
          if (before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs) {
            for (let target = licensePath, relativeDepth = 0; relativeDepth < 9; target = p.dirname(target), relativeDepth++) {
              const stat = relativeDepth === 0 ? after : await fs.lstat(target, { bigint: true });
              if (stat.nlink < 0n || stat.nlink > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
              chain.push({ path: target, relativeDepth, pathSha256: digest(target), type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
                symbolicLink: stat.isSymbolicLink(), nlink: Number(stat.nlink), fileIdSha256: digest(`${stat.dev}:${stat.ino}`) });
              if (p.dirname(target) === target) break;
            }
            targetObservation = 'hash_bound';
          }
        }
      } catch { chain.length = 0; }
    }
    const dirs = files.map((f) => { const name = row(f).path; if (typeof name !== 'string') throw new Error('TEST ACL graph invalid'); return p.dirname(name); });
    const candidates = new Set<string>(), mounts: string[] = [];
    for (const start of new Set([delivery.root, ...dirs])) for (let dir = start; ; dir = p.dirname(dir)) {
      candidates.add(p.join(dir, 'node_modules')); if (p.dirname(dir) === dir) break;
    }
    phase = 'mounts';
    const targets = [...candidates];
    for (let index = 0; index < targets.length; index += 32) {
      if (Date.now() >= deadline) return unavailable('deadline');
      const results = await Promise.all(targets.slice(index, index + 32).map(async (target) => {
        const resolved = await fs.realpath(target).catch((e: unknown) => { if (row(e).code === 'ENOENT') return null; throw e; });
        return { target, resolved, directory: resolved === null || (await fs.lstat(resolved)).isDirectory() };
      }));
      for (const result of results) {
        if (result.resolved === null) continue;
        if (result.resolved !== result.target || !result.directory) return unavailable('mount_alias_or_type');
        mounts.push(result.resolved);
      }
    }
    const bunRoot = p.dirname(bun.path), cliRoot = await fs.realpath(p.dirname(p.dirname(native.executablePath)));
    const inside = (a: string, b: string) => { const r = p.win32.relative(a, b); return r === '' || r !== '..' && !r.startsWith('..\\') && !p.win32.isAbsolute(r); };
    phase = 'roots';
    const rawRoots = [...new Set([delivery.root, bunRoot, cliRoot, ...dirs, ...mounts])];
    for (let index = 0; index < rawRoots.length; index += 32) {
      if (Date.now() >= deadline) return unavailable('deadline');
      const results = await Promise.all(rawRoots.slice(index, index + 32).map(async (root) => await fs.realpath(root) === root));
      if (results.some((same) => !same)) return unavailable('root_alias');
    }
    const roots: string[] = [];
    for (const root of rawRoots) {
      if (roots.some((a) => inside(a, root))) continue;
      for (let i = roots.length - 1; i >= 0; i--) if (inside(root, roots[i]!)) roots.splice(i, 1);
      roots.push(root);
    }
    if (roots.length > 4096) return unavailable('root_budget');
    const taskNode = row(native.taskNode).path;
    const input = roots.map((root) => ({ path: root, rootClass: inside(root, delivery.root) ? 'sdk' : inside(root, bunRoot) ? 'bun' :
      inside(root, cliRoot) ? 'selected_cli' : typeof taskNode === 'string' && inside(root, taskNode) ? 'controller_runtime' : 'dependencies' }));
    const targetMetadata = { observation: targetObservation, captureTiming: 'after_public_stop', memberSidObservation: 'unavailable',
      contentSha256: licenseSha256, facts: chain.map(({ path: _path, ...metadata }) => metadata) };
    const command = [
      "$ErrorActionPreference='Stop'; function Principal($sid) { if($sid -eq $current){return 'current_user'}; switch($sid){",
      "'S-1-5-18' {'local_system';break};'S-1-5-32-544' {'administrators';break};'S-1-5-32-545' {'builtin_users';break};'S-1-5-11' {'authenticated_users';break};'S-1-1-0' {'everyone';break};'S-1-3-0' {'creator_owner';break};'S-1-3-1' {'creator_group';break};'S-1-15-2-1' {'all_application_packages';break};default{if($sid.StartsWith('S-1-15-2-')){'app_package'}else{'other'}}}}",
      "try{$psPhase='principal';$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$psPhase='input';$inputValue=[Console]::In.ReadToEnd()|ConvertFrom-Json;$inputs=@($inputValue.roots);$targets=@($inputValue.targets);if($inputs.Count -gt 4096 -or $targets.Count -gt 9){throw 'budget'};$facts=@();$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access;foreach($r in $targets){$psPhase='target_acl';$item=if($r.type -eq 'directory'){[IO.DirectoryInfo]::new($r.path)}else{[IO.FileInfo]::new($r.path)};$acl=[IO.FileSystemAclExtensions]::GetAccessControl($item,$sections);$sd=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);$aces=@();if($null -ne $sd.DiscretionaryAcl){if($sd.DiscretionaryAcl.Count -gt 64){throw 'budget'};foreach($ace in $sd.DiscretionaryAcl){if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.AceType.ToString() -notin @('AccessAllowed','AccessDenied')){throw 'shape'};$sid=[Text.Encoding]::UTF8.GetBytes($ace.SecurityIdentifier.Value);$aces+=@{sidSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($sid)).ToLowerInvariant();kind=$ace.AceType.ToString();mask=([long]$ace.AccessMask -band 4294967295L);flags=[int]$ace.AceFlags}}};$facts+=@{relativeDepth=$r.relativeDepth;reparsePoint=([int]$item.Attributes -band 1024) -ne 0;control=[int]$sd.ControlFlags;ownerClass=(Principal $sd.Owner.Value);nullDacl=($null -eq $sd.DiscretionaryAcl);aces=@($aces)}};$bad=@();foreach($r in $inputs){",
      "$psPhase='acl_read';$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access;$acl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($r.path),$sections);$psPhase='descriptor';$sd=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm($sections));$owner=Principal $sd.Owner.Value;$guard=$null;$principal='other';$flags=0;[long]$mask=0;",
      "if($owner -notin @('current_user','local_system','administrators')){$guard='owner'}elseif($null -eq $sd.DiscretionaryAcl){$guard='acl'}else{foreach($ace in $sd.DiscretionaryAcl){$psPhase='ace';",
      "if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.AceType.ToString() -notin @('AccessAllowed','AccessDenied')){$guard='ace_shape';break};$principal=Principal $ace.SecurityIdentifier.Value;$flags=[int]$ace.AceFlags;$mask=[long]$ace.AccessMask -band 4294967295L;",
      "$creator=$principal -eq 'creator_owner' -and ($flags -band 8) -ne 0 -and ($flags -band 3) -ne 0 -and ($flags -band (-bnot 27)) -eq 0;",
      "if($ace.AceType.ToString() -eq 'AccessAllowed' -and ($mask -band (-bnot 2685534377L)) -ne 0 -and !$creator -and $principal -notin @('current_user','local_system','administrators')){$guard='foreign_write';break}}}",
      "if($guard){$bad+=@{rootClass=$r.rootClass;guard=$guard;ownerClass=$owner;principalClass=$principal;inheritOnly=($flags -band 8) -ne 0;mutation=@{writeData=($mask -band 2) -ne 0;appendData=($mask -band 4) -ne 0;writeEA=($mask -band 16) -ne 0;writeAttributes=($mask -band 256) -ne 0;deleteChild=($mask -band 64) -ne 0;delete=($mask -band 65536) -ne 0;writeDac=($mask -band 262144) -ne 0;writeOwner=($mask -band 524288) -ne 0;genericWrite=($mask -band 1073741824) -ne 0;genericAll=($mask -band 268435456) -ne 0;otherMutation=($mask -band (-bnot (2685534377L -bor 2 -bor 4 -bor 16 -bor 256 -bor 64 -bor 65536 -bor 262144 -bor 524288 -bor 1073741824 -bor 268435456))) -ne 0}};if($bad.Count -eq 1){break}}};@{observation='raw_acl_shape_only';offenders=@($bad);targetAcl=@($facts)}|ConvertTo-Json -Depth 6 -Compress}catch{@{observation='unavailable';phase=$psPhase}|ConvertTo-Json -Compress}",
    ].join('\n');
    phase = 'powershell';
    const powershell = process.env.OPENCODE_TEST_ACL_POWERSHELL;
    if (!powershell || !p.win32.isAbsolute(powershell) || p.basename(powershell).toLowerCase() !== 'pwsh.exe' ||
        p.basename(p.dirname(powershell)) !== '7' || p.basename(p.dirname(p.dirname(powershell))).toLowerCase() !== 'powershell' ||
        await fs.realpath(powershell) !== powershell) return unavailable('powershell_unavailable');
    if (Date.now() >= deadline) return unavailable('deadline');
    let output: string;
    try { output = await new Promise<string>((resolve, reject) => {
      const child = execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { timeout: Math.max(1, Math.min(5000, deadline - Date.now())), maxBuffer: 131072, windowsHide: true }, (e, stdout) => e ? reject(e) : resolve(stdout));
      child.stdin?.on('error', () => {}); child.stdin?.end(JSON.stringify({ roots: input, targets: chain }));
    }); } catch { return { observation: 'unavailable', phase: 'powershell', reason: 'observation_failed', target: targetMetadata }; }
    phase = 'response';
    const result = row(JSON.parse(output)), principals = ['current_user', 'local_system', 'administrators', 'builtin_users', 'authenticated_users', 'everyone', 'creator_owner', 'creator_group', 'all_application_packages', 'app_package', 'other'];
    if (result.observation === 'unavailable') return { observation: 'unavailable', phase: 'powershell', reason: ['principal', 'input', 'target_acl', 'acl_read', 'descriptor', 'ace'].find((value) => value === result.phase) ?? 'unclassified', target: targetMetadata };
    if (result.observation !== 'raw_acl_shape_only' || !Array.isArray(result.offenders) || result.offenders.length > 1) return unavailable('response_invalid');
    const offenders = result.offenders.map((v) => {
      const item = row(v), mutation = row(item.mutation);
      if (!['sdk', 'bun', 'selected_cli', 'controller_runtime', 'dependencies'].includes(String(item.rootClass)) || !['owner', 'acl', 'ace_shape', 'foreign_write'].includes(String(item.guard)) ||
          !principals.includes(String(item.ownerClass)) || !principals.includes(String(item.principalClass)) || typeof item.inheritOnly !== 'boolean') throw new Error('TEST ACL response invalid');
      const bits = Object.fromEntries(['writeData', 'appendData', 'writeEA', 'writeAttributes', 'deleteChild', 'delete', 'writeDac', 'writeOwner', 'genericWrite', 'genericAll', 'otherMutation'].map((key) => {
        if (typeof mutation[key] !== 'boolean') throw new Error('TEST ACL response invalid'); return [key, mutation[key]];
      }));
      return { rootClass: item.rootClass, guard: item.guard, ownerClass: item.ownerClass, principalClass: item.principalClass, inheritOnly: item.inheritOnly, mutation: bits };
    });
    const targetAclFacts = (value: unknown) => {
      if (!Array.isArray(value) || value.length !== chain.length) throw new Error('TEST target ACL response invalid');
      return value.map((entry, index) => {
        const fact = row(entry), item = chain[index]!;
        if (fact.relativeDepth !== item.relativeDepth || !Number.isInteger(fact.control) || Number(fact.control) < 0 || Number(fact.control) > 65535 ||
            !principals.includes(String(fact.ownerClass)) || typeof fact.reparsePoint !== 'boolean' || typeof fact.nullDacl !== 'boolean' || !Array.isArray(fact.aces) || fact.aces.length > 64) throw new Error('TEST target ACL response invalid');
        const aces = fact.aces.map((entry) => { const ace = row(entry);
          if (typeof ace.sidSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ace.sidSha256) || !['AccessAllowed', 'AccessDenied'].includes(String(ace.kind)) ||
              !Number.isSafeInteger(ace.mask) || Number(ace.mask) < 0 || Number(ace.mask) > 0xffffffff || !Number.isInteger(ace.flags) || Number(ace.flags) < 0 || Number(ace.flags) > 255) throw new Error('TEST target ACL response invalid');
          return { sidSha256: ace.sidSha256, kind: ace.kind, mask: ace.mask, flags: ace.flags };
        });
        const { path: _path, ...metadata } = item;
        return { ...metadata, reparsePoint: fact.reparsePoint, control: fact.control, ownerClass: fact.ownerClass, nullDacl: fact.nullDacl, aces };
      });
    };
    return { observation: 'raw_acl_shape_only', offenders, target: { ...targetMetadata, facts: targetAclFacts(result.targetAcl) } };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work().catch(() => unavailable('observation_failed')), new Promise((resolve) => { timer = setTimeout(() => resolve(unavailable('deadline')), 8000); })]); }
  finally { clearTimeout(timer); }
}

// Diagnostic observation only: never substitutes for authenticated stop or retirement.
async function snapshotStartupFailure(value: unknown, session: string, plan: unknown, sdkRoot: string, nativeLaunches: unknown[]): Promise<unknown> {
  const row = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const one = (v: unknown, choices: readonly string[]) => choices.find((item) => item === v) ?? 'unclassified';
  const aliasFailure = (input: unknown) => {
    const value = row(input);
    const operations = ['assertLive', 'identity', 'launch', 'ownerArchive', 'ownerAssertDirectory', 'ownerCloseDirectory', 'ownerCreatePreparedDatabase', 'ownerInspectProfileConfig', 'ownerOpenDirectory', 'ownerPreparePrivateDirectory', 'ownerReadMetadata', 'ownerReadRecord', 'ownerSelectConfig', 'ownerValidateSelectedProfile', 'ownerWriteExclusive', 'ownerWriteMetadata', 'ownerWritePreparedAuth', 'ownerWritePreparedConfig', 'retire', 'runStateAcquire', 'runStateClose', 'runStateDiscover', 'runStateListen', 'runStateOwnerRetired', 'runStatePoisonConnection', 'runStateProcessIdentity', 'runStateReadControllerInbox', 'runStateReadRecord', 'runStateReadStop', 'runStateRequest', 'runStateReserve', 'runStateRespond', 'runStateSelect', 'runStateValidateEndpoint', 'runStateWriteRecord', 'selfImageCustody', 'send'];
    if (Object.keys(value).sort().join(',') !== 'operation,passed,predicate,sourceLine' ||
        !operations.some(operation => operation === value.operation) || value.passed !== false ||
        !Number.isSafeInteger(value.sourceLine) || Number(value.sourceLine) < 1 || Number(value.sourceLine) > 100000 ||
        !Number.isSafeInteger(value.predicate) || Number(value.predicate) < 0 || Number(value.predicate) > 4) return null;
    return { operation: value.operation, sourceLine: value.sourceLine, predicate: value.predicate, passed: false };
  };
  const acquisitionTiming = (input: unknown) => {
    const value = row(input);
    const phases = ['preparing', 'delivery-resolved', 'profile-validated', 'native-validated', 'graph-validated',
      'resolution-prepared', 'controller-prepared', 'prepared', 'mapping', 'child-bound', 'start-sent',
      'ready', 'catalog-ready', 'auth-ready', 'selection-ready'];
    if (Object.keys(value).sort().join(',') !== 'elapsedMs,history' || !Number.isSafeInteger(value.elapsedMs) ||
        Number(value.elapsedMs) < 0 || Number(value.elapsedMs) > 86400000 ||
        !Array.isArray(value.history) || value.history.length < 1 || value.history.length > 15) return null;
    const history: { phase: string; elapsedMs: number }[] = [];
    for (const item of value.history) {
      const entry = row(item);
      if (Object.keys(entry).sort().join(',') !== 'elapsedMs,phase' || typeof entry.phase !== 'string' ||
          !phases.includes(entry.phase) || !Number.isSafeInteger(entry.elapsedMs) ||
          Number(entry.elapsedMs) < (history.at(-1)?.elapsedMs ?? 0) || Number(entry.elapsedMs) > Number(value.elapsedMs) ||
          history.some(previous => previous.phase === entry.phase)) return null;
      history.push({ phase: entry.phase, elapsedMs: Number(entry.elapsedMs) });
    }
    if (history[0]?.phase !== 'preparing' || history[0].elapsedMs !== 0) return null;
    return { elapsedMs: Number(value.elapsedMs), history };
  };
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
    const read = async (parent: string, name: string, limit: number, presence = false, plain = false): Promise<Record<string, unknown>> => {
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
          return presence ? { observation: 'present' } : plain ? { observation: 'read', body: bytes.subarray(0, result.bytesRead).toString('utf8') } : { observation: 'read', data: row(JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'))) };
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
    const providerCodes = ['run_acquisition_timeout', 'run_initialization_timeout', 'run_stopped', 'cancelled', 'execution_path_alias', 'timeout', 'run_control_process_identity', 'provider_missing', 'provider_key_method_unsupported', 'provider_existing_credentials_unsupported',
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
  'execution_owner_read_only', 'execution_owner_unknown', 'execution_owner_write_through_pending'];
    const nativeStages = ['alias_predicate', 'assert_mapping', 'assert_stopped', 'assert_broker', 'retire_broker_state', 'retire_broker_write', 'retire_job', 'retire_wait', 'retire_io_join',
  'retire_main_exit', 'retire_owned_pair', 'retire_commands', 'retire_receipt', 'retire_grants',
  'retire_grants_dll', 'retire_grants_roots', 'retire_grants_metadata', 'process_birth', 'process_image_path', 'process_image_open', 'process_birth_changed',
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
      'shared_readonly_owner_changed', 'shared_readonly_control_changed', 'shared_readonly_foreign_changed', 'shared_readonly_member_missing'];
    const members = (v: unknown) => Array.isArray(v) ? v.slice(0, 3).map((item) => {
      const member = row(item), bootstrap = row(member.bootstrap), cleanup = row(member.cleanup);
      return { memberMatches: Array.isArray(row(plan).members) && (row(plan).members as unknown[]).some(value => row(value).memberId === member.memberId), state: one(member.state, ['accepted', 'unknown', 'rejected']),
        originalSessionMatches: member.originalSessionId === session, runtimeSessionMatches: member.runtimeSessionId === session,
        opencodeSessionMatches: member.opencodeSessionId === session, bootstrapVerified: bootstrap.verified === true,
        missingNativeMessageID: bootstrap.missingNativeMessageID === true, scopeClosed: cleanup.scopeClosed === true,
        processRetired: cleanup.processRetired === true, descendantsRetired: cleanup.descendantsRetired === true,
        errors: Array.isArray(member.errors) ? member.errors.slice(0, 8).map((code) => one(code,
          ['tombstone_unknown', 'cancel_or_interrupt_unknown', 'readers_unknown', 'physical_cleanup_unknown', 'run_tombstone_unknown'])) : [] };
    }) : [];
    const selectedMembers = row(plan).members;
    const matches = Array.isArray(selectedMembers) && selectedMembers.length <= 3 ? selectedMembers.map(row).filter(member => member.originalSessionId === session) : [];
    const selectedMember = matches.length === 1 ? matches[0]! : {};
    const selectedProfileRoot = row(selectedMember.profile).root;
    const executionOwner = typeof selectedProfileRoot === 'string' && paths.dirname(selectedProfileRoot) === paths.join(root, 'opencode', 'v2', 'profiles') &&
        /^[a-f0-9]{16}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(paths.basename(selectedProfileRoot))
      ? row((await read(paths.join(selectedProfileRoot, '.opencode-v2-execution-owner'), 'owner.json', 16384)).data) : {};
    const diagnostics = [], diagnosticRoot = paths.join(root, 'opencode', 'v2', 'provider-diagnostics');
    try {
      const listing = await fs.opendir(diagnosticRoot);
      try { for await (const entry of listing) {
        if (!/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
        const result = await read(diagnosticRoot, entry.name, 16384), data = row(result.data), native = row(data.native);
        const nativeStage = nativeStages.find((stage) => stage === native.stage);
        const startup = row(data.startup), acquisition = acquisitionTiming(data.acquisition);
        const startupElapsedMs = Number.isSafeInteger(startup.elapsedMs) && Number(startup.elapsedMs) >= 0 && Number(startup.elapsedMs) <= 86400000 ? Number(startup.elapsedMs) : null;
        const startupHistory: { stage: string; elapsedMs: number }[] = [];
        if (Array.isArray(startup.history) && startup.history.length <= 10) {
          for (const value of startup.history) {
            const item = row(value), stage = one(item.stage, ['windows-cohort', 'windows-profile', 'windows-roots', 'windows-dll', 'windows-process', 'windows-owned-pair', 'windows-published', 'windows-connected', 'windows-prepare', 'windows-assert']);
            if (stage === 'unclassified' || startupElapsedMs === null || !Number.isSafeInteger(item.elapsedMs) || Number(item.elapsedMs) < (startupHistory.at(-1)?.elapsedMs ?? 0) || Number(item.elapsedMs) > startupElapsedMs || startupHistory.some(entry => entry.stage === stage)) {
              startupHistory.length = 0; break;
            }
            startupHistory.push({ stage, elapsedMs: Number(item.elapsedMs) });
          }
        }
        const nativeFailure = nativeStage && typeof native.nativeCode === 'number' && Number.isSafeInteger(native.nativeCode) &&
          native.nativeCode >= 0 && native.nativeCode <= 0xffffffff ? { stage: nativeStage, nativeCode: native.nativeCode } : null;
        diagnostics.push({ observation: result.observation, phase: one(data.phase, ['execution-host-startup', 'run-owner-initialization', 'run-member-retirement']),
          category: one(data.category, providerCodes), native: nativeFailure, alias: aliasFailure(data.alias),
          failure: data.failure === undefined ? null : {
            name: one(row(data.failure).name, ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'AbortError']),
            errno: one(row(data.failure).errno, ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'UNKNOWN', 'EIO', 'ENOSYS']),
            operation: one(row(data.failure).operation, ['realpath', 'open', 'read', 'lstat', 'stat']),
          }, startupReason: data.startup === undefined ? null : one(row(data.startup).reason, ['timeout', 'failed']), startupStage: data.startup === undefined ? null : one(row(data.startup).stage,
            ['windows-cohort', 'windows-profile', 'windows-roots', 'windows-dll', 'windows-process', 'windows-owned-pair', 'windows-published', 'windows-connected', 'windows-prepare', 'windows-assert', 'waiting-for-prepare', 'profile-validation', 'native-validation', 'graph-validation', 'waiting-for-activation', 'runtime-import', 'server-start', 'effect-import', 'selected-oauth-import', 'scope-acquisition', 'ready-identity']),
          startupElapsedMs, startupHistory, graphFailure: await graphFailureCoverage(startup.graphFailure, plan, nativeLaunches, sdkRoot, executionOwner),
          cleanupPhase: one(row(data.cleanup).phase, ['dispose-transport', 'send-close', 'force-kill', 'wait-exit', 'read-birth', 'kernel-retirement', 'process-retirement', 'closed-ack', 'kernel-proof', 'kernel-binding', 'owner-release', 'retained-roots', 'plan-close']),
          cleanupNativePhase: ['kernel-retirement', 'force-kill'].some(phase => phase === row(data.cleanup).phase)
            ? one(row(data.cleanup).nativePhase, ['retire_job', 'retire_wait', 'retire_io_join', 'retire_main_exit', 'retire_owned_pair', 'retire_commands', 'retire_receipt', 'retire_grants', 'retire_grants_dll', 'retire_grants_roots', 'retire_grants_metadata']) : 'unclassified',
          cleanupElapsedMs: Number.isSafeInteger(row(data.cleanup).elapsedMs) && Number(row(data.cleanup).elapsedMs) >= 0 && Number(row(data.cleanup).elapsedMs) <= 86400000 ? Number(row(data.cleanup).elapsedMs) : null,
          startupStderrKind: one(startup.nativeStderrKind, ['empty', 'entry_resolution', 'module_resolution', 'child_identity', 'child_pipe', 'access_denied', 'pipe_refused', 'pipe_missing', 'bun_error', 'unclassified', 'unavailable']),
          startupExitCode: Number.isSafeInteger(startup.nativeExitCode) && Number(startup.nativeExitCode) >= 0 && Number(startup.nativeExitCode) <= 0xffffffff ? startup.nativeExitCode : null,
          initializationPhase: data.initialization === undefined ? null : one(row(data.initialization).phase, ['MCP-connect', 'MCP-readback', 'controller-tools', 'probe-authority']),
          acquisitionLastPhase: acquisition?.history.at(-1)?.phase ?? null,
          acquisitionElapsedMs: acquisition?.elapsedMs ?? null, acquisitionHistory: acquisition?.history ?? [] });
        if (diagnostics.length === 4) break;
      } } finally { await listing.close().catch(() => {}); }
    } catch { /* Diagnostic absence is not evidence of process retirement. */ }
    let stdio: { observation: string; kind: string; errorLine?: string; readTargetKind?: string; readErrorCode?: string; readTargetLocation?: string; readTargetAncestorDistance?: number; childStartup?: { stage: string; cause: string; reason: string; errno: string; operation: string; errorName: string; profileGuard: string; environmentMismatchKeys: string[]; graphFailure?: unknown; elapsedMs: number | null; graph: { phase: string; completed: number | null; total: number | null } } } = { observation: 'unavailable', kind: 'unavailable' };
    try {
      const profileRoot = row(selectedMember.profile).root;
      if (matches.length !== 1 || typeof profileRoot !== 'string' ||
          paths.dirname(profileRoot) !== paths.join(root, 'opencode', 'v2', 'profiles') ||
          !/^[a-f0-9]{16}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(paths.basename(profileRoot)))
        throw new Error('TEST fixed stdio profile invalid');
      const ownerRoot = paths.join(profileRoot, '.opencode-v2-execution-owner');
      const parents = [profileRoot, ownerRoot];
      const pins = await Promise.all(parents.map(async parent => {
        const pin = await fs.lstat(parent, { bigint: true });
        if (!pin.isDirectory() || pin.isSymbolicLink() || await fs.realpath(parent) !== parent)
          throw new Error('TEST fixed stdio parent invalid');
        return pin;
      }));
      const leaves = (await fs.readdir(ownerRoot)).filter(name => /^native-stdio-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name));
      if (leaves.length !== 1) stdio = { observation: leaves.length === 0 ? 'missing' : 'unavailable', kind: 'unavailable' };
      else {
        const result = await read(paths.join(ownerRoot, leaves[0]!), 'main.stderr', 16384, false, true);
        let kind = 'unavailable', errorLine: string | undefined, readTargetKind: string | undefined, readErrorCode: string | undefined, readTargetLocation: string | undefined, readTargetAncestorDistance: number | undefined, childStartup: { stage: string; cause: string; reason: string; errno: string; operation: string; errorName: string; profileGuard: string; environmentMismatchKeys: string[]; graphFailure?: unknown; elapsedMs: number | null; graph: { phase: string; completed: number | null; total: number | null } } | undefined;
        if (result.observation === 'read' && typeof result.body === 'string') {
          kind = result.body.length === 0 ? 'empty' : 'unclassified';
          for (const line of result.body.split('\n')) {
            const message = line.trimStart();
            if (message.startsWith('{')) {
              try {
                const event = row(JSON.parse(message));
                if (event.event === 'opencode-v2-startup') childStartup = {
                  stage: one(event.stage, ['waiting-for-prepare', 'delivery-resolution', 'profile-validation', 'native-validation', 'graph-validation', 'waiting-for-activation', 'runtime-import', 'server-start', 'effect-import', 'selected-oauth-import', 'scope-acquisition', 'ready-identity']),
                  cause: one(event.cause, ['execution_contract_invalid', 'execution_identity_mismatch', 'execution_entry_changed', 'v2_compiled_runtime_unsupported', 'v2_execution_layout_unsupported', 'execution_profile_changed', 'execution_graph_changed', 'execution_graph_incomplete', 'execution_graph_dependency_missing', 'execution_containment_identity_mismatch', 'execution_timeout', 'execution_cancelled']),
                  reason: one(event.reason, ['timeout', 'failed']),
                  elapsedMs: Number.isSafeInteger(event.elapsedMs) && Number(event.elapsedMs) >= 0 ? Number(event.elapsedMs) : null,
                  graph: { phase: one(row(event.graph).phase, ['hash', 'closure']),
                    completed: Number.isSafeInteger(row(event.graph).completed) && Number(row(event.graph).completed) >= 0 && Number(row(event.graph).completed) <= 65536 ? Number(row(event.graph).completed) : null,
                    total: Number.isSafeInteger(row(event.graph).total) && Number(row(event.graph).total) >= 0 && Number(row(event.graph).total) <= 65536 ? Number(row(event.graph).total) : null },
                  graphFailure: await graphFailureCoverage(event.graphFailure, plan, nativeLaunches, sdkRoot, executionOwner),
                  errno: one(event.errno, ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'UNKNOWN', 'EIO', 'ENOSYS']),
                  operation: one(event.operation, ['realpath', 'open', 'read', 'lstat', 'stat']),
                  errorName: one(event.errorName, ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'AbortError']),
                  profileGuard: one(event.profileGuard, ['environment_hash', 'config_hash', 'home_mapping', 'path_containment', 'database_type', 'models_type', 'models_hash', 'process_cwd', 'process_pwd', 'process_environment']),
                  environmentMismatchKeys: Array.isArray(event.environmentMismatchKeys) ? event.environmentMismatchKeys.slice(0, 25).map(value => one(value, ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'NO_COLOR', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'OPENCODE_CONFIG_DIR', 'AGENT_TEAMS_MCP_CLAUDE_DIR', 'OPENSSL_CONF', 'other'])) : [],
                };
              } catch { /* Only the fixed structured startup event is observed. */ }
            }
            if (!/^(?:error|Error): /.test(message)) continue;
            kind = 'bun_error';
            // Fixed TEST diagnostic roles only: never publish the denied path.
            if (readTargetKind === undefined && /^error: (?:EPERM reading |Cannot read file )/.test(message)) {
              const match = /["'`]([^"'`]+)["'`](?::\s*(EPERM|EACCES|ENOENT|ENOTDIR|EISDIR))?\s*$/.exec(message);
              const target = match?.[1]; readErrorCode = match?.[2];
              if (target !== undefined && paths.win32.isAbsolute(target)) {
                const directory = paths.win32.normalize(target), source = paths.win32.normalize(sdkRoot);
                const relative = paths.win32.relative(source, directory);
                readTargetLocation = relative === '' ? 'sdk_root' :
                  !paths.win32.isAbsolute(relative) && relative.split('\\').every(part => part === '..') ? 'sdk_ancestor' :
                  !paths.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\') ? 'sdk_descendant' :
                  paths.win32.relative(process.cwd(), directory) === '' ? 'desktop_root' :
                  paths.win32.relative(profileRoot, directory) === '' ? 'profile_root' : 'other';
                if (readTargetLocation === 'sdk_ancestor') readTargetAncestorDistance = relative.split('\\').length;
              }
              const leaf = target?.split(/[\\/]/).at(-1);
              const roles: Record<string, string> = { 'package.json': 'package_manifest',
                'tsconfig.json': 'typescript_config', 'bunfig.toml': 'bun_config',
                'opencodeV2ExecutionServer.ts': 'execution_entry', 'opencodeV2ExecutionServer.js': 'execution_entry',
                'opencodeV2RunOwner.ts': 'owner_entry', 'opencodeV2RunOwner.js': 'owner_entry' };
              readTargetKind = target !== undefined && /[\\/]$/.test(target) ? 'package_scope_directory' :
                leaf !== undefined && Object.hasOwn(roles, leaf) ? roles[leaf] :
                leaf?.endsWith('.json') ? 'json_file' : leaf?.endsWith('.node') ? 'native_module' :
                leaf?.endsWith('.dll') ? 'native_library' : /\.[cm]?js$/.test(leaf ?? '') ? 'javascript_module' :
                /\.[cm]?tsx?$/.test(leaf ?? '') ? 'typescript_module' : 'other';
            }
            if (errorLine === undefined) {
              // TEST-only text: sanitize the complete bounded line before truncation.
              let clean = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
              if (clean.includes('\x1b')) clean = 'error: [terminal control text redacted]';
              clean = clean.replace(/[^\x20-\x7e]/g, '');
              if (/\b(?:authorization|bearer|password|token|secret|api[_-]?key|cookie)\b/i.test(clean)) clean = 'error: [credential-labelled text redacted]';
              else {
                let quoted = '', offset = 0;
                while (offset < clean.length) {
                  const quote = clean[offset]!;
                  if (quote !== '"' && quote !== "'" && quote !== '`') { quoted += quote; offset++; continue; }
                  quoted += '[value]'; offset++;
                  while (offset < clean.length) {
                    if (clean[offset] === '\\') { offset += 2; continue; }
                    if (clean[offset++] === quote) break;
                  }
                }
                clean = quoted.replace(/(?:https?:\/\/|[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/).*$/g, '[path]')
                  .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\b/g, '[email]')
                  .replace(/[A-Za-z0-9_+=/-]{20,}/g, value => value === 'CouldntReadCurrentDirectory' ? value : '[value]');
              }
              errorLine = clean.slice(0, 256);
            }

            const rules = [['Unable to resolve entry point', 'entry_resolution'], ['Cannot find module', 'module_resolution'],
              ['execution_containment_identity_mismatch', 'child_identity'], ['execution_containment_pipe_denied', 'child_pipe'],
              ['EACCES', 'access_denied'], ['EPERM', 'access_denied'], ['Access is denied', 'access_denied'],
              ['ECONNREFUSED', 'pipe_refused'], ['connect ENOENT', 'pipe_missing']] as const;
            const matched = rules.find(([token]) => message.includes(token));
            if (matched) { kind = matched[1]; break; }
          }
        }
        stdio = { observation: one(result.observation, ['read', 'missing', 'unavailable']), kind, ...(errorLine === undefined ? {} : { errorLine }), ...(readTargetKind === undefined ? {} : { readTargetKind }), ...(readErrorCode === undefined ? {} : { readErrorCode }), ...(readTargetLocation === undefined ? {} : { readTargetLocation }), ...(readTargetAncestorDistance === undefined ? {} : { readTargetAncestorDistance }), ...(childStartup === undefined ? {} : { childStartup }) };
      }
      for (let index = 0; index < parents.length; index++) {
        const parent = parents[index]!;
        if (!same(pins[index]!, await fs.lstat(parent, { bigint: true })) || await fs.realpath(parent) !== parent)
          stdio = { observation: 'unavailable', kind: 'unavailable' };
      }
    } catch (error) { stdio = { observation: row(error).code === 'ENOENT' ? 'missing' : 'unavailable', kind: 'unavailable' }; }
    return { observation: 'snapshot_only', stdio, state: { observation: state.observation,
      state: one(stateData.state, ['starting', 'active', 'stopping', 'stopped', 'cleanup_unknown']), members: members(stateData.members) },
      operation: { observation: operation.observation, operation: one(failure.operation,
        ['send', 'observe', 'transcript', 'permissions', 'permissionReply', 'mcp', 'status', 'probeEvidence', 'stop']), category: one(failure.category, [...codes, 'run_control_pump_failed']),
        controlPhase: one(failure.controlPhase, ['accept_wait', 'accept_authenticate', 'accept_replenish', 'read_frame', 'verify_frame', 'validate_payload', 'publish_request']),
        controlCode: one(failure.controlCode, ['cleanup_unknown', 'run_control_accept_timeout', 'run_control_accept_unknown', 'run_control_connect_unknown', 'run_control_connection_limit', 'run_control_disconnected', 'run_control_endpoint_changed', 'run_control_foreign', 'run_control_frame_invalid', 'run_control_frame_oversize', 'run_control_held_identity', 'run_control_held_inputs', 'run_control_hmac_unknown', 'run_control_image_changed', 'run_control_image_hash', 'run_control_listen_unknown', 'run_control_owner_identity', 'run_control_package_peer_identity', 'run_control_parent_birth', 'run_control_parent_join', 'run_control_path_alias', 'run_control_peer_identity', 'run_control_pipe_name', 'run_control_pipe_security', 'run_control_process_identity', 'run_control_pump_unknown', 'run_control_read_unknown', 'run_control_timeout', 'run_control_write_partial', 'run_control_write_unknown', 'run_process_changed', 'run_state_acl_unknown', 'run_state_challenge_changed', 'run_state_challenge_unknown', 'run_state_endpoint_changed', 'run_state_endpoint_missing', 'run_state_held_inputs', 'run_state_identity_changed', 'run_state_record_absent', 'run_state_record_changed', 'run_state_record_collision', 'run_state_record_encoding', 'run_state_record_name', 'run_state_record_read', 'run_state_record_rename', 'run_state_record_size', 'run_state_record_temporary', 'run_state_record_unknown', 'run_state_record_write', 'run_state_start_changed', 'run_state_unknown']),
        nativeCode: Number.isSafeInteger(failure.nativeCode) && Number(failure.nativeCode) >= 0 && Number(failure.nativeCode) <= 0xffffffff ? failure.nativeCode : null },
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
  projectPath: string, selectedModel: string, expectedVersion: string,
  report: (phase: 'owner_launch' | 'member_readiness' | 'physical_stop', facts: {
    launchCalls: number; ownerReturned: boolean; memberReady: boolean; memberCount: number; readyMemberCount: number;
    stopConfirmed: boolean; cleanupUnknown: boolean;
  }) => void,
  snapshot: (record: unknown, session: string, plan: unknown, timing: 'before_stop' | 'after_stop') => Promise<void>
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
  const roster = expectedVersion === '2.0.0' ? ['team-lead', 'alice'] : expectedVersion === '2.0.21' ? ['team-lead', 'alice', 'bob'] : [];
  if (!roster.length) throw new Error('TEST probe preparation plan invalid');
  const { lstat, readdir, open, rename } = await import('node:fs/promises');
  const { join, isAbsolute } = await import('node:path');
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
    stopConfirmed: false, cleanupUnknown: false };
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
      let phase: 'owner_launch' | 'member_readiness' | 'physical_stop' = 'owner_launch';
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
        // One retained native broker serves this cohort. Avoid duplicate status
        // exchanges queued behind each other with already-running RPC deadlines.
        for (const member of members) {
        try {
        const readinessMs = Math.floor(readinessDeadline - Date.now());
        if (readinessMs <= 0) throw new Error('TEST probe readiness budget exhausted');
        const ready = await control.awaitOpenCodeV2RunMemberReadiness(returnedOwner, {
          memberId: String(member.memberId), originalSessionId: String(member.originalSessionId),
          selectedModel, selectedVariant: 'default', pin: expectedVersion,
        }, readinessMs);
        if (!ready) throw new Error('TEST probe member not ready');
        const memberStatus = record(ready);
        if (typeof memberStatus.runtimePid !== 'number' || !Number.isSafeInteger(memberStatus.runtimePid) ||
            memberStatus.runtimePid <= 0) throw new Error('TEST probe member not ready');
        readyPids.set(member.memberId, memberStatus.runtimePid);
        facts.readyMemberCount = readyPids.size; update();
        // Exercise the actual live DLL custody, using only this fresh TEST profile.
        const tmpPath = record(record(member.profile).env).TMPDIR;
        if (typeof tmpPath !== 'string' || !isAbsolute(tmpPath))
          throw new Error('TEST private DLL profile invalid');
        const leaves = (await readdir(tmpPath)).filter(name =>
          /^native-realpath-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name));
        if (leaves.length !== 1) throw new Error('TEST private DLL leaf invalid');
        const leaf = join(tmpPath, leaves[0]!);
        const dll = join(leaf, 'opencode-v2-windows-realpath.dll');
        const beforeLeaf = await lstat(leaf), beforeDll = await lstat(dll);
        if (!beforeLeaf.isDirectory() || beforeLeaf.isSymbolicLink() ||
            !beforeDll.isFile() || beforeDll.isSymbolicLink() || beforeDll.nlink !== 1)
          throw new Error('TEST private DLL custody invalid');
        const denied = async (work: () => Promise<unknown>) => {
          try { await work(); }
          catch (error) {
            if (error && typeof error === 'object' && 'code' in error &&
                ['EACCES', 'EPERM', 'EBUSY'].includes(String(error.code))) return;
            throw error;
          }
          throw new Error('TEST private DLL mutation admitted');
        };
        await denied(async () => {
          const writer = await open(dll, 'r+');
          await writer.close().catch(() => undefined); // A writable open always fails the assertion.
        });
        await denied(() => rename(leaf, leaf + '.TEST-forbidden-rename'));
        const afterLeaf = await lstat(leaf), afterDll = await lstat(dll);
        if (afterLeaf.dev !== beforeLeaf.dev || afterLeaf.ino !== beforeLeaf.ino ||
            afterDll.dev !== beforeDll.dev || afterDll.ino !== beforeDll.ino)
          throw new Error('TEST private DLL custody changed');
        } catch (error) { readinessFailed = true; readinessFailure ??= error; }
        }
        if (readinessFailed) throw readinessFailure;
        facts.memberReady = readyPids.size === members.length; update();
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
          } catch (error) { cleanupFailure = error; facts.cleanupUnknown = true; }
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
assert.equal(process.versions.bun, '1.4.3');
assert.equal(process.argv.length, 7);
const selectedModel = process.argv[5]!;
assert(/^openrouter\/[a-zA-Z0-9_./:-]+$/.test(selectedModel), 'Explicit TEST selected model required for native startup, including source-only; no model prompts are submitted');
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
  // Reuse the PowerShell 7 installation already required by TEST ACL creation.
  const programFiles = process.env.ProgramFiles;
  assert(programFiles && path.win32.isAbsolute(programFiles));
  const aclPowerShell = await realpath(path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'));
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
let startupBeforeStop = null;
let readOnlyAclObservation = null;
const nativeFailures = new WeakMap();
const nativeLaunches = [];
const graphFailureCoverage = (${graphFailureCoverage.toString()});
let nativeObserver, exitCode = 0;
try {
 const nativeModule = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.ts')).href)});
 const { spyOn: observeFactory } = await import('bun:test');
 nativeObserver = (${observeNativeBrokerFailures.toString()})(nativeModule, observeFactory, nativeFailures, nativeLaunches);
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
 preparation = await (${verifyProbePreparation.toString()})(inspectOpenCodeV2SourceAvailability,
   resolveOpenCodeV2ExecutionProbe, buildOpenCodeV2InternalRunPlan, runOwner, control, spyOn, ${JSON.stringify(desktop.projectPath)},
   ${JSON.stringify(selectedModel)}, ${JSON.stringify(expectedVersion)},
   (phase, facts) => { stage=phase; startupFacts=facts; },
   async (record, session, plan, timing) => {
     if (timing === 'before_stop') {
       if (record) { startupBeforeStop ??= []; startupBeforeStop.push(await (${snapshotStartupFailure.toString()})(record, session, plan, ${JSON.stringify(sdk)}, nativeLaunches)); }
       return;
     }
     if (record) { startupFailureState ??= []; startupFailureState.push(await (${snapshotStartupFailure.toString()})(record, session, plan, ${JSON.stringify(sdk)}, nativeLaunches)); }
     if (readOnlyAclObservation === null) {
       const { resolveOpenCodeV2ExecutionDelivery } = await import(${JSON.stringify(pathToFileURL(path.join(sdk, 'src/services/opencode/host/OpenCodeV2ExecutionDelivery.ts')).href)});
       readOnlyAclObservation = await (${snapshotReadOnlyAcl.toString()})(plan, resolveOpenCodeV2ExecutionDelivery);
     }
   });
 // False readiness also opens the store: run it only AFTER the cold preparation.
 stage='readiness';
 await (${verifyModelFreeReadiness.toString()})(executeSelectedOpenCodeBridgeCommandEnvelope,
   executeOpenCodeBridgeCommandEnvelope,${JSON.stringify(desktop.projectPath)},${JSON.stringify(expectedVersion)},${JSON.stringify(selectedModel)});`
     : ''
 }
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:true,stage,preparation,startupFacts,version:${JSON.stringify(expectedVersion ?? null)}}));
} catch (error) {
 const missing = /^readiness_file_missing:(owner_discovery|source_availability|execution_probe)$/.exec(error?.message ?? '');
 const match = /^execution_owner_not_private:(private_acl_owner(?:_run_(?:data_root|opencode|v2|runs|leaf))?):[0-9]{1,10}(?::private_dir_([0-9]{1,2}))?$/.exec(error?.message ?? '');
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:false,stage,startupFacts,startupBeforeStop,startupFailureState,readOnlyAclObservation,
   code:match?'execution_owner_not_private':missing||(stage==='probe-controller-state'&&error?.code==='ENOENT')?'readiness_file_missing':'source_gate_unknown',role:match?.[1]??missing?.[1]??'unknown',privateDirectoryIndex:match?.[2]??null,
   ...(${safeSourceGateFailure.toString()})(error,nativeFailures)}));
 exitCode = 1;
} finally { nativeObserver?.mockRestore(); }
process.exit(exitCode);`;
  // Windows CreateProcess caps the quoted command line at 32767 UTF-16 units.
  // Keep the complete generated source in this fresh protected TEST root instead.
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
        OPENCODE_TEST_ACL_POWERSHELL: aclPowerShell,
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
for (const [index, version] of ['2.0.0', '2.0.21'].entries()) {
  const binary = process.argv[index + 3]!;
  assert(path.isAbsolute(binary));
  await preflight(await realpath(binary), version as '2.0.0' | '2.0.21');
}
