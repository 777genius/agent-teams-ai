import type { DrainEvidenceEnvelope } from '../w4-w6-contract/drain-evidence-envelope.mjs';

export const repoRoot: string;

export type AuthActionType =
  | 'bootstrap'
  | 'pair'
  | 'restart'
  | 'lose_keyring'
  | 'expire_session'
  | 'renew'
  | 'logout'
  | 'forget_device'
  | 'begin_reset'
  | 'record_drain_evidence'
  | 'advance_reset';

export const AUTH_ACTION_TYPES: readonly AuthActionType[];

export interface AuthAction {
  type: string;
  [field: string]: unknown;
}

export interface ProcessAnchorState {
  status: 'ready' | 'drained';
  protocolVersion: number;
  deploymentGeneration: string;
  processAnchorGeneration: string;
  processAnchorGenerationOrdinal: number;
  anchorIdentity: string;
  spawnNonceHash: string;
}

export interface AuthSessionState {
  generation: number;
  active: boolean;
  revokedReason?: string;
  expiredBy?: unknown;
}

export interface AuthDeviceState {
  familyRef: string;
  generation: number;
  predecessor: { generation: number; remainingUses: number } | null;
  revokedReason?: string;
}

export interface ResetIntentState {
  generation: number;
  stage: string;
  drainEvidence: DrainEvidenceEnvelope | null;
}

export interface AuthState {
  processEpoch: number;
  processAnchor: ProcessAnchorState;
  keyring: { status: string; keyId: string | null };
  resetGeneration: number;
  resetIntent: ResetIntentState | null;
  challenge: { ref: string; consumed: boolean } | null;
  device: AuthDeviceState | null;
  sessions: Record<string, AuthSessionState>;
  mutationAdmission: boolean;
}

export interface CookieTransition {
  cookie: string;
  operation: string;
  attributes: string[];
  domain: string | null;
}

export interface AuthTransitionResult {
  state: AuthState;
  outcome: 'accepted' | 'rejected';
  code: string;
  cookieTransitions?: CookieTransition[];
  response?: {
    delivered: boolean;
    sessionRef: string | null;
    deviceGeneration: number | null;
  };
}

export interface AuthTraceEntry {
  action: string;
  outcome: 'accepted' | 'rejected';
  code: string;
}

export interface DrainEvidenceOverrides {
  ready?: Record<string, unknown>;
  drained?: Record<string, unknown>;
  [field: string]: unknown;
}

export function newAuthState(): AuthState;
export function validateDrainEvidence(
  state: AuthState,
  evidence: unknown,
  purpose: string,
  resetGeneration: number,
  recorded?: boolean
): string | null;
export function drainEvidenceFor(
  state: AuthState,
  purpose: string,
  resetGeneration: number,
  overrides?: DrainEvidenceOverrides
): DrainEvidenceEnvelope;
export function authTransition(input: AuthState, action: AuthAction): AuthTransitionResult;
export function runAuthSchedule(actions: readonly AuthAction[]): {
  state: AuthState;
  trace: AuthTraceEntry[];
};

export interface ProxyRequestInput {
  peer?: string;
  socketEncrypted?: boolean;
  host?: string;
  forwarded?: { proto?: unknown; host?: unknown };
  browserRequest?: boolean;
  origin?: string;
  surface?: string;
}

export interface ProxyConfigInput {
  publicOrigin: string;
  corsOrigin: string;
  trustedProxyPeers: string[];
}

export interface ProxyEvaluation {
  accepted: boolean;
  code: string;
  stage: string;
  cookieLookup: boolean;
  bodyParsed: boolean;
  idempotencyClaimed: boolean;
}

export function evaluateProxyRequest(
  request: ProxyRequestInput,
  config: ProxyConfigInput
): ProxyEvaluation;

export interface AuthorityCookieInput {
  headerBytes: number;
  maxHeaderBytes: number;
  parseStatus: string;
  cookieNames: string[];
}

export function evaluateAuthorityCookieInput(input: AuthorityCookieInput): {
  accepted: boolean;
  code: string;
  cookieLookup: boolean;
};

export const STANDALONE_CHARACTERIZATION_PATH: string;
export const STANDALONE_CHARACTERIZATION_RECORD_TYPE: string;
export const STANDALONE_CANONICAL_SOURCE_COMMIT: string;
export const ARTIFACT_EVOLUTION_ASSUMPTION: string;
export const ARTIFACT_PROOF_LEVELS: Readonly<Record<string, string>>;

export interface ProjectionValidationResult {
  ok: boolean;
  violations: string[];
}

export function validateArtifactAuthorityProjections(
  authority: unknown,
  evidence: unknown,
  estimate: unknown,
  handoff: unknown
): ProjectionValidationResult;

export interface StandaloneCharacterizationSource {
  standaloneInput: string;
  rendererOutput: string;
  externalPackages: string[];
  nativeCatchAllEmptyStub: boolean;
  broadElectronStub: boolean;
  standaloneServiceStubs: boolean;
  terminalNodeInstallStub: boolean;
  terminalRuntimeArtifactPresent: boolean;
  standaloneWorkerEntry: boolean;
  electronWorkerEntry: boolean;
  internalWorkerRuntimeFilename: string;
  defaultWildcardCors: boolean;
  directHttpPublished: boolean;
  productionNodeModulesCopiedWhole: boolean;
  terminalPackages: string[];
  cookiePlugin: string | null;
  versions: Record<string, string | undefined>;
  terminalHttpRegistration: boolean;
  terminalMigration: boolean;
}

export interface StandaloneCharacterizationEmitted {
  observed: boolean;
  files: { path: string; bytes: number; sha256: string }[];
  internalStorageWorkerPresent: boolean;
  electronEmptyStubPresent: boolean;
  terminalServiceMarkerPresent: boolean;
  terminalPlatformMarkerPresent: boolean;
}

export interface TerminalAbsenceReport {
  passes: boolean;
  violations: string[];
}

export interface StandaloneCharacterization {
  schemaVersion: number;
  recordType: string;
  phaseStartSha: string;
  canonicalSourceCommit: string;
  proofLevel: string;
  characterizationScope: string;
  build: Record<string, unknown>;
  historicalProvenance: Record<string, unknown>;
  source: StandaloneCharacterizationSource;
  emitted: StandaloneCharacterizationEmitted;
  terminalAbsence?: TerminalAbsenceReport;
}

export function standaloneCharacterizationSha256(characterization: unknown): string;

export interface StandaloneCharacterizationProjection {
  authorityPath: string;
  authorityRecordType: string;
  authoritySha256: string;
  disposition: string;
}

export function buildStandaloneCharacterizationProjection(
  characterization: unknown
): StandaloneCharacterizationProjection;
export function validateStandaloneCharacterizationProjection(
  characterization: StandaloneCharacterization,
  projection: unknown
): ProjectionValidationResult & { expected: StandaloneCharacterizationProjection };

export function scanStandalone(
  root?: string,
  options?: { buildRoot?: string | null }
): StandaloneCharacterization;

export function evaluateV1TerminalAbsence(scan: StandaloneCharacterization): TerminalAbsenceReport;

export interface HostedArtifactContractRow {
  artifactId: string;
  finalImagePath?: string;
  protocolSha256?: string;
  spikeSourcePath?: string;
  spikeSourceSha256?: string;
  [field: string]: unknown;
}

export interface HostedArtifactContract {
  recordType?: string;
  status?: string;
  capabilityClaims?: Record<string, unknown>;
  artifacts?: HostedArtifactContractRow[];
  controllerContractPath?: string;
  [field: string]: unknown;
}

export function evaluateHostedArtifactContract(contract: HostedArtifactContract): {
  contractPasses: boolean;
  releasePasses: boolean;
  hostedV1Admitted: boolean;
  violations: string[];
  unresolvedArtifactIds: string[];
};

export interface FinalImageSurfaceScan {
  packages?: unknown;
  files?: unknown;
  routes?: unknown;
  migrations?: unknown;
  capabilities?: unknown;
  processes?: unknown;
  rendererChunks?: unknown;
  ports?: unknown;
  volumes?: unknown;
}

export function evaluateFinalImageTerminalAbsence(
  image: FinalImageSurfaceScan
): TerminalAbsenceReport;

export interface SqliteAbiProbe {
  packageName: string;
  version: string;
  sqliteVersion: string;
  reopenedValue: string;
}

export function runAbiSmokeProbe(): {
  runtime: {
    node: string;
    nodeModuleAbi: number;
    napi: number;
    electron: string;
    electronModuleAbi: number;
  };
  sqlite: SqliteAbiProbe[];
};
