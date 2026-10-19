import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { redactLaunchFailureArtifactText } from '../../src/main/services/team/TeamLaunchFailureArtifactPack';
import { electronTeamPort, nativeCommandMatch } from './opencode-native-team-port';
import { prepareNativeDesktopEnvironment } from './opencode-native-desktop-environment';
import { Cdp, waitFor } from './release-updater/cdp.mts';
import { serializedFunction } from './release-updater/serialized-function.mts';

const execute = promisify(execFile);
type Port = ReturnType<typeof electronTeamPort>;
type Operation = Exclude<keyof Port, 'progress' | 'dispose'>;
type Arguments<K extends Operation> = Parameters<Port[K]>;
type Result<K extends Operation> = Awaited<ReturnType<Port[K]>>;
const IPC_FAILURE_CLASSIFICATIONS = [
  'team_stop_unconfirmed:stopped',
  'team_stop_unconfirmed:stop_failed',
  'team_stop_unconfirmed:timed_out',
  'team_stop_unconfirmed:runtime_already_down',
  'team_stop_unconfirmed:unknown',
  'Team launch handlers are not initialized',
  'No handler registered',
  'RUNTIME_SELECTION_REQUIRED',
  'RUNTIME_SELECTION_UNSUPPORTED',
  'teamName must be kebab-case',
  'cwd is required',
  'members must be an array',
  'single owned OpenCode launch required',
  'TEST team required',
  'OpenCode CLI not found',
  'provider is not configured for runtime use',
  'provider is not authenticated',
  'agent-teams MCP preflight failed before team launch',
  'run_control_selection_missing',
  'run_control_native_pending',
  'run_state_endpoint_missing',
  'is not a function',
  'is not defined',
] as const;
// Self-contained so the same projection runs before the renderer/CDP boundary
// and again on receipt. Never retain raw exception text or quoted arguments.
export function safeIpcFailureDetail(value: string, redact: (text: string) => string): string {
  const bounded = value.slice(0, 16_384);
  const role =
    /execution_owner_not_private:private_acl_owner_run_(data_root|opencode|v2|runs|leaf):[0-9]{1,10}(?![0-9])/.exec(
      bounded
    )?.[1];
  // Projection is idempotent: a retained closed code never earns a second label.
  const roleName = role === 'data_root' ? 'data' : role;
  const label = roleName && !bounded.startsWith('[owner role: ') ? `[owner role: ${roleName}] ` : '';
  const detail = redact(bounded)
    .replace(/["'`][\s\S]*/g, '[argument]')
    .replace(/[A-Za-z]:[\\/][^\r\n,;]*/g, '[path]')
    .replace(/\\\\[^\r\n,;]*/g, '[path]')
    .replace(/\/[^\s"'<>]+/g, '[path]')
    // Long lowercase snake_case tokens are closed SDK/native codes, never content.
    .replace(/[A-Za-z0-9_+./=-]{24,}/g, (token) => (/^[a-z_]+$/.test(token) && token.includes('_') ? token : '[opaque]'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return (label + detail).slice(0, 500);
}
export function projectIpcCausalFailure(value: unknown) {
  const row = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  let candidate = value;
  if (typeof value === 'string') {
    const marker = '\nOPENCODE_STOP_CAUSE_V1=';
    const index = value.lastIndexOf(marker);
    if (index < 0 || !['team_stop_unconfirmed:', 'opencode_message_delivery_exception:'].some(prefix => value.slice(0, index).startsWith(prefix))) return null;
    const encoded = value.slice(index + marker.length);
    if (encoded.length > 2048 || /[\r\n]/.test(encoded)) return null;
    try { candidate = JSON.parse(encoded); } catch { return null; }
  }
  const input = row(candidate);
  const phases = ['manifest', 'binding', 'stop_ledger_lookup', 'stop_recovery', 'handshake',
    'handshake_validation', 'lease_acquire', 'stop_target', 'ledger_begin', 'dispatch',
    'failure_persistence', 'result_validation', 'stop_result_validation', 'ledger_complete',
    'lease_release', 'unclassified'];
  const phase = phases.find((phase) => phase === input.phase);
  if (!phase) return null;
  const errno = (value: unknown) => ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EROFS',
    'EEXIST', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE', 'EBUSY', 'EINVAL', 'ETIMEDOUT',
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ABORT_ERR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']
    .find((code) => code === value) ?? null;
  const own = (value: unknown, key: string): unknown => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch { return undefined; }
  };
  const handshake = own(input, 'handshakeFailure');
  const handshakeKind = own(handshake, 'kind'), handshakeCode = own(handshake, 'sdkCode');
  const handshakeOperation = own(handshake, 'nativeOperation');
  const kind = ['unsupported_schema', 'unsupported_command', 'invalid_input', 'runtime_not_ready', 'provider_error',
    'timeout', 'transport_watchdog_timeout', 'contract_violation', 'internal_error'].find(value => value === handshakeKind);
  const sdkCode = [
    'cleanup_unknown', 'execution_cancelled', 'execution_containment_dll_identity', 'execution_containment_filesystem_denied',
    'execution_containment_helper_closed', 'execution_containment_helper_failed', 'execution_containment_helper_identity', 'execution_containment_launcher_denied',
    'execution_containment_pipe_denied', 'execution_containment_platform_pending', 'execution_containment_profile_denied', 'execution_containment_unavailable',
    'execution_containment_unqualified', 'execution_identity_unknown', 'execution_invalid_response', 'execution_native_command_unknown',
    'execution_native_stdio_owner_unknown', 'execution_native_timeout', 'execution_native_unknown', 'execution_owner_alias',
    'execution_owner_archive_identity_mismatch', 'execution_owner_archive_path_mismatch', 'execution_owner_archive_reopen_identity_mismatch', 'execution_owner_archive_unknown',
    'execution_owner_local_volume_required', 'execution_owner_metadata_budget', 'execution_owner_metadata_changed', 'execution_owner_metadata_invalid',
    'execution_owner_metadata_missing', 'execution_owner_metadata_purpose_invalid', 'execution_owner_not_private', 'execution_owner_ntfs_required',
    'execution_owner_path_invalid', 'execution_owner_prepared_invalid', 'execution_owner_prepared_purpose_invalid', 'execution_owner_read_only',
    'execution_owner_unknown', 'execution_owner_write_through_pending', 'execution_path_alias', 'execution_probe',
    'execution_profile_changed', 'execution_selected_auth_changed', 'member_authority_ambiguous', 'operation_timeout',
    'original_session_changed', 'run_control_accept_timeout', 'run_control_accept_unknown', 'run_control_changed',
    'run_control_cleanup_unknown', 'run_control_config_budget', 'run_control_config_identity', 'run_control_connect_unknown',
    'run_control_connection_limit', 'run_control_disconnected', 'run_control_endpoint_changed', 'run_control_foreign',
    'run_control_frame_invalid', 'run_control_frame_oversize', 'run_control_frame_too_large', 'run_control_frame_utf8',
    'run_control_held_identity', 'run_control_held_inputs', 'run_control_hmac_unknown', 'run_control_image_changed',
    'run_control_image_hash', 'run_control_invalid', 'run_control_listen_unknown', 'run_control_native_pending',
    'run_control_native_unknown', 'run_control_owner_identity', 'run_control_package_peer_identity', 'run_control_parent_birth',
    'run_control_parent_join', 'run_control_path_alias', 'run_control_peer_identity', 'run_control_pipe_name',
    'run_control_pipe_security', 'run_control_process_identity', 'run_control_pump_failed', 'run_control_pump_unknown',
    'run_control_read_unknown', 'run_control_selection_budget', 'run_control_selection_changed', 'run_control_selection_missing',
    'run_control_timeout', 'run_control_write_partial', 'run_control_write_unknown', 'run_controller_config_unknown',
    'run_controller_inbox_unknown', 'run_deadline_expired', 'run_identity_conflict', 'run_identity_missing',
    'run_original_behavior_changed', 'run_original_member_missing', 'run_original_qualification_missing', 'run_owner_stale',
    'run_owner_unknown', 'run_process_appcontainer', 'run_process_changed', 'run_process_unknown',
    'run_selected_model_changed', 'run_state_absent', 'run_state_acl_unknown', 'run_state_challenge_changed',
    'run_state_challenge_unknown', 'run_state_directory', 'run_state_endpoint_changed', 'run_state_endpoint_missing',
    'run_state_held_inputs', 'run_state_identity_changed', 'run_state_missing', 'run_state_record_absent',
    'run_state_record_changed', 'run_state_record_collision', 'run_state_record_encoding', 'run_state_record_name',
    'run_state_record_read', 'run_state_record_rename', 'run_state_record_size', 'run_state_record_temporary',
    'run_state_record_unknown', 'run_state_record_write', 'run_state_start_changed', 'run_state_unknown',
    'run_status_unknown', 'run_stopped_or_unknown',
  ].find(value => value === handshakeCode);
  const nativeOperation = sdkCode ? [
    'assertLive', 'identity', 'launch', 'ownerArchive',
    'ownerAssertDirectory', 'ownerCloseDirectory', 'ownerCreatePreparedDatabase', 'ownerInspectProfileConfig',
    'ownerOpenDirectory', 'ownerPreparePrivateDirectory', 'ownerReadMetadata', 'ownerReadRecord',
    'ownerSelectConfig', 'ownerValidateSelectedProfile', 'ownerWriteExclusive', 'ownerWriteMetadata',
    'ownerWritePreparedAuth', 'ownerWritePreparedConfig', 'retire', 'runStateAcquire',
    'runStateClose', 'runStateDiscover', 'runStateListen', 'runStateOwnerRetired',
    'runStatePoisonConnection', 'runStateProcessIdentity', 'runStateReadControllerInbox', 'runStateReadRecord',
    'runStateReadStop', 'runStateRequest', 'runStateReserve', 'runStateRespond',
    'runStateSelect', 'runStateValidateEndpoint', 'runStateWriteRecord', 'selfImageCustody',
    'send',
  ].find(value => value === handshakeOperation) : undefined;
  const frame = row(input.sourceFrame);
  const source = ['OpenCodeStateChangingBridgeCommandService.ts', 'OpenCodeBridgeCommandClient.ts',
    'OpenCodeBridgeHandshakeClient.ts', 'OpenCodeBridgeCommandLedgerStore.ts',
    'OpenCodeLifecycleManifestBinding.ts', 'OpenCodeRuntimeStopProtocol.ts',
    'OpenCodeStopOutcomeRecovery.ts'].find((source) => source === frame.source);
  return {
    phase, errno: errno(input.errno),
    ...(kind ? { handshakeFailure: { kind, ...(sdkCode ? { sdkCode } : {}), ...(nativeOperation ? { nativeOperation } : {}) } } : {}),
    ...(Object.hasOwn(input, 'cleanupErrno') ? { cleanupErrno: errno(input.cleanupErrno) } : {}),
    reason: [
      'OpenCode lifecycle command requires the exact persisted lane run and capability snapshot',
      'OpenCode lifecycle command requires a persisted lane capability snapshot',
      'OpenCode lifecycle capability snapshot does not match the persisted lane manifest',
      'Bridge handshake client identity mismatch',
      'Bridge server capability snapshot mismatch',
      'Bridge server active run mismatch',
      'Bridge server runtime manifest high watermark is stale',
      'Bridge handshake identity hash mismatch',
      'OpenCode lifecycle command body does not match its persisted lane identity',
      'Invalid OpenCode Stop domain result; exact-target reconciliation required',
      'Invalid durable Stop result; reconciliation required',
      'Stop binding mismatch; reconciliation required',
      'Stop receipt target/runtime mismatch; reconciliation required',
      'Invalid original Stop identity; reconciliation unknown',
      'Stop reconciliation unknown: original session set missing',
      'Ambiguous original Stop session set',
      'Invalid original Stop capability/behavior identity',
      'Bridge handshake protocol version mismatch',
      'Unsupported Stop recovery capability/version; reconciliation unknown',
      'Stop target changed before dispatch; reconciliation required',
      'OpenCode bridge command outcome must be reconciled before retry',
      'OpenCode bridge command already started',
      'OpenCode bridge command completed concurrently; retry recovery',
      'OpenCode bridge command already completed; recover through commandStatus',
      'Invalid Stop recovery object; reconciliation required',
      'Unsupported Stop recovery contract version',
      'Stop observation session-set token mismatch',
      'Stop recovery requires a validated success envelope',
      'OpenCode Stop requires authoritative exact-target reconciliation; no durable outcome',
      'OpenCode Stop recovery target or outcome mismatch; reconciliation required',
      'Stop receipt envelope identity mismatch; reconciliation required',
      'OpenCode bridge idempotency key reused with different payload',
      'OpenCode bridge command lease was not created',
    ].find((reason) => reason === input.reason) ?? null,
    sourceFrame: source && Number.isSafeInteger(frame.line) && Number(frame.line) >= 1 && Number(frame.line) <= 9_999_999
      && Number.isSafeInteger(frame.column) && Number(frame.column) >= 1 && Number(frame.column) <= 99_999
      ? { source, line: Number(frame.line), column: Number(frame.column) } : null,
  };
}

export class NativeDesktopIpcError extends Error {
  readonly operation: Operation;
  readonly classification: string;
  readonly detail?: string;
  readonly causalFailure: ReturnType<typeof projectIpcCausalFailure>;
  constructor(operation: Operation, classification: string | undefined, detail?: string, causalFailure?: unknown) {
    super('Owned desktop IPC failed');
    this.causalFailure = projectIpcCausalFailure(causalFailure);
    this.operation = operation;
    this.classification =
      IPC_FAILURE_CLASSIFICATIONS.find((reason) => reason === classification) ?? 'unclassified';
    if (typeof detail === 'string')
      this.detail = safeIpcFailureDetail(detail, redactLaunchFailureArtifactText);
  }
}
interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}
interface RendererState {
  port: Port;
  calls: Record<
    string,
    { state: 'pending' | 'done' | 'failed'; result?: unknown; failure?: string; detail?: string; causalFailure?: ReturnType<typeof projectIpcCausalFailure> }
  >;
}

/** Prepare before seeding explicit local TEST auth. No ambient credentials or
 * real projects are inherited. This host qualifies Electron integration only;
 * the scenario must independently assert files, tool effects and native stop.
 */
export async function prepareNativeDesktop() {
  const { root, projectPath, teamName, env } = await prepareNativeDesktopEnvironment();
  let launched = false;
  return {
    root,
    projectPath,
    teamName,
    env,
    async launch(executable: string) {
      assert(!launched, 'Do not repeat an uncertain Electron launch');
      assert(path.isAbsolute(executable), 'Packaged executable must be absolute');
      const selected = await realpath(executable);
      const resources =
        process.platform === 'darwin'
          ? path.resolve(path.dirname(selected), '..', 'Resources')
          : path.join(path.dirname(selected), 'resources');
      const rendererUrl = pathToFileURL(
        path.join(resources, 'app.asar', 'out', 'renderer', 'index.html')
      ).href;
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const address = reservation.address();
      assert(address && typeof address !== 'string');
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve()))
      );
      launched = true;
      const child = spawn(
        selected,
        [
          `--remote-debugging-port=${port}`,
          '--remote-debugging-address=127.0.0.1',
          `--user-data-dir=${env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR}`,
        ],
        { env, cwd: root, stdio: ['ignore', 'ignore', 'pipe'] }
      );
      // Retain only static OS startup classifications, never application or
      // provider log text. This diagnoses exits before the normal IPC boundary.
      let startupFailure = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        const classifications = [
          'No usable sandbox',
          'SUID sandbox helper',
          'Failed to move to new namespace',
          'error while loading shared libraries',
          'Missing X server',
          'Running as root',
        ];
        startupFailure ||= classifications.find((reason) => text.includes(reason)) ?? '';
      });
      let spawnFailure: Error | undefined;
      child.once('error', (error) => {
        spawnFailure = error;
      });
      let cdp: Cdp | undefined;
      try {
        const renderer = await waitFor(async () => {
          if (spawnFailure) throw new Error('Owned Electron spawn failed');
          assert(
            child.exitCode === null && child.signalCode === null,
            `Owned Electron exited (${startupFailure || child.signalCode || child.exitCode})`
          );
          assert(child.pid, 'Owned Electron PID required');
          if (!(await ownsListener(child.pid, port))) return null;
          let targets: Target[];
          try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
              signal: AbortSignal.timeout(2000),
              redirect: 'error',
            });
            if (!response.ok) return null;
            targets = (await response.json()) as Target[];
          } catch (error) {
            if (
              error instanceof TypeError ||
              (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
            )
              return null;
            throw error;
          }
          const matches = targets.filter(
            (target) =>
              target.type === 'page' && target.url === rendererUrl && target.webSocketDebuggerUrl
          );
          assert(matches.length <= 1, 'Ambiguous packaged renderer');
          return matches[0] ?? null;
        }, 'owned packaged Electron renderer');
        const inspector = new URL(renderer.webSocketDebuggerUrl!);
        assert.equal(inspector.hostname, '127.0.0.1');
        assert.equal(Number(inspector.port), port);
        cdp = await Cdp.connect(inspector.href);
        await waitFor(
          async () =>
            (await cdp!.evaluate<boolean>(
              'Boolean(window.electronAPI?.teams && window.electronAPI?.config)'
            )) || null,
          'normal preload API'
        );
        // This variable belongs only to this fresh renderer. No production hook.
        await cdp.evaluate(`window.__opencodeNativeProof = { port: ${serializedFunction(electronTeamPort)}(
          window.electronAPI, ${JSON.stringify(teamName)}, ${JSON.stringify(projectPath)}, ${serializedFunction(nativeCommandMatch)}, ${serializedFunction(projectIpcCausalFailure)}), calls: {} }; true`);
        let closed = false;
        return {
          pid: child.pid!,
          async call<K extends Operation>(operation: K, ...args: Arguments<K>): Promise<Result<K>> {
            const id = randomUUID();
            const start = (
              id: string,
              operation: Operation,
              args: unknown[],
              reasons: readonly string[],
              safeDetail: typeof safeIpcFailureDetail,
              redact: typeof redactLaunchFailureArtifactText,
              safeCausal: typeof projectIpcCausalFailure
            ) => {
              const state = (window as unknown as { __opencodeNativeProof: RendererState })
                .__opencodeNativeProof;
              if (state.calls[id]) throw new Error('single IPC submission required');
              state.calls[id] = { state: 'pending' };
              Promise.resolve()
                .then(() => Reflect.apply(state.port[operation], state.port, args))
                .then((result) => {
                  state.calls[id] = { state: 'done', result };
                })
                // Do not copy provider error text across the boundary.
                .catch((error: unknown) => {
                  // Static classifications only; never expose provider error text.
                  const message =
                    error &&
                    typeof error === 'object' &&
                    'message' in error &&
                    typeof error.message === 'string'
                      ? error.message
                      : typeof error === 'string'
                        ? error
                        : '';
                  const failure =
                    reasons.find((reason) => message.includes(reason)) ?? 'unclassified';
                  state.calls[id] = {
                    state: 'failed',
                    failure,
                    detail: safeDetail(message, redact),
                    causalFailure: safeCausal(message) ?? safeCausal(
                      error && typeof error === 'object' && 'details' in error
                      && error.details && typeof error.details === 'object' && 'causalFailure' in error.details
                        ? error.details.causalFailure : null
                    ),
                  };
                });
              return true;
            };
            await cdp!.evaluate(
              `${serializedFunction(start)}(${JSON.stringify(id)}, ${JSON.stringify(operation)}, ${JSON.stringify(args)}, ${JSON.stringify(IPC_FAILURE_CLASSIFICATIONS)}, ${serializedFunction(safeIpcFailureDetail)}, ${serializedFunction(redactLaunchFailureArtifactText)}, ${serializedFunction(projectIpcCausalFailure)})`
            );
            const completed = await waitFor(
              async () => {
                const entry = await cdp!.evaluate<{
                  state: string;
                  result?: Result<K>;
                  failure?: string;
                  detail?: string;
                  causalFailure?: ReturnType<typeof projectIpcCausalFailure>;
                }>(`window.__opencodeNativeProof.calls[${JSON.stringify(id)}]`);
                if (entry.state === 'failed')
                  throw new NativeDesktopIpcError(operation, entry.failure, entry.detail, entry.causalFailure);
                return entry.state === 'done' ? { value: entry.result } : null;
              },
              `single ${operation} IPC result`,
              // Normal create/launch includes the app's 300s readiness budget
              // and Darwin's 180s startup budget; the host must outlive both.
              operation === 'createTeam' || operation === 'launchTeam' ? 510_000 : 180_000
            );
            return completed.value as Result<K>;
          },
          async progress() {
            return cdp!.evaluate<Port['progress']>('window.__opencodeNativeProof.port.progress');
          },
          async close() {
            if (closed) return;
            // The scenario must confirm native team cleanup before closing its app.
            const failures: unknown[] = [];
            try {
              await cdp!.evaluate('window.__opencodeNativeProof.port.dispose(); true');
            } catch (error) {
              failures.push(error);
            } finally {
              cdp!.close();
              try {
                await stopApp(child);
              } catch (error) {
                failures.push(error);
              }
            }
            if (failures.length) throw new AggregateError(failures, 'Owned app close failed');
            closed = true;
            // Only a confirmed exit permits deliberate reopening of this TEST profile.
            launched = false;
          },
        };
      } catch (error) {
        const failures: unknown[] = [error];
        try {
          cdp?.close();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        try {
          await stopApp(child);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        if (failures.length > 1)
          throw new AggregateError(failures, 'Owned Electron startup and cleanup failed');
        throw error;
      }
    },
  };
}

async function ownsListener(pid: number, port: number): Promise<boolean> {
  if (process.platform === 'linux') {
    const processRoot = `/proc/${pid}`;
    const birth = async () => {
      const stat = await readFile(`${processRoot}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    };
    const before = await birth();
    assert(before && /^\d+$/.test(before), 'Owned Electron birth required');
    const sockets = new Set<string>();
    for (const fd of await readdir(`${processRoot}/fd`)) {
      try {
        const target = await readlink(`${processRoot}/fd/${fd}`);
        const socket = /^socket:\[(\d+)\]$/.exec(target);
        if (socket) sockets.add(socket[1]);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
          throw error;
      }
    }
    let found = false;
    for (const table of ['tcp', 'tcp6']) {
      let contents: string;
      try {
        contents = await readFile(`/proc/net/${table}`, 'utf8');
      } catch (error) {
        if (
          table === 'tcp6' &&
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          continue;
        throw error;
      }
      const rows = contents.trim().split('\n').slice(1);
      for (const row of rows) {
        const fields = row.trim().split(/\s+/);
        const [address, encodedPort] = fields[1].split(':');
        if (fields[3] !== '0A' || parseInt(encodedPort, 16) !== port) continue;
        assert(table === 'tcp' && address === '0100007F', 'Inspector must bind IPv4 loopback');
        assert(sockets.has(fields[9]), 'Foreign inspector listener');
        found = true;
      }
    }
    assert.equal(await birth(), before, 'Owned Electron PID changed during listener check');
    return found;
  }
  if (process.platform === 'win32') {
    const { stdout } = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Filter after querying listeners: the cmdlet reports no matching port
        // as an error during startup. Actual query failures must still reject.
        `@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq ${port} }).OwningProcess | ConvertTo-Json -Compress`,
      ],
      { timeout: 5000, maxBuffer: 4096 }
    );
    if (!stdout.trim()) return false;
    const owners: number | number[] = JSON.parse(stdout);
    const rows = Array.isArray(owners) ? owners : [owners];
    assert(
      rows.every((owner) => owner === pid),
      'Foreign inspector listener'
    );
    return rows.length > 0;
  }
  assert.equal(
    process.platform,
    'darwin',
    'This host requires a native listener identity implementation'
  );
  try {
    const { stdout } = await execute(
      '/usr/sbin/lsof',
      ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'],
      {
        timeout: 5000,
        maxBuffer: 4096,
      }
    );
    const owners = stdout
      .split('\n')
      .filter((line) => line.startsWith('p'))
      .map((line) => Number(line.slice(1)));
    assert(
      owners.every((owner) => owner === pid),
      'Foreign inspector listener'
    );
    return owners.length > 0;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return false;
    throw error;
  }
}

async function stopApp(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    child.stderr?.destroy();
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned app did not exit; preserve TEST state')),
          10_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // The app's descendants may retain its inherited stderr writer after exit.
    // Release only our diagnostic read end; this is not native cleanup proof.
    child.stderr?.destroy();
  }
}
