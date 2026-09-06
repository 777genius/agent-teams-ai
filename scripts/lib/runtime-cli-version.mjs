const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/**
 * Release identity remains lock.version plus the pinned archive checksum.
 * --version may report a separate Claude compatibility version.
 */
export function getExpectedRuntimeCliVersion(runtimeLock) {
  const field = Object.hasOwn(runtimeLock, 'cliVersion') ? 'cliVersion' : 'version';
  const value = runtimeLock[field];
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value.trim())) {
    throw new Error(`runtime.lock.json ${field} must be a version such as 0.0.79 or 2.1.251`);
  }
  return value.trim();
}

export function matchesRuntimeCliVersion(versionText, expectedVersion) {
  return (
    typeof versionText === 'string' && versionText.trim().split(/\s+/u, 1)[0] === expectedVersion
  );
}
