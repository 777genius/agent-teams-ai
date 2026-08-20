import { createHash, createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH,
  ACTUAL_OWNER_DESCRIPTOR_TOKENS,
  ACTUAL_OWNER_DRIVER_PROTOCOL,
  ACTUAL_OWNER_PURPOSE,
  type ActualOwnerNegativeCase,
  type ActualOwnerRestartCheckpoint,
  type ActualOwnerRuntimeManifest,
  type ActualOwnerTimelineAuthority,
  actualOwnerTimelineAuthorityPayload,
  EXPECTED_NEGATIVE_OUTCOMES,
  parseActualOwnerContractBundle,
  REQUIRED_NEGATIVE_CASES,
  REQUIRED_RESTART_CHECKPOINTS,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';

import type { ActualOwnerDecisionNonceIssuance } from '../../../../scripts/e2e/hosted-actual-owner/evidence';

export type ActualOwnerBrowserCase = 'allow' | 'ambiguous' | 'deny' | 'non_owner';

export interface ActualOwnerStartedCase {
  readonly actionNonceSha256: string;
  readonly approvalId: string;
  readonly decisionPath: string;
  readonly decisionRequest: Readonly<Record<string, unknown>>;
  readonly decisionRequestSha256: string;
  readonly generation: string;
  readonly effectId: string | null;
  readonly requestId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly summary: string;
  readonly nonceIssuance: ActualOwnerDecisionNonceIssuance;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new Error('hosted_actual_owner_driver_canonical_json_invalid');
    return serialized;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('hosted_actual_owner_driver_canonical_json_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const item = value as JsonRecord;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
      .join(',')}}`;
  }
  throw new Error('hosted_actual_owner_driver_canonical_json_invalid');
}

function authenticatedNonceIssuance(
  value: unknown,
  manifest: ActualOwnerRuntimeManifest
): ActualOwnerDecisionNonceIssuance {
  const issuance = record(value, 'decision_nonce_issuance');
  exact(
    issuance,
    [
      'schemaVersion',
      'purpose',
      'actionNonce',
      'actionNonceSha256',
      'approvalId',
      'authentication',
      'decisionBody',
      'decisionBodySha256',
      'issuedAt',
      'ownerSessionId',
      'runId',
    ],
    'decision_nonce_issuance'
  );
  const { authentication, ...unsigned } = issuance;
  const ownerToken = process.env.HOSTED_ACTUAL_OWNER_E2E_OWNER_TOKEN;
  let decisionBody: unknown;
  try {
    decisionBody = JSON.parse(String(issuance.decisionBody));
  } catch {
    throw new Error('hosted_actual_owner_driver_decision_nonce_issuance_invalid');
  }
  if (
    issuance.schemaVersion !== 1 ||
    issuance.purpose !== 'agent-teams.hosted-actual-owner-e2e.decision-nonce-issuance/v1' ||
    typeof issuance.actionNonce !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(issuance.actionNonce) ||
    issuance.actionNonceSha256 !==
      createHash('sha256').update(issuance.actionNonce).digest('hex') ||
    typeof issuance.decisionBody !== 'string' ||
    canonicalJson(decisionBody) !== issuance.decisionBody ||
    issuance.decisionBodySha256 !==
      createHash('sha256').update(issuance.decisionBody).digest('hex') ||
    typeof issuance.approvalId !== 'string' ||
    (decisionBody as JsonRecord).approvalId !== issuance.approvalId ||
    (decisionBody as JsonRecord).actionNonce !== issuance.actionNonce ||
    issuance.ownerSessionId !== manifest.ownerBinding.ownerSessionId ||
    issuance.runId !== manifest.runId ||
    typeof issuance.issuedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(issuance.issuedAt) ||
    new Date(issuance.issuedAt).toISOString() !== issuance.issuedAt ||
    typeof ownerToken !== 'string' ||
    typeof authentication !== 'string' ||
    authentication !==
      createHmac('sha256', ownerToken).update(canonicalJson(unsigned)).digest('hex')
  ) {
    throw new Error('hosted_actual_owner_driver_decision_nonce_issuance_invalid');
  }
  return Object.freeze(issuance) as unknown as ActualOwnerDecisionNonceIssuance;
}

function validateCapabilitySocket(value: unknown, endpoint: string, ownerSessionId: string): void {
  const socket = record(value, 'capability_socket');
  exact(socket, ['device', 'endpoint', 'inode', 'ownerSessionId'], 'capability_socket');
  if (
    socket.endpoint !== endpoint ||
    socket.ownerSessionId !== ownerSessionId ||
    typeof socket.device !== 'string' ||
    !/^\d+$/u.test(socket.device) ||
    typeof socket.inode !== 'string' ||
    !/^\d+$/u.test(socket.inode)
  ) {
    throw new Error('hosted_actual_owner_driver_capability_socket_invalid');
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
      'capabilityEndpoint',
      'ownerWalTimelineRawPath',
      'ownerBinding',
      'socketIdentity',
      'contract',
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
  exact(
    browser,
    ['ownerStorageStatePath', 'nonOwnerStorageStatePath', 'tracePath', 'resultsPath'],
    'runtime_browser'
  );
  exact(
    capture,
    [
      'browserResultsPath',
      'conditionalPostLedgerPath',
      'negativeResultsPath',
      'openCodeTimelinePath',
      'ownerWalTimelinePath',
      'productTimelinePath',
      'protectedEffectLedgerPath',
    ],
    'runtime_capture'
  );
  if (
    capture.browserResultsPath !== browser.resultsPath ||
    parsed.ownerWalTimelineRawPath !== capture.ownerWalTimelinePath
  ) {
    throw new Error('hosted_actual_owner_driver_capture_contract_invalid');
  }
  const ownerBinding = record(parsed.ownerBinding, 'runtime_owner_binding');
  exact(ownerBinding, ['ownerUid', 'ownerSessionId', 'ownerTokenSha256'], 'runtime_owner_binding');
  const token = process.env.HOSTED_ACTUAL_OWNER_E2E_OWNER_TOKEN;
  if (
    ownerBinding.ownerUid !== process.getuid?.() ||
    ownerBinding.ownerSessionId !== `session_${parsed.runId}` ||
    typeof token !== 'string' ||
    createHash('sha256').update(token).digest('hex') !== ownerBinding.ownerTokenSha256
  ) {
    throw new Error('hosted_actual_owner_driver_owner_binding_invalid');
  }
  const socketIdentity = record(parsed.socketIdentity, 'runtime_socket_identity');
  exact(socketIdentity, ['driverSocket', 'productSocket'], 'runtime_socket_identity');
  if (
    socketIdentity.driverSocket !== new URL(String(parsed.driverBaseUrl)).host ||
    socketIdentity.productSocket !== new URL(String(parsed.productBaseUrl)).host ||
    parsed.capabilityEndpoint !== new URL('v1/capability', String(parsed.driverBaseUrl)).toString()
  ) {
    throw new Error('hosted_actual_owner_driver_socket_identity_invalid');
  }
  const contract = record(parsed.contract, 'runtime_contract');
  exact(
    contract,
    [
      'path',
      'sha256',
      'byteCount',
      'gitBlob',
      'sourceCommit',
      'repositoryPath',
      'device',
      'inode',
      'mode',
    ],
    'runtime_contract'
  );
  const contractPath = expand(contract.path);
  const contractHandle = await open(contractPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await contractHandle.stat({ bigint: true });
    const bundle = parseActualOwnerContractBundle(await contractHandle.readFile());
    if (
      contract.repositoryPath !== ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH ||
      contract.sourceCommit !== (record(parsed.refs, 'runtime_refs').product as string) ||
      contract.sha256 !== bundle.sha256 ||
      contract.byteCount !== bundle.byteCount ||
      contract.device !== stat.dev.toString() ||
      contract.inode !== stat.ino.toString() ||
      contract.mode !== (stat.mode & 0o777n).toString() ||
      stat.nlink !== 1n
    ) {
      throw new Error('hosted_actual_owner_driver_contract_binding_invalid');
    }
  } finally {
    await contractHandle.close();
  }
  return Object.freeze({
    ...parsed,
    sandboxRoot: expand(parsed.sandboxRoot),
    markerPath: expand(parsed.markerPath),
    ownerWalTimelineRawPath: expand(parsed.ownerWalTimelineRawPath),
    browser: Object.freeze(
      Object.fromEntries(Object.entries(browser).map(([key, value]) => [key, expand(value)]))
    ),
    capture: Object.freeze(
      Object.fromEntries(Object.entries(capture).map(([key, value]) => [key, expand(value)]))
    ),
    contract: Object.freeze({ ...contract, path: contractPath }),
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
  private readonly allCaseNonceIssuanceLedger = new Map<string, ActualOwnerDecisionNonceIssuance>();
  private readonly ownerPostNonceIssuanceLedger = new Map<
    string,
    ActualOwnerDecisionNonceIssuance
  >();

  constructor(
    private readonly manifest: ActualOwnerRuntimeManifest,
    private readonly timeoutMs: number
  ) {}

  async assertCapability(): Promise<void> {
    const body = await this.request('GET', 'v1/capability');
    exact(
      body,
      [
        'schemaVersion',
        'protocol',
        'noFakeRuntime',
        'markerPath',
        'refs',
        'contract',
        'ownerBinding',
        'socketIdentity',
      ],
      'capability'
    );
    const socketIdentity = record(body.socketIdentity, 'capability_socket_identity');
    exact(socketIdentity, ['driverSocket', 'productSocket'], 'capability_socket_identity');
    validateCapabilitySocket(
      socketIdentity.driverSocket,
      this.manifest.socketIdentity.driverSocket,
      this.manifest.ownerBinding.ownerSessionId
    );
    validateCapabilitySocket(
      socketIdentity.productSocket,
      this.manifest.socketIdentity.productSocket,
      this.manifest.ownerBinding.ownerSessionId
    );
    const driverSocket = record(socketIdentity.driverSocket, 'driver_socket');
    const productSocket = record(socketIdentity.productSocket, 'product_socket');
    if (
      body.schemaVersion !== 1 ||
      body.protocol !== ACTUAL_OWNER_DRIVER_PROTOCOL ||
      body.noFakeRuntime !== true ||
      body.markerPath !== this.manifest.markerPath ||
      JSON.stringify(body.contract) !== JSON.stringify(this.manifest.contract) ||
      JSON.stringify(body.ownerBinding) !== JSON.stringify(this.manifest.ownerBinding) ||
      (driverSocket.device === productSocket.device &&
        driverSocket.inode === productSocket.inode) ||
      JSON.stringify(body.refs) !== JSON.stringify(this.manifest.refs)
    ) {
      throw new Error('hosted_actual_owner_driver_capability_invalid');
    }
  }

  async startCase(kind: ActualOwnerBrowserCase): Promise<ActualOwnerStartedCase> {
    const body = await this.request('POST', 'v1/cases', { kind });
    exact(
      body,
      [
        'approvalId',
        'actionNonce',
        'decisionPath',
        'decisionRequest',
        'decisionRequestSha256',
        'generation',
        'effectId',
        'requestId',
        'routeId',
        'runId',
        'sessionId',
        'summary',
        'nonceIssuance',
      ],
      'started_case'
    );
    const decisionRequest = record(body.decisionRequest, 'decision_request');
    const decisionRequestSha256 = createHash('sha256')
      .update(JSON.stringify(decisionRequest))
      .digest('hex');
    const actionNonceSha256 = createHash('sha256').update(String(body.actionNonce)).digest('hex');
    const nonceIssuance = authenticatedNonceIssuance(body.nonceIssuance, this.manifest);
    if (
      typeof body.approvalId !== 'string' ||
      !/^approval_[A-Za-z0-9._:-]{8,191}$/u.test(body.approvalId) ||
      typeof body.actionNonce !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(body.actionNonce) ||
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
      new URL(body.decisionPath, this.manifest.productBaseUrl).pathname !== body.decisionPath ||
      body.decisionRequestSha256 !== decisionRequestSha256 ||
      typeof body.generation !== 'string' ||
      !/^generation_[A-Za-z0-9._-]{1,128}$/u.test(body.generation) ||
      typeof body.requestId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(body.requestId) ||
      typeof body.runId !== 'string' ||
      body.runId !== this.manifest.runId ||
      typeof body.routeId !== 'string' ||
      !/^route_[A-Za-z0-9._:-]{1,191}$/u.test(body.routeId) ||
      typeof body.sessionId !== 'string' ||
      body.sessionId !== this.manifest.ownerBinding.ownerSessionId ||
      (body.effectId !== null &&
        (typeof body.effectId !== 'string' ||
          !/^effect_[A-Za-z0-9._:-]{8,191}$/u.test(body.effectId))) ||
      decisionRequest.approvalId !== body.approvalId ||
      decisionRequest.actionNonce !== body.actionNonce ||
      decisionRequest.generation !== body.generation ||
      decisionRequest.requestId !== body.requestId ||
      decisionRequest.runId !== body.runId ||
      decisionRequest.routeId !== body.routeId ||
      decisionRequest.sessionId !== body.sessionId ||
      decisionRequest.effectId !== body.effectId ||
      !['allow_once', 'reject'].includes(String(decisionRequest.decision)) ||
      nonceIssuance.approvalId !== body.approvalId ||
      nonceIssuance.actionNonce !== body.actionNonce ||
      nonceIssuance.decisionBody !== canonicalJson(decisionRequest) ||
      nonceIssuance.decisionBodySha256 !== body.decisionRequestSha256
    ) {
      throw new Error('hosted_actual_owner_driver_started_case_invalid');
    }
    const effectId = body.effectId as string | null;
    this.trackNonceIssuance(nonceIssuance, kind !== 'non_owner');
    return Object.freeze({
      actionNonceSha256,
      approvalId: body.approvalId,
      decisionPath: body.decisionPath,
      decisionRequest: Object.freeze(decisionRequest),
      decisionRequestSha256,
      generation: body.generation,
      effectId,
      requestId: body.requestId,
      routeId: body.routeId,
      runId: body.runId,
      sessionId: body.sessionId,
      summary: body.summary,
      nonceIssuance,
    });
  }

  allCaseDecisionNonceIssuances(): readonly ActualOwnerDecisionNonceIssuance[] {
    return Object.freeze([...this.allCaseNonceIssuanceLedger.values()]);
  }

  ownerPostDecisionNonceIssuances(): readonly ActualOwnerDecisionNonceIssuance[] {
    return Object.freeze([...this.ownerPostNonceIssuanceLedger.values()]);
  }

  async ownerWalAuthority(): Promise<ActualOwnerTimelineAuthority> {
    const body = await this.request('GET', 'v1/owner-wal-authority');
    exact(
      body,
      [
        'authority',
        'byteCount',
        'ctimeNs',
        'device',
        'inode',
        'mtimeNs',
        'ownerSessionId',
        'sha256',
        'signature',
        'size',
      ],
      'owner_wal_authority'
    );
    const unsigned = {
      authority: body.authority,
      byteCount: body.byteCount,
      ctimeNs: body.ctimeNs,
      device: body.device,
      inode: body.inode,
      mtimeNs: body.mtimeNs,
      ownerSessionId: body.ownerSessionId,
      sha256: body.sha256,
      size: body.size,
    } as Omit<ActualOwnerTimelineAuthority, 'signature'>;
    const ownerToken = process.env.HOSTED_ACTUAL_OWNER_E2E_OWNER_TOKEN ?? '';
    const expected = createHmac('sha256', ownerToken)
      .update(actualOwnerTimelineAuthorityPayload(unsigned))
      .digest('hex');
    if (
      body.authority !== 'product-owner-wal' ||
      body.ownerSessionId !== this.manifest.ownerBinding.ownerSessionId ||
      typeof body.byteCount !== 'number' ||
      !Number.isSafeInteger(body.byteCount) ||
      body.byteCount < 2 ||
      body.size !== body.byteCount ||
      ![body.ctimeNs, body.device, body.inode, body.mtimeNs].every(
        (value) => typeof value === 'string' && /^\d+$/u.test(value)
      ) ||
      typeof body.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(body.sha256) ||
      body.signature !== expected
    ) {
      throw new Error('hosted_actual_owner_driver_owner_wal_authority_invalid');
    }
    return Object.freeze(body) as unknown as ActualOwnerTimelineAuthority;
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
        'nonceIssuance',
        'outcome',
      ],
      'negative'
    );
    const expectedAttemptPosts =
      negative.startsWith('http_') ||
      ['redirect', 'timeout', 'reset', 'malformed_response'].includes(negative)
        ? 1
        : 0;
    const nonceIssuance =
      expectedAttemptPosts === 1
        ? authenticatedNonceIssuance(body.nonceIssuance, this.manifest)
        : null;
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
    if (
      (expectedAttemptPosts === 0 && body.nonceIssuance !== null) ||
      (nonceIssuance !== null && nonceIssuance.approvalId !== body.approvalId)
    ) {
      throw new Error(`hosted_actual_owner_driver_negative_${negative}_nonce_invalid`);
    }
    if (nonceIssuance) this.trackNonceIssuance(nonceIssuance, true);
  }

  private trackNonceIssuance(
    nonceIssuance: ActualOwnerDecisionNonceIssuance,
    expectsOwnerPost: boolean
  ): void {
    if (
      this.allCaseNonceIssuanceLedger.has(nonceIssuance.approvalId) ||
      [...this.allCaseNonceIssuanceLedger.values()].some(
        (tracked) =>
          tracked.actionNonce === nonceIssuance.actionNonce ||
          tracked.actionNonceSha256 === nonceIssuance.actionNonceSha256
      )
    ) {
      throw new Error('hosted_actual_owner_driver_decision_nonce_reissued');
    }
    this.allCaseNonceIssuanceLedger.set(nonceIssuance.approvalId, nonceIssuance);
    if (expectsOwnerPost) {
      this.ownerPostNonceIssuanceLedger.set(nonceIssuance.approvalId, nonceIssuance);
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
      const ownerToken = process.env.HOSTED_ACTUAL_OWNER_E2E_OWNER_TOKEN;
      if (
        !ownerToken ||
        createHash('sha256').update(ownerToken).digest('hex') !==
          this.manifest.ownerBinding.ownerTokenSha256
      ) {
        throw new Error('hosted_actual_owner_driver_owner_token_invalid');
      }
      const response = await fetch(new URL(path, this.manifest.driverBaseUrl), {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-actual-owner-session': this.manifest.ownerBinding.ownerSessionId,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
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
