import { createHash, createHmac } from 'node:crypto';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  ACTUAL_OWNER_CONTRACT_BYTE_COUNT,
  ACTUAL_OWNER_CONTRACT_GIT_BLOB,
  ACTUAL_OWNER_CONTRACT_SHA256,
  ACTUAL_OWNER_PURPOSE,
  EXPECTED_NEGATIVE_OUTCOMES,
  REQUIRED_NEGATIVE_CASES,
  REQUIRED_RESTART_CHECKPOINTS,
  type ActualOwnerNegativeCase,
  type ActualOwnerProcessName,
  type ActualOwnerRestartCheckpoint,
  type ActualOwnerTimelineEvent,
  type ActualOwnerTimelineAuthority,
  exactIsoTimestamp,
  validateActualOwnerTimelineEvent,
} from './contracts';
import type {
  ActualOwnerArtifactEvidence,
  ActualOwnerExecutableEvidence,
  ActualOwnerRepositoryEvidence,
  ActualOwnerSourceFileEvidence,
} from './preflight';
import type { ActualOwnerCleanupEvidence, ActualOwnerSandbox } from './sandbox';
import {
  atomicAnchoredPrivateFile,
  readAnchoredPrivateFile,
  readAnchoredPrivateFileEvidence,
} from './secure-files';

export interface ActualOwnerDiskEvidence {
  readonly availableBytes: number;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export interface ActualOwnerProcessEvidence {
  readonly args: readonly string[];
  readonly executable: string;
  readonly executableDevice: string;
  readonly executableInode: string;
  readonly executableSha256: string;
  readonly name: ActualOwnerProcessName;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly sourceRef: string;
  readonly uid: number;
}

export interface ActualOwnerPostLedgerEntry {
  readonly actionNonceSha256: string;
  readonly approvalId: string;
  readonly at: string;
  readonly bodySha256: string;
  readonly conditional: true;
  readonly decision: 'allow_once' | 'reject';
  readonly generation: string;
  readonly effectId: string | null;
  readonly requestId: string;
  readonly routeId: string;
  readonly responseClass: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly upstream: 'real_opencode';
}

export interface ActualOwnerProtectedEffectEntry {
  readonly actionNonceSha256: string;
  readonly approvalId: string;
  readonly at: string;
  readonly decisionBodySha256: string | null;
  readonly effectCount: number;
  readonly effectId: string | null;
  readonly effectSha256: string | null;
  readonly generation: string;
  readonly kind: 'allow' | 'deny' | 'ambiguous' | 'negative';
  readonly requestId: string;
  readonly routeId: string;
  readonly runId: string;
  readonly sessionId: string;
}

export interface ActualOwnerNegativeEvidence {
  readonly approvalId: string;
  readonly automaticRetryPostDelta: number;
  readonly case: ActualOwnerNegativeCase;
  readonly effectDelta: number;
  readonly outcome: 'forbidden' | 'operator_required' | 'stale' | 'unavailable';
  readonly attemptPostDelta: number;
}

export interface ActualOwnerRestartEvidence {
  readonly approvalId: string;
  readonly checkpoint: ActualOwnerRestartCheckpoint;
  readonly duplicatePendingDelta: number;
  readonly postDelta: number;
  readonly survived: boolean;
}

export interface ActualOwnerDecisionNonceIssuance {
  readonly schemaVersion: 1;
  readonly purpose: 'agent-teams.hosted-actual-owner-e2e.decision-nonce-issuance/v1';
  readonly actionNonce: string;
  readonly actionNonceSha256: string;
  readonly approvalId: string;
  readonly authentication: string;
  readonly decisionBody: string;
  readonly decisionBodySha256: string;
  readonly issuedAt: string;
  readonly ownerSessionId: string;
  readonly runId: string;
}

export interface ActualOwnerBrowserResults {
  readonly schemaVersion: 1;
  readonly nonceIssuances: readonly ActualOwnerDecisionNonceIssuance[];
  readonly ownerWalAuthority: ActualOwnerTimelineAuthority;
  readonly ownerAllow: Readonly<{
    actionNonceSha256: string;
    approvalId: string;
    bodySha256: string;
    clicked: true;
    clickedAt: string;
    decision: 'allow_once';
    generation: string;
    effectId: string | null;
    pendingAfterRestart: true;
    requestId: string;
    routeId: string;
    runId: string;
    sessionId: string;
  }>;
  readonly ownerDeny: Readonly<{
    actionNonceSha256: string;
    approvalId: string;
    bodySha256: string;
    clicked: true;
    clickedAt: string;
    decision: 'reject';
    generation: string;
    effectId: string | null;
    requestId: string;
    routeId: string;
    runId: string;
    sessionId: string;
  }>;
  readonly nonOwner: Readonly<{ status: 403; postDelta: 0; effectDelta: 0 }>;
  readonly ambiguous: Readonly<{
    actionNonceSha256: string;
    approvalId: string;
    automaticRetryPostDelta: 0;
    bodySha256: string;
    clicked: true;
    clickedAt: string;
    decision: 'allow_once';
    generation: string;
    effectId: string | null;
    requestId: string;
    routeId: string;
    runId: string;
    sessionId: string;
    status: 'operator_required';
  }>;
}

export interface ActualOwnerCapabilityEvidence {
  readonly checkedAt: string;
  readonly contractSha256: string;
  readonly driverSocket: Readonly<{
    readonly device: string;
    readonly endpoint: string;
    readonly inode: string;
    readonly ownerSessionId: string;
  }>;
  readonly markerPath: string;
  readonly noFakeRuntime: true;
  readonly ownerSessionId: string;
  readonly productSocket: Readonly<{
    readonly device: string;
    readonly endpoint: string;
    readonly inode: string;
    readonly ownerSessionId: string;
  }>;
  readonly refsSha256: string;
}

export interface ActualOwnerTimelineCaptureEvidence {
  readonly byteCount: number;
  readonly ctimeNs: string;
  readonly device: string;
  readonly inode: string;
  readonly mtimeNs: string;
  readonly path: string;
  readonly sha256: string;
}

export interface ActualOwnerEvidenceDocument {
  readonly schemaVersion: 1;
  readonly purpose: typeof ACTUAL_OWNER_PURPOSE;
  readonly runId: string;
  readonly status: 'failed' | 'passed' | 'running';
  readonly refs: Readonly<{
    readonly artifact: ActualOwnerArtifactEvidence | null;
    readonly orchestrator: ActualOwnerRepositoryEvidence | null;
    readonly product: ActualOwnerRepositoryEvidence | null;
    readonly productExecutable: ActualOwnerExecutableEvidence | null;
    readonly productContractSource: ActualOwnerSourceFileEvidence | null;
    readonly productContractStaged: ActualOwnerSourceFileEvidence | null;
    readonly orchestratorLauncherSource: ActualOwnerSourceFileEvidence | null;
    readonly orchestratorAcceptanceSource: ActualOwnerSourceFileEvidence | null;
    readonly orchestratorLauncherStaged: ActualOwnerSourceFileEvidence | null;
    readonly orchestratorAcceptanceStaged: ActualOwnerSourceFileEvidence | null;
    readonly playwrightReleaseManifest: Readonly<{
      readonly byteCount: number;
      readonly sha256: string;
    }> | null;
  }>;
  readonly disk: Readonly<{
    readonly before: ActualOwnerDiskEvidence;
    readonly after: ActualOwnerDiskEvidence | null;
  }>;
  readonly processIds: readonly ActualOwnerProcessEvidence[];
  readonly capability: ActualOwnerCapabilityEvidence | null;
  readonly timelines: Readonly<{
    readonly ownerWal: readonly ActualOwnerTimelineEvent[];
    readonly product: readonly ActualOwnerTimelineEvent[];
    readonly openCode: readonly ActualOwnerTimelineEvent[];
  }>;
  readonly timelineCaptures: Readonly<{
    readonly ownerWal: ActualOwnerTimelineCaptureEvidence | null;
    readonly product: ActualOwnerTimelineCaptureEvidence | null;
    readonly openCode: ActualOwnerTimelineCaptureEvidence | null;
  }>;
  readonly postLedger: readonly ActualOwnerPostLedgerEntry[];
  readonly protectedEffectLedger: readonly ActualOwnerProtectedEffectEntry[];
  readonly browserTracePath: string | null;
  readonly browser: ActualOwnerBrowserResults | null;
  readonly restartMatrix: readonly ActualOwnerRestartEvidence[];
  readonly negatives: readonly ActualOwnerNegativeEvidence[];
  readonly cleanup: ActualOwnerCleanupEvidence | null;
  readonly assertions: Readonly<{
    readonly checked: boolean;
    readonly violations: readonly string[];
  }>;
  readonly failure: string | null;
}

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export function initialActualOwnerEvidence(input: {
  readonly diskBefore: ActualOwnerDiskEvidence;
  readonly runId: string;
}): ActualOwnerEvidenceDocument {
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PURPOSE,
    runId: input.runId,
    status: 'running',
    refs: Object.freeze({
      artifact: null,
      orchestrator: null,
      product: null,
      productExecutable: null,
      productContractSource: null,
      productContractStaged: null,
      orchestratorLauncherSource: null,
      orchestratorAcceptanceSource: null,
      orchestratorLauncherStaged: null,
      orchestratorAcceptanceStaged: null,
      playwrightReleaseManifest: null,
    }),
    disk: Object.freeze({ before: input.diskBefore, after: null }),
    processIds: Object.freeze([]),
    capability: null,
    timelines: Object.freeze({
      ownerWal: Object.freeze([]),
      product: Object.freeze([]),
      openCode: Object.freeze([]),
    }),
    timelineCaptures: Object.freeze({ ownerWal: null, product: null, openCode: null }),
    postLedger: Object.freeze([]),
    protectedEffectLedger: Object.freeze([]),
    browserTracePath: null,
    browser: null,
    restartMatrix: Object.freeze([]),
    negatives: Object.freeze([]),
    cleanup: null,
    assertions: Object.freeze({ checked: false, violations: Object.freeze([]) }),
    failure: null,
  });
}

export function validateActualOwnerCompletionEvidence(
  evidence: ActualOwnerEvidenceDocument
): readonly string[] {
  const violations: string[] = [];
  if (
    !evidence.refs.product ||
    !evidence.refs.orchestrator ||
    !evidence.refs.artifact ||
    !evidence.refs.productExecutable ||
    !evidence.refs.productContractSource ||
    !evidence.refs.productContractStaged ||
    !evidence.refs.orchestratorLauncherSource ||
    !evidence.refs.orchestratorAcceptanceSource ||
    !evidence.refs.orchestratorLauncherStaged ||
    !evidence.refs.orchestratorAcceptanceStaged ||
    !evidence.refs.playwrightReleaseManifest
  ) {
    violations.push('exact_refs_missing');
  }
  if (
    evidence.refs.playwrightReleaseManifest &&
    (!Number.isSafeInteger(evidence.refs.playwrightReleaseManifest.byteCount) ||
      evidence.refs.playwrightReleaseManifest.byteCount < 2 ||
      !/^[0-9a-f]{64}$/u.test(evidence.refs.playwrightReleaseManifest.sha256))
  ) {
    violations.push('playwright_release_manifest_evidence_invalid');
  }
  if (
    evidence.refs.product &&
    evidence.refs.productContractSource &&
    evidence.refs.productContractStaged &&
    (evidence.refs.productContractSource.sourceCommit !== evidence.refs.product.head ||
      evidence.refs.productContractStaged.sourceCommit !== evidence.refs.product.head ||
      evidence.refs.productContractStaged.sha256 !== evidence.refs.productContractSource.sha256 ||
      evidence.refs.productContractStaged.size !== evidence.refs.productContractSource.size ||
      evidence.refs.productContractSource.sha256 !== ACTUAL_OWNER_CONTRACT_SHA256 ||
      evidence.refs.productContractSource.size !== ACTUAL_OWNER_CONTRACT_BYTE_COUNT ||
      evidence.refs.productContractSource.gitBlob !== ACTUAL_OWNER_CONTRACT_GIT_BLOB ||
      evidence.refs.productContractStaged.gitBlob !== ACTUAL_OWNER_CONTRACT_GIT_BLOB ||
      evidence.refs.productContractStaged.mode !== 0o400)
  ) {
    violations.push('product_contract_git_blob_binding_invalid');
  }
  if (
    [evidence.disk.before, evidence.disk.after].some(
      (disk) =>
        disk !== null &&
        (!Number.isSafeInteger(disk.availableBytes) ||
          !Number.isSafeInteger(disk.freeBytes) ||
          !Number.isSafeInteger(disk.totalBytes) ||
          disk.availableBytes < 0 ||
          disk.freeBytes < 0 ||
          disk.totalBytes < disk.freeBytes ||
          disk.totalBytes < disk.availableBytes)
    )
  ) {
    violations.push('disk_evidence_invalid');
  }
  const processNames = new Set(evidence.processIds.map(({ name }) => name));
  const expectedCapabilityRefsSha256 =
    evidence.refs.artifact && evidence.refs.orchestrator && evidence.refs.product
      ? createHash('sha256')
          .update(
            JSON.stringify({
              openCode: evidence.refs.artifact.sourceCommit,
              openCodeExecutableSha256: evidence.refs.artifact.sha256,
              orchestrator: evidence.refs.orchestrator.head,
              product: evidence.refs.product.head,
            })
          )
          .digest('hex')
      : null;
  if (
    !evidence.capability ||
    evidence.capability.noFakeRuntime !== true ||
    !exactIsoTimestamp(evidence.capability.checkedAt) ||
    evidence.capability.refsSha256 !== expectedCapabilityRefsSha256 ||
    evidence.capability.contractSha256 !== evidence.refs.productContractSource?.sha256 ||
    evidence.capability.ownerSessionId !== `session_${evidence.runId}` ||
    !validSocketIdentity(evidence.capability.driverSocket, evidence.capability.ownerSessionId) ||
    !validSocketIdentity(evidence.capability.productSocket, evidence.capability.ownerSessionId) ||
    evidence.capability.driverSocket.endpoint === evidence.capability.productSocket.endpoint ||
    (evidence.capability.driverSocket.device === evidence.capability.productSocket.device &&
      evidence.capability.driverSocket.inode === evidence.capability.productSocket.inode) ||
    !isAbsolute(evidence.capability.markerPath)
  ) {
    violations.push('capability_observation_invalid');
  }
  if (
    evidence.processIds.length !== 3 ||
    processNames.size !== 3 ||
    !['opencode', 'orchestrator', 'product'].every((name) =>
      processNames.has(name as ActualOwnerProcessName)
    )
  ) {
    violations.push('real_process_identity_set_incomplete');
  }
  const openCodeProcess = evidence.processIds.find(({ name }) => name === 'opencode');
  if (
    !openCodeProcess ||
    !evidence.refs.artifact ||
    openCodeProcess.executableSha256 !== evidence.refs.artifact.sha256 ||
    openCodeProcess.sourceRef !== evidence.refs.artifact.sourceCommit ||
    !evidence.cleanup ||
    !openCodeProcess.executable.startsWith(
      `${evidence.cleanup.root}/runtime/descriptor-bound-executables/`
    )
  ) {
    violations.push('opencode_process_artifact_binding_invalid');
  }
  const productProcess = evidence.processIds.find(({ name }) => name === 'product');
  if (
    !productProcess ||
    !evidence.refs.product ||
    !evidence.refs.productExecutable ||
    productProcess.executableSha256 !== evidence.refs.productExecutable.sha256 ||
    productProcess.sourceRef !== evidence.refs.productExecutable.sourceCommit ||
    evidence.refs.productExecutable.sourceCommit !== evidence.refs.product.head ||
    !evidence.cleanup ||
    !productProcess.executable.startsWith(
      `${evidence.cleanup.root}/runtime/descriptor-bound-executables/`
    )
  ) {
    violations.push('product_process_artifact_binding_invalid');
  }
  const orchestratorProcess = evidence.processIds.find(({ name }) => name === 'orchestrator');
  const stagedSources = [
    evidence.refs.orchestratorLauncherStaged,
    evidence.refs.orchestratorAcceptanceStaged,
  ];
  if (
    !orchestratorProcess ||
    !evidence.refs.orchestrator ||
    !evidence.refs.orchestratorLauncherSource ||
    !evidence.refs.orchestratorAcceptanceSource ||
    stagedSources.some(
      (source) =>
        !source ||
        !evidence.cleanup ||
        !source.path.startsWith(
          `${evidence.cleanup.root}/runtime/descriptor-bound-sources/orchestrator-`
        )
    ) ||
    evidence.refs.orchestratorLauncherStaged?.sha256 !==
      evidence.refs.orchestratorLauncherSource.sha256 ||
    evidence.refs.orchestratorAcceptanceStaged?.sha256 !==
      evidence.refs.orchestratorAcceptanceSource.sha256 ||
    evidence.refs.orchestratorLauncherStaged?.mode !== 0o500 ||
    evidence.refs.orchestratorAcceptanceStaged?.mode !== 0o400 ||
    evidence.refs.orchestratorLauncherStaged?.sourceCommit !== evidence.refs.orchestrator.head ||
    evidence.refs.orchestratorAcceptanceStaged?.sourceCommit !== evidence.refs.orchestrator.head ||
    orchestratorProcess.sourceRef !== evidence.refs.orchestrator.head ||
    evidence.refs.orchestratorLauncherSource.sourceCommit !== evidence.refs.orchestrator.head ||
    evidence.refs.orchestratorAcceptanceSource.sourceCommit !== evidence.refs.orchestrator.head
  ) {
    violations.push('orchestrator_process_source_binding_invalid');
  }
  if (
    evidence.processIds.some(
      (item) =>
        !Number.isSafeInteger(item.pid) ||
        item.pid < 1 ||
        !Number.isSafeInteger(item.uid) ||
        item.uid < 0 ||
        typeof item.processStartIdentity !== 'string' ||
        !/^\d+$/u.test(item.processStartIdentity) ||
        typeof item.sourceRef !== 'string' ||
        !/^[0-9a-f]{40}$/u.test(item.sourceRef) ||
        typeof item.executableSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(item.executableSha256)
    ) ||
    new Set(evidence.processIds.map(({ pid }) => pid)).size !== evidence.processIds.length
  ) {
    violations.push('real_process_identity_invalid');
  }
  const allow = evidence.browser?.ownerAllow?.approvalId;
  const deny = evidence.browser?.ownerDeny?.approvalId;
  const ambiguous = evidence.browser?.ambiguous?.approvalId;
  if (
    !hasExactKeys(evidence.browser, [
      'schemaVersion',
      'nonceIssuances',
      'ownerAllow',
      'ownerDeny',
      'nonOwner',
      'ambiguous',
      'ownerWalAuthority',
    ]) ||
    evidence.browser?.schemaVersion !== 1 ||
    !Array.isArray(evidence.browser?.nonceIssuances) ||
    !hasExactKeys(evidence.browser?.ownerAllow, [
      'approvalId',
      'actionNonceSha256',
      'bodySha256',
      'clicked',
      'clickedAt',
      'decision',
      'generation',
      'effectId',
      'pendingAfterRestart',
      'requestId',
      'routeId',
      'runId',
      'sessionId',
    ]) ||
    !hasExactKeys(evidence.browser?.ownerDeny, [
      'approvalId',
      'actionNonceSha256',
      'bodySha256',
      'clicked',
      'clickedAt',
      'decision',
      'generation',
      'effectId',
      'requestId',
      'routeId',
      'runId',
      'sessionId',
    ]) ||
    !hasExactKeys(evidence.browser?.ambiguous, [
      'approvalId',
      'actionNonceSha256',
      'automaticRetryPostDelta',
      'bodySha256',
      'clicked',
      'clickedAt',
      'decision',
      'generation',
      'effectId',
      'requestId',
      'routeId',
      'runId',
      'sessionId',
      'status',
    ]) ||
    !hasExactKeys(evidence.browser?.nonOwner, ['status', 'postDelta', 'effectDelta']) ||
    !allow ||
    !deny ||
    !ambiguous ||
    new Set([allow, deny, ambiguous]).size !== 3 ||
    evidence.browser?.ownerAllow?.clicked !== true ||
    evidence.browser?.ownerAllow?.decision !== 'allow_once' ||
    !validClickTime(evidence.browser?.ownerAllow?.clickedAt) ||
    evidence.browser?.ownerDeny?.clicked !== true ||
    evidence.browser?.ownerDeny?.decision !== 'reject' ||
    !validClickTime(evidence.browser?.ownerDeny?.clickedAt) ||
    evidence.browser?.ambiguous?.clicked !== true ||
    evidence.browser?.ambiguous?.decision !== 'allow_once' ||
    !validClickTime(evidence.browser?.ambiguous?.clickedAt)
  ) {
    violations.push('browser_case_identity_invalid');
  }
  if (!validDecisionNonceIssuanceSet(evidence)) {
    violations.push('decision_nonce_issuance_consumption_invalid');
  }
  if (
    evidence.browser?.nonOwner?.status !== 403 ||
    evidence.browser?.nonOwner?.postDelta !== 0 ||
    evidence.browser?.nonOwner?.effectDelta !== 0
  ) {
    violations.push('non_owner_not_forbidden');
  }
  if (!evidence.browserTracePath || !isAbsolute(evidence.browserTracePath)) {
    violations.push('browser_trace_missing');
  }
  const timelineEvents = [
    ...evidence.timelines.ownerWal,
    ...evidence.timelines.product,
    ...evidence.timelines.openCode,
  ];
  if (
    Object.values(evidence.timelineCaptures).some(
      (capture) =>
        !capture ||
        !isAbsolute(capture.path) ||
        !Number.isSafeInteger(capture.byteCount) ||
        capture.byteCount < 1 ||
        !/^[0-9a-f]{64}$/u.test(capture.sha256) ||
        ![capture.device, capture.inode, capture.mtimeNs, capture.ctimeNs].every((value) =>
          /^\d+$/u.test(value)
        )
    )
  ) {
    violations.push('timeline_capture_identity_invalid');
  }
  const ownerWalAuthority = evidence.browser?.ownerWalAuthority;
  const ownerWalCapture = evidence.timelineCaptures.ownerWal;
  if (
    !hasExactKeys(ownerWalAuthority, [
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
    ]) ||
    ownerWalAuthority?.authority !== 'product-owner-wal' ||
    ownerWalAuthority.ownerSessionId !== `session_${evidence.runId}` ||
    !/^[0-9a-f]{64}$/u.test(ownerWalAuthority.signature) ||
    !ownerWalCapture ||
    ownerWalAuthority.byteCount !== ownerWalCapture.byteCount ||
    ownerWalAuthority.size !== ownerWalCapture.byteCount ||
    ownerWalAuthority.sha256 !== ownerWalCapture.sha256 ||
    ownerWalAuthority.device !== ownerWalCapture.device ||
    ownerWalAuthority.inode !== ownerWalCapture.inode ||
    ownerWalAuthority.mtimeNs !== ownerWalCapture.mtimeNs ||
    ownerWalAuthority.ctimeNs !== ownerWalCapture.ctimeNs
  ) {
    violations.push('owner_wal_raw_authority_invalid');
  }
  if (
    timelineEvents.some((item) => {
      try {
        return validateActualOwnerTimelineEvent(item).runId !== evidence.runId;
      } catch {
        return true;
      }
    })
  ) {
    violations.push('timeline_event_invalid');
  }
  if (
    [evidence.timelines.ownerWal, evidence.timelines.product, evidence.timelines.openCode].some(
      (timeline) =>
        new Set(timeline.map(({ sequence }) => sequence)).size !== timeline.length ||
        timeline.some(
          (item, index) => index > 0 && item.sequence <= (timeline[index - 1]?.sequence ?? -1)
        )
    )
  ) {
    violations.push('timeline_sequence_invalid');
  }
  if (
    evidence.postLedger.some(
      (item) =>
        !hasExactKeys(item, [
          'approvalId',
          'actionNonceSha256',
          'at',
          'bodySha256',
          'conditional',
          'decision',
          'generation',
          'effectId',
          'requestId',
          'routeId',
          'responseClass',
          'runId',
          'sessionId',
          'sequence',
          'upstream',
        ]) ||
        item.conditional !== true ||
        item.upstream !== 'real_opencode' ||
        !/^approval_[A-Za-z0-9._:-]{8,191}$/u.test(item.approvalId) ||
        !/^[0-9a-f]{64}$/u.test(item.bodySha256) ||
        !/^[0-9a-f]{64}$/u.test(item.actionNonceSha256) ||
        !Number.isSafeInteger(item.sequence) ||
        item.sequence < 0 ||
        !exactIsoTimestamp(item.at) ||
        !/^generation_[A-Za-z0-9._-]{1,128}$/u.test(item.generation) ||
        (item.effectId !== null &&
          (typeof item.effectId !== 'string' ||
            !/^effect_[A-Za-z0-9._:-]{8,191}$/u.test(item.effectId))) ||
        !/^route_[A-Za-z0-9._:-]{1,191}$/u.test(item.routeId) ||
        !/^session_[A-Za-z0-9._:-]{1,191}$/u.test(item.sessionId) ||
        typeof item.requestId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(item.requestId) ||
        item.runId !== evidence.runId ||
        typeof item.responseClass !== 'string' ||
        item.responseClass.length < 1
    ) ||
    new Set(evidence.postLedger.map(({ sequence }) => sequence)).size !== evidence.postLedger.length
  ) {
    violations.push('conditional_post_ledger_invalid');
  }
  if (allow && !pendingBeforeDecision(evidence, allow, true)) {
    violations.push('allow_pending_not_durable_before_decision');
  }
  if (evidence.browser?.ownerAllow?.pendingAfterRestart !== true) {
    violations.push('allow_pending_restart_not_proved');
  }
  if (deny && !pendingBeforeDecision(evidence, deny, false)) {
    violations.push('deny_pending_not_durable_before_decision');
  }
  if (allow && !singleConditionalPost(evidence, allow, 'allow_once', 'applied')) {
    violations.push('allow_post_count_not_one');
  }
  if (deny && !singleConditionalPost(evidence, deny, 'reject', 'applied')) {
    violations.push('deny_post_count_not_one');
  }
  if (allow && !singleEffect(evidence, allow, 'allow', 1))
    violations.push('allow_effect_count_not_one');
  if (deny && !singleEffect(evidence, deny, 'deny', 0)) violations.push('deny_effect_not_zero');
  const expectedEffectIds = new Set([
    ...(allow ? [allow] : []),
    ...(deny ? [deny] : []),
    ...(ambiguous ? [ambiguous] : []),
    ...evidence.negatives.map(({ approvalId }) => approvalId),
  ]);
  if (
    evidence.protectedEffectLedger.length !== expectedEffectIds.size ||
    new Set(evidence.protectedEffectLedger.map(({ approvalId }) => approvalId)).size !==
      evidence.protectedEffectLedger.length ||
    evidence.protectedEffectLedger.some(
      (item) =>
        !hasExactKeys(item, [
          'approvalId',
          'actionNonceSha256',
          'at',
          'decisionBodySha256',
          'effectCount',
          'effectId',
          'effectSha256',
          'generation',
          'kind',
          'requestId',
          'routeId',
          'runId',
          'sessionId',
        ]) ||
        !expectedEffectIds.has(item.approvalId) ||
        !/^[0-9a-f]{64}$/u.test(item.actionNonceSha256) ||
        !exactIsoTimestamp(item.at) ||
        !/^generation_[A-Za-z0-9._-]{1,128}$/u.test(item.generation) ||
        item.runId !== evidence.runId ||
        !/^route_[A-Za-z0-9._:-]{1,191}$/u.test(item.routeId) ||
        !/^session_[A-Za-z0-9._:-]{1,191}$/u.test(item.sessionId) ||
        typeof item.requestId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(item.requestId) ||
        !['allow', 'ambiguous', 'deny', 'negative'].includes(item.kind) ||
        ![0, 1].includes(item.effectCount) ||
        (item.effectCount === 1
          ? typeof item.effectSha256 !== 'string' ||
            !/^[0-9a-f]{64}$/u.test(item.effectSha256) ||
            typeof item.effectId !== 'string' ||
            !/^effect_[A-Za-z0-9._:-]{8,191}$/u.test(item.effectId)
          : item.effectSha256 !== null || item.effectId !== null)
    )
  ) {
    violations.push('protected_effect_ledger_scope_invalid');
  }
  if (
    !decisionEffectProof(evidence, evidence.browser?.ownerAllow, 'allow', 1) ||
    !decisionEffectProof(evidence, evidence.browser?.ownerDeny, 'deny', 0) ||
    !decisionEffectProof(evidence, evidence.browser?.ambiguous, 'ambiguous', 1) ||
    new Set([
      evidence.browser?.ownerAllow.actionNonceSha256,
      evidence.browser?.ownerDeny.actionNonceSha256,
      evidence.browser?.ambiguous.actionNonceSha256,
    ]).size !== 3
  ) {
    violations.push('browser_decision_effect_causality_invalid');
  }
  if (!approvalCorrelationProof(evidence)) {
    violations.push('route_session_effect_correlation_invalid');
  }
  if (allow && !hasTerminalEvents(evidence, allow))
    violations.push('allow_settlement_or_reconciliation_missing');
  if (deny && !hasTerminalEvents(evidence, deny))
    violations.push('deny_settlement_or_reconciliation_missing');
  if (
    ambiguous &&
    (evidence.browser?.ambiguous?.status !== 'operator_required' ||
      evidence.browser?.ambiguous?.automaticRetryPostDelta !== 0 ||
      !singleAmbiguousPost(evidence, ambiguous) ||
      !singleEffect(evidence, ambiguous, 'ambiguous', 1))
  ) {
    violations.push('ambiguous_effect_retry_or_state_invalid');
  }
  for (const checkpoint of REQUIRED_RESTART_CHECKPOINTS) {
    const matches = evidence.restartMatrix.filter(
      (candidate) => candidate.checkpoint === checkpoint
    );
    const item = matches[0];
    if (
      matches.length !== 1 ||
      !item ||
      !hasExactKeys(item, [
        'approvalId',
        'checkpoint',
        'duplicatePendingDelta',
        'postDelta',
        'survived',
      ]) ||
      !item.survived ||
      item.duplicatePendingDelta !== 0 ||
      item.postDelta !== 0
    ) {
      violations.push(`restart_${checkpoint}_invalid`);
    } else if (
      !timelineEvents.some(
        (event) =>
          event.approvalId === item.approvalId && event.event === `restart_checkpoint:${checkpoint}`
      )
    ) {
      violations.push(`restart_${checkpoint}_observation_missing`);
    }
  }
  for (const requiredCase of REQUIRED_NEGATIVE_CASES) {
    const matches = evidence.negatives.filter((candidate) => candidate.case === requiredCase);
    const item = matches[0];
    const expectedAttemptPosts =
      requiredCase.startsWith('http_') ||
      ['redirect', 'timeout', 'reset', 'malformed_response'].includes(requiredCase)
        ? 1
        : 0;
    if (
      matches.length !== 1 ||
      !item ||
      !hasExactKeys(item, [
        'approvalId',
        'attemptPostDelta',
        'automaticRetryPostDelta',
        'case',
        'effectDelta',
        'outcome',
      ]) ||
      !/^approval_[A-Za-z0-9._:-]{8,191}$/u.test(item.approvalId) ||
      item.attemptPostDelta !== expectedAttemptPosts ||
      item.automaticRetryPostDelta !== 0 ||
      item.effectDelta !== 0 ||
      item.outcome !== EXPECTED_NEGATIVE_OUTCOMES[requiredCase]
    ) {
      violations.push(`negative_${requiredCase}_invalid`);
    } else {
      const posts = evidence.postLedger.filter(
        (candidate) => candidate.approvalId === item.approvalId
      );
      if (
        posts.length !== expectedAttemptPosts ||
        (posts[0] !== undefined && posts[0].responseClass !== requiredCase)
      ) {
        violations.push(`negative_${requiredCase}_post_ledger_invalid`);
      }
      if (!singleEffect(evidence, item.approvalId, 'negative', 0)) {
        violations.push(`negative_${requiredCase}_effect_ledger_invalid`);
      }
      if (
        !timelineEvents.some(
          (event) =>
            event.approvalId === item.approvalId &&
            event.event === `negative_observed:${requiredCase}:${item.outcome}`
        )
      ) {
        violations.push(`negative_${requiredCase}_observation_missing`);
      }
    }
  }
  if (
    !evidence.cleanup?.markerVerified ||
    !evidence.cleanup.removed ||
    evidence.cleanup.runId !== evidence.runId
  ) {
    violations.push('marker_scoped_cleanup_unproved');
  }
  if (!evidence.disk.after) violations.push('disk_after_missing');
  return Object.freeze(violations);
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validSocketIdentity(
  value: ActualOwnerCapabilityEvidence['driverSocket'],
  ownerSessionId: string
): boolean {
  return (
    hasExactKeys(value, ['device', 'endpoint', 'inode', 'ownerSessionId']) &&
    /^\d+$/u.test(value.device) &&
    /^\d+$/u.test(value.inode) &&
    value.endpoint.length > 0 &&
    value.ownerSessionId === ownerSessionId
  );
}

function validClickTime(value: unknown): boolean {
  return exactIsoTimestamp(value);
}

function decisionNonceIssuanceUnsigned(
  issuance: ActualOwnerDecisionNonceIssuance
): Omit<ActualOwnerDecisionNonceIssuance, 'authentication'> {
  return {
    schemaVersion: issuance.schemaVersion,
    purpose: issuance.purpose,
    actionNonce: issuance.actionNonce,
    actionNonceSha256: issuance.actionNonceSha256,
    approvalId: issuance.approvalId,
    decisionBody: issuance.decisionBody,
    decisionBodySha256: issuance.decisionBodySha256,
    issuedAt: issuance.issuedAt,
    ownerSessionId: issuance.ownerSessionId,
    runId: issuance.runId,
  };
}

function canonicalDecisionBody(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    if (canonicalJson(parsed) !== value) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('hosted_actual_owner_canonical_json_invalid');
    return serialized;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('hosted_actual_owner_canonical_json_invalid');
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('hosted_actual_owner_canonical_json_invalid');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('hosted_actual_owner_canonical_json_invalid');
}

function validDecisionNonceIssuanceSet(
  evidence: Pick<ActualOwnerEvidenceDocument, 'browser' | 'postLedger' | 'runId'>
): boolean {
  const issuances = evidence.browser?.nonceIssuances;
  if (!issuances || issuances.length !== evidence.postLedger.length || issuances.length < 1) {
    return false;
  }
  const nonceValues = new Set<string>();
  const nonceHashes = new Set<string>();
  const approvals = new Set<string>();
  for (const issuance of issuances) {
    if (
      !hasExactKeys(issuance, [
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
      ]) ||
      issuance.schemaVersion !== 1 ||
      issuance.purpose !== 'agent-teams.hosted-actual-owner-e2e.decision-nonce-issuance/v1' ||
      !/^[0-9a-f]{64}$/u.test(issuance.actionNonce) ||
      createHash('sha256').update(issuance.actionNonce).digest('hex') !==
        issuance.actionNonceSha256 ||
      createHash('sha256').update(issuance.decisionBody).digest('hex') !==
        issuance.decisionBodySha256 ||
      !/^[0-9a-f]{64}$/u.test(issuance.authentication) ||
      !exactIsoTimestamp(issuance.issuedAt) ||
      issuance.ownerSessionId !== `session_${evidence.runId}` ||
      issuance.runId !== evidence.runId
    ) {
      return false;
    }
    const body = canonicalDecisionBody(issuance.decisionBody);
    const postMatches = evidence.postLedger.filter(
      (post) =>
        post.approvalId === issuance.approvalId &&
        post.actionNonceSha256 === issuance.actionNonceSha256 &&
        post.bodySha256 === issuance.decisionBodySha256
    );
    if (
      !body ||
      body.actionNonce !== issuance.actionNonce ||
      body.approvalId !== issuance.approvalId ||
      postMatches.length !== 1 ||
      body.decision !== postMatches[0]?.decision ||
      nonceValues.has(issuance.actionNonce) ||
      nonceHashes.has(issuance.actionNonceSha256) ||
      approvals.has(issuance.approvalId)
    ) {
      return false;
    }
    nonceValues.add(issuance.actionNonce);
    nonceHashes.add(issuance.actionNonceSha256);
    approvals.add(issuance.approvalId);
  }
  return evidence.postLedger.every(
    (post) =>
      issuances.filter(
        (issuance) =>
          issuance.approvalId === post.approvalId &&
          issuance.actionNonceSha256 === post.actionNonceSha256 &&
          issuance.decisionBodySha256 === post.bodySha256
      ).length === 1
  );
}

export function assertAuthenticatedDecisionNonceIssuances(input: {
  readonly browser: ActualOwnerBrowserResults;
  readonly ownerToken: string;
  readonly postLedger: readonly ActualOwnerPostLedgerEntry[];
  readonly runId: string;
}): void {
  const evidence: Pick<ActualOwnerEvidenceDocument, 'browser' | 'postLedger' | 'runId'> = {
    browser: input.browser,
    postLedger: input.postLedger,
    runId: input.runId,
  };
  if (!validDecisionNonceIssuanceSet(evidence)) {
    throw new Error('hosted_actual_owner_decision_nonce_issuance_invalid');
  }
  for (const issuance of input.browser.nonceIssuances) {
    const expected = createHmac('sha256', input.ownerToken)
      .update(canonicalJson(decisionNonceIssuanceUnsigned(issuance)))
      .digest('hex');
    if (issuance.authentication !== expected) {
      throw new Error('hosted_actual_owner_decision_nonce_authentication_invalid');
    }
  }
}

function decisionEffectProof(
  evidence: ActualOwnerEvidenceDocument,
  browser:
    | ActualOwnerBrowserResults['ownerAllow']
    | ActualOwnerBrowserResults['ownerDeny']
    | ActualOwnerBrowserResults['ambiguous']
    | undefined,
  kind: ActualOwnerProtectedEffectEntry['kind'],
  effectCount: number
): boolean {
  if (
    !browser ||
    browser.runId !== evidence.runId ||
    !/^[0-9a-f]{64}$/u.test(browser.bodySha256) ||
    !/^[0-9a-f]{64}$/u.test(browser.actionNonceSha256) ||
    !/^generation_[A-Za-z0-9._-]{1,128}$/u.test(browser.generation) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(browser.requestId) ||
    !/^route_[A-Za-z0-9._:-]{1,191}$/u.test(browser.routeId) ||
    browser.sessionId !== `session_${evidence.runId}` ||
    (browser.effectId !== null && !/^effect_[A-Za-z0-9._:-]{8,191}$/u.test(browser.effectId))
  ) {
    return false;
  }
  const post = evidence.postLedger.find((item) => item.approvalId === browser.approvalId);
  const effect = evidence.protectedEffectLedger.find(
    (item) => item.approvalId === browser.approvalId
  );
  const decision = evidence.timelines.product.find(
    (item) => item.approvalId === browser.approvalId && item.event === 'decision_committed'
  );
  if (!post || !effect || !decision) return false;
  const clickedAt = Date.parse(browser.clickedAt);
  const decisionAt = Date.parse(decision.at);
  const postAt = Date.parse(post.at);
  const effectAt = Date.parse(effect.at);
  return (
    [clickedAt, decisionAt, postAt, effectAt].every(Number.isFinite) &&
    clickedAt < decisionAt &&
    decisionAt < postAt &&
    postAt < effectAt &&
    decision.generation === browser.generation &&
    decision.requestId === browser.requestId &&
    decision.routeId === browser.routeId &&
    decision.sessionId === browser.sessionId &&
    decision.effectId === browser.effectId &&
    post.approvalId === browser.approvalId &&
    post.actionNonceSha256 === browser.actionNonceSha256 &&
    post.bodySha256 === browser.bodySha256 &&
    post.decision === browser.decision &&
    post.generation === browser.generation &&
    post.effectId === browser.effectId &&
    post.requestId === browser.requestId &&
    post.routeId === browser.routeId &&
    post.runId === browser.runId &&
    post.sessionId === browser.sessionId &&
    effect.kind === kind &&
    effect.actionNonceSha256 === browser.actionNonceSha256 &&
    effect.effectCount === effectCount &&
    effect.decisionBodySha256 === browser.bodySha256 &&
    effect.generation === browser.generation &&
    effect.requestId === browser.requestId &&
    effect.effectId === browser.effectId &&
    effect.routeId === browser.routeId &&
    effect.runId === browser.runId &&
    effect.sessionId === browser.sessionId
  );
}

function approvalCorrelationProof(evidence: ActualOwnerEvidenceDocument): boolean {
  const timeline = [
    ...evidence.timelines.ownerWal,
    ...evidence.timelines.product,
    ...evidence.timelines.openCode,
  ].filter((item) => item.approvalId !== null);
  for (const approvalId of new Set(timeline.map((item) => item.approvalId))) {
    const events = timeline.filter((item) => item.approvalId === approvalId);
    const first = events[0];
    if (!first) return false;
    const correlated = (item: {
      readonly effectId: string | null;
      readonly generation: string;
      readonly requestId: string | null;
      readonly routeId: string;
      readonly runId: string;
      readonly sessionId: string;
    }) =>
      item.effectId === first.effectId &&
      item.generation === first.generation &&
      item.requestId === first.requestId &&
      item.routeId === first.routeId &&
      item.runId === first.runId &&
      item.sessionId === first.sessionId;
    if (
      events.some((item) => !correlated(item)) ||
      evidence.postLedger
        .filter((item) => item.approvalId === approvalId)
        .some((item) => !correlated(item)) ||
      evidence.protectedEffectLedger
        .filter((item) => item.approvalId === approvalId)
        .some((item) => !correlated(item))
    ) {
      return false;
    }
  }
  return true;
}

function pendingBeforeDecision(
  evidence: ActualOwnerEvidenceDocument,
  approvalId: string,
  requireRestart: boolean
): boolean {
  const wal = evidence.timelines.ownerWal.find(
    (item) => item.approvalId === approvalId && item.event === 'ingress_durable'
  );
  const product = evidence.timelines.product.find(
    (item) => item.approvalId === approvalId && item.event === 'pending_durable'
  );
  const decision = evidence.timelines.product.find(
    (item) => item.approvalId === approvalId && item.event === 'decision_committed'
  );
  const restarted = evidence.timelines.product.find(
    (item) => item.approvalId === approvalId && item.event === 'pending_durable_after_restart'
  );
  return (
    !!wal &&
    !!product &&
    !!decision &&
    Number.isFinite(Date.parse(wal.at)) &&
    Number.isFinite(Date.parse(product.at)) &&
    Number.isFinite(Date.parse(decision.at)) &&
    Date.parse(wal.at) < Date.parse(decision.at) &&
    Date.parse(product.at) < Date.parse(decision.at) &&
    (!requireRestart ||
      (!!restarted &&
        Number.isFinite(Date.parse(restarted.at)) &&
        Date.parse(product.at) < Date.parse(restarted.at) &&
        Date.parse(restarted.at) < Date.parse(decision.at)))
  );
}

function singleConditionalPost(
  evidence: ActualOwnerEvidenceDocument,
  approvalId: string,
  decision: ActualOwnerPostLedgerEntry['decision'],
  responseClass: string
): boolean {
  const matches = evidence.postLedger.filter((item) => item.approvalId === approvalId);
  return (
    matches.length === 1 &&
    matches[0]?.decision === decision &&
    matches[0].responseClass === responseClass &&
    matches[0].conditional === true &&
    matches[0].upstream === 'real_opencode'
  );
}

function singleAmbiguousPost(evidence: ActualOwnerEvidenceDocument, approvalId: string): boolean {
  const matches = evidence.postLedger.filter((item) => item.approvalId === approvalId);
  return (
    matches.length === 1 &&
    matches[0]?.conditional === true &&
    matches[0].decision === 'allow_once' &&
    matches[0].upstream === 'real_opencode' &&
    ['reset_after_effect', 'timeout_after_effect'].includes(matches[0].responseClass)
  );
}

function singleEffect(
  evidence: ActualOwnerEvidenceDocument,
  approvalId: string,
  kind: ActualOwnerProtectedEffectEntry['kind'],
  effectCount: number
): boolean {
  const matches = evidence.protectedEffectLedger.filter((item) => item.approvalId === approvalId);
  const item = matches[0];
  return (
    matches.length === 1 &&
    item?.kind === kind &&
    item.effectCount === effectCount &&
    (effectCount === 1
      ? typeof item.effectSha256 === 'string' && /^[0-9a-f]{64}$/u.test(item.effectSha256)
      : item.effectSha256 === null)
  );
}

function hasTerminalEvents(evidence: ActualOwnerEvidenceDocument, approvalId: string): boolean {
  const decision = evidence.timelines.product.find(
    (item) => item.approvalId === approvalId && item.event === 'decision_committed'
  );
  const post = evidence.postLedger.find((item) => item.approvalId === approvalId);
  const settlement = evidence.timelines.openCode.find(
    (item) => item.approvalId === approvalId && item.event === 'permission_settled'
  );
  const ownerTerminal = evidence.timelines.ownerWal.find(
    (item) => item.approvalId === approvalId && ['completed', 'rejected'].includes(item.event)
  );
  const reconciliation = evidence.timelines.product.find(
    (item) => item.approvalId === approvalId && item.event === 'reconciled_terminal'
  );
  if (!decision || !post || !settlement || !ownerTerminal || !reconciliation) return false;
  const ordered = [decision.at, post.at, settlement.at, ownerTerminal.at, reconciliation.at].map(
    (at) => Date.parse(at)
  );
  return (
    ordered.every(Number.isFinite) &&
    ordered.every((value, index) => index === 0 || (ordered[index - 1] as number) < value)
  );
}

export async function createActualOwnerEvidenceDirectory(
  parent: string,
  sandbox: ActualOwnerSandbox
): Promise<string> {
  if (!isAbsolute(parent) || resolve(parent) !== parent) {
    throw new Error('hosted_actual_owner_evidence_parent_invalid');
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (
    (await realpath(parent)) !== parent ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o077) !== 0
  ) {
    throw new Error('hosted_actual_owner_evidence_parent_not_private');
  }
  const relation = relative(sandbox.root, parent);
  if (
    !relation ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  ) {
    throw new Error('hosted_actual_owner_evidence_inside_sandbox');
  }
  const directory = join(parent, `actual-owner-${sandbox.runId}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

export async function writeActualOwnerEvidence(
  directory: string,
  evidence: ActualOwnerEvidenceDocument
): Promise<string> {
  const target = join(directory, 'evidence.json');
  await atomicAnchoredPrivateFile(
    target,
    Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  );
  return target;
}

export async function readJsonCapture<T>(path: string): Promise<T> {
  return JSON.parse((await readPrivateCapture(path, 2)).toString('utf8')) as T;
}

export async function readNdjsonCapture<T>(path: string): Promise<readonly T[]> {
  const source = (await readPrivateCapture(path, 1)).toString('utf8');
  const values = source
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
  return Object.freeze(values);
}

export async function readActualOwnerTimelineCapture(path: string): Promise<
  Readonly<{
    events: readonly ActualOwnerTimelineEvent[];
    evidence: ActualOwnerTimelineCaptureEvidence;
  }>
> {
  const capture = await readAnchoredPrivateFileEvidence(path, {
    minimumBytes: 2,
    maximumBytes: MAX_CAPTURE_BYTES,
  });
  if (
    capture.bytes.at(-1) !== 0x0a ||
    capture.bytes.includes(Buffer.from('\r', 'utf8')) ||
    capture.bytes.includes(Buffer.from('\n\n', 'utf8'))
  ) {
    throw new Error('hosted_actual_owner_timeline_ndjson_bytes_invalid');
  }
  const lines = capture.bytes.toString('utf8').slice(0, -1).split('\n');
  const events = Object.freeze(
    lines.map((line: string) => validateActualOwnerTimelineEvent(JSON.parse(line)))
  );
  return Object.freeze({
    events,
    evidence: Object.freeze({
      byteCount: capture.size,
      ctimeNs: capture.ctimeNs,
      device: capture.device,
      inode: capture.inode,
      mtimeNs: capture.mtimeNs,
      path,
      sha256: createHash('sha256').update(capture.bytes).digest('hex'),
    }),
  });
}

export async function assertActualOwnerTimelineCaptureCurrent(
  expected: ActualOwnerTimelineCaptureEvidence
): Promise<void> {
  const capture = await readAnchoredPrivateFileEvidence(expected.path, {
    minimumBytes: 2,
    maximumBytes: MAX_CAPTURE_BYTES,
  });
  if (
    capture.size !== expected.byteCount ||
    capture.device !== expected.device ||
    capture.inode !== expected.inode ||
    capture.mtimeNs !== expected.mtimeNs ||
    capture.ctimeNs !== expected.ctimeNs ||
    createHash('sha256').update(capture.bytes).digest('hex') !== expected.sha256
  ) {
    throw new Error('hosted_actual_owner_timeline_capture_rotated');
  }
}

export async function copyPrivateCapture(source: string, destination: string): Promise<void> {
  await atomicAnchoredPrivateFile(destination, await readPrivateCapture(source, 1));
}

async function readPrivateCapture(path: string, minimumBytes: number): Promise<Buffer> {
  return readAnchoredPrivateFile(path, {
    minimumBytes,
    maximumBytes: MAX_CAPTURE_BYTES,
  });
}

export async function removeIncompleteEvidenceTemporaryFiles(directory: string): Promise<void> {
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
  await Promise.all(
    entries
      .filter((name) => /^\.evidence-\d+-[0-9a-f]{16}\.tmp$/u.test(name))
      .map((name) => rm(join(directory, name), { force: true }))
  );
}
