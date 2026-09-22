import { MEMBER_LOG_STREAM_PROVIDER_ORDER } from './memberLogStreamMergePolicy';

import type {
  MemberLogPreviewItem,
  MemberLogPreviewMember,
  MemberLogStreamCoverage,
  MemberLogStreamWarning,
} from '../../../contracts';

export interface MemberLogPreviewSourceMergeResult {
  coverage: MemberLogStreamCoverage;
  items: readonly MemberLogPreviewItem[];
  warnings: readonly MemberLogStreamWarning[];
  truncated?: boolean;
  overflowCount?: number;
}

function getItemTime(item: MemberLogPreviewItem): number {
  const parsed = Date.parse(item.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
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

function dedupeItems(items: readonly MemberLogPreviewItem[]): MemberLogPreviewItem[] {
  const byId = new Map<string, MemberLogPreviewItem>();
  for (const item of items) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

export function buildMemberLogPreviewMember(input: {
  memberName: string;
  sourceResults: readonly MemberLogPreviewSourceMergeResult[];
  generatedAt: string;
  maxItems: number;
}): MemberLogPreviewMember {
  const maxItems = Math.max(1, Math.min(3, Math.floor(input.maxItems)));
  const sortedItems = dedupeItems(input.sourceResults.flatMap((result) => [...result.items])).sort(
    (left, right) => {
      const byTime = getItemTime(right) - getItemTime(left);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    }
  );
  const items = sortedItems.slice(0, maxItems);
  const sourceOverflow = input.sourceResults.reduce(
    (sum, result) => sum + Math.max(0, result.overflowCount ?? 0),
    0
  );
  const overCap = Math.max(0, sortedItems.length - items.length);

  return {
    memberName: input.memberName,
    items,
    coverage: input.sourceResults
      .map((result) => result.coverage)
      .sort(
        (left, right) =>
          MEMBER_LOG_STREAM_PROVIDER_ORDER.indexOf(left.provider) -
          MEMBER_LOG_STREAM_PROVIDER_ORDER.indexOf(right.provider)
      ),
    warnings: dedupeWarnings(input.sourceResults.flatMap((result) => [...result.warnings])),
    truncated:
      overCap > 0 ||
      sourceOverflow > 0 ||
      input.sourceResults.some((result) => result.truncated === true),
    overflowCount: sourceOverflow + overCap,
    generatedAt: input.generatedAt,
  };
}
