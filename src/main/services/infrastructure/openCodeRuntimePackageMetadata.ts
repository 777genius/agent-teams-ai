const NPM_REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 60_000;

export interface NpmPackageMetadata {
  name?: string;
  version?: string;
  dist?: { tarball?: string; integrity?: string };
  optionalDependencies?: Record<string, string>;
  versions?: Record<string, NpmPackageMetadata>;
}

/** A null version reads one registry versions snapshot instead of a mutable tag. */
export async function fetchOpenCodePackageMetadata(
  packageName: string,
  version: string | null = 'latest',
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<NpmPackageMetadata> {
  const url = `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}${
    version === null ? '' : `/${encodeURIComponent(version)}`
  }`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      ...(version === null ? { headers: { Accept: 'application/vnd.npm.install-v1+json' } } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    const parsed = (await response.json()) as NpmPackageMetadata;
    if (
      version === null
        ? !parsed?.versions || typeof parsed.versions !== 'object' || Array.isArray(parsed.versions)
        : !parsed?.version || !parsed.dist?.tarball || !parsed.dist.integrity
    ) {
      throw new Error(`Invalid npm metadata for ${packageName}@${version}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
