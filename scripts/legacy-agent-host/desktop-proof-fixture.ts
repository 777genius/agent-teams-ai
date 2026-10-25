import { prepareDesktopNativeExtensionsFixture } from './desktop-native-extensions-fixture.ts';
import { prepareDesktopSkillsFixture } from './desktop-skills-fixture.ts';
import type { CandidateRuntimePaths } from './candidate-runtime-paths.ts';
import type { CapturedActivitySource } from './desktop-activity-readback-fixture.ts';
import { prepareDesktopCapturedActivityReadback } from './desktop-activity-readback-fixture.ts';
import assert from 'node:assert/strict';
import { prepareProcessFixture } from './desktop-native-process-fixture.ts';
import { prepareDesktopCrossTeamUiFixture } from './desktop-cross-team-ui-smoke.ts';
import { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { readSavedDesktopFixture } from './desktop-readback-fixture.ts';

/** TEST fixture composition; no app or provider process starts here. */
export async function prepareDesktopProofFixture(
  repo: string,
  mode: string,
  pnpm: string,
  options: {
    candidateRuntime?: CandidateRuntimePaths;
    processUiMode?: boolean;
    processReadbackMode?: boolean;
    approvalUiMode?: boolean;
    nativeReviewMode?: boolean;
    nativeReviewReadbackMode?: boolean;
    nativeReviewContinuationMode?: boolean;
    readbackMode: boolean;
    reviewReadbackMode: boolean;
    reviewUiMode: boolean;
    legacyImportMode: boolean;
    uiMode: boolean;
    launchDialogMode: boolean;
    createConfigMode: boolean;
    nativeStopMode: boolean;
    modelUrl?: string;
  }
): Promise<
  Awaited<ReturnType<typeof prepareDesktopBackendFixture>> & {
    activitySource?: CapturedActivitySource;
  }
> {
  if (mode === 'native-activity-readback-ui') {
    const { fixture, source } = await prepareDesktopCapturedActivityReadback(
      repo,
      pnpm,
      process.env.LEGACY_DESKTOP_ACTIVITY_SOURCE_ROOT!
    );
    return { ...fixture, activitySource: source };
  }
  if (options.processUiMode) {
    assert.equal(mode, 'native-process-ui');
    if (options.processReadbackMode) return readSavedDesktopFixture(
      process.env.LEGACY_DESKTOP_READBACK_ROOT!,
      process.env.LEGACY_DESKTOP_READBACK_RECEIPT_SHA256!, { nativeProcess: true }
    );
    assert.ok(options.modelUrl, 'one original finite localhost process model');
    return prepareProcessFixture(repo, {
      pnpmEntry: pnpm,
      nativeClaude: {
        path: process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
        sha256: 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f',
        modelUrl: options.modelUrl,
      },
    });
  }
  if (options.readbackMode || options.reviewReadbackMode || options.nativeReviewReadbackMode)
    return readSavedDesktopFixture(
      process.env.LEGACY_DESKTOP_READBACK_ROOT!,
      process.env.LEGACY_DESKTOP_READBACK_RECEIPT_SHA256!,
      {
        review: options.reviewReadbackMode,
        nativeQuit: mode === 'native-quit-readback-ui',
        nativeReview: options.nativeReviewReadbackMode,
        nativeReviewContinuation: options.nativeReviewContinuationMode,
      }
    );
  const fixture = await prepareDesktopBackendFixture(repo, {
    ...(options.candidateRuntime ? { candidateRuntime: options.candidateRuntime } : {}),
    ...(process.env.LEGACY_DESKTOP_DIAGNOSTIC_HOST_ENTRY
      ? {
          diagnosticHostEntry: {
            path: process.env.LEGACY_DESKTOP_DIAGNOSTIC_HOST_ENTRY,
            sha256: process.env.LEGACY_DESKTOP_HOST_ENTRY_SHA256!,
          },
        }
      : {}),
    seedUiTask: options.uiMode,
    approvalUi: options.approvalUiMode,
    ...(mode === 'native-conversation-ui' && process.env.LEGACY_DESKTOP_CHAT_ATTACHMENTS === '1'
      ? { nativeChatAttachments: true }
      : {}),
    ...(mode === 'native-conversation-ui' && process.env.LEGACY_DESKTOP_GROUP_CHATS === '1'
      ? { nativeGroupChats: true }
      : {}),
    reviewUi: options.reviewUiMode,
    nativeReviewUi: options.nativeReviewMode,
    stoppedImportUi: options.legacyImportMode,
    launchDialog: options.launchDialogMode || options.createConfigMode || options.legacyImportMode,
    creation: options.createConfigMode || options.legacyImportMode,
    pnpmEntry: pnpm,
    seedCodexApiKey: mode === 'codex-account-auth',
    ...(!options.candidateRuntime &&
    process.env.LEGACY_DESKTOP_CODEX_PATH &&
    mode !== 'native-mixed-create-launch-ui'
      ? {
          nativeCodex: {
            path: process.env.LEGACY_DESKTOP_CODEX_PATH,
            sha256: '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57',
          },
        }
      : {}),
    ...(options.nativeStopMode ||
    options.launchDialogMode ||
    options.createConfigMode ||
    options.legacyImportMode
      ? {
          nativeClaude: {
            path:
              options.candidateRuntime?.claudeExecutable ?? process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
            sha256: 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f',
            ...(options.modelUrl ? { modelUrl: options.modelUrl } : {}),
          },
        }
      : {}),
  });
  if (mode === 'skills-ui') return prepareDesktopSkillsFixture(fixture);
  if (mode === 'task-board-cross-team-ui' || mode === 'cross-team-ui') {
    const overlay = await prepareDesktopCrossTeamUiFixture(fixture.root);
    Object.assign(fixture.appEnvironment, overlay.appEnvironment);
    Object.assign(fixture.pins, overlay.pins);
  }
  if (mode === 'native-extensions-ui') return prepareDesktopNativeExtensionsFixture(fixture);
  return fixture;
}
