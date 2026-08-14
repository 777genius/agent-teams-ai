import { isAbsolute, resolve } from 'node:path';

export const ACTUAL_OWNER_PURPOSE = 'agent-teams.hosted-actual-owner-e2e/v1' as const;
export const ACTUAL_OWNER_INTEGRATION_PURPOSE =
  'agent-teams.hosted-actual-owner-e2e.integration/v1' as const;
export const ACTUAL_OWNER_DRIVER_PROTOCOL =
  'agent-teams.hosted-actual-owner-e2e.driver/v1' as const;
export const ACTUAL_OWNER_DESCRIPTOR_TOKENS = Object.freeze({
  sandboxRoot: '${SANDBOX_ROOT}',
  productRoot: '${PRODUCT_ROOT}',
  orchestratorRoot: '${ORCHESTRATOR_ROOT}',
  openCodeExecutable: '${OPENCODE_EXECUTABLE}',
} as const);

export const REQUIRED_NEGATIVE_CASES = Object.freeze([
  'stale_identity',
  'artifact_rotation',
  'process_rotation',
  'session_rotation',
  'http_401',
  'http_404',
  'redirect',
  'http_5xx',
  'timeout',
  'reset',
  'malformed_response',
] as const);

export const REQUIRED_RESTART_CHECKPOINTS = Object.freeze([
  'after_owner_ingress_before_product_ack',
  'after_product_pending_before_decision',
  'after_product_decision_before_owner_delivery',
  'after_owner_completion_before_product_reconciliation',
] as const);

export type ActualOwnerNegativeCase = (typeof REQUIRED_NEGATIVE_CASES)[number];
export type ActualOwnerRestartCheckpoint = (typeof REQUIRED_RESTART_CHECKPOINTS)[number];
export type ActualOwnerProcessName = 'opencode' | 'orchestrator' | 'product';

export const EXPECTED_NEGATIVE_OUTCOMES: Readonly<
  Record<ActualOwnerNegativeCase, 'forbidden' | 'operator_required' | 'stale' | 'unavailable'>
> = Object.freeze({
  stale_identity: 'stale',
  artifact_rotation: 'stale',
  process_rotation: 'stale',
  session_rotation: 'stale',
  http_401: 'unavailable',
  http_404: 'unavailable',
  redirect: 'unavailable',
  http_5xx: 'unavailable',
  timeout: 'unavailable',
  reset: 'unavailable',
  malformed_response: 'unavailable',
});

export interface ActualOwnerCliOptions {
  readonly evidenceRoot: string;
  readonly integrationManifest: string;
  readonly openCodeExecutable: string;
  readonly openCodeReleaseManifest: string;
  readonly openCodeSha256: string;
  readonly openCodeSourceRef: string;
  readonly orchestratorAcceptanceEntry: string;
  readonly orchestratorRef: string;
  readonly orchestratorRoot: string;
  readonly orchestratorSourceLauncher: string;
  readonly productRef: string;
  readonly productReleaseManifest: string;
  readonly productRoot: string;
  readonly sandboxParent: string;
}

export interface ActualOwnerProcessTemplate {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executable?: string;
  readonly executableSha256?: string;
  readonly productRef?: string;
}

export interface ActualOwnerIntegrationManifest {
  readonly schemaVersion: 1;
  readonly purpose: typeof ACTUAL_OWNER_INTEGRATION_PURPOSE;
  readonly integrations: Readonly<{
    readonly browserApprovalSurface: 'integrated';
    readonly orchestratorAcceptanceEntry: 'integrated';
    readonly trustedAdmissionPublisher: 'integrated';
  }>;
  readonly driverBaseUrl: string;
  readonly productBaseUrl: string;
  readonly approvalPath: string;
  readonly processes: Readonly<{
    readonly opencode: ActualOwnerProcessTemplate;
    readonly orchestrator: ActualOwnerProcessTemplate;
    readonly product: ActualOwnerProcessTemplate;
  }>;
  readonly timeouts: Readonly<{
    readonly browserMs: number;
    readonly processReadyMs: number;
    readonly shutdownMs: number;
  }>;
}

export interface ActualOwnerRuntimeManifest {
  readonly schemaVersion: 1;
  readonly purpose: typeof ACTUAL_OWNER_PURPOSE;
  readonly runId: string;
  readonly sandboxRoot: string;
  readonly markerPath: string;
  readonly evidenceRoot: string;
  readonly driverBaseUrl: string;
  readonly productBaseUrl: string;
  readonly approvalPath: string;
  readonly descriptors: Readonly<{
    readonly sandboxRoot: ActualOwnerRuntimePathDescriptor;
    readonly productRoot: ActualOwnerRuntimePathDescriptor;
    readonly orchestratorRoot: ActualOwnerRuntimePathDescriptor;
    readonly openCodeExecutable: ActualOwnerRuntimePathDescriptor &
      Readonly<{
        size: string;
        sha256: string;
      }>;
  }>;
  readonly browser: Readonly<{
    readonly ownerStorageStatePath: string;
    readonly nonOwnerStorageStatePath: string;
    readonly tracePath: string;
    readonly resultsPath: string;
  }>;
  readonly capture: Readonly<{
    readonly conditionalPostLedgerPath: string;
    readonly negativeResultsPath: string;
    readonly openCodeTimelinePath: string;
    readonly ownerWalTimelinePath: string;
    readonly productTimelinePath: string;
    readonly protectedEffectLedgerPath: string;
  }>;
  readonly refs: Readonly<{
    readonly openCode: string;
    readonly openCodeExecutableSha256: string;
    readonly orchestrator: string;
    readonly product: string;
  }>;
}

export interface ActualOwnerRuntimePathDescriptor {
  readonly token: string;
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly uid: string;
}

export type ActualOwnerApprovalTimelineEventName =
  | 'completed'
  | 'decision_committed'
  | 'ingress_durable'
  | 'pending_durable'
  | 'pending_durable_after_restart'
  | 'permission_settled'
  | 'reconciled_terminal'
  | 'rejected'
  | `restart_checkpoint:${ActualOwnerRestartCheckpoint}`
  | `negative_observed:${ActualOwnerNegativeCase}:${'forbidden' | 'operator_required' | 'stale' | 'unavailable'}`;

export type ActualOwnerTimelineEvent =
  | Readonly<{
      schemaVersion: 1;
      at: string;
      approvalId: string;
      event: ActualOwnerApprovalTimelineEventName;
      generation: string;
      runId: string;
      sequence: number;
    }>
  | Readonly<{
      schemaVersion: 1;
      at: string;
      approvalId: null;
      event:
        | 'poll_ingress'
        | 'reconcile_delivered'
        | 'reconcile_not_delivered'
        | 'reconcile_operator_required'
        | 'reconcile_unavailable';
      generation: string;
      runId: string;
      sequence: number;
    }>;

type JsonRecord = Record<string, unknown>;

const RESERVED_PROCESS_ENVIRONMENT = new Set([
  'BUN_OPTIONS',
  'DYLD_INSERT_LIBRARIES',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'HOME',
  'HOSTED_ACTUAL_OWNER_E2E_MARKER',
  'HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST',
  'LANG',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LC_ALL',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`hosted_actual_owner_${label}_keys_invalid`);
  }
}

export function assertFullGitRef(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`hosted_actual_owner_${label}_unfrozen_ref`);
  }
}

export function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`hosted_actual_owner_${label}_sha256_invalid`);
  }
}

export function assertCanonicalAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    throw new Error(`hosted_actual_owner_${label}_path_invalid`);
  }
}

function parsePositiveDuration(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 60 * 60_000) {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  return value as number;
}

function parseLoopbackUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== '/'
  ) {
    throw new Error(`hosted_actual_owner_${label}_not_loopback`);
  }
  return parsed.toString();
}

function parseProcessTemplate(
  value: unknown,
  name: ActualOwnerProcessName
): ActualOwnerProcessTemplate {
  const input = record(value, `${name}_process`);
  const allowed =
    name === 'product'
      ? ['args', 'cwd', 'environment', 'executable', 'executableSha256', 'productRef']
      : ['args', 'cwd', 'environment'];
  exactKeys(input, allowed, `${name}_process`);
  if (
    !Array.isArray(input.args) ||
    input.args.length > 128 ||
    input.args.some(
      (item) => typeof item !== 'string' || item.length > 4_096 || item.includes('\0')
    ) ||
    typeof input.cwd !== 'string' ||
    input.cwd.length > 4_096
  ) {
    throw new Error(`hosted_actual_owner_${name}_process_invalid`);
  }
  const environment = record(input.environment, `${name}_environment`);
  if (
    Object.keys(environment).length > 128 ||
    Object.entries(environment).some(
      ([key, item]) =>
        RESERVED_PROCESS_ENVIRONMENT.has(key) ||
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(key) ||
        typeof item !== 'string' ||
        item.length > 16_384 ||
        item.includes('\0')
    )
  ) {
    throw new Error(`hosted_actual_owner_${name}_environment_invalid`);
  }
  if (name === 'product') {
    if (
      typeof input.executable !== 'string' ||
      input.executable.length > 4_096 ||
      typeof input.executableSha256 !== 'string' ||
      typeof input.productRef !== 'string'
    ) {
      throw new Error('hosted_actual_owner_product_executable_invalid');
    }
    assertCanonicalAbsolutePath(input.executable, 'product_executable');
    assertSha256(input.executableSha256, 'product_executable');
    assertFullGitRef(input.productRef, 'product_manifest');
  }
  const serialized = JSON.stringify(input).toLowerCase();
  if (
    serialized.includes('fake-runtime') ||
    serialized.includes('fakeruntime') ||
    serialized.includes('in-memory-backend') ||
    serialized.includes('inmemorybackend') ||
    serialized.includes('docker-compose.e2e')
  ) {
    throw new Error(`hosted_actual_owner_${name}_fake_runtime_forbidden`);
  }
  return Object.freeze({
    args: Object.freeze([...(input.args as string[])]),
    cwd: input.cwd,
    environment: Object.freeze(environment as Record<string, string>),
    ...(name === 'product'
      ? {
          executable: input.executable as string,
          executableSha256: input.executableSha256 as string,
          productRef: input.productRef as string,
        }
      : {}),
  });
}

export function parseActualOwnerIntegrationManifest(
  value: unknown
): ActualOwnerIntegrationManifest {
  const input = record(value, 'integration_manifest');
  exactKeys(
    input,
    [
      'schemaVersion',
      'purpose',
      'integrations',
      'driverBaseUrl',
      'productBaseUrl',
      'approvalPath',
      'processes',
      'timeouts',
    ],
    'integration_manifest'
  );
  if (input.schemaVersion !== 1 || input.purpose !== ACTUAL_OWNER_INTEGRATION_PURPOSE) {
    throw new Error('hosted_actual_owner_integration_manifest_invalid');
  }
  const integrations = record(input.integrations, 'integrations');
  exactKeys(
    integrations,
    ['browserApprovalSurface', 'orchestratorAcceptanceEntry', 'trustedAdmissionPublisher'],
    'integrations'
  );
  if (
    integrations.browserApprovalSurface !== 'integrated' ||
    integrations.orchestratorAcceptanceEntry !== 'integrated' ||
    integrations.trustedAdmissionPublisher !== 'integrated'
  ) {
    throw new Error('hosted_actual_owner_integration_precondition_missing');
  }
  const processes = record(input.processes, 'processes');
  exactKeys(processes, ['opencode', 'orchestrator', 'product'], 'processes');
  const timeouts = record(input.timeouts, 'timeouts');
  exactKeys(timeouts, ['browserMs', 'processReadyMs', 'shutdownMs'], 'timeouts');
  if (
    typeof input.approvalPath !== 'string' ||
    !input.approvalPath.startsWith('/') ||
    input.approvalPath.startsWith('//') ||
    input.approvalPath.includes('\\') ||
    input.approvalPath.includes('?') ||
    input.approvalPath.includes('#') ||
    new URL(input.approvalPath, 'http://127.0.0.1').pathname !== input.approvalPath ||
    input.approvalPath.length > 1_024
  ) {
    throw new Error('hosted_actual_owner_approval_path_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_INTEGRATION_PURPOSE,
    integrations: Object.freeze({
      browserApprovalSurface: 'integrated',
      orchestratorAcceptanceEntry: 'integrated',
      trustedAdmissionPublisher: 'integrated',
    }),
    driverBaseUrl: parseLoopbackUrl(input.driverBaseUrl, 'driver_url'),
    productBaseUrl: parseLoopbackUrl(input.productBaseUrl, 'product_url'),
    approvalPath: input.approvalPath,
    processes: Object.freeze({
      opencode: parseProcessTemplate(processes.opencode, 'opencode'),
      orchestrator: parseProcessTemplate(processes.orchestrator, 'orchestrator'),
      product: parseProcessTemplate(processes.product, 'product'),
    }),
    timeouts: Object.freeze({
      browserMs: parsePositiveDuration(timeouts.browserMs, 'browser_timeout'),
      processReadyMs: parsePositiveDuration(timeouts.processReadyMs, 'ready_timeout'),
      shutdownMs: parsePositiveDuration(timeouts.shutdownMs, 'shutdown_timeout'),
    }),
  });
}

const CLI_FLAGS: Readonly<Record<string, keyof ActualOwnerCliOptions>> = Object.freeze({
  '--evidence-root': 'evidenceRoot',
  '--integration-manifest': 'integrationManifest',
  '--opencode-executable': 'openCodeExecutable',
  '--opencode-release-manifest': 'openCodeReleaseManifest',
  '--opencode-sha256': 'openCodeSha256',
  '--opencode-source-ref': 'openCodeSourceRef',
  '--orchestrator-acceptance-entry': 'orchestratorAcceptanceEntry',
  '--orchestrator-ref': 'orchestratorRef',
  '--orchestrator-root': 'orchestratorRoot',
  '--orchestrator-source-launcher': 'orchestratorSourceLauncher',
  '--product-ref': 'productRef',
  '--product-release-manifest': 'productReleaseManifest',
  '--product-root': 'productRoot',
  '--sandbox-parent': 'sandboxParent',
});

export function parseActualOwnerCliOptions(args: readonly string[]): ActualOwnerCliOptions {
  if (args.length !== Object.keys(CLI_FLAGS).length * 2) {
    throw new Error('hosted_actual_owner_cli_arguments_incomplete');
  }
  const values: Partial<Record<keyof ActualOwnerCliOptions, string>> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? '';
    const value = args[index + 1] ?? '';
    const key = CLI_FLAGS[flag];
    if (!key || values[key] !== undefined || value.length === 0 || value.includes('\0')) {
      throw new Error('hosted_actual_owner_cli_arguments_invalid');
    }
    values[key] = value;
  }
  const result = values as unknown as ActualOwnerCliOptions;
  assertFullGitRef(result.productRef, 'product');
  assertFullGitRef(result.orchestratorRef, 'orchestrator');
  assertFullGitRef(result.openCodeSourceRef, 'opencode');
  assertSha256(result.openCodeSha256, 'opencode_executable');
  for (const [label, value] of Object.entries(result).filter(([key]) => key !== 'openCodeSha256')) {
    if (!label.endsWith('Ref')) assertCanonicalAbsolutePath(value, label);
  }
  return Object.freeze({ ...result });
}

export function expandActualOwnerToken(
  value: string,
  replacements: Readonly<Record<string, string>>
): string {
  const matches = value.match(/\$\{[A-Z][A-Z0-9_]*\}/gu) ?? [];
  if (matches.some((token) => replacements[token] === undefined)) {
    throw new Error('hosted_actual_owner_template_token_unresolved');
  }
  let expanded = value;
  for (const token of matches) expanded = expanded.replaceAll(token, replacements[token] as string);
  if (/\$\{[^}]*\}/u.test(expanded) || expanded.includes('\0')) {
    throw new Error('hosted_actual_owner_template_token_unresolved');
  }
  return expanded;
}

export function validateActualOwnerTimelineEvent(value: unknown): ActualOwnerTimelineEvent {
  const input = record(value, 'timeline_event');
  exactKeys(
    input,
    ['schemaVersion', 'at', 'approvalId', 'event', 'generation', 'runId', 'sequence'],
    'timeline_event'
  );
  const commonValid =
    input.schemaVersion === 1 &&
    typeof input.at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.at) &&
    Number.isFinite(Date.parse(input.at)) &&
    typeof input.event === 'string' &&
    input.event.length > 0 &&
    typeof input.generation === 'string' &&
    /^generation_[A-Za-z0-9._-]{1,128}$/u.test(input.generation) &&
    typeof input.runId === 'string' &&
    /^[0-9a-f]{48}$/u.test(input.runId) &&
    Number.isSafeInteger(input.sequence) &&
    (input.sequence as number) >= 0;
  const maintenanceEvents = new Set([
    'poll_ingress',
    'reconcile_delivered',
    'reconcile_not_delivered',
    'reconcile_operator_required',
    'reconcile_unavailable',
  ]);
  const fixedApprovalEvents = new Set([
    'completed',
    'decision_committed',
    'ingress_durable',
    'pending_durable',
    'pending_durable_after_restart',
    'permission_settled',
    'reconciled_terminal',
    'rejected',
  ]);
  const restartEvent = /^restart_checkpoint:(.+)$/u.exec(input.event as string);
  const negativeEvent = /^negative_observed:([^:]+):([^:]+)$/u.exec(input.event as string);
  const approvalEventValid =
    fixedApprovalEvents.has(input.event as string) ||
    (restartEvent !== null &&
      (REQUIRED_RESTART_CHECKPOINTS as readonly string[]).includes(restartEvent[1] as string)) ||
    (negativeEvent !== null &&
      (REQUIRED_NEGATIVE_CASES as readonly string[]).includes(negativeEvent[1] as string) &&
      EXPECTED_NEGATIVE_OUTCOMES[negativeEvent[1] as ActualOwnerNegativeCase] === negativeEvent[2]);
  const approvalValid =
    !maintenanceEvents.has(input.event as string) &&
    approvalEventValid &&
    typeof input.approvalId === 'string' &&
    /^approval_[A-Za-z0-9._:-]{8,191}$/u.test(input.approvalId);
  const maintenanceValid =
    maintenanceEvents.has(input.event as string) && input.approvalId === null;
  if (!commonValid || (!approvalValid && !maintenanceValid)) {
    throw new Error('hosted_actual_owner_timeline_event_invalid');
  }
  return Object.freeze(input) as unknown as ActualOwnerTimelineEvent;
}
