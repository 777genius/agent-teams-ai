import type { McpInstallSpec } from '@shared/types/extensions';

function getNpmTargetKey(target: string): string | null {
  const parts = target.trim().split(/\s+/);
  if (parts.length !== 3 || parts[0] !== 'npx' || parts[1] !== '-y') {
    return null;
  }

  const packageSpec = parts[2];
  if (!packageSpec || packageSpec.startsWith('-')) {
    return null;
  }

  return `npm:${packageSpec}`;
}

function getHttpTargetKey(target: string): string | null {
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const queryKeys = Array.from(parsed.searchParams.keys()).sort();
    const queryShape = queryKeys.length > 0 ? `?${queryKeys.join('&')}` : '';
    return `http:${parsed.protocol}//${parsed.host}${parsed.pathname}${queryShape}`;
  } catch {
    return null;
  }
}

/**
 * Build a secret-free identity key for an install target.
 * Query values, credentials, and URL fragments are intentionally excluded.
 */
export function getMcpRuntimeTargetKey(target: string, transport?: string | null): string | null {
  if (transport === 'stdio') {
    return getNpmTargetKey(target);
  }

  if (transport === 'http' || transport === 'sse' || transport === 'streamable-http') {
    return getHttpTargetKey(target);
  }

  return getNpmTargetKey(target) ?? getHttpTargetKey(target);
}

/** Build the same identity key directly from a registry install spec. */
export function getMcpInstallTargetKey(installSpec: McpInstallSpec | null): string | null {
  if (!installSpec) {
    return null;
  }

  if (installSpec.type === 'stdio') {
    const packageSpec = installSpec.npmVersion
      ? `${installSpec.npmPackage}@${installSpec.npmVersion}`
      : installSpec.npmPackage;
    return getNpmTargetKey(`npx -y ${packageSpec}`);
  }

  return getHttpTargetKey(installSpec.url);
}
