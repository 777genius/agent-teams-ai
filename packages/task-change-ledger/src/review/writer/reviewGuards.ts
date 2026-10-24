import * as path from 'node:path';

const SENSITIVE_PATTERNS: RegExp[] = [
  // SSH keys and config
  /[/\\]\.ssh[/\\]/i,
  // AWS credentials
  /[/\\]\.aws[/\\]/i,
  // GCP credentials
  /[/\\]\.config[/\\]gcloud[/\\]/i,
  // Azure credentials
  /[/\\]\.azure[/\\]/i,
  // Environment files (anywhere in path)
  /[/\\]\.env($|\.)/i,
  // Git credentials
  /[/\\]\.git-credentials$/i,
  /[/\\]\.gitconfig$/i,
  // NPM tokens
  /[/\\]\.npmrc$/i,
  // Docker credentials
  /[/\\]\.docker[/\\]config\.json$/i,
  // Kubernetes config
  /[/\\]\.kube[/\\]config$/i,
  // Password files
  /[/\\]\.password/i,
  /[/\\]\.secret/i,
  // Private keys
  /[/\\]id_rsa$/i,
  /[/\\]id_ed25519$/i,
  /[/\\]id_ecdsa$/i,
  /[/\\][^/\\]*\.pem$/i,
  /[/\\][^/\\]*\.key$/i,
  // System files
  /^\/etc\/passwd$/,
  /^\/etc\/shadow$/,
  // Credentials in filename
  /credentials\.json$/i,
  /secrets\.json$/i,
  /tokens\.json$/i,
];

function normalizeForCompare(input: string, isWindows: boolean): string {
  const normalized = path.resolve(path.normalize(input));
  return isWindows ? normalized.toLowerCase() : normalized;
}

export function isPathWithinRoot(
  targetPath: string,
  rootPath: string,
  options?: { preserveCase?: boolean }
): boolean {
  if (options?.preserveCase) return isCasePreservingPathWithinRoot(targetPath, rootPath);
  const isWindows = process.platform === 'win32';
  const target = normalizeForCompare(targetPath, isWindows);
  const root = normalizeForCompare(rootPath, isWindows);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Use for real paths when distinct directory casing can name distinct files. */
function isCasePreservingPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const canonical = (value: string): string => {
    const resolved = path.resolve(path.normalize(value));
    if (process.platform !== 'win32') return resolved;
    const volumeRoot = path.parse(resolved).root;
    return `${volumeRoot.toLowerCase()}${resolved.slice(volumeRoot.length)}`;
  };
  const target = canonical(targetPath);
  const root = canonical(rootPath);
  return (
    target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
  );
}

export function matchesSensitivePattern(normalizedPath: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export function isWindowsReservedFileName(name: string): boolean {
  if (typeof name !== 'string') {
    return false;
  }

  const normalized = name
    .trim()
    .replace(/[. ]+$/g, '')
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  const stem = normalized.split('.')[0] ?? normalized;
  return WINDOWS_RESERVED_BASENAMES.has(stem);
}

export function validateTaskId(value: unknown): { valid: boolean; value?: string; error?: string } {
  if (typeof value !== 'string') return { valid: false, error: 'taskId must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { valid: false, error: 'taskId cannot be empty' };
  if (trimmed.length > 64) return { valid: false, error: 'taskId exceeds max length (64)' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(trimmed))
    return { valid: false, error: 'taskId contains invalid characters' };
  if (isWindowsReservedFileName(trimmed))
    return { valid: false, error: 'taskId is reserved on Windows' };
  return { valid: true, value: trimmed };
}
