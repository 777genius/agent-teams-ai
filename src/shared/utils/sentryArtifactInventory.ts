/** Application-owned build contract. These records never contain filesystem roots or map content. */
export const SENTRY_INVENTORY_FILE = 'sentry-artifact-inventory.json';
export const SENTRY_INVENTORY_PAYLOAD_ID = 'sentry-artifact-inventory';
export const SENTRY_INVENTORY_MAX_BYTES = 256 * 1024;
export const SENTRY_INVENTORY_MAX_ARTIFACTS = 1024;
export const SENTRY_DEBUG_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SENTRY_TARGET_PREFIXES = {
  main: 'dist-electron/main/',
  renderer: 'out/renderer/',
  preload: 'dist-electron/preload/',
} as const;

export type SentryArtifactTarget = keyof typeof SENTRY_TARGET_PREFIXES;
export type SentryBuildIdentity = Readonly<{ release: string; buildId: string; gitSha: string }>;
export type SentryRuntimeArtifact = Readonly<{
  target: SentryArtifactTarget;
  relativeFile: string;
  locator: string;
  debugId: string;
}>;
export type SentryRuntimeInventory = SentryBuildIdentity &
  Readonly<{
    schemaVersion: 1;
    artifacts: readonly SentryRuntimeArtifact[];
    coverage: Readonly<Record<SentryArtifactTarget, 'covered' | 'uncovered'>>;
  }>;

export function isSentryArtifactFile(value: string): boolean {
  return (
    value.length <= 512 &&
    /^[A-Za-z0-9_./-]+\.(?:js|cjs|mjs)$/.test(value) &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function identityToken(value: unknown, allowEmpty: boolean): value is string {
  return (
    typeof value === 'string' &&
    ((allowEmpty && value === '') || /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,159}$/.test(value))
  );
}

/** Bounded, strict and fail-closed. Copy/freeze admitted data rather than retaining untrusted objects. */
export function parseSentryArtifactInventory(
  json: string,
  expected: SentryBuildIdentity
): SentryRuntimeInventory | null {
  if (
    json.length > SENTRY_INVENTORY_MAX_BYTES ||
    new TextEncoder().encode(json).length > SENTRY_INVENTORY_MAX_BYTES
  )
    return null;
  try {
    const value: unknown = JSON.parse(json);
    if (
      !object(value) ||
      !exactKeys(value, [
        'schemaVersion',
        'release',
        'buildId',
        'gitSha',
        'artifacts',
        'coverage',
      ]) ||
      value.schemaVersion !== 1 ||
      !identityToken(value.release, false) ||
      !identityToken(value.buildId, true) ||
      typeof value.gitSha !== 'string' ||
      (value.gitSha !== '' && !/^[0-9a-f]{40}$/.test(value.gitSha)) ||
      value.release !== expected.release ||
      value.buildId !== expected.buildId ||
      value.gitSha !== expected.gitSha ||
      !object(value.coverage) ||
      !exactKeys(value.coverage, ['main', 'renderer', 'preload']) ||
      !Array.isArray(value.artifacts) ||
      value.artifacts.length > SENTRY_INVENTORY_MAX_ARTIFACTS
    )
      return null;
    const coverage = value.coverage;
    if (Object.values(coverage).some((status) => status !== 'covered' && status !== 'uncovered'))
      return null;
    if (Object.values(coverage).includes('covered') && (!value.buildId || !value.gitSha))
      return null;
    const artifacts: SentryRuntimeArtifact[] = [];
    let previous = '';
    for (const row of value.artifacts) {
      if (
        !object(row) ||
        !exactKeys(row, ['target', 'relativeFile', 'locator', 'debugId']) ||
        typeof row.target !== 'string' ||
        !Object.hasOwn(SENTRY_TARGET_PREFIXES, row.target) ||
        typeof row.relativeFile !== 'string' ||
        !isSentryArtifactFile(row.relativeFile) ||
        typeof row.locator !== 'string' ||
        row.locator !== `app:///${row.relativeFile}` ||
        typeof row.debugId !== 'string' ||
        !SENTRY_DEBUG_ID_PATTERN.test(row.debugId)
      )
        return null;
      const target = row.target as SentryArtifactTarget;
      if (
        coverage[target] !== 'covered' ||
        !row.relativeFile.startsWith(SENTRY_TARGET_PREFIXES[target]) ||
        row.locator <= previous
      )
        return null;
      previous = row.locator;
      artifacts.push(
        Object.freeze({
          target,
          relativeFile: row.relativeFile,
          locator: row.locator,
          debugId: row.debugId,
        })
      );
    }
    if (
      Object.keys(SENTRY_TARGET_PREFIXES).some(
        (target) =>
          coverage[target] === 'covered' && !artifacts.some((row) => row.target === target)
      )
    )
      return null;
    return Object.freeze({
      schemaVersion: 1,
      release: value.release,
      buildId: value.buildId,
      gitSha: value.gitSha,
      artifacts: Object.freeze(artifacts),
      coverage: Object.freeze({
        main: coverage.main,
        renderer: coverage.renderer,
        preload: coverage.preload,
      }),
    }) as SentryRuntimeInventory;
  } catch {
    return null;
  }
}
