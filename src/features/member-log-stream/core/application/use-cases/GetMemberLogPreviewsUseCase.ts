import { createEmptyMemberLogPreviewResponse } from '../../../contracts';
import {
  clampMemberLogPreviewItemLimit,
  clampMemberLogPreviewTextLimit,
  DEFAULT_MEMBER_LOG_PREVIEW_BUDGET,
} from '../../domain/models/MemberLogPreviewBudget';
import { buildMemberLogPreviewMember } from '../../domain/policies/memberLogPreviewMergePolicy';

import type {
  MemberLogPreviewResponse,
  MemberLogStreamProvider,
  MemberLogStreamWarning,
} from '../../../contracts';
import type { MemberLogPreviewBudget } from '../../domain/models/MemberLogPreviewBudget';
import type { ClockPort } from '../ports/ClockPort';
import type { LoggerPort } from '../ports/LoggerPort';
import type {
  MemberLogPreviewSource,
  MemberLogPreviewSourceResult,
} from '../ports/MemberLogPreviewSource';

export interface GetMemberLogPreviewsInput {
  teamName: string;
  memberNames: string[];
  maxItemsPerMember?: number;
  textLimit?: number;
  laneIdsByMember?: Record<string, string>;
  forceRefresh?: boolean;
}

interface GetMemberLogPreviewsUseCaseDeps {
  sources: readonly MemberLogPreviewSource[];
  clock: ClockPort;
  logger: LoggerPort;
  budget?: Partial<MemberLogPreviewBudget>;
}

interface NormalizedMemberRequest {
  memberName: string;
  laneId?: string;
}

function normalizeMemberName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeMembers(
  memberNames: readonly string[],
  laneIdsByMember: Record<string, string> | undefined,
  maxMembers: number
): NormalizedMemberRequest[] {
  const result: NormalizedMemberRequest[] = [];
  const seen = new Set<string>();
  for (const memberName of memberNames) {
    const trimmed = memberName.trim();
    if (!trimmed) continue;
    const key = normalizeMemberName(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    const laneId = laneIdsByMember?.[trimmed] ?? laneIdsByMember?.[key];
    result.push({
      memberName: trimmed,
      ...(laneId ? { laneId } : {}),
    });
    if (result.length >= maxMembers) break;
  }
  return result;
}

function stableInputKey(input: {
  teamName: string;
  members: readonly NormalizedMemberRequest[];
  maxItems: number;
  textLimit: number;
  forceRefresh?: boolean;
}): string {
  return JSON.stringify([
    input.teamName,
    input.members.map((member) => [normalizeMemberName(member.memberName), member.laneId ?? '']),
    input.maxItems,
    input.textLimit,
    input.forceRefresh === true,
  ]);
}

function warningForSourceFailure(
  provider: MemberLogStreamProvider,
  message: string
): MemberLogStreamWarning {
  return {
    code:
      provider === 'opencode_runtime'
        ? 'opencode_runtime_unavailable'
        : 'unreadable_transcript_file',
    message,
  };
}

export class GetMemberLogPreviewsUseCase {
  private readonly budget: MemberLogPreviewBudget;
  private readonly inFlight = new Map<string, Promise<MemberLogPreviewResponse>>();

  constructor(private readonly deps: GetMemberLogPreviewsUseCaseDeps) {
    this.budget = { ...DEFAULT_MEMBER_LOG_PREVIEW_BUDGET, ...(deps.budget ?? {}) };
  }

  async execute(input: GetMemberLogPreviewsInput): Promise<MemberLogPreviewResponse> {
    const maxItems = clampMemberLogPreviewItemLimit(input.maxItemsPerMember, this.budget);
    const textLimit = clampMemberLogPreviewTextLimit(input.textLimit, this.budget);
    const members = normalizeMembers(
      input.memberNames,
      input.laneIdsByMember,
      this.budget.maxMembers
    );
    if (members.length === 0) {
      return createEmptyMemberLogPreviewResponse(new Date(this.deps.clock.now()).toISOString());
    }

    const key = stableInputKey({
      teamName: input.teamName,
      members,
      maxItems,
      textLimit,
      forceRefresh: input.forceRefresh,
    });
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.buildResponse({
      input,
      members,
      maxItems,
      textLimit,
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async buildResponse(args: {
    input: GetMemberLogPreviewsInput;
    members: readonly NormalizedMemberRequest[];
    maxItems: number;
    textLimit: number;
  }): Promise<MemberLogPreviewResponse> {
    const generatedAt = new Date(this.deps.clock.now()).toISOString();
    if (this.deps.sources.length === 0) {
      return createEmptyMemberLogPreviewResponse(generatedAt);
    }

    const members = await Promise.all(
      args.members.map(async (member) => {
        const sourceResults = await Promise.all(
          this.deps.sources.map((source): Promise<MemberLogPreviewSourceResult> => {
            return source
              .loadPreview({
                teamName: args.input.teamName,
                memberName: member.memberName,
                laneId: member.laneId,
                budget: this.budget,
                maxItems: args.maxItems,
                textLimit: args.textLimit,
                forceRefresh: args.input.forceRefresh,
              })
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.deps.logger.warn(
                  `Member log preview source ${source.provider} failed for ${args.input.teamName}/${member.memberName}: ${message}`
                );
                return {
                  provider: source.provider,
                  status: 'skipped',
                  reason: message,
                  items: [],
                  warnings: [warningForSourceFailure(source.provider, message)],
                  truncated: false,
                  overflowCount: 0,
                };
              });
          })
        );

        return buildMemberLogPreviewMember({
          memberName: member.memberName,
          sourceResults: sourceResults.map((result) => ({
            coverage: {
              provider: result.provider,
              status: result.status,
              ...(result.reason ? { reason: result.reason } : {}),
            },
            items: result.items,
            warnings: result.warnings,
            truncated: result.truncated,
            overflowCount: result.overflowCount,
          })),
          generatedAt,
          maxItems: args.maxItems,
        });
      })
    );

    return {
      members,
      generatedAt,
    };
  }
}
