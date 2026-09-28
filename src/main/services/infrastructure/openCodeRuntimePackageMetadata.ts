const NPM_REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 60_000;

export interface NpmPackageMetadata {
  name?: string;
  version?: string;
  dist?: { tarball?: string; integrity?: string };
  optionalDependencies?: Record<string, string>;
}

export async function fetchOpenCodePackageMetadata(
  packageName: string,
  version = 'latest',
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<NpmPackageMetadata> {
  const url = `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    const parsed = (await response.json()) as NpmPackageMetadata;
    if (!parsed.version || !parsed.dist?.tarball || !parsed.dist.integrity) {
      throw new Error(`Invalid npm metadata for ${packageName}@${version}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
