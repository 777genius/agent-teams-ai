import { classifyNativeVersion } from '@features/opencode-compatibility';

import type { OpenCodeInstallGeneration } from '../../contracts';

interface PackageMetadata {
  name?: string;
  version?: string;
  optionalDependencies?: Record<string, string>;
  dist?: { tarball?: string; integrity?: string };
}

/** npm is transport; the pinned contract, never a moving dist tag, selects V2. */
export async function selectOpenCodeInstallPackage(
  generation: OpenCodeInstallGeneration,
  qualifiedV2Version: string | null,
  candidates: readonly { packageName: string }[],
  fetchMetadata: (name: string, version?: string) => Promise<PackageMetadata>
): Promise<{
  packageName: string;
  metadata: PackageMetadata;
  generation: OpenCodeInstallGeneration;
}> {
  if (generation === 'v2' && !qualifiedV2Version)
    throw new Error(
      'No compatible OpenCode V2 is qualified for this platform. Install V1 instead.'
    );
  const rootName = generation === 'v2' ? '@opencode/cli' : 'opencode-ai';
  const root = await fetchMetadata(rootName, generation === 'v2' ? qualifiedV2Version! : 'latest');
  const classification = root.version ? classifyNativeVersion(root.version) : null;
  if (
    classification?.kind !== 'recognized' ||
    classification.generation !== generation ||
    (generation === 'v2' && (root.name !== rootName || root.version !== qualifiedV2Version))
  )
    throw new Error('OpenCode npm package version does not match the selected generation');
  const names = candidates.map(({ packageName }) =>
    generation === 'v2' ? packageName.replace(/^opencode-/, '@opencode/cli-') : packageName
  );
  const packageName = names.find((name) => root.optionalDependencies?.[name]);
  if (!packageName) throw new Error('No OpenCode binary package is available for this platform');
  const version = root.optionalDependencies![packageName].replace(/^[~^]/, '');
  if (version !== root.version)
    throw new Error('OpenCode native package version differs from its root package');
  const metadata = await fetchMetadata(packageName, version);
  if (metadata.version !== version || (generation === 'v2' && metadata.name !== packageName))
    throw new Error('OpenCode native npm package identity mismatch');
  return { packageName, metadata, generation };
}
