export function isReviewedWindowsTargetVersion(version: string) {
  return version === '2.17.6' || version === '2.17.10';
}

export function isWindowsOtaMode(mode: string) {
  return mode === 'full' || mode === 'cold' || mode === 'warm';
}

interface FinalWindowsProof {
  architecture: string;
  mode: string;
  targetVersion: string;
  legacyFixture: boolean;
  plan?: { input: { target: { tag: string; id: number } } };
  stagedMetadata?: { releaseId: number };
  passed: boolean;
  freshInstallProved: boolean;
  fullOtaProved: boolean;
}

// The caller supplies verified plan/feed bindings only after the native scenario succeeds.
export function finalWindowsReleaseProved(value: FinalWindowsProof) {
  const target = value.plan?.input.target;
  return (
    (value.architecture === 'x64' || value.architecture === 'arm64') &&
    isReviewedWindowsTargetVersion(value.targetVersion) &&
    value.legacyFixture === false &&
    target?.tag === `v${value.targetVersion}` &&
    target.id === value.stagedMetadata?.releaseId &&
    value.passed === true &&
    (value.mode === 'fresh'
      ? value.freshInstallProved === true
      : isWindowsOtaMode(value.mode) && value.fullOtaProved === true)
  );
}
