import {
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  setClaudeBasePathOverride,
} from '@main/utils/pathDecoder';

interface HarnessPathOverrideLease {
  token: symbol;
  claudeRoot: string;
  previousClaudeBasePathOverride: string | null;
}

let activePathOverrideLease: HarnessPathOverrideLease | null = null;

export function assertCanApplyPathOverride(): void {
  if (!activePathOverrideLease) {
    return;
  }

  throw new Error(
    `TeamProvisioningHarnessBuilder already owns a Claude path override for ${activePathOverrideLease.claudeRoot}; clean up the active harness before building another override-backed harness.`
  );
}

export function applyHarnessPathOverride(claudeRoot: string): () => void {
  assertCanApplyPathOverride();

  const previousClaudeBasePath = getClaudeBasePath();
  const previousClaudeBasePathOverride =
    previousClaudeBasePath === getAutoDetectedClaudeBasePath() ? null : previousClaudeBasePath;
  const token = Symbol('TeamProvisioningHarnessPathOverride');
  setClaudeBasePathOverride(claudeRoot);
  activePathOverrideLease = {
    token,
    claudeRoot,
    previousClaudeBasePathOverride,
  };

  return () => {
    if (activePathOverrideLease?.token !== token) {
      throw new Error('TeamProvisioningHarnessBuilder path override cleanup is not active.');
    }

    activePathOverrideLease = null;
    setClaudeBasePathOverride(previousClaudeBasePathOverride);
  };
}
