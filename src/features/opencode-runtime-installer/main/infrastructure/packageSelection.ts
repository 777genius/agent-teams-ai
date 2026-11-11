import {
  classifyNativeVersion,
  getOpenCodeV2EngineVersion,
} from '@features/opencode-compatibility';

import type { OpenCodeInstallGeneration } from '../../contracts';

interface PackageMetadata {
  name?: string;
  version?: string;
  optionalDependencies?: Record<string, string>;
  dist?: { tarball?: string; integrity?: string };
}

type FetchPackageMetadata = (name: string, version?: string) => Promise<PackageMetadata>;

/** Resolve CLI metadata once; a moving CLI tag never changes the qualified V2 engine. */
export async function selectOpenCodeRootPackage(
  generation: OpenCodeInstallGeneration,
  qualifiedV2Version: string | null,
  fetchMetadata: FetchPackageMetadata,
  requestedVersion = 'latest'
): Promise<PackageMetadata & { name: string; version: string }> {
  if (generation === 'v2' && !qualifiedV2Version)
    throw new Error(
      'No compatible OpenCode V2 is qualified for this platform. Install V1 instead.'
    );
  const rootName = generation === 'v2' ? '@opencode/cli' : 'opencode-ai';
  const root = await fetchMetadata(rootName, requestedVersion);
  const classification = typeof root.version === 'string' ? classifyNativeVersion(root.version) : null;
  if (
    root.name !== rootName ||
    classification?.kind !== 'recognized' ||
    classification.generation !== generation ||
    classification.version !== root.version ||
    (requestedVersion !== 'latest' && root.version !== requestedVersion) ||
    (generation === 'v2' && getOpenCodeV2EngineVersion(root.version) !== qualifiedV2Version)
  )
    throw new Error('OpenCode npm package version does not match the selected generation');
  return { ...root, name: rootName, version: classification.version };
}

/** Pin native bytes to the resolved CLI release, independently of its execution engine. */
export async function selectOpenCodeInstallPackage(
  generation: OpenCodeInstallGeneration,
  qualifiedV2Version: string | null,
  candidates: readonly { packageName: string }[],
  fetchMetadata: FetchPackageMetadata,
  requestedVersion = 'latest'
): Promise<{
  packageName: string;
  metadata: PackageMetadata;
  generation: OpenCodeInstallGeneration;
}> {
  const root = await selectOpenCodeRootPackage(
    generation, qualifiedV2Version, fetchMetadata, requestedVersion
  );
  const names = candidates.map(({ packageName }) =>
    generation === 'v2' ? packageName.replace(/^opencode-/, '@opencode/cli-') : packageName
  );
  const packageName = names.find((name) => typeof root.optionalDependencies?.[name] === 'string');
  if (!packageName) throw new Error('No OpenCode binary package is available for this platform');
  const version = root.optionalDependencies![packageName].replace(/^[~^]/, '');
  if (version !== root.version)
    throw new Error('OpenCode native package version differs from its root package');
  const metadata = await fetchMetadata(packageName, version);
  if (metadata.version !== version || metadata.name !== packageName)
    throw new Error('OpenCode native npm package identity mismatch');
  return { packageName, metadata, generation };
}
