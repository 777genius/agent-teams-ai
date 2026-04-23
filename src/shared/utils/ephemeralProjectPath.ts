const TMP_SEGMENT = 'tmp';
const POSIX_TMP_ROOT = `/${TMP_SEGMENT}/`;
const PRIVATE_TMP_ROOT = `/private/${TMP_SEGMENT}/`;

function normalizePathForEphemeralCheck(projectPath: string): string {
  return projectPath.trim().replace(/\\/g, '/').toLowerCase();
}

function getBasename(normalizedPath: string): string {
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

function isKnownTempRoot(normalizedPath: string): boolean {
  return (
    normalizedPath.startsWith('/private/var/folders/') ||
    normalizedPath.startsWith('/var/folders/') ||
    normalizedPath.startsWith(PRIVATE_TMP_ROOT) ||
    normalizedPath.startsWith(POSIX_TMP_ROOT) ||
    normalizedPath.includes('/appdata/local/temp/') ||
    normalizedPath.includes('/appdata/locallow/temp/')
  );
}

export function isEphemeralProjectPath(projectPath: string | null | undefined): boolean {
  const normalizedPath = normalizePathForEphemeralCheck(projectPath ?? '');
  if (!normalizedPath) {
    return false;
  }

  if (
    normalizedPath.includes('rendered_mcp_') ||
    normalizedPath.includes('rendered_mcp_config') ||
    normalizedPath.includes('/portable-mcp-live')
  ) {
    return true;
  }

  const basename = getBasename(normalizedPath);
  return basename.startsWith('codex-agent-teams-appstyle-') && isKnownTempRoot(normalizedPath);
}
