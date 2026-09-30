import { readFileSync } from 'node:fs';

export const PHASE_START_SHA = 'c72fd201867b9bcd1ef77d5e0f95ba379adb4fca';
export const EVIDENCE_ROOT = 'docs/research/hosted-web/phase-0/provider-runtime';

export const ARTIFACTS = [
  'execution-topology.json',
  'runtime-ingress-inventory.json',
  'environment-provenance.json',
  'credential-exposure-matrix.json',
  'fake-runtime-fixture-matrix.json',
  'estimate-input.json',
] as const;

export const EXPECTED_ROUTES = [
  '/api/teams/:teamName/opencode/runtime/bootstrap-checkin',
  '/api/teams/:teamName/opencode/runtime/deliver-message',
  '/api/teams/:teamName/opencode/runtime/task-event',
  '/api/teams/:teamName/opencode/runtime/heartbeat',
] as const;
export const EXPECTED_COMMANDS = [
  'runtime.bootstrap-checkin',
  'runtime.deliver-message',
  'runtime.task-event',
  'runtime.heartbeat',
  'runtime.permission-answer',
] as const;
export const EXPECTED_PROVIDERS = ['anthropic', 'codex', 'gemini', 'opencode'] as const;
export const EXPECTED_MODES = [
  'primary_only',
  'pure_opencode',
  'pure_opencode_solo',
  'pure_opencode_member_lanes',
  'mixed_opencode_side_lanes',
  'unsupported_opencode_led_mixed_team',
] as const;
export const EXPECTED_MATRIX_CASES = [
  'homogeneous_anthropic',
  'homogeneous_codex',
  'homogeneous_gemini',
  'homogeneous_opencode',
  'mixed_provider_team',
  'missing_runtime',
  'missing_auth',
  'unsupported_backend',
  'malformed_capability_response',
  'process_timeout',
  'partial_launch',
  'restart_adoption',
  'opencode_secondary_lane_recovery',
] as const;
export const EXPECTED_FAKE_RUNTIME_SEAMS: Record<
  (typeof EXPECTED_MATRIX_CASES)[number],
  { seam: string; path: string; token: string }
> = {
  homogeneous_anthropic: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  homogeneous_codex: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  homogeneous_gemini: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  homogeneous_opencode: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  mixed_provider_team: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  missing_runtime: {
    seam: 'adapter',
    path: 'src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts',
    token: 'export class OpenCodeTeamRuntimeAdapter',
  },
  missing_auth: {
    seam: 'preflight',
    path: 'src/main/services/team/provisioning/TeamProvisioningProviderPreflight.ts',
    token: 'export function extractAuthStatusReadiness',
  },
  unsupported_backend: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  malformed_capability_response: {
    seam: 'capability_response_parser',
    path: 'src/main/services/team/opencode/capabilities/OpenCodeApiCapabilities.ts',
    token: 'export async function detectOpenCodeApiCapabilities',
  },
  process_timeout: {
    seam: 'adapter',
    path: 'src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts',
    token: 'export class OpenCodeTeamRuntimeAdapter',
  },
  partial_launch: {
    seam: 'adapter',
    path: 'src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts',
    token: 'export class OpenCodeTeamRuntimeAdapter',
  },
  restart_adoption: {
    seam: 'recovery',
    path: 'src/main/services/team/provisioning/TeamProvisioningStaleMixedSecondaryRecovery.ts',
    token: 'export async function recoverStaleMixedSecondaryLaunchSnapshotWithPorts',
  },
  opencode_secondary_lane_recovery: {
    seam: 'recovery',
    path: 'src/main/services/team/provisioning/TeamProvisioningStaleMixedSecondaryRecovery.ts',
    token: 'export async function recoverStaleMixedSecondaryLaunchSnapshotWithPorts',
  },
};
export const ENVIRONMENT_DISCOVERY_ROOTS = [
  'src/main',
  'src/features/codex-account',
  'src/features/member-work-sync',
  'src/features/workspace-trust/main/infrastructure/workspaceTrustPreflightEnv.ts',
] as const;
export const ENVIRONMENT_DISCOVERY_EXCLUDED_SEGMENTS = ['/__tests__/', '/renderer/'];
export const PROVIDER_RUNTIME_ROUTING_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_CODEX_BACKEND',
  'CLAUDE_CODE_GEMINI_BACKEND',
] as const;
export const NON_ENVIRONMENT_LITERALS = new Set([
  'AgentStudio',
  'AppData',
  'Local',
  'EEXIST',
  'ENOENT',
  'NFKD',
  'Atomic',
  'Details',
]);

export type JsonRecord = Record<string, unknown>;

export interface SurfaceFixture {
  routes: string[];
  commands: string[];
  providers: string[];
  modes: string[];
}

export interface ProviderModeIngressFixture {
  authorityModel: string;
  dispositions: Array<{
    provider: string;
    mode: string;
    disposition:
      | 'current_source_observed_runtime_ingress'
      | 'current_source_observed_no_runtime_ingress';
    operations: string[];
    authorityRefs: Array<{ path: string; token: string }>;
    targetStatus: string;
  }>;
}

export interface EnvironmentSemanticsFixture {
  schemaVersion: number;
  canonicalBaseSha: string;
  derivation: string;
  delegatedExecutableSemantics: {
    keys: string[];
    authorityPaths: string[];
    proofTestId: string;
  };
  entries: Array<{
    key: string;
    policyProfileId: string;
    semanticRole: string;
    providerBindings: Array<{
      providerId: string;
      backendFamily: string;
      targetDisposition: string;
    }>;
    platformScope: string;
    childVisibility: string;
    credentialExposureSetId: string;
    providerlessProhibition?: {
      scope: string;
      targetDisposition: string;
      reason: string;
    };
    authority: { path: string; token: string };
  }>;
}

export interface ProviderRuntimeRoutingObservation {
  key: (typeof PROVIDER_RUNTIME_ROUTING_KEYS)[number];
  providerId: 'anthropic' | 'codex' | 'gemini';
  backendFamily: 'provisioning_cli_primary';
  runtimeBackend:
    | 'anthropic_default'
    | 'anthropic_bedrock'
    | 'anthropic_vertex'
    | 'anthropic_foundry'
    | 'anthropic_claude_platform_aws'
    | 'codex_configured'
    | 'gemini_configured';
  targetDisposition: 'required' | 'optional' | 'forbidden';
  emissionDisposition:
    | 'emitted_always'
    | 'emitted_when_backend_selected'
    | 'emitted_configured_backend'
    | 'preserved_when_custom_configuration'
    | 'removed_before_spawn';
}

export function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
}

export function extractQuoted(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

export function compareSet(
  label: string,
  actual: readonly string[],
  expected: readonly string[]
): string[] {
  const errors = compareUnique(label, [...actual]);
  const actualSet = new Set(actual);
  for (const value of expected)
    if (!actualSet.has(value)) errors.push(`${label}: missing ${value}`);
  for (const value of actualSet)
    if (!expected.includes(value)) errors.push(`${label}: unexpected ${value}`);
  return errors;
}

export function compareUnique(label: string, values: string[]): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const value of values) {
    if (!value) errors.push(`${label}: empty value`);
    else if (seen.has(value)) errors.push(`${label}: duplicate ${value}`);
    seen.add(value);
  }
  return errors;
}
