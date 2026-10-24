import { CapturedCodexAuthCommands } from './CapturedCodexAuthCommands';
import { projectCapturedCodexCatalog } from './capturedCodexCatalog';
import { readCapturedCodexMetadata } from './capturedCodexMetadata';

import type { CodexAuthIntentStore } from '../../infrastructure/FileCodexAuthIntentStore';
import type { CaptureCodexMetadata, CapturedCodexMetadata } from './capturedCodexMetadata';
import type {
  CodexAccountAuthMode,
  CodexAccountPlanType,
  CodexAccountSnapshotDto,
} from '@features/codex-account/contracts';
import type { CodexAccountFeatureFacade } from '@features/codex-account/main';
import type { CodexModelCatalogFeatureFacade } from '@features/codex-model-catalog/main';

const unavailable = 'This action is not integrated with the captured Codex Host yet.';
const knownPlans: CodexAccountPlanType[] = [
  'free',
  'go',
  'plus',
  'pro',
  'team',
  'business',
  'enterprise',
  'edu',
];

function account(
  value: CapturedCodexMetadata,
  preferredAuthMode: CodexAccountAuthMode
): CodexAccountSnapshotDto {
  const native = value.account;
  const managedAccount = native
    ? native.type === 'apiKey'
      ? { type: 'api_key' as const, email: null, planType: null }
      : {
          type: 'chatgpt' as const,
          email: native.email,
          planType: knownPlans.includes(native.planType as CodexAccountPlanType)
            ? (native.planType as CodexAccountPlanType)
            : ('unknown' as const),
        }
    : null;
  return {
    preferredAuthMode,
    effectiveAuthMode: native ? (native.type === 'apiKey' ? 'api_key' : 'chatgpt') : null,
    // Account observation does not qualify the still-pending ordinary Desktop launch path.
    launchAllowed: false,
    launchReadinessState: 'incompatible',
    launchIssueMessage: unavailable,
    appServerState: 'healthy',
    appServerStatusMessage: null,
    managedAccount,
    apiKey: { available: native?.type === 'apiKey', source: null, sourceLabel: null },
    requiresOpenaiAuth: value.requiresOpenaiAuth,
    login: { status: 'idle', error: null, startedAt: null },
    rateLimits: value.rateLimits?.snapshot
      ? {
          ...value.rateLimits.snapshot,
          planType: knownPlans.includes(value.rateLimits.snapshot.planType as CodexAccountPlanType)
            ? (value.rateLimits.snapshot.planType as CodexAccountPlanType)
            : 'unknown',
        }
      : null,
    updatedAt: new Date().toISOString(),
  };
}

/** Existing Desktop account/catalog facades over a captured native Host, without ambient CLI fallback. */
export function createCapturedCodexFeatures(
  capture: CaptureCodexMetadata,
  intents?: CodexAuthIntentStore,
  preferredAuthMode: () => CodexAccountAuthMode = () => 'auto'
) {
  const auth = intents ? new CapturedCodexAuthCommands(capture, intents) : undefined;
  let disposed = false;
  const assertActive = () => {
    if (disposed) throw new Error('Captured Codex feature is disposed.');
  };
  const read = async (projectPath: string | null, models: boolean, rates = false) => {
    assertActive();
    const result = await readCapturedCodexMetadata(capture, projectPath, models, rates);
    assertActive();
    return result;
  };
  const unsupported = async (): Promise<never> => {
    assertActive();
    throw new Error(unavailable);
  };
  const present = (value: CapturedCodexMetadata) => {
    const mode = preferredAuthMode();
    if (!['auto', 'chatgpt', 'api_key'].includes(mode))
      throw new Error('Invalid Codex authentication preference.');
    return account(value, mode);
  };
  const accountFeature: CodexAccountFeatureFacade = {
    async getSnapshot() {
      return present((await read(null, false)).value);
    },
    getCachedSnapshot: () => null,
    async refreshSnapshot(options) {
      // The captured Host owns runtime selection; an ambient binary override cannot retarget it.
      if (options?.binaryPathOverride)
        throw new Error('Select a captured Codex profile to change its executable.');
      if (options?.forceRefreshToken) {
        assertActive();
        if (!auth) return unsupported();
        const target = await auth.execute('credential.refresh');
        assertActive();
        return present(
          (
            await readCapturedCodexMetadata(
              async () => target,
              null,
              false,
              options.includeRateLimits === true
            )
          ).value
        );
      }
      return present((await read(null, false, options?.includeRateLimits === true)).value);
    },
    startChatgptLogin: unsupported,
    cancelLogin: unsupported,
    async logout() {
      assertActive();
      if (!auth) return unsupported();
      const target = await auth.execute('credential.forget');
      assertActive();
      return present(
        (await readCapturedCodexMetadata(async () => target, null, false, true)).value
      );
    },
    subscribe: () => () => {},
    setMainWindow: () => {},
    async getLaunchReadiness() {
      const snapshot = await accountFeature.getSnapshot();
      return {
        state: snapshot.launchReadinessState,
        launchAllowed: snapshot.launchAllowed,
        effectiveAuthMode: snapshot.effectiveAuthMode,
        issueMessage: snapshot.launchIssueMessage,
      };
    },
    async dispose() {
      disposed = true;
    },
  };
  const modelCatalogFeature: CodexModelCatalogFeatureFacade = {
    async getCatalog(options = {}) {
      // Profile selection is trusted composition data, never a caller-owned native override.
      if (options.profile)
        throw new Error('Select a captured Codex profile before reading its catalog.');
      const { value } = await read(options.cwd ?? null, true);
      return projectCapturedCodexCatalog(value, options.includeHidden === true);
    },
    invalidate: () => {},
    async dispose() {
      disposed = true;
    },
  };
  return { accountFeature, modelCatalogFeature };
}
