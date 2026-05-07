import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { mapOpenCodeRuntimeTranscriptMessagesToParsedMessages } from '@main/services/team/taskLogs/stream/OpenCodeRuntimeProjectionMapper';

import { extractMemberLogPreviewItems } from '../../../../core/domain/policies/memberLogPreviewExtractor';

import { normalizeMemberName } from './memberLogStreamSourceUtils';

import type { MemberLogStreamWarning } from '../../../../contracts';
import type {
  MemberLogPreviewSource,
  MemberLogPreviewSourceInput,
  MemberLogPreviewSourceResult,
} from '../../../../core/application/ports/MemberLogPreviewSource';
import type { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';

interface BinaryResolverLike {
  resolve(): Promise<string | null>;
}

function classifyOpenCodePreviewError(error: unknown): MemberLogStreamWarning {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return {
      code: 'opencode_runtime_timeout',
      message: 'OpenCode runtime preview timed out; graph preview will use other sources.',
    };
  }
  if (
    normalized.includes('--lane') ||
    normalized.includes('multiple') ||
    normalized.includes('ambiguous')
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

export class OpenCodeMemberRuntimePreviewSource implements MemberLogPreviewSource {
  readonly provider = 'opencode_runtime' as const;
  private readonly cache = new Map<
    string,
    { expiresAt: number; result: MemberLogPreviewSourceResult }
  >();
  private readonly inFlight = new Map<string, Promise<MemberLogPreviewSourceResult>>();

  constructor(
    private readonly runtimeBridge: ClaudeMultimodelBridgeService,
    private readonly binaryResolver: BinaryResolverLike = ClaudeBinaryResolver
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

    const binaryPath = await this.binaryResolver.resolve();
    if (!binaryPath) {
      return this.skipped(
        'opencode_runtime_unavailable',
        'OpenCode runtime bridge is unavailable.'
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
          warnings: [],
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
        warnings: [],
        truncated: extracted.truncated,
        overflowCount: extracted.overflowCount,
      };
    } catch (error) {
      const warning = classifyOpenCodePreviewError(error);
      return this.skipped(warning.code, warning.message, warning);
    }
  }

  private skipped(
    code: MemberLogStreamWarning['code'],
    reason: string,
    warning: MemberLogStreamWarning = { code, message: reason }
  ): MemberLogPreviewSourceResult {
    return {
      provider: this.provider,
      status: 'skipped',
      reason,
      items: [],
      warnings: [warning],
      truncated: false,
      overflowCount: 0,
    };
  }
}
