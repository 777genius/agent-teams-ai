import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  ACTUAL_OWNER_DESCRIPTOR_TOKENS,
  ACTUAL_OWNER_DRIVER_PROTOCOL,
  ACTUAL_OWNER_PURPOSE,
  type ActualOwnerNegativeCase,
  type ActualOwnerRestartCheckpoint,
  type ActualOwnerRuntimeManifest,
  EXPECTED_NEGATIVE_OUTCOMES,
  REQUIRED_NEGATIVE_CASES,
  REQUIRED_RESTART_CHECKPOINTS,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';

export type ActualOwnerBrowserCase = 'allow' | 'ambiguous' | 'deny' | 'non_owner';

export interface ActualOwnerStartedCase {
  readonly approvalId: string;
  readonly decisionPath: string;
  readonly decisionRequest: Readonly<Record<string, unknown>>;
  readonly summary: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`hosted_actual_owner_driver_${label}_invalid`);
  }
  return value as JsonRecord;
}

function exact(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`hosted_actual_owner_driver_${label}_invalid`);
  }
}

export async function loadActualOwnerRuntimeManifest(
  path: string
): Promise<ActualOwnerRuntimeManifest> {
  const parsed = record(JSON.parse(await readFile(path, 'utf8')), 'runtime_manifest');
  exact(
    parsed,
    [
      'schemaVersion',
      'purpose',
      'runId',
      'sandboxRoot',
      'markerPath',
      'evidenceRoot',
      'driverBaseUrl',
      'productBaseUrl',
      'approvalPath',
      'descriptors',
      'browser',
      'capture',
      'refs',
    ],
    'runtime_manifest'
  );
  if (
    parsed.schemaVersion !== 1 ||
    parsed.purpose !== ACTUAL_OWNER_PURPOSE ||
    typeof parsed.runId !== 'string' ||
    !/^[0-9a-f]{48}$/u.test(parsed.runId)
  ) {
    throw new Error('hosted_actual_owner_driver_runtime_manifest_invalid');
  }
  const descriptors = record(parsed.descriptors, 'runtime_descriptors');
  exact(
    descriptors,
    ['sandboxRoot', 'productRoot', 'orchestratorRoot', 'openCodeExecutable'],
    'runtime_descriptors'
  );
  const sandbox = await validateDescriptor(
    descriptors.sandboxRoot,
    ACTUAL_OWNER_DESCRIPTOR_TOKENS.sandboxRoot,
    'directory'
  );
  await validateDescriptor(
    descriptors.productRoot,
    ACTUAL_OWNER_DESCRIPTOR_TOKENS.productRoot,
    'directory'
  );
  await validateDescriptor(
    descriptors.orchestratorRoot,
    ACTUAL_OWNER_DESCRIPTOR_TOKENS.orchestratorRoot,
    'directory'
  );
  await validateDescriptor(
    descriptors.openCodeExecutable,
    ACTUAL_OWNER_DESCRIPTOR_TOKENS.openCodeExecutable,
    'executable'
  );
  const sandboxToken = sandbox.token;
  const sandboxPath = sandbox.path;
  const expand = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      (value !== sandboxToken && !value.startsWith(`${sandboxToken}/`))
    ) {
      throw new Error('hosted_actual_owner_driver_descriptor_binding_invalid');
    }
    return `${sandboxPath}${value.slice(sandboxToken.length)}`;
  };
  const browser = record(parsed.browser, 'runtime_browser');
  const capture = record(parsed.capture, 'runtime_capture');
  return Object.freeze({
    ...parsed,
    sandboxRoot: expand(parsed.sandboxRoot),
    markerPath: expand(parsed.markerPath),
    browser: Object.freeze(
      Object.fromEntries(Object.entries(browser).map(([key, value]) => [key, expand(value)]))
    ),
    capture: Object.freeze(
      Object.fromEntries(Object.entries(capture).map(([key, value]) => [key, expand(value)]))
    ),
  }) as unknown as ActualOwnerRuntimeManifest;
}

async function validateDescriptor(
  value: unknown,
  token: string,
  kind: 'directory' | 'executable'
): Promise<JsonRecord & { readonly path: string; readonly token: string }> {
  const descriptor = record(value, `${kind}_descriptor`);
  exact(
    descriptor,
    kind === 'executable'
      ? ['token', 'path', 'device', 'inode', 'mode', 'uid', 'size', 'sha256']
      : ['token', 'path', 'device', 'inode', 'mode', 'uid'],
    `${kind}_descriptor`
  );
  if (
    descriptor.token !== token ||
    typeof descriptor.path !== 'string' ||
    !isAbsolute(descriptor.path) ||
    resolve(descriptor.path) !== descriptor.path ||
    (await realpath(descriptor.path)) !== descriptor.path ||
    typeof descriptor.device !== 'string' ||
    !/^\d+$/u.test(descriptor.device) ||
    typeof descriptor.inode !== 'string' ||
    !/^\d+$/u.test(descriptor.inode) ||
    typeof descriptor.mode !== 'string' ||
    !/^\d+$/u.test(descriptor.mode) ||
    typeof descriptor.uid !== 'string' ||
    !/^\d+$/u.test(descriptor.uid)
  ) {
    throw new Error(`hosted_actual_owner_driver_${kind}_descriptor_invalid`);
  }
  const handle = await open(
    descriptor.path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (kind === 'directory' ? constants.O_DIRECTORY : 0)
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      (kind === 'directory' ? !before.isDirectory() : !before.isFile()) ||
      before.dev.toString() !== descriptor.device ||
      before.ino.toString() !== descriptor.inode ||
      (before.mode & 0o777n).toString() !== descriptor.mode ||
      before.uid.toString() !== descriptor.uid
    ) {
      throw new Error(`hosted_actual_owner_driver_${kind}_descriptor_rotated`);
    }
    if (kind === 'executable') {
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        typeof descriptor.size !== 'string' ||
        descriptor.size !== before.size.toString() ||
        typeof descriptor.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(descriptor.sha256) ||
        createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256 ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      ) {
        throw new Error('hosted_actual_owner_driver_executable_descriptor_invalid');
      }
    }
  } finally {
    await handle.close();
  }
  return descriptor as JsonRecord & { readonly path: string; readonly token: string };
}

export class ActualOwnerScenarioDriver {
  constructor(
    private readonly manifest: ActualOwnerRuntimeManifest,
    private readonly timeoutMs: number
  ) {}

  async assertCapability(): Promise<void> {
    const body = await this.request('GET', 'v1/capability');
    exact(body, ['schemaVersion', 'protocol', 'noFakeRuntime', 'markerPath', 'refs'], 'capability');
    if (
      body.schemaVersion !== 1 ||
      body.protocol !== ACTUAL_OWNER_DRIVER_PROTOCOL ||
      body.noFakeRuntime !== true ||
      body.markerPath !== this.manifest.markerPath ||
      JSON.stringify(body.refs) !== JSON.stringify(this.manifest.refs)
    ) {
      throw new Error('hosted_actual_owner_driver_capability_invalid');
    }
  }

  async startCase(kind: ActualOwnerBrowserCase): Promise<ActualOwnerStartedCase> {
    const body = await this.request('POST', 'v1/cases', { kind });
    exact(body, ['approvalId', 'decisionPath', 'decisionRequest', 'summary'], 'started_case');
    if (
      typeof body.approvalId !== 'string' ||
      !/^approval_[A-Za-z0-9._:-]{8,191}$/u.test(body.approvalId) ||
      typeof body.summary !== 'string' ||
      body.summary.length < 1 ||
      body.summary.length > 256 ||
      body.summary.includes('\n') ||
      typeof body.decisionPath !== 'string' ||
      !body.decisionPath.startsWith('/api/') ||
      body.decisionPath.startsWith('//') ||
      body.decisionPath.includes('\\') ||
      body.decisionPath.includes('?') ||
      body.decisionPath.includes('#') ||
      new URL(body.decisionPath, this.manifest.productBaseUrl).pathname !== body.decisionPath
    ) {
      throw new Error('hosted_actual_owner_driver_started_case_invalid');
    }
    return Object.freeze({
      approvalId: body.approvalId,
      decisionPath: body.decisionPath,
      decisionRequest: Object.freeze(record(body.decisionRequest, 'decision_request')),
      summary: body.summary,
    });
  }

  async waitForCaseState(approvalId: string, state: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const body = await this.request('GET', `v1/cases/${encodeURIComponent(approvalId)}`);
      exact(body, ['approvalId', 'state'], 'case_state');
      if (body.approvalId !== approvalId || typeof body.state !== 'string') {
        throw new Error('hosted_actual_owner_driver_case_state_invalid');
      }
      if (body.state === state) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`hosted_actual_owner_driver_state_timeout_${state}`);
  }

  async restartPending(approvalId: string): Promise<void> {
    const body = await this.request(
      'POST',
      `v1/cases/${encodeURIComponent(approvalId)}/restart-pending`
    );
    exact(body, ['approvalId', 'pendingAfterRestart'], 'restart_pending');
    if (body.approvalId !== approvalId || body.pendingAfterRestart !== true) {
      throw new Error('hosted_actual_owner_driver_restart_pending_invalid');
    }
  }

  async assertAmbiguousNoRetry(approvalId: string): Promise<void> {
    const body = await this.request(
      'POST',
      `v1/cases/${encodeURIComponent(approvalId)}/restart-ambiguous`
    );
    exact(body, ['approvalId', 'automaticRetryPostDelta', 'status'], 'ambiguous_restart');
    if (
      body.approvalId !== approvalId ||
      body.status !== 'operator_required' ||
      body.automaticRetryPostDelta !== 0
    ) {
      throw new Error('hosted_actual_owner_driver_ambiguous_retry_invalid');
    }
  }

  async runRestartMatrix(): Promise<void> {
    for (const checkpoint of REQUIRED_RESTART_CHECKPOINTS)
      await this.runRestartCheckpoint(checkpoint);
  }

  async runNegativeMatrix(): Promise<void> {
    for (const negative of REQUIRED_NEGATIVE_CASES) await this.runNegative(negative);
  }

  private async runRestartCheckpoint(checkpoint: ActualOwnerRestartCheckpoint): Promise<void> {
    const body = await this.request('POST', 'v1/restart-matrix', { checkpoint });
    exact(
      body,
      ['approvalId', 'checkpoint', 'duplicatePendingDelta', 'postDelta', 'survived'],
      'restart_checkpoint'
    );
    if (
      body.checkpoint !== checkpoint ||
      body.survived !== true ||
      body.duplicatePendingDelta !== 0 ||
      body.postDelta !== 0
    ) {
      throw new Error(`hosted_actual_owner_driver_restart_${checkpoint}_invalid`);
    }
  }

  private async runNegative(negative: ActualOwnerNegativeCase): Promise<void> {
    const body = await this.request('POST', 'v1/negatives', { case: negative });
    exact(
      body,
      [
        'approvalId',
        'attemptPostDelta',
        'automaticRetryPostDelta',
        'case',
        'effectDelta',
        'outcome',
      ],
      'negative'
    );
    const expectedAttemptPosts =
      negative.startsWith('http_') ||
      ['redirect', 'timeout', 'reset', 'malformed_response'].includes(negative)
        ? 1
        : 0;
    if (
      body.case !== negative ||
      typeof body.approvalId !== 'string' ||
      !/^approval_[A-Za-z0-9._:-]{8,191}$/u.test(body.approvalId) ||
      body.effectDelta !== 0 ||
      body.attemptPostDelta !== expectedAttemptPosts ||
      body.automaticRetryPostDelta !== 0 ||
      body.outcome !== EXPECTED_NEGATIVE_OUTCOMES[negative]
    ) {
      throw new Error(`hosted_actual_owner_driver_negative_${negative}_invalid`);
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    payload?: Readonly<Record<string, unknown>>
  ): Promise<JsonRecord> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.manifest.driverBaseUrl), {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      if (response.status !== 200) {
        throw new Error(`hosted_actual_owner_driver_http_${response.status}`);
      }
      return record(await response.json(), 'response');
    } finally {
      clearTimeout(timer);
    }
  }
}
