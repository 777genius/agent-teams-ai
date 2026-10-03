import type { NativeKey } from '../../contracts';

export const MINIMUM_AGENT_TEAMS_OPENCODE_VERSION = '1.16.0';
export interface OpenCodeSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/** Normalize only the measured whole V2 CLI spelling; V1 remains bare semver. */
function normalizeOpenCodeVersionText(raw: string): string {
  return raw.trim().replace(/^opencode v(?=2\.)/, '').replace(/^v/, '');
}

/** Whole CLI output only; never extract a version from arbitrary diagnostic text. */
export function parseOpenCodeSemver(raw: string): OpenCodeSemver | null {
  if (raw.length > 256) return null;
  const version = normalizeOpenCodeVersionText(raw);
  const metadata = version.split('+');
  const validIdentifiers = (value: string): boolean =>
    value.length > 0 && !/[^0-9A-Za-z.-]/.test(value) && !value.split('.').includes('');
  if (metadata.length > 2 || (metadata.length === 2 && !validIdentifiers(metadata[1]))) return null;
  const prereleaseOffset = metadata[0].indexOf('-');
  const core = prereleaseOffset < 0 ? metadata[0] : metadata[0].slice(0, prereleaseOffset);
  const suffix = prereleaseOffset < 0 ? null : metadata[0].slice(prereleaseOffset + 1);
  if (suffix !== null && !validIdentifiers(suffix)) return null;
  const components = core.split('.');
  if (components.length !== 3 || components.some((part) => !/^(0|[1-9]\d*)(?![\s\S])/.test(part)))
    return null;
  const [major, minor, patch] = components.map(Number);
  const prerelease = suffix?.split('.') ?? [];
  if (
    ![major, minor, patch].every(Number.isSafeInteger) ||
    prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))
  )
    return null;
  return { major, minor, patch, prerelease };
}

export type NativeVersionClassification =
  | (NativeKey & { kind: 'recognized'; version: string; productionEligible: boolean })
  | { kind: 'blocked'; reason: 'invalid' | 'prerelease' | 'too_old' | 'unknown_generation' };

export function classifyNativeVersion(raw: string): NativeVersionClassification {
  const parsed = parseOpenCodeSemver(raw);
  if (!parsed) return { kind: 'blocked', reason: 'invalid' };
  if (parsed.prerelease.length) return { kind: 'blocked', reason: 'prerelease' };
  const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (parsed.major === 1) {
    if (parsed.minor < 16) return { kind: 'blocked', reason: 'too_old' };
    return {
      kind: 'recognized',
      generation: 'v1',
      apiDialect: 'v1',
      version,
      productionEligible: true,
    };
  }
  // V2 build metadata cannot establish an exact qualified dialect.
  if (normalizeOpenCodeVersionText(raw) === version && (version === '2.0.0' || version === '2.0.21')) {
    return {
      kind: 'recognized',
      generation: 'v2',
      apiDialect: `v2-${version}`,
      version,
      productionEligible: false,
    };
  }
  return { kind: 'blocked', reason: parsed.major === 0 ? 'too_old' : 'unknown_generation' };
}

export function isLegacyOpenCodeVersionSupported(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const classification = classifyNativeVersion(raw);
  return classification.kind === 'recognized' && classification.productionEligible;
}

export function semverCoreLt(left: OpenCodeSemver, right: string | OpenCodeSemver): boolean {
  const parsedRight = typeof right === 'string' ? parseOpenCodeSemver(right) : right;
  if (!parsedRight) return true;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] < parsedRight[key]) return true;
    if (left[key] > parsedRight[key]) return false;
  }
  return false;
}

export function semverLt(left: OpenCodeSemver, right: string | OpenCodeSemver): boolean {
  const parsedRight = typeof right === 'string' ? parseOpenCodeSemver(right) : right;
  if (!parsedRight) return true;
  if (semverCoreLt(left, parsedRight)) return true;
  if (semverCoreLt(parsedRight, left)) return false;
  return left.prerelease.length > 0 && parsedRight.prerelease.length === 0;
}

export interface OpenCodeSupportedVersionPolicy {
  minimumVersion: string;
  allowedPrerelease: boolean;
  requireCapabilities: boolean;
}
export type OpenCodeSupportLevel =
  | 'unsupported_too_old'
  | 'unsupported_prerelease'
  | 'supported_capabilities_pending'
  | 'production_supported';
export interface OpenCodeSupportDecision {
  supported: boolean;
  supportLevel: OpenCodeSupportLevel;
  semver: OpenCodeSemver | null;
  diagnostics: string[];
}

/** Capability evidence is obtained only after admitting stable legacy V1. */
export function evaluateLegacyOpenCodeSupport(input: {
  version: string;
  policy: OpenCodeSupportedVersionPolicy;
  capabilities: () => { ready: boolean; missing: string[] };
}): OpenCodeSupportDecision {
  const parsed = parseOpenCodeSemver(input.version);
  const { policy } = input;
  if (
    !parsed ||
    semverCoreLt(parsed, policy.minimumVersion) ||
    (parsed.major === 1 && parsed.minor < 16)
  ) {
    return {
      supported: false,
      supportLevel: 'unsupported_too_old',
      semver: parsed,
      diagnostics: [
        `OpenCode ${input.version} is below supported minimum ${policy.minimumVersion}`,
      ],
    };
  }
  if (parsed.prerelease.length) {
    return {
      supported: false,
      supportLevel: 'unsupported_prerelease',
      semver: parsed,
      diagnostics: [
        `OpenCode prerelease ${input.version} is not enabled for production team launch`,
      ],
    };
  }
  const classification = classifyNativeVersion(input.version);
  if (classification.kind !== 'recognized' || classification.generation !== 'v1') {
    return {
      supported: false,
      supportLevel:
        classification.kind === 'recognized'
          ? 'supported_capabilities_pending'
          : 'unsupported_too_old',
      semver: parsed,
      diagnostics: [
        classification.kind === 'recognized'
          ? `OpenCode ${input.version} native V2 is unqualified for production team launch`
          : `OpenCode ${input.version} has an unsupported native generation`,
      ],
    };
  }
  if (policy.requireCapabilities) {
    const capabilities = input.capabilities();
    if (!capabilities.ready)
      return {
        supported: false,
        supportLevel: 'supported_capabilities_pending',
        semver: parsed,
        diagnostics: capabilities.missing,
      };
  }
  return { supported: true, supportLevel: 'production_supported', semver: parsed, diagnostics: [] };
}
