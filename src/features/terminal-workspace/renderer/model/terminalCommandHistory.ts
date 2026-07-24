export function normalizeStoredTerminalCommandHistoryEntry(value: string): string | null {
  const entry = stripStoredShellPromptPrefix(value.trim()).trim();
  return entry.length > 0 ? entry : null;
}

function stripStoredShellPromptPrefix(value: string): string {
  const command = findStoredShellPromptCommand(value);
  if (command !== null) {
    return command;
  }

  return isStoredShellPromptOnly(value) ? '' : value;
}

function findStoredShellPromptCommand(value: string): string | null {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const marker = value[index] ?? '';
    if (!isShellPromptMarker(marker)) continue;

    const command = value.slice(index + 1);
    if (!command.startsWith(' ') || command.trim().length === 0) continue;

    const prefix = value.slice(0, index).trimEnd();
    if (looksLikeStoredShellPromptPrefix(prefix)) {
      return command.trimStart();
    }
  }

  return null;
}

function isStoredShellPromptOnly(value: string): boolean {
  const trimmed = value.trimEnd();
  const marker = trimmed.at(-1) ?? '';
  if (!isShellPromptMarker(marker)) {
    return false;
  }

  return looksLikeStoredShellPromptPrefix(trimmed.slice(0, -1).trimEnd());
}

function looksLikeStoredShellPromptPrefix(value: string): boolean {
  let remaining = value.trim();
  let hasEnvironmentPrefix = false;

  while (remaining.startsWith('(')) {
    const closeIndex = remaining.indexOf(')');
    if (closeIndex < 2 || closeIndex > 48) {
      return false;
    }

    hasEnvironmentPrefix = true;
    remaining = remaining.slice(closeIndex + 1).trimStart();
  }

  if (!remaining || remaining.length > 260) {
    return false;
  }

  const firstToken = firstWhitespaceSeparatedToken(remaining);
  const locationToken = lastWhitespaceSeparatedToken(remaining);
  const hasUserHostPrefix = firstToken.includes('@') && firstToken !== locationToken;

  return (
    isPathLikePromptToken(locationToken) ||
    ((hasEnvironmentPrefix || hasUserHostPrefix) && isSafePromptToken(locationToken))
  );
}

function firstWhitespaceSeparatedToken(value: string): string {
  const trimmed = value.trim();
  const spaceIndex = trimmed.indexOf(' ');
  const tabIndex = trimmed.indexOf('\t');
  const index =
    spaceIndex === -1 ? tabIndex : tabIndex === -1 ? spaceIndex : Math.min(spaceIndex, tabIndex);
  return index === -1 ? trimmed : trimmed.slice(0, index);
}

function lastWhitespaceSeparatedToken(value: string): string {
  const trimmed = value.trim();
  const spaceIndex = trimmed.lastIndexOf(' ');
  const tabIndex = trimmed.lastIndexOf('\t');
  const index = Math.max(spaceIndex, tabIndex);
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function isPathLikePromptToken(value: string): boolean {
  return (
    value === '~' ||
    value.startsWith('~/') ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    isWindowsDrivePath(value)
  );
}

function isWindowsDrivePath(value: string): boolean {
  const driveLetter = value.charCodeAt(0);
  const isLetter =
    (driveLetter >= 65 && driveLetter <= 90) || (driveLetter >= 97 && driveLetter <= 122);
  return isLetter && value[1] === ':' && value.length > 2;
}

function isSafePromptToken(value: string): boolean {
  if (value.length === 0 || value.length > 181) {
    return false;
  }

  return Array.from(value).every((char) => {
    const code = char.charCodeAt(0);
    return code > 32 && char !== '%' && char !== '$' && char !== '#';
  });
}

function isShellPromptMarker(value: string): boolean {
  return value === '%' || value === '$' || value === '#';
}
