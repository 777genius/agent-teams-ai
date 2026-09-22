export function formatWorkingDirectory(path?: string | null, fallback = ''): string {
  const normalizedPath = trimTrailingSlashes(path?.trim() || '');
  if (!normalizedPath) {
    return fallback;
  }

  return compactUserHome(normalizedPath);
}

export function formatTerminalPromptLabel(path?: string | null, localShellLabel = ''): string {
  const workingDirectory = formatWorkingDirectory(path, '');
  return workingDirectory || localShellLabel;
}

export function normalizeTerminalPathScope(path: string | null | undefined): string | null {
  const trimmed = trimTrailingSlashes(path?.trim() || '');
  return trimmed ? trimmed : null;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function compactUserHome(path: string): string {
  const usersPrefix = '/Users/';
  if (!path.startsWith(usersPrefix)) {
    return path;
  }

  const rest = path.slice(usersPrefix.length);
  const nextSlashIndex = rest.indexOf('/');
  if (nextSlashIndex === -1) {
    return '~';
  }

  return `~${rest.slice(nextSlashIndex)}`;
}
