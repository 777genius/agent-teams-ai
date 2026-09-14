import {
  parseCursor,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type Revision,
  type TeamId,
} from '@shared/contracts/hosted';

import {
  type CanonicalListTeamLifecycleResult,
  parseCanonicalListTeamLifecycleResult,
  type TeamLifecycleState,
} from '../../contracts/team-lifecycle-read';

import type {
  LegacyTeamBindingPage,
  LegacyTeamIdentityBinding,
  LegacyTeamReadAvailability,
} from './LegacyTeamLifecycleReadSource';

export const TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_BINDINGS = 1_000;
export const TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_LEGACY_ITEMS = 2_000;
export const TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_FINDINGS = 4_001;

export type TeamLifecycleProjectionShadowStatus = 'match' | 'mismatch' | 'not_comparable';

export type TeamLifecycleProjectionShadowFindingCode =
  | 'canonical_item_missing'
  | 'canonical_result_failure'
  | 'canonical_result_inapplicable'
  | 'canonical_result_invalid'
  | 'display_name_mismatch'
  | 'identity_binding_legacy_name_duplicate'
  | 'identity_binding_missing'
  | 'identity_binding_page_invalid'
  | 'identity_binding_team_id_duplicate'
  | 'legacy_evidence_corrupt'
  | 'legacy_evidence_partial'
  | 'legacy_evidence_provisioning'
  | 'legacy_evidence_unavailable'
  | 'legacy_observation_duplicate'
  | 'legacy_observation_invalid'
  | 'legacy_observation_oversized'
  | 'legacy_summary_missing'
  | 'lifecycle_mismatch'
  | 'revision_mismatch'
  | 'snapshot_revision_mismatch'
  | 'workspace_id_mismatch';

export interface TeamLifecycleProjectionShadowFinding {
  readonly code: TeamLifecycleProjectionShadowFindingCode;
  readonly teamId?: TeamId;
}

export interface TeamLifecycleProjectionShadowReport {
  readonly status: TeamLifecycleProjectionShadowStatus;
  readonly snapshotRevision: Revision | null;
  readonly comparedCount: number;
  readonly findings: readonly TeamLifecycleProjectionShadowFinding[];
}

type CanonicalSuccess = Extract<CanonicalListTeamLifecycleResult, { readonly kind: 'success' }>;

interface ParsedBinding extends LegacyTeamIdentityBinding {
  readonly availability: LegacyTeamReadAvailability;
}

interface ParsedBindingPage {
  readonly snapshotRevision: Revision;
  readonly bindingsByTeamId: ReadonlyMap<TeamId, ParsedBinding>;
  readonly bindingsByLegacyName: ReadonlyMap<string, ParsedBinding>;
}

interface ParsedLegacySummary {
  readonly lifecycle: TeamLifecycleState;
}

interface ParsedLegacyObservation {
  readonly summariesByLegacyName: ReadonlyMap<string, ParsedLegacySummary>;
}

type ParseResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly findings: readonly TeamLifecycleProjectionShadowFinding[];
    }
  | { readonly ok: false; readonly findings: readonly TeamLifecycleProjectionShadowFinding[] };

const LEGACY_TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const DISPLAY_NAME_PRIVATE_PATH = /^(?:\/|~\/|[A-Za-z]:\\)/;
const WINDOWS_RESERVED_TEAM_NAMES = Object.freeze([
  'aux',
  'con',
  'nul',
  'prn',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
] as const);
const LEGACY_AVAILABILITIES = Object.freeze([
  'current',
  'draft',
  'provisioning',
  'corrupt',
  'partial',
  'unavailable',
] as const satisfies readonly LegacyTeamReadAvailability[]);

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegacyTeamName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    LEGACY_TEAM_NAME.test(value) &&
    !WINDOWS_RESERVED_TEAM_NAMES.includes(value as (typeof WINDOWS_RESERVED_TEAM_NAMES)[number])
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function isDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.trim() === value &&
    !DISPLAY_NAME_PRIVATE_PATH.test(value) &&
    !hasControlCharacter(value)
  );
}

function finding(
  code: TeamLifecycleProjectionShadowFindingCode,
  teamId?: TeamId
): TeamLifecycleProjectionShadowFinding {
  return Object.freeze(teamId === undefined ? { code } : { code, teamId });
}

function compareFindings(
  left: TeamLifecycleProjectionShadowFinding,
  right: TeamLifecycleProjectionShadowFinding
): number {
  if (left.teamId !== right.teamId) {
    if (left.teamId === undefined) return -1;
    if (right.teamId === undefined) return 1;
    return left.teamId < right.teamId ? -1 : 1;
  }
  if (left.code === right.code) return 0;
  return left.code < right.code ? -1 : 1;
}

function freezeFindings(
  source: readonly TeamLifecycleProjectionShadowFinding[]
): readonly TeamLifecycleProjectionShadowFinding[] {
  const byStableIdentity = new Map<string, TeamLifecycleProjectionShadowFinding>();
  for (const item of source) {
    const key = `${item.code}\u0000${item.teamId ?? ''}`;
    if (!byStableIdentity.has(key)) byStableIdentity.set(key, item);
  }
  const sorted = [...byStableIdentity.values()].sort(compareFindings);
  return Object.freeze(sorted.slice(0, TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_FINDINGS));
}

function report(
  status: TeamLifecycleProjectionShadowStatus,
  snapshotRevision: Revision | null,
  comparedCount: number,
  findings: readonly TeamLifecycleProjectionShadowFinding[]
): TeamLifecycleProjectionShadowReport {
  return Object.freeze({
    status,
    snapshotRevision,
    comparedCount,
    findings: freezeFindings(findings),
  });
}

function parseCanonical(
  value: CanonicalListTeamLifecycleResult
): ParseResult<CanonicalSuccess> & { readonly snapshotRevision: Revision | null } {
  const parsed = parseCanonicalListTeamLifecycleResult(value);
  if (!parsed.ok) {
    return {
      ok: false,
      snapshotRevision: null,
      findings: Object.freeze([finding('canonical_result_invalid')]),
    };
  }
  if (parsed.value.kind === 'failure') {
    return {
      ok: false,
      snapshotRevision: null,
      findings: Object.freeze([finding('canonical_result_failure')]),
    };
  }
  if (parsed.value.kind === 'inapplicable') {
    return {
      ok: false,
      snapshotRevision: null,
      findings: Object.freeze([finding('canonical_result_inapplicable')]),
    };
  }
  return {
    ok: true,
    value: parsed.value,
    snapshotRevision: parsed.value.snapshotRevision,
    findings: Object.freeze([]),
  };
}

function parseBindingPage(value: LegacyTeamBindingPage): ParseResult<ParsedBindingPage> {
  try {
    if (!isRecord(value) || !Array.isArray(value.bindings)) throw new TypeError();
    if (value.bindings.length > TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_BINDINGS) {
      throw new TypeError();
    }

    const snapshotRevision = parseRevision(value.snapshotRevision);
    if (value.nextCursor !== null) parseCursor(value.nextCursor);

    const bindingsByTeamId = new Map<TeamId, ParsedBinding>();
    const bindingsByLegacyName = new Map<string, ParsedBinding>();
    for (let index = 0; index < value.bindings.length; index += 1) {
      if (!Object.hasOwn(value.bindings, index)) throw new TypeError();
      const candidate = value.bindings[index] as unknown;
      if (!isRecord(candidate)) throw new TypeError();

      const workspaceId = parseWorkspaceId(candidate.workspaceId);
      const teamId = parseTeamId(candidate.teamId);
      const legacyTeamName = candidate.legacyTeamName;
      const availability = candidate.availability ?? 'current';
      if (
        !isLegacyTeamName(legacyTeamName) ||
        !isDisplayName(candidate.displayName) ||
        !LEGACY_AVAILABILITIES.includes(availability as LegacyTeamReadAvailability)
      ) {
        throw new TypeError();
      }

      if (bindingsByTeamId.has(teamId)) {
        return {
          ok: false,
          findings: Object.freeze([finding('identity_binding_team_id_duplicate', teamId)]),
        };
      }
      if (bindingsByLegacyName.has(legacyTeamName)) {
        return {
          ok: false,
          findings: Object.freeze([finding('identity_binding_legacy_name_duplicate', teamId)]),
        };
      }

      const binding = Object.freeze({
        workspaceId,
        teamId,
        legacyTeamName,
        displayName: candidate.displayName,
        revision: parseRevision(candidate.revision),
        availability: availability as LegacyTeamReadAvailability,
      });
      bindingsByTeamId.set(teamId, binding);
      bindingsByLegacyName.set(legacyTeamName, binding);
    }

    return {
      ok: true,
      value: Object.freeze({
        snapshotRevision,
        bindingsByTeamId,
        bindingsByLegacyName,
      }),
      findings: Object.freeze([]),
    };
  } catch {
    return {
      ok: false,
      findings: Object.freeze([finding('identity_binding_page_invalid')]),
    };
  }
}

function lifecycleFromLegacySummary(
  summary: Readonly<Record<PropertyKey, unknown>>
): TeamLifecycleState {
  if (typeof summary.deletedAt === 'string') return 'deleted';
  if (summary.pendingCreate === true) return 'draft';
  if (summary.partialLaunchFailure === true) return 'degraded';
  return 'ready';
}

function hasValidLegacyLifecycleMarkers(summary: Readonly<Record<PropertyKey, unknown>>): boolean {
  return (
    (!Object.hasOwn(summary, 'deletedAt') || typeof summary.deletedAt === 'string') &&
    (!Object.hasOwn(summary, 'pendingCreate') || typeof summary.pendingCreate === 'boolean') &&
    (!Object.hasOwn(summary, 'partialLaunchFailure') ||
      typeof summary.partialLaunchFailure === 'boolean')
  );
}

function parseLegacyObservation(
  value: unknown,
  bindingsByLegacyName: ReadonlyMap<string, ParsedBinding>
): ParseResult<ParsedLegacyObservation> {
  if (value === null || value === undefined) {
    return {
      ok: false,
      findings: Object.freeze([finding('legacy_evidence_unavailable')]),
    };
  }
  try {
    if (!Array.isArray(value)) throw new TypeError();
    if (value.length > TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_LEGACY_ITEMS) {
      return {
        ok: false,
        findings: Object.freeze([finding('legacy_observation_oversized')]),
      };
    }

    const summariesByLegacyName = new Map<string, ParsedLegacySummary>();
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError();
      const candidate = value[index] as unknown;
      if (!isRecord(candidate)) throw new TypeError();
      const legacyTeamName = candidate.teamName;
      if (!isLegacyTeamName(legacyTeamName) || !hasValidLegacyLifecycleMarkers(candidate)) {
        throw new TypeError();
      }

      const binding = bindingsByLegacyName.get(legacyTeamName);
      if (!binding) continue;
      if (summariesByLegacyName.has(legacyTeamName)) {
        return {
          ok: false,
          findings: Object.freeze([finding('legacy_observation_duplicate', binding.teamId)]),
        };
      }
      summariesByLegacyName.set(
        legacyTeamName,
        Object.freeze({ lifecycle: lifecycleFromLegacySummary(candidate) })
      );
    }
    return {
      ok: true,
      value: Object.freeze({ summariesByLegacyName }),
      findings: Object.freeze([]),
    };
  } catch {
    return {
      ok: false,
      findings: Object.freeze([finding('legacy_observation_invalid')]),
    };
  }
}

function availabilityFinding(binding: ParsedBinding): TeamLifecycleProjectionShadowFinding | null {
  switch (binding.availability) {
    case 'corrupt':
      return finding('legacy_evidence_corrupt', binding.teamId);
    case 'partial':
      return finding('legacy_evidence_partial', binding.teamId);
    case 'provisioning':
      return finding('legacy_evidence_provisioning', binding.teamId);
    case 'unavailable':
      return finding('legacy_evidence_unavailable', binding.teamId);
    case 'current':
    case 'draft':
      return null;
  }
}

function expectedLifecycle(
  binding: ParsedBinding,
  observation: ParsedLegacyObservation
): TeamLifecycleState | null {
  if (binding.availability === 'draft') return 'draft';
  return observation.summariesByLegacyName.get(binding.legacyTeamName)?.lifecycle ?? null;
}

/**
 * Compares three immutable values captured by a caller. This observer never acquires either source,
 * and deliberately has no production composition or reporting side effect.
 */
export class TeamLifecycleProjectionShadowComparator {
  compare(
    canonicalResult: CanonicalListTeamLifecycleResult,
    identityPage: LegacyTeamBindingPage,
    legacyListObservation: unknown
  ): TeamLifecycleProjectionShadowReport {
    const canonical = parseCanonical(canonicalResult);
    if (!canonical.ok) {
      return report('not_comparable', canonical.snapshotRevision, 0, canonical.findings);
    }

    const bindingPage = parseBindingPage(identityPage);
    if (!bindingPage.ok) {
      return report('not_comparable', canonical.snapshotRevision, 0, bindingPage.findings);
    }

    const legacy = parseLegacyObservation(
      legacyListObservation,
      bindingPage.value.bindingsByLegacyName
    );
    if (!legacy.ok) {
      return report('not_comparable', canonical.snapshotRevision, 0, legacy.findings);
    }

    const comparabilityFindings: TeamLifecycleProjectionShadowFinding[] = [];
    for (const binding of bindingPage.value.bindingsByTeamId.values()) {
      const unavailable = availabilityFinding(binding);
      if (unavailable) {
        comparabilityFindings.push(unavailable);
        continue;
      }
      if (expectedLifecycle(binding, legacy.value) === null) {
        comparabilityFindings.push(finding('legacy_summary_missing', binding.teamId));
      }
    }
    if (comparabilityFindings.length > 0) {
      return report('not_comparable', canonical.snapshotRevision, 0, comparabilityFindings);
    }

    const canonicalByTeamId = new Map(
      canonical.value.items.map((item) => [item.teamId, item] as const)
    );
    const findings: TeamLifecycleProjectionShadowFinding[] = [];
    let comparedCount = 0;

    if (canonical.value.snapshotRevision !== bindingPage.value.snapshotRevision) {
      findings.push(finding('snapshot_revision_mismatch'));
    }

    const sortedBindings = [...bindingPage.value.bindingsByTeamId.values()].sort((left, right) =>
      left.teamId === right.teamId ? 0 : left.teamId < right.teamId ? -1 : 1
    );
    for (const binding of sortedBindings) {
      const canonicalItem = canonicalByTeamId.get(binding.teamId);
      if (!canonicalItem) {
        findings.push(finding('canonical_item_missing', binding.teamId));
        continue;
      }

      comparedCount += 1;
      if (canonicalItem.workspaceId !== binding.workspaceId) {
        findings.push(finding('workspace_id_mismatch', binding.teamId));
      }
      if (canonicalItem.displayName !== binding.displayName) {
        findings.push(finding('display_name_mismatch', binding.teamId));
      }
      if (canonicalItem.lifecycle !== expectedLifecycle(binding, legacy.value)) {
        findings.push(finding('lifecycle_mismatch', binding.teamId));
      }
      if (canonicalItem.revision !== binding.revision) {
        findings.push(finding('revision_mismatch', binding.teamId));
      }
    }

    for (const teamId of canonicalByTeamId.keys()) {
      if (!bindingPage.value.bindingsByTeamId.has(teamId)) {
        findings.push(finding('identity_binding_missing', teamId));
      }
    }

    return report(
      findings.length === 0 ? 'match' : 'mismatch',
      canonical.snapshotRevision,
      comparedCount,
      findings
    );
  }
}
