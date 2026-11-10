import path from 'node:path';

import type { LaunchTrustProviderId, LaunchTrustRequest } from '../../contracts';

export function validateLaunchTrustRequest(value: unknown): LaunchTrustRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const projectPath = request.projectPath;
  if (
    typeof projectPath !== 'string' ||
    !projectPath.trim() ||
    projectPath.length > 4096 ||
    projectPath.includes('\0') ||
    !path.isAbsolute(projectPath.trim())
  )
    return null;
  if (
    !Array.isArray(request.providerIds) ||
    request.providerIds.length > 32 ||
    !Array.from(request.providerIds).every(
      (provider) => provider === 'anthropic' || provider === 'codex'
    )
  )
    return null;
  return {
    projectPath: projectPath.trim(),
    providerIds: [...new Set(request.providerIds as LaunchTrustProviderId[])].sort(),
  };
}
