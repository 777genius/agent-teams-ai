import * as path from 'node:path';

import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { getOpenCodeTeamRuntimeLaneDirectory } from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { mapOpenCodeRuntimeTranscriptMessagesToParsedMessages } from '@main/services/team/taskLogs/stream/OpenCodeRuntimeProjectionMapper';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { extractMemberLogPreviewItems } from '../../../../core/domain/policies/memberLogPreviewExtractor';

import { normalizeMemberName } from './memberLogStreamSourceUtils';
import {
  type OpenCodeMemberVisibleActivityEntry,
  OpenCodeMemberVisibleActivityReader,
  sanitizeOpenCodeVisibleActivityText,
} from './OpenCodeMemberVisibleActivityReader';

import type { MemberLogPreviewItem, MemberLogStreamWarning } from '../../../../contracts';
import type {
  MemberLogPreviewSource,
  MemberLogPreviewSourceInput,
  MemberLogPreviewSourceResult,
} from '../../../../core/application/ports/MemberLogPreviewSource';
import type { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';

const OPENCODE_PROMPT_DELIVERY_LEDGER_FILE = 'opencode-prompt-delivery-ledger.json';
const MAX_LEDGER_RECORDS_TO_CONSIDER = 24;
const HIDDEN_PREVIEW_BLOCK_TAGS = [
  'info_for_agent',
  'opencode_runtime_identity',
  'opencode_app_message_delivery',
  'system-reminder',
] as const;
const ERROR_RESPONSE_STATES: ReadonlySet<string> = new Set([
  'permission_blocked',
  'tool_error',
  'empty_assistant_turn',
  'prompt_delivered_no_assistant_message',
  'session_stale',
  'session_error',
  'reconcile_failed',
] as const);
const OPENCODE_DELIVERY_DELAYED_WARNING: MemberLogStreamWarning = {
  code: 'opencode_delivery_delayed',
  message: 'OpenCode logs are delayed while message delivery is being confirmed.',
};

interface LedgerPreviewCandidate {
  item: MemberLogPreviewItem | null;
  warning?: MemberLogStreamWarning;
}

interface BinaryResolverLike {
  resolve(): Promise<string | null>;
}

interface OpenCodePromptDeliveryLedgerPreviewReader {
  list(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord[]>;
}

class FileOpenCodePromptDeliveryLedgerPreviewReader implements OpenCodePromptDeliveryLedgerPreviewReader {
  async list(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord[]> {
    const laneDir = getOpenCodeTeamRuntimeLaneDirectory(
      getTeamsBasePath(),
      input.teamName,
      input.laneId
    );
    const store = createOpenCodePromptDeliveryLedgerStore({
      filePath: path.join(laneDir, OPENCODE_PROMPT_DELIVERY_LEDGER_FILE),
    });
    const normalizedMemberName = normalizeMemberName(input.memberName);
    return (await store.list()).filter(
      (record) =>
        record.teamName === input.teamName &&
        normalizeMemberName(record.memberName) === normalizedMemberName &&
        record.laneId === input.laneId
    );
  }
}

const DEFAULT_LEDGER_PREVIEW_READER = new FileOpenCodePromptDeliveryLedgerPreviewReader();
const DEFAULT_VISIBLE_ACTIVITY_READER = new OpenCodeMemberVisibleActivityReader();

function classifyOpenCodePreviewError(error: unknown): MemberLogStreamWarning {
  const message = error instanceof Error ? error.message : String(error);
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const code = typeof record?.code === 'string' ? record.code : '';
  const signal = typeof record?.signal === 'string' ? record.signal : '';
  const killed = record?.killed === true ? 'killed' : '';
  const normalized = [message, code, signal, killed].join(' ').toLowerCase();
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('code 143') ||
    normalized.includes('signal sigterm') ||
    normalized.includes('killed')
  ) {
    return {
      code: 'opencode_runtime_timeout',
      message: 'OpenCode runtime preview timed out; graph preview will use other sources.',
    };
  }
  if (
    normalized.includes('ambiguous') ||
    normalized.includes('without a safe lane') ||
    normalized.includes('requires --lane') ||
    (normalized.includes('multiple') && normalized.includes('lane'))
  ) {
    return {
      code: 'opencode_ambiguous_lane',
      message: 'OpenCode runtime session is ambiguous without a safe lane id.',
    };
  }
  return {
    code: 'opencode_runtime_unavailable',
    message: `OpenCode runtime preview is unavailable: ${message}`,
  };
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ledgerRecordTimestampMs(record: OpenCodePromptDeliveryLedgerRecord): number {
  return Math.max(
    parseTimestampMs(record.respondedAt),
    parseTimestampMs(record.lastObservedAt),
    parseTimestampMs(record.failedAt),
    parseTimestampMs(record.acceptedAt),
    parseTimestampMs(record.lastAttemptAt),
    parseTimestampMs(record.updatedAt),
    parseTimestampMs(record.createdAt),
    parseTimestampMs(record.inboxTimestamp)
  );
}

function ledgerRecordTimestampIso(record: OpenCodePromptDeliveryLedgerRecord): string {
  return new Date(ledgerRecordTimestampMs(record) || 0).toISOString();
}

function removeHiddenPreviewBlocks(value: string): string {
  let result = value;
  for (const tag of HIDDEN_PREVIEW_BLOCK_TAGS) {
    result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  return result;
}

function stripAngleTags(value: string): string {
  let result = '';
  let insideTag = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!insideTag && char === '<') {
      const next = value[index + 1] ?? '';
      if (/[A-Za-z/!]/.test(next)) {
        insideTag = true;
        result += ' ';
        continue;
      }
    }
    if (insideTag) {
      if (char === '>') {
        insideTag = false;
        result += ' ';
      }
      continue;
    }
    result += char;
  }
  return result;
}

function sanitizeLedgerPreviewText(value: string, limit: number): string {
  const compact = stripAngleTags(removeHiddenPreviewBlocks(value))
    .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= limit) {
    return compact;
  }
  const allowed = Math.max(1, limit - 3);
  return `${compact.slice(0, allowed)}...`;
}

function formatLedgerToolNames(toolNames: readonly string[], limit: number): string {
  const uniqueNames = [...new Set(toolNames.map((name) => name.trim()).filter(Boolean))];
  const visibleNames = uniqueNames.slice(0, 5);
  const suffix = uniqueNames.length > visibleNames.length ? ` +${uniqueNames.length - 5} more` : '';
  return sanitizeLedgerPreviewText(`${visibleNames.join(', ')}${suffix}`, limit);
}

function formatTaskRefs(record: OpenCodePromptDeliveryLedgerRecord): string {
  const refs = record.taskRefs
    .map((taskRef) => taskRef.displayId || taskRef.taskId.slice(0, 8))
    .filter(Boolean)
    .slice(0, 2);
  return refs.length > 0 ? ` for #${refs.join(', #')}` : '';
}

function ledgerStatusText(record: OpenCodePromptDeliveryLedgerRecord): string {
  const taskSuffix = formatTaskRefs(record);
  switch (record.status) {
    case 'pending':
      return `Prompt queued${taskSuffix}`;
    case 'accepted':
      return `Prompt accepted${taskSuffix}`;
    case 'responded':
      return `Response observed${taskSuffix}`;
    case 'unanswered':
      return `Prompt delivered, response not observed yet${taskSuffix}`;
    case 'retry_scheduled':
      return `Delivery retry scheduled${taskSuffix}`;
    case 'retried':
      return `Prompt retried${taskSuffix}`;
    case 'failed_retryable':
      return `Delivery retry pending${taskSuffix}`;
    case 'failed_terminal':
      return `Delivery failed${taskSuffix}`;
    default:
      return `OpenCode delivery updated${taskSuffix}`;
  }
}

function ledgerRecordHasDeliveryIssue(record: OpenCodePromptDeliveryLedgerRecord): boolean {
  return record.status === 'failed_terminal' || ERROR_RESPONSE_STATES.has(record.responseState);
}

function firstNonEmptyText(values: readonly (string | null | undefined)[]): string {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';
}

function ledgerRecordHasObservedEvidence(record: OpenCodePromptDeliveryLedgerRecord): boolean {
  return (
    Boolean(record.observedAssistantPreview?.trim()) ||
    record.observedToolCallNames.length > 0 ||
    Boolean(record.observedVisibleMessageId?.trim()) ||
    record.responseState === 'responded_visible_message' ||
    record.responseState === 'responded_plain_text'
  );
}

function buildLedgerPreviewWarning(
  record: OpenCodePromptDeliveryLedgerRecord
): MemberLogStreamWarning | undefined {
  if (!ledgerRecordHasDeliveryIssue(record)) {
    return undefined;
  }
  return OPENCODE_DELIVERY_DELAYED_WARNING;
}

function buildLedgerPreviewItem(
  record: OpenCodePromptDeliveryLedgerRecord,
  input: MemberLogPreviewSourceInput
): LedgerPreviewCandidate {
  const timestamp = ledgerRecordTimestampIso(record);
  const warning = buildLedgerPreviewWarning(record);
  const sourceBase = {
    provider: 'opencode_runtime' as const,
    timestamp,
    sourceLabel: 'OpenCode delivery',
    sessionId: record.runtimeSessionId ?? undefined,
    laneId: input.laneId,
  };

  if (record.observedAssistantPreview?.trim()) {
    return {
      item: {
        ...sourceBase,
        id: `opencode-ledger:${record.id}:assistant`,
        kind: 'text',
        title:
          record.responseState === 'responded_visible_message' ||
          record.responseState === 'responded_plain_text'
            ? 'OpenCode reply'
            : 'Assistant',
        preview: sanitizeLedgerPreviewText(record.observedAssistantPreview, input.textLimit),
        tone: 'neutral',
      },
      warning,
    };
  }

  if (record.observedToolCallNames.length > 0) {
    return {
      item: {
        ...sourceBase,
        id: `opencode-ledger:${record.id}:tools`,
        kind: 'tool_use',
        title: 'Tool activity',
        preview: formatLedgerToolNames(record.observedToolCallNames, input.textLimit),
        tone: 'neutral',
      },
      warning,
    };
  }

  if (
    record.responseState === 'responded_visible_message' ||
    record.responseState === 'responded_plain_text'
  ) {
    return {
      item: {
        ...sourceBase,
        id: `opencode-ledger:${record.id}:reply`,
        kind: 'text',
        title: 'OpenCode reply',
        preview: sanitizeLedgerPreviewText(ledgerStatusText(record), input.textLimit),
        tone: 'success',
      },
      warning,
    };
  }

  if (ledgerRecordHasDeliveryIssue(record) && !ledgerRecordHasObservedEvidence(record)) {
    return { item: null, warning };
  }

  const statusText = sanitizeLedgerPreviewText(
    firstNonEmptyText([record.lastReason, ledgerStatusText(record)]),
    input.textLimit
  );
  return statusText
    ? {
        item: {
          ...sourceBase,
          id: `opencode-ledger:${record.id}:status`,
          kind: 'text',
          title: 'OpenCode status',
          preview: statusText,
          tone:
            record.status === 'failed_retryable' || record.status === 'retry_scheduled'
              ? 'warning'
              : 'neutral',
        },
        warning,
      }
    : { item: null, warning };
}

function dedupeWarnings(warnings: readonly MemberLogStreamWarning[]): MemberLogStreamWarning[] {
  const seen = new Set<string>();
  const result: MemberLogStreamWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  return result;
}

function previewItemTimestampMs(item: MemberLogPreviewItem): number {
  const parsed = Date.parse(item.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function comparePreviewItemsNewestFirst(
  left: MemberLogPreviewItem,
  right: MemberLogPreviewItem
): number {
  const byTime = previewItemTimestampMs(right) - previewItemTimestampMs(left);
  return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
}

function dedupePreviewItems(items: readonly MemberLogPreviewItem[]): MemberLogPreviewItem[] {
  const deduped = new Map<string, MemberLogPreviewItem>();
  for (const item of items) {
    if (!deduped.has(item.id)) {
      deduped.set(item.id, item);
    }
  }
  return [...deduped.values()];
}

function buildVisibleActivityPreviewItem(
  entry: OpenCodeMemberVisibleActivityEntry,
  input: MemberLogPreviewSourceInput
): MemberLogPreviewItem {
  return {
    id: `${entry.id}:preview`,
    kind: 'text',
    provider: 'opencode_runtime',
    timestamp: entry.timestamp,
    title: entry.title,
    preview: sanitizeOpenCodeVisibleActivityText(entry.text, input.textLimit),
    tone: entry.title === 'Agent error' ? 'error' : 'neutral',
    sourceLabel: entry.sourceLabel,
    laneId: input.laneId,
  };
}

export class OpenCodeMemberRuntimePreviewSource implements MemberLogPreviewSource {
  readonly provider = 'opencode_runtime' as const;
  private readonly cache = new Map<
    string,
    { expiresAt: number; result: MemberLogPreviewSourceResult }
  >();
  private readonly inFlight = new Map<string, Promise<MemberLogPreviewSourceResult>>();

  constructor(
    private readonly runtimeBridge: ClaudeMultimodelBridgeService,
    private readonly binaryResolver: BinaryResolverLike = ClaudeBinaryResolver,
    private readonly ledgerReader: OpenCodePromptDeliveryLedgerPreviewReader = DEFAULT_LEDGER_PREVIEW_READER,
    private readonly visibleActivityReader: OpenCodeMemberVisibleActivityReader = DEFAULT_VISIBLE_ACTIVITY_READER
  ) {}

  async loadPreview(input: MemberLogPreviewSourceInput): Promise<MemberLogPreviewSourceResult> {
    const cacheKey = [
      input.teamName,
      normalizeMemberName(input.memberName),
      input.laneId ?? '',
      input.maxItems,
      input.textLimit,
      input.budget.openCodeMessageLimit,
    ].join('::');

    if (!input.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }
    }

    const inFlightKey = input.forceRefresh ? `${cacheKey}::force` : cacheKey;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) {
      return existing;
    }

    const promise = this.buildResult(input)
      .then((result) => {
        this.cache.set(cacheKey, {
          expiresAt: Date.now() + input.budget.cacheTtlMs,
          result,
        });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(inFlightKey);
      });
    this.inFlight.set(inFlightKey, promise);
    return promise;
  }

  private async buildResult(
    input: MemberLogPreviewSourceInput
  ): Promise<MemberLogPreviewSourceResult> {
    if (!input.laneId) {
      return {
        provider: this.provider,
        status: 'skipped',
        reason: 'opencode_safe_lane_unavailable',
        items: [],
        warnings: [],
        truncated: false,
        overflowCount: 0,
      };
    }

    const ledgerResult = await this.buildLedgerResult(input);
    const visibleActivityResult = await this.buildVisibleActivityResult(input, ledgerResult);
    if (visibleActivityResult.status === 'included') {
      return visibleActivityResult;
    }
    if (ledgerResult.status === 'included') {
      return {
        ...ledgerResult,
        warnings: dedupeWarnings([...ledgerResult.warnings, ...visibleActivityResult.warnings]),
      };
    }

    return this.buildTranscriptResult(
      input,
      dedupeWarnings([...ledgerResult.warnings, ...visibleActivityResult.warnings])
    );
  }

  private async buildVisibleActivityResult(
    input: MemberLogPreviewSourceInput,
    ledgerResult: MemberLogPreviewSourceResult
  ): Promise<MemberLogPreviewSourceResult> {
    try {
      const activityItems = (
        await this.visibleActivityReader.list({
          teamName: input.teamName,
          memberName: input.memberName,
          forceRefresh: input.forceRefresh,
        })
      ).map((entry) => buildVisibleActivityPreviewItem(entry, input));
      const mergedItems = dedupePreviewItems([...activityItems, ...ledgerResult.items]).sort(
        comparePreviewItemsNewestFirst
      );
      const items = mergedItems.slice(0, input.maxItems);
      const overflowCount = Math.max(
        0,
        mergedItems.length - items.length + ledgerResult.overflowCount
      );
      return {
        provider: this.provider,
        status: items.length > 0 ? 'included' : 'skipped',
        reason: items.length > 0 ? undefined : 'opencode_visible_activity_empty',
        items,
        warnings: [...ledgerResult.warnings],
        truncated: overflowCount > 0,
        overflowCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        provider: this.provider,
        status: 'skipped',
        reason: 'opencode_visible_activity_unavailable',
        items: [],
        warnings: [
          ...ledgerResult.warnings,
          {
            code: 'opencode_runtime_unavailable',
            message: `OpenCode visible activity preview is unavailable: ${message}`,
          },
        ],
        truncated: false,
        overflowCount: 0,
      };
    }
  }

  private async buildLedgerResult(
    input: MemberLogPreviewSourceInput
  ): Promise<MemberLogPreviewSourceResult> {
    try {
      const orderedRecords = (
        await this.ledgerReader.list({
          teamName: input.teamName,
          memberName: input.memberName,
          laneId: input.laneId ?? '',
        })
      ).sort((left, right) => {
        const byTime = ledgerRecordTimestampMs(right) - ledgerRecordTimestampMs(left);
        return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
      });
      const records = orderedRecords.slice(0, MAX_LEDGER_RECORDS_TO_CONSIDER);
      const candidates = records.map((record) => buildLedgerPreviewItem(record, input));
      const previewItems = candidates
        .map((candidate) => candidate.item)
        .filter((item): item is MemberLogPreviewItem => Boolean(item));
      const warnings = dedupeWarnings(
        candidates
          .map((candidate) => candidate.warning)
          .filter((warning): warning is MemberLogStreamWarning => Boolean(warning))
      );
      const items = previewItems.slice(0, input.maxItems);
      const overflowCount = Math.max(0, previewItems.length - items.length);
      return {
        provider: this.provider,
        status: items.length > 0 ? 'included' : 'skipped',
        reason:
          items.length > 0
            ? undefined
            : warnings.length > 0
              ? 'opencode_delivery_delayed'
              : 'opencode_delivery_ledger_empty',
        items,
        warnings,
        truncated: overflowCount > 0,
        overflowCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.skipped(
        'opencode_runtime_unavailable',
        'OpenCode delivery ledger preview is unavailable.',
        {
          code: 'opencode_runtime_unavailable',
          message: `OpenCode delivery ledger preview is unavailable: ${message}`,
        }
      );
    }
  }

  private async buildTranscriptResult(
    input: MemberLogPreviewSourceInput,
    extraWarnings: readonly MemberLogStreamWarning[]
  ): Promise<MemberLogPreviewSourceResult> {
    const binaryPath = await this.binaryResolver.resolve();
    if (!binaryPath) {
      return this.skipped(
        'opencode_runtime_unavailable',
        'OpenCode runtime bridge is unavailable.',
        {
          code: 'opencode_runtime_unavailable',
          message: 'OpenCode runtime bridge is unavailable.',
        },
        extraWarnings
      );
    }

    try {
      const transcript = await this.runtimeBridge.getOpenCodeTranscript(binaryPath, {
        teamId: input.teamName,
        memberName: input.memberName,
        limit: input.budget.openCodeMessageLimit,
        laneId: input.laneId,
        timeoutMs: input.budget.openCodeTimeoutMs,
      });
      const projectedMessages = transcript?.logProjection?.messages ?? [];
      const parsedMessages = mapOpenCodeRuntimeTranscriptMessagesToParsedMessages(projectedMessages)
        .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
        .slice(-input.budget.maxSourceMessagesPerProvider);
      if (parsedMessages.length === 0) {
        return {
          provider: this.provider,
          status: 'skipped',
          reason: 'opencode_missing_runtime_session',
          items: [],
          warnings: [...extraWarnings],
          truncated: false,
          overflowCount: 0,
        };
      }

      const sessionId =
        transcript?.sessionId ??
        parsedMessages[0]?.sessionId ??
        `opencode:${normalizeMemberName(input.memberName)}`;
      const extracted = extractMemberLogPreviewItems({
        messages: parsedMessages,
        provider: this.provider,
        maxItems: input.maxItems,
        textLimit: input.textLimit,
        sourceId: sessionId,
        sourceLabel: 'OpenCode runtime',
        sessionId,
        laneId: input.laneId,
      });

      return {
        provider: this.provider,
        status: extracted.items.length > 0 ? 'included' : 'skipped',
        reason: extracted.items.length > 0 ? undefined : 'opencode_no_renderable_preview',
        items: extracted.items,
        warnings: [...extraWarnings],
        truncated: extracted.truncated,
        overflowCount: extracted.overflowCount,
      };
    } catch (error) {
      const warning = classifyOpenCodePreviewError(error);
      return this.skipped(warning.code, warning.message, warning, extraWarnings);
    }
  }

  private skipped(
    code: MemberLogStreamWarning['code'],
    reason: string,
    warning: MemberLogStreamWarning | undefined = { code, message: reason },
    extraWarnings: readonly MemberLogStreamWarning[] = []
  ): MemberLogPreviewSourceResult {
    return {
      provider: this.provider,
      status: 'skipped',
      reason,
      items: [],
      warnings: [...extraWarnings, ...(warning ? [warning] : [])],
      truncated: false,
      overflowCount: 0,
    };
  }
}
