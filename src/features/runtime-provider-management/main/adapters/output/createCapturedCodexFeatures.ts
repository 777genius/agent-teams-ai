import {
  CodexAccountSnapshotPresenter,
  evaluateCodexLaunchReadiness,
} from '@features/codex-account/main';

import { CapturedCodexAuthCommands } from './CapturedCodexAuthCommands';
import { projectCapturedCodexCatalog } from './capturedCodexCatalog';
import { CapturedCodexLogin } from './CapturedCodexLogin';
import { readCapturedCodexMetadata } from './capturedCodexMetadata';

import type { CodexAuthIntentStore } from '../../infrastructure/FileCodexAuthIntentStore';
import type { CaptureCodexMetadata, CapturedCodexMetadata } from './capturedCodexMetadata';
import type { CapturedProviderManagement } from '@features/agent-backend/main';
import type {
  CodexAccountAuthMode,
  CodexAccountPlanType,
  CodexAccountSnapshotDto,
  CodexLoginStateDto,
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
  preferredAuthMode: CodexAccountAuthMode,
  login: CodexLoginStateDto
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
  const apiKey = value.apiKey ?? {
    available: native?.type === 'apiKey',
    source: null,
    sourceLabel: null,
  };
  const readiness = evaluateCodexLaunchReadiness({
    preferredAuthMode,
    managedAccount,
    apiKey,
    appServerState: 'healthy',
    appServerStatusMessage: null,
  });
  return {
    preferredAuthMode,
    // This preserves the account/auth gate. The selected model still has its own launch preflight.
    effectiveAuthMode: readiness.effectiveAuthMode,
    launchAllowed: readiness.launchAllowed,
    launchReadinessState: readiness.state,
    launchIssueMessage: readiness.issueMessage,
    appServerState: 'healthy',
    appServerStatusMessage: null,
    managedAccount,
    apiKey,
    requiresOpenaiAuth: value.requiresOpenaiAuth,
    login,
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
  preferredAuthMode: () => CodexAccountAuthMode = () => 'auto',
  restore: (targetId: string, contextId: string) => Promise<CapturedProviderManagement> = async (
    targetId,
    contextId
  ) => {
    const target = await capture(null);
    if (target.targetId !== targetId || target.originalContextId !== contextId)
      throw new Error('The original Codex profile is unavailable.');
    return target;
  }
) {
  const auth = intents ? new CapturedCodexAuthCommands(capture, intents) : undefined;
  const presenter = new CodexAccountSnapshotPresenter();
  const listeners = new Set<(snapshot: CodexAccountSnapshotDto) => void>();
  let cached: { target: CapturedProviderManagement; snapshot: CodexAccountSnapshotDto } | undefined;
  let disposed = false;
  let starting: Promise<CodexAccountSnapshotDto> | undefined;
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
  const mode = () => {
    const mode = preferredAuthMode();
    if (!['auto', 'chatgpt', 'api_key'].includes(mode))
      throw new Error('Invalid Codex authentication preference.');
    return mode;
  };
  const publish = (target: CapturedProviderManagement, snapshot: CodexAccountSnapshotDto) => {
    assertActive();
    if (!target.isCurrent()) throw new Error('The original Codex profile is unavailable.');
    cached = { target, snapshot };
    presenter.publish(snapshot);
    for (const listener of listeners) {
      try {
        listener(structuredClone(snapshot));
      } catch {
        /* A renderer listener cannot change login ownership. */
      }
    }
    return structuredClone(snapshot);
  };
  const login: CapturedCodexLogin | undefined = intents
    ? new CapturedCodexLogin(intents, restore, (target, settled) => {
        void capture(null)
          .then(async (foreground) => {
            if (disposed || target.targetId !== foreground.targetId || !foreground.isCurrent())
              return;
            if (cached?.target.targetId === foreground.targetId)
              publish(foreground, {
                ...cached.snapshot,
                login: login!.state(foreground),
                updatedAt: new Date().toISOString(),
              });
            if (settled) await readAccount(foreground, true);
          })
          .catch(() => {});
      })
    : undefined;
  const readAccount = async (
    target: CapturedProviderManagement,
    rates = false
  ): Promise<CodexAccountSnapshotDto> => {
    assertActive();
    await login?.observe(target);
    const { value } = await readCapturedCodexMetadata(async () => target, null, false, rates);
    return publish(
      target,
      account(
        value,
        mode(),
        login?.state(target) ?? { status: 'idle', error: null, startedAt: null }
      )
    );
  };
  const presentPending = (target: CapturedProviderManagement) => {
    const previous = cached?.target.targetId === target.targetId ? cached.snapshot : undefined;
    const snapshot: CodexAccountSnapshotDto = {
      preferredAuthMode: mode(),
      effectiveAuthMode: null,
      launchAllowed: false,
      launchReadinessState: 'missing_auth',
      launchIssueMessage: 'Account verification is in progress.',
      appServerState: 'degraded',
      appServerStatusMessage: null,
      managedAccount: null,
      apiKey: { available: false, source: null, sourceLabel: null },
      requiresOpenaiAuth: null,
      rateLimits: null,
      ...previous,
      login: login!.state(target),
      updatedAt: new Date().toISOString(),
    };
    const preferred = mode();
    const readiness = evaluateCodexLaunchReadiness({ ...snapshot, preferredAuthMode: preferred });
    return publish(target, {
      ...snapshot,
      preferredAuthMode: preferred,
      effectiveAuthMode: readiness.effectiveAuthMode,
      launchAllowed: readiness.launchAllowed,
      launchReadinessState: readiness.state,
      launchIssueMessage: readiness.issueMessage,
    });
  };
  const accountFeature: CodexAccountFeatureFacade = {
    async getSnapshot() {
      const target = await capture(null);
      await login?.observe(target);
      if (
        cached?.target.targetId === target.targetId &&
        ['starting', 'pending'].includes(login?.state(target).status ?? '')
      )
        return presentPending(target);
      return readAccount(target);
    },
    // A synchronous cache cannot witness a newly selected immutable source revision.
    // The existing async API/subscriptions recapture its exact target before presentation.
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
        return readAccount(target, options.includeRateLimits === true);
      }
      return readAccount(await capture(null), options?.includeRateLimits === true);
    },
    startChatgptLogin(options) {
      assertActive();
      if (!login) return unsupported();
      if (starting) return starting;
      const pending = (async () => {
        const target = await capture(null);
        presentPending(target);
        await login.start(target, options?.mode ?? 'browser');
        return presentPending(target);
      })();
      starting = pending;
      void pending
        .finally(() => {
          if (starting === pending) starting = undefined;
        })
        .catch(() => {});
      return pending;
    },
    async cancelLogin() {
      assertActive();
      if (!login) return unsupported();
      await starting?.catch(() => {});
      await login.cancel();
      return readAccount(await capture(null), true);
    },
    async logout() {
      assertActive();
      if (!auth) return unsupported();
      const original = await capture(null);
      await starting?.catch(() => {});
      await login?.cancel();
      const target = await auth.execute('credential.forget', original);
      assertActive();
      return readAccount(target, true);
    },
    subscribe(listener) {
      assertActive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setMainWindow: (window) => presenter.setMainWindow(window),
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
      listeners.clear();
      cached = undefined;
      presenter.setMainWindow(null);
      await starting?.catch(() => {});
      await login?.dispose();
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
