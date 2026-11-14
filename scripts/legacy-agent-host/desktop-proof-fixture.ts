import { prepareDesktopOwnerRoutingSource } from './desktop-owner-routing-fixture.ts';
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
import { prepareDesktopCodexResumeFixture } from './desktop-codex-resume-fixture.ts';
import { prepareControlledProcessFixture } from './desktop-controlled-process-fixture.ts';
import { reserveMixedOpenCodeEndpoint } from './desktop-mixed-native-fixture.ts';
import { prepareDesktopScheduleFixture } from './desktop-schedule-fixture.ts';
import { prepareDesktopNativeCommandsFixture } from './desktop-native-commands-fixture.ts';
import { prepareDesktopClaudeCheckpointUpgrade, type DesktopClaudeCheckpointUpgrade } from './desktop-claude-checkpoint-upgrade.ts';

import { prepareDesktopNativeExtensionConsumptionFixture } from './desktop-native-extension-consumption-fixture.ts';

/** TEST fixture composition; no app or provider process starts here. */
export async function prepareDesktopProofFixture(
  repo: string,
  mode: string,
  pnpm: string,
  options: {
    candidateRuntime?: CandidateRuntimePaths;
    processUiMode?: boolean;
    controlledProcessMode?: boolean;
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
    codexResumeMode?: boolean;
    openCodeLifecycleMode?: boolean;
    capturedMcpNonce?: string;
  }
): Promise<
  Awaited<ReturnType<typeof prepareDesktopBackendFixture>> & {
    activitySource?: CapturedActivitySource;
    claudeCheckpointUpgrade?: DesktopClaudeCheckpointUpgrade;
    codexResume?: Awaited<ReturnType<typeof prepareDesktopCodexResumeFixture>>['codexResume'];
    openCodeV2?: { model: string; modelId: string; displayName: string };
    controlledProcess?: Awaited<ReturnType<typeof prepareControlledProcessFixture>>['controlledProcess'];
  }
> {
  const donorSavedOnly = process.env.LEGACY_DESKTOP_DONOR_SAVED_ONLY === '1';
  if (donorSavedOnly) {
    assert.equal(mode, 'stopped-import-ui');
    assert.ok(options.legacyImportMode && options.modelUrl && !options.candidateRuntime &&
      !options.openCodeLifecycleMode && !options.codexResumeMode && !options.readbackMode &&
      !options.reviewReadbackMode && !options.nativeReviewReadbackMode && !options.nativeReviewContinuationMode &&
      !options.controlledProcessMode && !options.processUiMode && !options.processReadbackMode && !options.capturedMcpNonce);
    assert.equal(process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH ?? '', '');
  }
  if (process.env.LEGACY_DESKTOP_CLAUDE_CHECKPOINT_UPGRADE === '1') {
    assert.equal(mode, 'native-resume-ui');
    assert.ok(options.modelUrl && options.launchDialogMode && !options.codexResumeMode &&
      !options.openCodeLifecycleMode && !options.candidateRuntime && !options.capturedMcpNonce);
    for (const key of ['LEGACY_DESKTOP_COMMANDS_UI', 'LEGACY_DESKTOP_SCHEDULE_UI',
      'LEGACY_DESKTOP_EXTENSIONS_CONSUMPTION_UI', 'LEGACY_DESKTOP_DIAGNOSTIC_HOST_ENTRY',
      'LEGACY_DESKTOP_CODEX_PATH'])
      assert.ok(!process.env[key], 'checkpoint upgrade has only the original Claude source');
    return prepareDesktopClaudeCheckpointUpgrade(repo, pnpm, options.modelUrl);
  }
  if (options.capturedMcpNonce !== undefined) {
    assert.equal(mode, 'native-launch-ui');
    assert.ok(options.openCodeLifecycleMode && !options.candidateRuntime && options.modelUrl);
    assert.equal(process.env.LEGACY_DESKTOP_OPENCODE_MCP_UI, '1');
  }
  if (process.env.LEGACY_DESKTOP_EXTENSIONS_CONSUMPTION_UI === '1') {
    assert.equal(mode, 'native-launch-ui');
    assert.notEqual(process.env.LEGACY_DESKTOP_SCHEDULE_UI, '1');
    assert.notEqual(process.env.LEGACY_DESKTOP_COMMANDS_UI, '1');
    assert.ok(options.modelUrl && !options.candidateRuntime);
    return prepareDesktopNativeExtensionConsumptionFixture(repo, pnpm, options.modelUrl);
  }
  if (process.env.LEGACY_DESKTOP_COMMANDS_UI === '1') {
    assert.equal(mode, 'native-launch-ui');
    assert.notEqual(process.env.LEGACY_DESKTOP_SCHEDULE_UI, '1');
    assert.ok(options.modelUrl && !options.candidateRuntime);
    return prepareDesktopNativeCommandsFixture(repo, pnpm, options.modelUrl);
  }
  if (process.env.LEGACY_DESKTOP_SCHEDULE_UI === '1') {
    assert.equal(mode, 'native-launch-ui');
    assert.ok(options.modelUrl && !options.candidateRuntime);
    return prepareDesktopScheduleFixture(repo, pnpm, options.modelUrl);
  }
  if (options.controlledProcessMode) {
    assert.equal(mode, 'process-cold-ui');
    return prepareControlledProcessFixture(repo, pnpm, options.candidateRuntime);
  }
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
        ...(options.openCodeLifecycleMode ? { openCodeGeneration: 'v2' as const } : {}),
        nativeReviewContinuation: options.nativeReviewContinuationMode,
      }
    );
  const selectedV2 = options.openCodeLifecycleMode ? {
    bunPath: process.env.OPENCODE_V2_EMBEDDED_BUN!, bunSha256: process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256!,
    engineDirectory: process.env.OPENCODE_V2_EMBEDDED_GRAPH!, modelUrl: options.modelUrl!,
    imageInput: mode === 'native-conversation-ui' && process.env.LEGACY_DESKTOP_CHAT_ATTACHMENTS === '1',
    endpoint: await reserveMixedOpenCodeEndpoint(), managementEndpoint: await reserveMixedOpenCodeEndpoint(),
    processCustody: { directory: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_DIRECTORY!,
      manifestSha256: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_MANIFEST_SHA256! },
  } : undefined;
  const fixture = await prepareDesktopBackendFixture(repo, {
    ...(donorSavedOnly ? { donorSavedOnly: true as const } : {}),
    ...(selectedV2 ? { nativeOpenCodeV2: selectedV2 } : {}),
    ...(options.nativeStopMode ? { configuredLaunchSetup: true as const } : {}),
    ...(options.capturedMcpNonce ? { capturedMcpNonce: options.capturedMcpNonce } : {}),
    ...(options.candidateRuntime ? { candidateRuntime: options.candidateRuntime } : {}),
    ...(process.env.LEGACY_DESKTOP_DIAGNOSTIC_HOST_ENTRY
      ? {
          diagnosticHostEntry: {
            path: process.env.LEGACY_DESKTOP_DIAGNOSTIC_HOST_ENTRY,
            sha256: process.env.LEGACY_DESKTOP_HOST_ENTRY_SHA256!,
          },
        }
      : {}),
    seedUiTask: options.uiMode && !options.codexResumeMode,
    ...(['task-board-ui', 'task-board-cross-team-ui'].includes(mode)
      ? { taskBoardGroup: true }
      : {}),
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
    ...(!selectedV2 && !options.candidateRuntime &&
    process.env.LEGACY_DESKTOP_CODEX_PATH &&
    mode !== 'native-mixed-create-launch-ui'
      ? {
          nativeCodex: {
            path: process.env.LEGACY_DESKTOP_CODEX_PATH,
            sha256: '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57',
          },
        }
      : {}),
    ...(!selectedV2 && (options.nativeStopMode ||
    options.launchDialogMode ||
    options.createConfigMode ||
    options.legacyImportMode)
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
  if (selectedV2) return { ...fixture,
    openCodeV2: { model: 'test-local/TEST-model', modelId: 'TEST-model', displayName: 'TEST-model' } };
  if (options.codexResumeMode) {
    assert.equal(mode, 'native-resume-ui');
    assert.ok(options.modelUrl && process.env.LEGACY_DESKTOP_CODEX_PATH);
    return prepareDesktopCodexResumeFixture(fixture, {
      executable: process.env.LEGACY_DESKTOP_CODEX_PATH,
      modelUrl: options.modelUrl,
    });
  }
  if (mode === 'skills-ui') return prepareDesktopSkillsFixture(fixture);
  if (mode === 'task-board-cross-team-ui' || mode === 'cross-team-ui') {
    const overlay = await prepareDesktopCrossTeamUiFixture(fixture.root);
    Object.assign(fixture.appEnvironment, overlay.appEnvironment);
    Object.assign(fixture.pins, overlay.pins);
  }
  if (mode === 'native-extensions-ui') return prepareDesktopNativeExtensionsFixture(fixture);
  return mode === 'task-board-cross-team-ui' ? prepareDesktopOwnerRoutingSource(fixture) : fixture;
}
