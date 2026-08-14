import { readFile } from 'node:fs/promises';

import {
  ACTUAL_OWNER_DRIVER_PROTOCOL,
  ACTUAL_OWNER_PURPOSE,
  REQUIRED_NEGATIVE_CASES,
  REQUIRED_RESTART_CHECKPOINTS,
  type ActualOwnerNegativeCase,
  type ActualOwnerRestartCheckpoint,
  type ActualOwnerRuntimeManifest,
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

export async function loadActualOwnerRuntimeManifest(path: string): Promise<ActualOwnerRuntimeManifest> {
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
  return parsed as unknown as ActualOwnerRuntimeManifest;
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
      body.decisionPath.startsWith('//')
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
    const body = await this.request('POST', `v1/cases/${encodeURIComponent(approvalId)}/restart-pending`);
    exact(body, ['approvalId', 'pendingAfterRestart'], 'restart_pending');
    if (body.approvalId !== approvalId || body.pendingAfterRestart !== true) {
      throw new Error('hosted_actual_owner_driver_restart_pending_invalid');
    }
  }

  async assertAmbiguousNoRetry(approvalId: string): Promise<void> {
    const body = await this.request('POST', `v1/cases/${encodeURIComponent(approvalId)}/restart-ambiguous`);
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
    for (const checkpoint of REQUIRED_RESTART_CHECKPOINTS) await this.runRestartCheckpoint(checkpoint);
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
      ['approvalId', 'attemptPostDelta', 'automaticRetryPostDelta', 'case', 'effectDelta', 'outcome'],
      'negative'
    );
    const expectedAttemptPosts = negative.startsWith('http_') ||
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
      !['forbidden', 'operator_required', 'stale', 'unavailable'].includes(String(body.outcome))
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
