export function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function readOptionalEnvNumber(name: string): number | undefined {
  const value = readOptionalEnv(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function readOptionalEnvArgs(
  name: string,
  onInvalidJsonArgs?: (name: string) => void
): string[] | undefined {
  const value = readOptionalEnv(name);
  if (!value) return undefined;
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        const args = parsed.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        );
        return args.length > 0 ? args : undefined;
      }
    } catch {
      onInvalidJsonArgs?.(name);
    }
  }
  const args = value.split(/\s+/).filter(Boolean);
  return args.length > 0 ? args : undefined;
}
