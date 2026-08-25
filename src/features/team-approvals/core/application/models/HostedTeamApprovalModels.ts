import { parseTeamId, type TeamId } from '@shared/contracts/hosted';

import {
  HOSTED_TEAM_APPROVAL_CATEGORIES,
  HOSTED_TEAM_APPROVAL_DECISIONS,
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  type HostedTeamApprovalDecision,
  type HostedTeamApprovalDecisionReceipt,
  type HostedTeamApprovalItem,
  type HostedTeamApprovalPreview,
  parseHostedTeamApprovalDecisionReceipt,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalPreviewRef,
} from '../../../contracts/hosted';

export const HOSTED_TEAM_APPROVAL_MAX_PAGE_ITEMS = 50;
export const HOSTED_TEAM_APPROVAL_MAX_SOURCE_ITEMS = 51;
export const HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES = 128 * 1024;
export const HOSTED_TEAM_APPROVAL_MAX_PAGE_TIME_MS = 250;
export const HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES = 64 * 1024;
export const HOSTED_TEAM_APPROVAL_MAX_PREVIEW_TIME_MS = 250;

const ITEM_KEYS = Object.freeze([
  'teamId',
  'approvalId',
  'generation',
  'category',
  'summary',
  'requestedAtMs',
  'expiresAtMs',
  'previewRef',
] as const);
const PREVIEW_KEYS = Object.freeze([
  'teamId',
  'approvalId',
  'generation',
  'content',
  'byteLength',
  'truncated',
  'isBinary',
] as const);

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSafeDisplayText(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if ((codePoint <= 31 && codePoint !== 9) || codePoint === 127) return false;
  }
  return true;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function normalizeHostedTeamApprovalItem(
  value: unknown,
  expectedTeamId: TeamId
): HostedTeamApprovalItem | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) return null;
    const teamId = parseTeamId(value.teamId);
    const category = value.category;
    const requestedAtMs = value.requestedAtMs;
    const expiresAtMs = value.expiresAtMs;
    if (
      teamId !== expectedTeamId ||
      !HOSTED_TEAM_APPROVAL_CATEGORIES.includes(category as never) ||
      !isSafeDisplayText(value.summary) ||
      !isTimestamp(requestedAtMs) ||
      (expiresAtMs !== null && !isTimestamp(expiresAtMs)) ||
      (typeof expiresAtMs === 'number' && expiresAtMs <= requestedAtMs)
    ) {
      return null;
    }
    return Object.freeze({
      teamId,
      approvalId: parseHostedTeamApprovalId(value.approvalId),
      generation: parseHostedTeamApprovalGeneration(value.generation),
      category: category as HostedTeamApprovalItem['category'],
      summary: value.summary,
      requestedAtMs,
      expiresAtMs,
      previewRef:
        value.previewRef === null ? null : parseHostedTeamApprovalPreviewRef(value.previewRef),
    });
  } catch {
    return null;
  }
}

export function normalizeHostedTeamApprovalPreview(
  value: unknown,
  expected: {
    readonly teamId: TeamId;
    readonly approvalId: ReturnType<typeof parseHostedTeamApprovalId>;
  }
): HostedTeamApprovalPreview | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, PREVIEW_KEYS)) return null;
    const teamId = parseTeamId(value.teamId);
    const approvalId = parseHostedTeamApprovalId(value.approvalId);
    const content = value.content;
    const byteLength = value.byteLength;
    if (
      teamId !== expected.teamId ||
      approvalId !== expected.approvalId ||
      typeof content !== 'string' ||
      typeof value.truncated !== 'boolean' ||
      typeof value.isBinary !== 'boolean' ||
      !Number.isSafeInteger(byteLength) ||
      (byteLength as number) < 0 ||
      (byteLength as number) > HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES ||
      new TextEncoder().encode(content).byteLength > (byteLength as number) ||
      (value.isBinary && content !== '')
    ) {
      return null;
    }
    return Object.freeze({
      schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
      kind: 'approval_preview' as const,
      teamId,
      approvalId,
      generation: parseHostedTeamApprovalGeneration(value.generation),
      content,
      byteLength: byteLength as number,
      truncated: value.truncated,
      isBinary: value.isBinary,
    });
  } catch {
    return null;
  }
}

export function normalizeHostedTeamApprovalReceipt(
  value: unknown,
  expected: {
    readonly outcome: HostedTeamApprovalDecisionReceipt['outcome'];
    readonly teamId: TeamId;
    readonly approvalId: ReturnType<typeof parseHostedTeamApprovalId>;
    readonly generation: ReturnType<typeof parseHostedTeamApprovalGeneration>;
    readonly decision: HostedTeamApprovalDecision;
  }
): HostedTeamApprovalDecisionReceipt | null {
  const parsed = parseHostedTeamApprovalDecisionReceipt(value);
  if (
    !parsed.ok ||
    parsed.value.outcome !== expected.outcome ||
    parsed.value.teamId !== expected.teamId ||
    parsed.value.approvalId !== expected.approvalId ||
    parsed.value.generation !== expected.generation ||
    parsed.value.decision !== expected.decision
  ) {
    return null;
  }
  return parsed.value;
}

export function normalizeHostedTeamApprovalDecision(
  value: unknown
): HostedTeamApprovalDecision | null {
  return HOSTED_TEAM_APPROVAL_DECISIONS.includes(value as HostedTeamApprovalDecision)
    ? (value as HostedTeamApprovalDecision)
    : null;
}

export function normalizeHostedTeamApprovalRetryAfterMs(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 60_000
    ? (value as number)
    : undefined;
}
