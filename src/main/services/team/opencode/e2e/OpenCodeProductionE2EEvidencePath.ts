import { join, resolve } from 'path';

export const OPENCODE_PRODUCTION_E2E_EVIDENCE_PATH_ENV =
  'CLAUDE_TEAM_OPENCODE_PRODUCTION_E2E_EVIDENCE_PATH';

export const OPENCODE_PRODUCTION_E2E_EVIDENCE_FILE = 'production-e2e-evidence.json';

export function resolveOpenCodeProductionE2EEvidencePath(input: {
  bridgeControlDir: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = input.env ?? process.env;
  const overridePath = env[OPENCODE_PRODUCTION_E2E_EVIDENCE_PATH_ENV]?.trim();

  if (overridePath) {
    return resolve(overridePath);
  }

  return join(input.bridgeControlDir, OPENCODE_PRODUCTION_E2E_EVIDENCE_FILE);
}
