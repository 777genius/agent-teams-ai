import { VersionedJsonStore, VersionedJsonStoreError } from '../store/VersionedJsonStore';

export const RUNTIME_PERMISSION_REQUEST_SCHEMA_VERSION = 1;

export type OpenCodePermissionDecision = 'once' | 'always' | 'reject';

export type OpenCodeRawPermissionRequest = {
  id?: unknown;
  requestID?: unknown;
  sessionID?: unknown;
  permission?: unknown;
  patterns?: unknown;
  metadata?: unknown;
  always?: unknown;
  tool?: unknown;
  title?: unknown;
  kind?: unknown;
};

export interface OpenCodeNormalizedPermissionRequest {
  requestId: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  alwaysPatterns: string[];
  toolName: string;
  toolCallId: string | null;
  messageId: string | null;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  rawShape: 'v1.14' | 'legacy' | 'mixed';
  raw: OpenCodeRawPermissionRequest;
}

export type RuntimePermissionState =
  | 'pending'
  | 'answering'
  | 'answered'
  | 'expired'
  | 'stale_run'
  | 'provider_missing'
  | 'failed_retryable'
  | 'failed_terminal';

export type RuntimePermissionAnswerOrigin = 'user_click' | 'provider_side_effect_projection';

export interface RuntimePermissionRequestRecord {
  appRequestId: string;
  providerRequestId: string;
  runId: string;
  teamName: string;
  memberName: string;
  providerId: 'opencode';
  runtimeSessionId: string;
  permission: string;
  patterns: string[];
  alwaysPatterns: string[];
  toolName: string;
  title: string;
  description: string | null;
  state: RuntimePermissionState;
  rawShape: OpenCodeNormalizedPermissionRequest['rawShape'];
  requestedAt: string;
  updatedAt: string;
  expiresAt: string;
  answeredAt: string | null;
  decision: OpenCodePermissionDecision | null;
  answerOrigin: RuntimePermissionAnswerOrigin | null;
  lastError: string | null;
}

export type OpenCodePermissionReplySideEffect =
  | {
      kind: 'answered_clicked_request';
      appRequestId: string;
      providerRequestId: string;
      decision: OpenCodePermissionDecision;
    }
  | {
      kind: 'reject_cancelled_same_session';
      appRequestId: string;
      providerRequestId: string;
      decision: 'reject';
    }
  | {
      kind: 'always_auto_allowed_same_session';
      appRequestId: string;
      providerRequestId: string;
      decision: 'always';
      matchedPatterns: string[];
    };

export interface RuntimePermissionAnswerProjectionResult {
  affectedAppRequestIds: string[];
  sideEffects: OpenCodePermissionReplySideEffect[];
}

export interface RuntimePermissionDiagnosticEvent {
  type:
    | 'opencode_permission_stale_answer_rejected'
    | 'opencode_permission_unmatched_session'
    | 'opencode_permission_requests_expired'
    | 'opencode_permission_answer_failed';
  providerId: 'opencode';
  teamName: string;
  runId: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimePermissionDiagnosticsSink {
  append(event: RuntimePermissionDiagnosticEvent): Promise<void>;
}

export interface RuntimePermissionLaunchStateStore {
  read(teamName: string): Promise<{ runId: string | null } | null>;
  updateMember(
    teamName: string,
    memberName: string,
    updater: (member: RuntimePermissionLaunchMemberState) => RuntimePermissionLaunchMemberState
  ): Promise<void>;
}

export interface RuntimePermissionLaunchMemberState {
  launchState?: string;
  bootstrapConfirmed?: boolean;
  pendingPermissionRequestIds?: string[];
  lastRuntimeEventAt?: string;
}

export interface OpenCodePermissionClientPort {
  listPendingPermissions(): Promise<OpenCodeNormalizedPermissionRequest[]>;
  answerPermission(input: {
    requestId: string;
    sessionId: string;
    decision: OpenCodePermissionDecision;
    message?: string;
  }): Promise<void>;
}

export interface OpenCodeSessionPermissionRef {
  runId: string;
  memberName: string;
  runtimeSessionId: string;
}

export interface OpenCodePermissionAnswerResult {
  ok: boolean;
  requestId: string;
  diagnostics: string[];
}

export class RuntimePermissionRequestStore {
  constructor(private readonly store: VersionedJsonStore<RuntimePermissionRequestRecord[]>) {}

  async upsertPending(
    input: RuntimePermissionRequestRecord
  ): Promise<'created' | 'updated' | 'unchanged'> {
    let outcome: 'created' | 'updated' | 'unchanged' = 'created';
    await this.store.updateLocked((records) => {
      const index = records.findIndex((record) => record.appRequestId === input.appRequestId);
      if (index < 0) {
        return [...records, input];
      }

      const current = records[index];
      if (current.state === 'answered') {
        if (current.answerOrigin !== 'provider_side_effect_projection') {
          outcome = 'unchanged';
          return records;
        }

        const reopened = {
          ...current,
          ...input,
          requestedAt: current.requestedAt,
          answeredAt: null,
          decision: null,
          answerOrigin: null,
          lastError: null,
        };
        outcome =
          stablePermissionRecordJson(current) === stablePermissionRecordJson(reopened)
            ? 'unchanged'
            : 'updated';
        return records.map((record, recordIndex) => (recordIndex === index ? reopened : record));
      }

      const next = {
        ...current,
        ...input,
        requestedAt: current.requestedAt,
        answeredAt: current.answeredAt,
        decision: current.decision,
        answerOrigin: current.answerOrigin,
        lastError: null,
      };
      outcome =
        stablePermissionRecordJson(current) === stablePermissionRecordJson(next)
          ? 'unchanged'
          : 'updated';
      return records.map((record, recordIndex) => (recordIndex === index ? next : record));
    });
    return outcome;
  }

  async beginAnswer(input: {
    appRequestId: string;
    runId: string;
    now: string;
  }): Promise<
    | { state: 'locked'; record: RuntimePermissionRequestRecord }
    | { state: 'missing' }
    | { state: 'stale_run'; record: RuntimePermissionRequestRecord }
    | { state: 'already_answered'; record: RuntimePermissionRequestRecord }
    | { state: 'already_answering'; record: RuntimePermissionRequestRecord }
  > {
    let result:
      | { state: 'locked'; record: RuntimePermissionRequestRecord }
      | { state: 'missing' }
      | { state: 'stale_run'; record: RuntimePermissionRequestRecord }
      | { state: 'already_answered'; record: RuntimePermissionRequestRecord }
      | { state: 'already_answering'; record: RuntimePermissionRequestRecord }
      | null = null;

    await this.store.updateLocked((records) => {
      const existing = records.find((record) => record.appRequestId === input.appRequestId);
      if (!existing) {
        result = { state: 'missing' };
        return records;
      }

      if (existing.runId !== input.runId) {
        result = { state: 'stale_run', record: existing };
        return records;
      }

      if (existing.state === 'answered') {
        result = { state: 'already_answered', record: existing };
        return records;
      }

      if (existing.state === 'answering') {
        result = { state: 'already_answering', record: existing };
        return records;
      }

      const locked = {
        ...existing,
        state: 'answering' as const,
        updatedAt: input.now,
        lastError: null,
      };
      result = { state: 'locked', record: locked };
      return records.map((record) =>
        record.appRequestId === input.appRequestId ? locked : record
      );
    });

    if (!result) {
      throw new Error('Runtime permission begin answer failed');
    }
    return result;
  }

  async markAnsweredWithSideEffects(input: {
    appRequestId: string;
    decision: OpenCodePermissionDecision;
    answeredAt: string;
  }): Promise<RuntimePermissionAnswerProjectionResult> {
    let result: RuntimePermissionAnswerProjectionResult | null = null;
    await this.store.updateLocked((records) => {
      const clicked = records.find((record) => record.appRequestId === input.appRequestId);
      if (!clicked) {
        throw new Error(`Runtime permission request not found: ${input.appRequestId}`);
      }

      const affectedAppRequestIds = new Set<string>([input.appRequestId]);
      const sideEffects: OpenCodePermissionReplySideEffect[] = [
        {
          kind: 'answered_clicked_request',
          appRequestId: clicked.appRequestId,
          providerRequestId: clicked.providerRequestId,
          decision: input.decision,
        },
      ];

      const nextRecords = records.map((record) => {
        if (record.appRequestId === input.appRequestId) {
          return answerPermissionRecord({
            record,
            decision: input.decision,
            answeredAt: input.answeredAt,
            answerOrigin: 'user_click',
          });
        }

        if (!isProjectableProviderSideEffectPeer(clicked, record)) {
          return record;
        }

        if (input.decision === 'reject') {
          affectedAppRequestIds.add(record.appRequestId);
          sideEffects.push({
            kind: 'reject_cancelled_same_session',
            appRequestId: record.appRequestId,
            providerRequestId: record.providerRequestId,
            decision: 'reject',
          });
          return answerPermissionRecord({
            record,
            decision: 'reject',
            answeredAt: input.answeredAt,
            answerOrigin: 'provider_side_effect_projection',
          });
        }

        if (input.decision === 'always') {
          const matchedPatterns = findAlwaysProjectionMatches(clicked, record);
          if (matchedPatterns.length === 0) {
            return record;
          }

          affectedAppRequestIds.add(record.appRequestId);
          sideEffects.push({
            kind: 'always_auto_allowed_same_session',
            appRequestId: record.appRequestId,
            providerRequestId: record.providerRequestId,
            decision: 'always',
            matchedPatterns,
          });
          return answerPermissionRecord({
            record,
            decision: 'always',
            answeredAt: input.answeredAt,
            answerOrigin: 'provider_side_effect_projection',
          });
        }

        return record;
      });

      result = {
        affectedAppRequestIds: [...affectedAppRequestIds],
        sideEffects,
      };
      return nextRecords;
    });

    if (!result) {
      throw new Error('Runtime permission answer projection failed');
    }
    return result;
  }

  async markFailed(input: {
    appRequestId: string;
    state: 'failed_retryable' | 'failed_terminal' | 'provider_missing';
    error: string;
    updatedAt: string;
  }): Promise<void> {
    await this.updateExisting(input.appRequestId, (record) => ({
      ...record,
      state: input.state,
      updatedAt: input.updatedAt,
      lastError: input.error,
    }));
  }

  async expireMissingProviderRequests(input: {
    runId: string;
    teamName: string;
    visibleProviderRequestIds: Set<string>;
    now: string;
  }): Promise<Array<Pick<RuntimePermissionRequestRecord, 'appRequestId' | 'memberName'>>> {
    const expired: Array<Pick<RuntimePermissionRequestRecord, 'appRequestId' | 'memberName'>> = [];
    await this.store.updateLocked((records) =>
      records.map((record) => {
        if (
          record.runId !== input.runId ||
          record.teamName !== input.teamName ||
          record.state !== 'pending' ||
          input.visibleProviderRequestIds.has(record.providerRequestId)
        ) {
          return record;
        }
        expired.push({ appRequestId: record.appRequestId, memberName: record.memberName });
        return {
          ...record,
          state: 'provider_missing' as const,
          updatedAt: input.now,
          lastError: 'Provider no longer lists this permission request',
        };
      })
    );
    return expired;
  }

  async listPendingForTeam(teamName: string): Promise<RuntimePermissionRequestRecord[]> {
    const records = await this.readRequired();
    return records.filter((record) => record.teamName === teamName && record.state === 'pending');
  }

  async get(appRequestId: string): Promise<RuntimePermissionRequestRecord | null> {
    const records = await this.readRequired();
    return records.find((record) => record.appRequestId === appRequestId) ?? null;
  }

  async list(): Promise<RuntimePermissionRequestRecord[]> {
    return this.readRequired();
  }

  private async updateExisting(
    appRequestId: string,
    updater: (record: RuntimePermissionRequestRecord) => RuntimePermissionRequestRecord
  ): Promise<void> {
    let found = false;
    await this.store.updateLocked((records) =>
      records.map((record) => {
        if (record.appRequestId !== appRequestId) {
          return record;
        }
        found = true;
        return updater(record);
      })
    );

    if (!found) {
      throw new Error(`Runtime permission request not found: ${appRequestId}`);
    }
  }

  private async readRequired(): Promise<RuntimePermissionRequestRecord[]> {
    const result = await this.store.read();
    if (!result.ok) {
      throw new VersionedJsonStoreError(result.message, result.reason, result.quarantinePath);
    }
    return result.data;
  }
}

export class RuntimePermissionAnswerService {
  constructor(
    private readonly store: RuntimePermissionRequestStore,
    private readonly launchStateStore: RuntimePermissionLaunchStateStore,
    private readonly openCodeClient: OpenCodePermissionClientPort,
    private readonly diagnostics: RuntimePermissionDiagnosticsSink,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async answer(input: {
    appRequestId: string;
    runId: string;
    decision: OpenCodePermissionDecision;
    message?: string;
  }): Promise<OpenCodePermissionAnswerResult> {
    const now = this.clock().toISOString();
    const begin = await this.store.beginAnswer({
      appRequestId: input.appRequestId,
      runId: input.runId,
      now,
    });

    if (begin.state === 'missing') {
      return {
        ok: false,
        requestId: input.appRequestId,
        diagnostics: ['Permission request not found'],
      };
    }
    if (begin.state === 'stale_run') {
      await this.diagnostics.append({
        type: 'opencode_permission_stale_answer_rejected',
        providerId: 'opencode',
        teamName: begin.record.teamName,
        runId: input.runId,
        severity: 'warning',
        message: 'OpenCode permission answer rejected because request belongs to another run',
        data: { appRequestId: input.appRequestId, requestRunId: begin.record.runId },
        createdAt: now,
      });
      return { ok: false, requestId: input.appRequestId, diagnostics: ['Stale runId rejected'] };
    }
    if (begin.state === 'already_answered') {
      return {
        ok: true,
        requestId: input.appRequestId,
        diagnostics: ['Permission already answered'],
      };
    }
    if (begin.state === 'already_answering') {
      return {
        ok: false,
        requestId: input.appRequestId,
        diagnostics: ['Permission answer already in progress'],
      };
    }

    const record = begin.record;
    const launchState = await this.launchStateStore.read(record.teamName);
    if (launchState?.runId !== record.runId) {
      await this.store.markFailed({
        appRequestId: record.appRequestId,
        state: 'failed_terminal',
        error: 'Launch state moved to another run before permission answer',
        updatedAt: now,
      });
      return {
        ok: false,
        requestId: record.appRequestId,
        diagnostics: ['Launch state moved to another run'],
      };
    }

    try {
      await this.openCodeClient.answerPermission({
        requestId: record.providerRequestId,
        sessionId: record.runtimeSessionId,
        decision: input.decision,
        message: input.message,
      });
      const answeredAt = this.clock().toISOString();
      await this.store.markAnsweredWithSideEffects({
        appRequestId: record.appRequestId,
        decision: input.decision,
        answeredAt,
      });
      const remainingMemberPendingIds = (await this.store.listPendingForTeam(record.teamName))
        .filter(
          (pendingRecord) =>
            pendingRecord.runId === record.runId && pendingRecord.memberName === record.memberName
        )
        .map((pendingRecord) => pendingRecord.appRequestId);
      await this.launchStateStore.updateMember(record.teamName, record.memberName, (member) => ({
        ...member,
        launchState:
          remainingMemberPendingIds.length > 0
            ? 'runtime_pending_permission'
            : member.launchState === 'confirmed_alive'
              ? member.launchState
              : member.bootstrapConfirmed
                ? 'confirmed_alive'
                : 'runtime_pending_bootstrap',
        pendingPermissionRequestIds: remainingMemberPendingIds,
        lastRuntimeEventAt: answeredAt,
      }));
      return { ok: true, requestId: record.appRequestId, diagnostics: [] };
    } catch (error) {
      await this.store.markFailed({
        appRequestId: record.appRequestId,
        state: 'failed_retryable',
        error: stringifyError(error),
        updatedAt: this.clock().toISOString(),
      });
      await this.diagnostics.append({
        type: 'opencode_permission_answer_failed',
        providerId: 'opencode',
        teamName: record.teamName,
        runId: record.runId,
        severity: 'warning',
        message: 'OpenCode permission answer failed and remains retryable',
        data: { appRequestId: record.appRequestId, error: stringifyError(error) },
        createdAt: this.clock().toISOString(),
      });
      throw error;
    }
  }
}

export class RuntimePermissionReconciler {
  constructor(
    private readonly client: OpenCodePermissionClientPort,
    private readonly store: RuntimePermissionRequestStore,
    private readonly launchStateStore: RuntimePermissionLaunchStateStore,
    private readonly diagnostics: RuntimePermissionDiagnosticsSink,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async reconcile(input: {
    runId: string;
    teamName: string;
    sessionsByOpenCodeId: Map<string, OpenCodeSessionPermissionRef>;
  }): Promise<void> {
    const now = this.clock().toISOString();
    const pending = await this.client.listPendingPermissions();
    const visibleProviderRequestIds = new Set<string>();
    const pendingByMember = new Map<string, string[]>();

    for (const permission of pending) {
      visibleProviderRequestIds.add(permission.requestId);
      const session = input.sessionsByOpenCodeId.get(permission.sessionId);
      if (!session || session.runId !== input.runId) {
        await this.diagnostics.append({
          type: 'opencode_permission_unmatched_session',
          providerId: 'opencode',
          teamName: input.teamName,
          runId: input.runId,
          severity: 'warning',
          message: 'OpenCode permission request did not match a current runtime session',
          data: { providerRequestId: permission.requestId, sessionId: permission.sessionId },
          createdAt: now,
        });
        continue;
      }

      const appRequestId = createOpenCodePermissionAppRequestId(input.runId, permission.requestId);
      await this.store.upsertPending({
        appRequestId,
        providerRequestId: permission.requestId,
        runId: input.runId,
        teamName: input.teamName,
        memberName: session.memberName,
        providerId: 'opencode',
        runtimeSessionId: permission.sessionId,
        permission: permission.permission,
        patterns: permission.patterns,
        alwaysPatterns: permission.alwaysPatterns,
        toolName: permission.toolName,
        title: permission.title,
        description: permission.description,
        state: 'pending',
        rawShape: permission.rawShape,
        requestedAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString(),
        answeredAt: null,
        decision: null,
        answerOrigin: null,
        lastError: null,
      });
      pendingByMember.set(session.memberName, [
        ...(pendingByMember.get(session.memberName) ?? []),
        appRequestId,
      ]);
    }

    const expired = await this.store.expireMissingProviderRequests({
      runId: input.runId,
      teamName: input.teamName,
      visibleProviderRequestIds,
      now,
    });
    if (expired.length > 0) {
      await this.diagnostics.append({
        type: 'opencode_permission_requests_expired',
        providerId: 'opencode',
        teamName: input.teamName,
        runId: input.runId,
        severity: 'info',
        message: 'OpenCode permission requests disappeared from provider and were expired locally',
        data: { expiredCount: expired.length },
        createdAt: now,
      });
    }

    const clearedMembers = new Set(
      expired
        .map((record) => record.memberName)
        .filter((memberName) => memberName.trim().length > 0)
        .filter((memberName) => !pendingByMember.has(memberName))
    );
    for (const memberName of clearedMembers) {
      await this.launchStateStore.updateMember(input.teamName, memberName, (member) => ({
        ...member,
        launchState:
          member.launchState === 'confirmed_alive'
            ? member.launchState
            : member.bootstrapConfirmed
              ? 'confirmed_alive'
              : 'runtime_pending_bootstrap',
        pendingPermissionRequestIds: [],
        lastRuntimeEventAt: now,
      }));
    }

    for (const [memberName, requestIds] of pendingByMember) {
      await this.launchStateStore.updateMember(input.teamName, memberName, (member) => ({
        ...member,
        launchState:
          member.launchState === 'confirmed_alive'
            ? member.launchState
            : 'runtime_pending_permission',
        pendingPermissionRequestIds: [...new Set(requestIds)],
        lastRuntimeEventAt: now,
      }));
    }
  }
}

export function createRuntimePermissionRequestStore(options: {
  filePath: string;
  clock?: () => Date;
}): RuntimePermissionRequestStore {
  const clock = options.clock ?? (() => new Date());
  return new RuntimePermissionRequestStore(
    new VersionedJsonStore<RuntimePermissionRequestRecord[]>({
      filePath: options.filePath,
      schemaVersion: RUNTIME_PERMISSION_REQUEST_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateRuntimePermissionRequestRecords,
      clock,
    })
  );
}

export function normalizeOpenCodePermissionRequest(
  raw: OpenCodeRawPermissionRequest
): OpenCodeNormalizedPermissionRequest | null {
  const requestId = asString(raw.id) ?? asString(raw.requestID);
  const sessionId = asString(raw.sessionID);
  if (!requestId || !sessionId) {
    return null;
  }

  const toolObject = isRecord(raw.tool) ? raw.tool : null;
  const legacyToolName = asString(raw.tool);
  const permission = asString(raw.permission) ?? asString(raw.kind) ?? legacyToolName ?? 'unknown';
  const patterns = asStringArray(raw.patterns);
  const alwaysPatterns = asStringArray(raw.always);
  const metadata = asRecord(raw.metadata);
  const toolName =
    legacyToolName ?? asString(toolObject?.name) ?? asString(metadata.toolName) ?? permission;
  const messageId = asString(toolObject?.messageID) ?? asString(metadata.messageID);
  const toolCallId = asString(toolObject?.callID) ?? asString(metadata.callID);

  return {
    requestId,
    sessionId,
    permission,
    patterns,
    alwaysPatterns,
    toolName,
    toolCallId,
    messageId,
    title: asString(raw.title) ?? buildOpenCodePermissionTitle({ permission, toolName, patterns }),
    description:
      asString(raw.kind) ??
      buildOpenCodePermissionDescription({ patterns, alwaysPatterns, metadata }),
    metadata,
    rawShape: detectPermissionRawShape(raw),
    raw,
  };
}

export function createOpenCodePermissionAppRequestId(
  runId: string,
  providerRequestId: string
): string {
  return `opencode:${runId}:${providerRequestId}`;
}

export function validateRuntimePermissionRequestRecords(
  value: unknown
): RuntimePermissionRequestRecord[] {
  if (!Array.isArray(value)) {
    throw new Error('Runtime permission requests must be an array');
  }
  const seen = new Set<string>();
  return value.map((record, index) => {
    if (!isRuntimePermissionRequestRecord(record)) {
      throw new Error(`Invalid runtime permission request at index ${index}`);
    }
    const normalized = normalizeRuntimePermissionRequestRecord(record);
    if (seen.has(normalized.appRequestId)) {
      throw new Error(`Duplicate runtime permission request id: ${normalized.appRequestId}`);
    }
    seen.add(normalized.appRequestId);
    return normalized;
  });
}

function detectPermissionRawShape(
  raw: OpenCodeRawPermissionRequest
): OpenCodeNormalizedPermissionRequest['rawShape'] {
  const hasV114Fields =
    typeof raw.id === 'string' || typeof raw.permission === 'string' || Array.isArray(raw.patterns);
  const hasLegacyFields =
    typeof raw.requestID === 'string' ||
    typeof raw.title === 'string' ||
    typeof raw.kind === 'string';
  if (hasV114Fields && hasLegacyFields) {
    return 'mixed';
  }
  if (hasV114Fields) {
    return 'v1.14';
  }
  return 'legacy';
}

function buildOpenCodePermissionTitle(input: {
  permission: string;
  toolName: string;
  patterns: string[];
}): string {
  if (input.patterns.length > 0) {
    return `OpenCode wants ${input.permission} permission for ${input.patterns[0]}`;
  }
  if (input.toolName !== 'unknown') {
    return `OpenCode wants to use ${input.toolName}`;
  }
  return `OpenCode permission request: ${input.permission}`;
}

function buildOpenCodePermissionDescription(input: {
  patterns: string[];
  alwaysPatterns: string[];
  metadata: Record<string, unknown>;
}): string | null {
  const parts: string[] = [];
  if (input.patterns.length > 0) {
    parts.push(`Patterns: ${input.patterns.join(', ')}`);
  }
  if (input.alwaysPatterns.length > 0) {
    parts.push(`Always candidates: ${input.alwaysPatterns.join(', ')}`);
  }
  const reason = asString(input.metadata.reason);
  if (reason) {
    parts.push(`Reason: ${reason}`);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function answerPermissionRecord(input: {
  record: RuntimePermissionRequestRecord;
  decision: OpenCodePermissionDecision;
  answeredAt: string;
  answerOrigin: RuntimePermissionAnswerOrigin;
}): RuntimePermissionRequestRecord {
  return {
    ...input.record,
    state: 'answered',
    answeredAt: input.answeredAt,
    decision: input.decision,
    answerOrigin: input.answerOrigin,
    updatedAt: input.answeredAt,
    lastError: null,
  };
}

function isProjectableProviderSideEffectPeer(
  clicked: RuntimePermissionRequestRecord,
  candidate: RuntimePermissionRequestRecord
): boolean {
  return (
    candidate.appRequestId !== clicked.appRequestId &&
    candidate.providerId === 'opencode' &&
    candidate.runId === clicked.runId &&
    candidate.teamName === clicked.teamName &&
    candidate.runtimeSessionId === clicked.runtimeSessionId &&
    candidate.state === 'pending'
  );
}

function findAlwaysProjectionMatches(
  clicked: RuntimePermissionRequestRecord,
  candidate: RuntimePermissionRequestRecord
): string[] {
  const allowedPatterns = new Set([...clicked.alwaysPatterns, ...clicked.patterns]);
  if (allowedPatterns.size === 0) {
    return [];
  }
  return [...new Set(candidate.patterns.filter((pattern) => allowedPatterns.has(pattern)))];
}

function normalizeRuntimePermissionRequestRecord(
  record: RuntimePermissionRequestRecord
): RuntimePermissionRequestRecord {
  return {
    ...record,
    permission: isNonEmptyString(record.permission) ? record.permission : record.toolName,
    patterns: isStringArray(record.patterns) ? record.patterns : [],
    alwaysPatterns: isStringArray(record.alwaysPatterns) ? record.alwaysPatterns : [],
    answerOrigin: isRuntimePermissionAnswerOrigin(record.answerOrigin) ? record.answerOrigin : null,
  };
}

function isRuntimePermissionRequestRecord(value: unknown): value is RuntimePermissionRequestRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value.appRequestId) &&
    isNonEmptyString(value.providerRequestId) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.teamName) &&
    isNonEmptyString(value.memberName) &&
    value.providerId === 'opencode' &&
    isNonEmptyString(value.runtimeSessionId) &&
    (value.permission === undefined || isNonEmptyString(value.permission)) &&
    (value.patterns === undefined || isStringArray(value.patterns)) &&
    (value.alwaysPatterns === undefined || isStringArray(value.alwaysPatterns)) &&
    isNonEmptyString(value.toolName) &&
    isNonEmptyString(value.title) &&
    (value.description === null || typeof value.description === 'string') &&
    isRuntimePermissionState(value.state) &&
    (value.rawShape === 'v1.14' || value.rawShape === 'legacy' || value.rawShape === 'mixed') &&
    isNonEmptyString(value.requestedAt) &&
    isNonEmptyString(value.updatedAt) &&
    isNonEmptyString(value.expiresAt) &&
    (value.answeredAt === null || isNonEmptyString(value.answeredAt)) &&
    (value.decision === null || isOpenCodePermissionDecision(value.decision)) &&
    (value.answerOrigin === undefined ||
      value.answerOrigin === null ||
      isRuntimePermissionAnswerOrigin(value.answerOrigin)) &&
    (value.lastError === null || typeof value.lastError === 'string')
  );
}

function isRuntimePermissionState(value: unknown): value is RuntimePermissionState {
  return (
    value === 'pending' ||
    value === 'answering' ||
    value === 'answered' ||
    value === 'expired' ||
    value === 'stale_run' ||
    value === 'provider_missing' ||
    value === 'failed_retryable' ||
    value === 'failed_terminal'
  );
}

function isOpenCodePermissionDecision(value: unknown): value is OpenCodePermissionDecision {
  return value === 'once' || value === 'always' || value === 'reject';
}

function isRuntimePermissionAnswerOrigin(value: unknown): value is RuntimePermissionAnswerOrigin {
  return value === 'user_click' || value === 'provider_side_effect_projection';
}

function stablePermissionRecordJson(value: RuntimePermissionRequestRecord): string {
  return JSON.stringify(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
