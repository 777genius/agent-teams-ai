import {
  classifyNativeVersion,
  getOpenCodeV2EngineVersion,
  parseOpenCodeSemver,
  semverLt,
} from '@features/opencode-compatibility';

import type { OpenCodeInstallGeneration } from '../../contracts';

interface PackageMetadata {
  name?: string;
  version?: string;
  optionalDependencies?: Record<string, string>;
  dist?: { tarball?: string; integrity?: string };
  versions?: Record<string, PackageMetadata>;
}

type FetchPackageMetadata = (name: string, version?: string | null) => Promise<PackageMetadata>;
type ResolvedPackage = PackageMetadata & { name: string; version: string };

function isCompatibleRoot(
  root: PackageMetadata | null | undefined,
  name: string,
  generation: OpenCodeInstallGeneration,
  qualifiedV2Version: string | null
): root is ResolvedPackage {
  const classification =
    typeof root?.version === 'string' ? classifyNativeVersion(root.version) : null;
  return (
    root?.name === name &&
    classification?.kind === 'recognized' &&
    classification.generation === generation &&
    classification.version === root.version &&
    (generation !== 'v2' || getOpenCodeV2EngineVersion(root.version) === qualifiedV2Version)
  );
}

function compatibleRoots(
  registry: PackageMetadata,
  name: string,
  generation: OpenCodeInstallGeneration,
  qualifiedV2Version: string | null
): ResolvedPackage[] {
  if (
    registry?.name !== name ||
    !registry.versions ||
    typeof registry.versions !== 'object' ||
    Array.isArray(registry.versions)
  )
    throw new Error('OpenCode npm package version does not match the selected generation');
  const roots: ResolvedPackage[] = [];
  for (const [version, candidate] of Object.entries(registry.versions)) {
    if (!isCompatibleRoot({ name, version }, name, generation, qualifiedV2Version)) continue;
    if (
      candidate?.version !== version ||
      !isCompatibleRoot(candidate, name, generation, qualifiedV2Version)
    )
      throw new Error('OpenCode npm package version does not match the selected generation');
    roots.push(candidate);
  }
  return roots.sort((left, right) =>
    left.version === right.version
      ? 0
      : semverLt(parseOpenCodeSemver(left.version)!, right.version)
        ? 1
        : -1
  );
}

function hasNativeDistribution(metadata: PackageMetadata | null | undefined): boolean {
  return (
    typeof metadata?.dist?.tarball === 'string' &&
    metadata.dist.tarball.length > 0 &&
    typeof metadata.dist.integrity === 'string' &&
    metadata.dist.integrity.length > 0
  );
}

function isMissingPackage(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 404;
}

function declaredNativeVersion(root: ResolvedPackage, name: string): string | undefined {
  const dependencies = root.optionalDependencies;
  if (dependencies === undefined) return undefined;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
    throw new Error('Invalid OpenCode native dependency metadata');
  const dependency = dependencies[name];
  if (dependency === undefined) return undefined;
  if (typeof dependency !== 'string' || dependency.replace(/^[~^]/, '') !== root.version)
    throw new Error('OpenCode native package version differs from its root package');
  return root.version;
}

/** Resolve CLI metadata once; a moving CLI tag never changes the qualified V2 engine. */
export async function selectOpenCodeRootPackage(
  generation: OpenCodeInstallGeneration,
  qualifiedV2Version: string | null,
  fetchMetadata: FetchPackageMetadata,
  requestedVersion = 'latest'
): Promise<ResolvedPackage> {
  if (generation === 'v2' && !qualifiedV2Version)
    throw new Error(
      'No compatible OpenCode V2 is qualified for this platform. Install V1 instead.'
    );
  const rootName = generation === 'v2' ? '@opencode/cli' : 'opencode-ai';
  let root = await fetchMetadata(rootName, requestedVersion);
  if (
    typeof root?.version !== 'string' ||
    root.version !== root.version.trim() ||
    !/^\d/.test(root.version) ||
    !parseOpenCodeSemver(root.version)
  )
    throw new Error('OpenCode npm package version does not match the selected generation');
  // A global tag can move beyond the selected generation. Resolve a compatible
  // stable release from one registry snapshot, without following the tag again.
  if (
    root?.name === rootName &&
    requestedVersion === 'latest' &&
    !isCompatibleRoot(root, rootName, generation, qualifiedV2Version)
  ) {
    const [latest] = compatibleRoots(
      await fetchMetadata(rootName, null),
      rootName,
      generation,
      qualifiedV2Version
    );
    if (!latest)
      throw new Error('OpenCode npm package version does not match the selected generation');
    root = latest;
  }
  if (
    !isCompatibleRoot(root, rootName, generation, qualifiedV2Version) ||
    (requestedVersion !== 'latest' && root.version !== requestedVersion)
  )
    throw new Error('OpenCode npm package version does not match the selected generation');
  return root;
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
  metadata: ResolvedPackage;
  generation: OpenCodeInstallGeneration;
}> {
  // Registry snapshots bound fallback requests by platform package count, not
  // release count. Never follow latest again or retry a failed native lookup.
  const snapshots = new Map<string, Promise<PackageMetadata>>();
  const fetchSelected: FetchPackageMetadata = (name, version) => {
    if (version !== null) return fetchMetadata(name, version);
    if (!snapshots.has(name)) snapshots.set(name, fetchMetadata(name, null));
    return snapshots.get(name)!;
  };
  const root = await selectOpenCodeRootPackage(
    generation,
    qualifiedV2Version,
    fetchSelected,
    requestedVersion
  );
  const names = candidates.map(({ packageName }) =>
    generation === 'v2' ? packageName.replace(/^opencode-/, '@opencode/cli-') : packageName
  );
  let originalError: unknown = new Error(
    'No OpenCode binary package is available for this platform'
  );
  const packageName = names.find((name) => declaredNativeVersion(root, name) !== undefined);
  if (packageName) {
    try {
      const metadata = await fetchSelected(packageName, root.version);
      if (metadata?.version !== root.version || metadata.name !== packageName)
        throw new Error('OpenCode native npm package identity mismatch');
      if (!hasNativeDistribution(metadata))
        throw new Error('OpenCode native npm package distribution is missing');
      return {
        packageName,
        metadata: { ...metadata, name: packageName, version: root.version },
        generation,
      };
    } catch (error) {
      if (!isMissingPackage(error)) throw error;
      originalError = error;
    }
  }
  if (requestedVersion !== 'latest') throw originalError;
  const roots = compatibleRoots(
    await fetchSelected(root.name, null),
    root.name,
    generation,
    qualifiedV2Version
  );
  for (const candidate of roots) {
    for (const name of names) {
      if (declaredNativeVersion(candidate, name) === undefined) continue;
      let registry: PackageMetadata;
      try {
        registry = await fetchSelected(name, null);
      } catch (error) {
        if (!isMissingPackage(error)) throw error;
        continue;
      }
      if (
        registry?.name !== name ||
        !registry.versions ||
        typeof registry.versions !== 'object' ||
        Array.isArray(registry.versions)
      )
        throw new Error('OpenCode native npm registry identity mismatch');
      const metadata = registry.versions[candidate.version];
      if (metadata === undefined) continue;
      if (metadata?.name !== name || metadata.version !== candidate.version)
        throw new Error('OpenCode native npm package identity mismatch');
      if (!hasNativeDistribution(metadata))
        throw new Error('OpenCode native npm package distribution is missing');
      return {
        packageName: name,
        metadata: { ...metadata, name, version: candidate.version },
        generation,
      };
    }
  }
  throw originalError;
}
