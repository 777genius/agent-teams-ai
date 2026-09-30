import { createRequire } from 'node:module';
import { closeSync, constants, openSync } from 'node:fs';
import type { FilePin } from '../contracts';
import { readReadonlyArtifact } from './readonly-artifact';
import type { RetainedPreparedProfile } from './private-profile-transfer';

export interface SelectedPreparedProfile {
  projectPath: string; profileRootKey: string; profileRootPath: string;
  projectBehaviorFingerprint: string; behaviorSources: string[];
  managedConfig: Record<string, unknown>; managedConfigFingerprint: string;
  homePath: string; tmpPath: string; xdgConfigHome: string; xdgDataHome: string; xdgCacheHome: string;
  managedAuthPath: string; sourceAuthPath: string | null;
  sourceAuthSources?: { path: string; fingerprint: string | null }[];
  sourceAuthFingerprint: string | null; managedAuthFingerprint: string | null;
  authState: 'ok' | 'missing' | 'stale'; env: NodeJS.ProcessEnv;
}
export interface SelectedPreparationInput {
  projectPath: '/sandbox/project'; paths: { data: string; cache: string };
  sourceHomePath: string; workingDirectory: '/sandbox/project';
  sourceAuthPaths: readonly string[]; globalAuthPath: string;
  environment: NodeJS.ProcessEnv; platform: 'linux'; appMcpConfig: Record<string, unknown>;
  options: { toolApprovalMode: 'manual'; includeAppMcp: true; includeManagedSubscriptionPlugins: true;
    modelOutputLimitOverrides?: readonly { modelId: string; outputTokens: number; contextTokens?: number }[];
    abortSignal: AbortSignal };
}
export interface ResolvedConfigObservations {
  config: { status: number; data: unknown }; configProviders: { status: number; data: unknown };
  agents: { status: number; data: unknown }; mcp: { status: number; data: unknown };
}
/** Exact named Owner exports, bundled by root from accepted source. The
 * resolver/fingerprint exports are the concurrent extraction contract. No
 * module can supply a precomputed profile instead of the real preparer call. */
export interface OwnerPreparationModule {
  prepareOpenCodeProfile(input: SelectedPreparationInput): Promise<SelectedPreparedProfile>;
  retainPreparedProfile(profile: SelectedPreparedProfile): RetainedPreparedProfile;
  resolveOpenCodeAppMcpLaunchConfig(input: {
    env: NodeJS.ProcessEnv; workingDirectory: string; moduleDirectory: string;
    repositoryRoot: string | null; home: string | null; entrypoint: string | null; platform: 'linux';
    resolveExecutable(name: string): string | null;
  }): Promise<{ config: Record<string, unknown> }>;
  buildResolvedConfigFingerprint(observations: ResolvedConfigObservations): string | null;
  collectProjectBehaviorMetadata(path: string): Promise<{ projectBehaviorFingerprint: string; behaviorSources: string[] }>;
}
/** The pin is read from the independently admitted recipe, never private FD3
 * data. Bundle dependencies into this one CJS artifact: no ambient resolution,
 * .review-inputs imports, Bun client closure, or runtime source substitution. */
export function loadOwnerPreparationModule(pin: FilePin): OwnerPreparationModule {
  if (pin.root !== 'p3b2' || !pin.relativePath.endsWith('.cjs')) {
    throw new Error('selected_owner_preparation_module');
  }
  const root = openSync('/p3b2', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const bytes = readReadonlyArtifact(root, pin, 32 * 1024 * 1024);
    bytes.fill(0);
    const module: unknown = createRequire('/p3b2/selected-entry.cjs')(`/p3b2/${pin.relativePath}`);
    for (const name of ['prepareOpenCodeProfile', 'retainPreparedProfile',
      'resolveOpenCodeAppMcpLaunchConfig', 'buildResolvedConfigFingerprint', 'collectProjectBehaviorMetadata']) {
      if (!module || typeof module !== 'object' || typeof Reflect.get(module, name) !== 'function') {
        throw new Error('selected_owner_preparation_exports');
      }
    }
    return Object.freeze(module) as OwnerPreparationModule;
  } finally { closeSync(root); }
}
