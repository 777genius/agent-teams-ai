import { runDesktopOwnerRoutingContinuation } from './desktop-owner-routing-ui-smoke.ts';
import { runDesktopScheduleUiProof } from './desktop-schedule-ui-proof.ts';
import type { DesktopOwnerRoutingContinuation } from './desktop-owner-routing-ui-smoke.ts';
import { verifyNativeProcessReadbackSource } from './desktop-native-process-readback.ts';
import { connectCapturedDesktopApp, restartCapturedDesktopApp, observePackedAppRelaunch, verifyCapturedDesktopBinding, cleanupCapturedDesktopApp } from './desktop-captured-app.ts';
import type { DesktopCdpPort as CdpPort, DesktopCdpLibrary as CdpLibrary } from './desktop-captured-app.ts';
import { observeDesktopStartup, requestObservedDesktopClose } from './startup-passive-observer.ts';
import { runDesktopNativeExtensionsUiSmoke } from './desktop-native-extensions-ui-smoke.ts';
import { isSkillsMetadataRefusal } from './desktop-skills-fixture.ts';
import { readCapturedCandidateElectron } from './candidate-electron.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { runDesktopCodexAccountProof } from './desktop-codex-account-proof.ts';
import { runDesktopActivityUiSmoke, finalizeDesktopActivityReadback } from './desktop-activity-ui-smoke.ts';
import { processFixtureBashCommand } from './desktop-native-process-fixture.ts';
import { qualifyPreparedProcessRegistration } from './desktop-native-process-host.ts';
import { qualifyColdProcessUi } from './desktop-native-process-ui.ts';
import type { prepareControlledProcessFixture } from './desktop-controlled-process-fixture.ts';
import assert from 'node:assert/strict';
import { runDesktopNativeQuitMode, verifyDesktopNativeQuitAfterShutdown, capturePendingDesktopNativeQuit } from './desktop-native-quit-ui-smoke.ts';
import { prepareDesktopMixedNativeFixture, reserveMixedOpenCodeEndpoint } from './desktop-mixed-native-fixture.ts';
import { runDesktopMixedCreateLaunchUiSmoke } from './desktop-mixed-create-launch-ui-smoke.ts';
import type { DesktopMixedModels } from './desktop-mixed-native-fixture.ts';
import { desktopProofEvidence } from './desktop-proof-evidence.ts';
import { runDesktopNativeReview } from './desktop-native-review-compose.ts';
import { desktopReadbackArtifacts, runDesktopNativeReadback } from './desktop-readback-fixture.ts';
import { assertCapturedDesktopMetadataAbsent, observeDesktopMetadataClose, captureDesktopOpenCodeV2ColdMetadata } from './desktop-opencode-v2-cold-metadata.ts';
import { readDesktopMetadataLineageFailure } from './desktop-opencode-metadata-lineage.ts';
import { prepareDesktopProofFixture } from './desktop-proof-fixture.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';
import { captureDesktopCodexNativeInputs, captureDesktopSourceHashes, verifyDesktopNativeFreeze, verifyDesktopPackedFreeze, verifyDesktopSourceFreeze } from './desktop-source-freeze.ts';
import { runDesktopF08ReadTimingProof, runDesktopHostRoutingProof } from './desktop-host-routing-proof.ts';
import { startDesktopCodexQuestionModel } from './desktop-codex-question-model.ts';
import { prepareDesktopCodexQuestionFixture, prepareDesktopCodexQuestionLaunch, waitDesktopCodexQuestionRenderer } from './desktop-codex-question-fixture.ts';
import { runDesktopCodexQuestionUiSmoke } from './desktop-codex-question-ui-smoke.ts';
import { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { runDesktopApprovalUiSmoke } from './desktop-approval-ui-smoke.ts';
import { runDesktopSkillsUiSmoke } from './desktop-skills-ui-smoke.ts';
import { runDesktopOfflineTaskBoardUiSmoke } from './desktop-task-board-cross-team-ui-smoke.ts';
import { prepareDesktopOversizedCommentUiFixture } from './desktop-oversized-comment-ui-smoke.ts';
import { runDesktopTaskTrashRestoreUiSmoke } from './desktop-task-trash-ui-smoke.ts';
import { runDesktopComposerUiSmoke } from './desktop-composer-ui-smoke.ts';
import { prepareDesktopProofMode } from './desktop-proof-mode.ts';
import { runDesktopLaunchUiSmoke } from './desktop-launch-ui-smoke.ts';
import { runDesktopCapturedMcpUiProof } from './desktop-opencode-v2-mcp-ui-proof.ts';
import { runDesktopCreateUiSmoke } from './desktop-create-launch-ui-smoke.ts';
import { runDesktopReviewUiSmoke } from './desktop-review-ui-smoke.ts';
import { runDesktopStoppedImportUiSmoke } from './desktop-stopped-import-ui-smoke.ts';
import { produceDesktopDonorSavedTeam } from './desktop-donor-saved-producer.ts';
import { produceDesktopCurrentStoppedTeam } from './desktop-stopped-import-prior-run.ts';
import { runDesktopDonorSavedImportUi } from './desktop-donor-saved-import-ui.ts';
import { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import type { startCodexModel } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  attachRendererDiagnostics,
  readRendererFailureSnapshot,
  runDesktopTeamUiSmoke,
} from './desktop-team-ui-smoke.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import {
  assertDesktopProofEnvironment,
  assertOwnedCdpListener,
  command,
  groupMembers,
  portOccupied,
  processTable,
  projectDesktopHarnessFailure,
  projectDesktopMixedSettingsFailure,
  readOwnedCdpListenerFailure,
  selectedCdpPort,
} from './desktop-backend-observations.ts';
import type { ProcessIdentity } from './desktop-backend-observations.ts';
import {
  captureDesktopNativeStopPresence,
  prepareDesktopNativeStop,
  verifyDesktopNativeStopArtifact,
} from './desktop-native-stop-fixture.ts';
import { runDesktopBackendBridgeProof } from './desktop-backend-bridge-proof.ts';

let questionModel: Awaited<ReturnType<typeof startDesktopCodexQuestionModel>> | undefined;
let mixedModels: DesktopMixedModels | undefined;
let conversationModel: Awaited<ReturnType<typeof startNativeTeamModel>> | undefined;
let codexResumeModel: Awaited<ReturnType<typeof startCodexModel>> | undefined;
let openCodeLifecycleModel: Awaited<ReturnType<typeof prepareDesktopProofMode>>['openCodeLifecycleModel'];
let openCodeReviewModel: Awaited<ReturnType<typeof prepareDesktopProofMode>>['openCodeReviewModel'];
let capturedMcpModel: Awaited<ReturnType<typeof prepareDesktopProofMode>>['capturedMcpModel'];
let controlledProcess: Awaited<ReturnType<typeof prepareControlledProcessFixture>>['controlledProcess'] | undefined;
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const tick = () => new Promise<void>((done) => setTimeout(done, 100));
function assertNoNativeHostChildren(group: number, fixture: {node: string; hostEntry: string}, phase: 'before-first-team-read' | 'after-team-read'): void {
  assertOwnedCdpListener(group);
  const table=processTable(),hosts=table.filter(row=>row.pgid===group&&command(row.pid)===`${fixture.node} ${fixture.hostEntry}`);
  if (phase === 'before-first-team-read') assert.ok(hosts.length === 0 || hosts.length === 1, 'Host may remain lazy only before the first canonical Team read');
  else assert.equal(hosts.length,1,'one original captured Host after canonical Team read');
  for (const host of hosts) assert.equal(table.filter(row=>row.ppid===host.pid).length,0,'readback never allocates a native child');
}
async function main(): Promise<DesktopOwnerRoutingContinuation | undefined> {
  const repo = resolve(import.meta.dirname, '../..');
  const packedRelaunchMode = process.env.LEGACY_DESKTOP_PROOF_MODE === 'packed-app-relaunch-ui';
  const mode = packedRelaunchMode ? 'native-launch-ui' : process.env.LEGACY_DESKTOP_PROOF_MODE ?? 'bridge-diagnostics';
  assertDesktopProofEnvironment(mode === 'process-cold-ui');
  assert.equal(
    await portOccupied(),
    false,
    'Selected CDP port is occupied; refuse without attaching to or stopping another app'
  );
  const quitScenario = process.env.LEGACY_DESKTOP_QUIT_SCENARIO;
  assert.ok(quitScenario === undefined || (mode === 'native-quit-ui' && quitScenario === 'pending-open'), 'explicit TEST Quit scenario');
  const startupDiagnosticMode = mode === 'startup-diagnostic-ui';
  const questionUiMode = mode === 'codex-question-ui';
  const scheduleUiMode = process.env.LEGACY_DESKTOP_SCHEDULE_UI === '1';
  const donorSavedOnly = process.env.LEGACY_DESKTOP_DONOR_SAVED_ONLY === '1';
  if (questionUiMode) questionModel = await startDesktopCodexQuestionModel();
  const packedCapturePath = process.env.LEGACY_DESKTOP_PACKED_CAPTURE_PATH;
  const packed = packedCapturePath ? await readCapturedCandidateElectron({ path: packedCapturePath, sha256: process.env.LEGACY_DESKTOP_PACKED_CAPTURE_SHA256! }) : undefined;
  const permittedSentinelObservation = (row: Record<string, unknown>) => (mode === 'skills-ui' && isSkillsMetadataRefusal(row)) || (!packed ? row.allowed === true : row.executable === 'shell-env' ? row.allowed === true : row.allowed === false && row.argc === 1 && Array.isArray(row.flags) && row.flags.length === 1 && row.flags[0] === '--version');
  if (packed) assert.ok(mode === 'native-launch-ui' || (process.platform === 'linux' && process.arch === 'x64' && mode === 'process-cold-ui'), 'bounded packed Launch or Linux cold process proof');
  if (packedRelaunchMode) assert.ok(packed, 'automatic app relaunch is an explicit captured packed scope');
  if (scheduleUiMode) assert.ok(mode === 'native-launch-ui' && !packed, 'original source schedule controls');
  if (donorSavedOnly) assert.ok(mode === 'stopped-import-ui' && !packed && !process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH, 'one actual donor saved-only scope');
  if (process.env.LEGACY_DESKTOP_OPENCODE_MCP_UI === '1') assert.ok(!packed && !packedRelaunchMode, 'captured MCP uses the existing source Launch scope');
  const { mixedMode, extensionsUiMode, capturedMcpUiMode, capturedMcpModel: selectedCapturedMcpModel, mixedModels: selectedMixedModels, processUiMode, controlledProcessMode, processReadbackMode, processModel, nativeReviewMode, nativeReviewReadbackMode, nativeReviewContinuationMode, readbackMode, reviewUiMode, reviewReadbackMode, legacyImportMode, conversationMode, taskBoardUiMode, approvalUiMode, nativeStopMode, uiMode, launchDialogMode, createConfigMode, model, codexResumeMode, codexResumeModel: selectedCodexResumeModel, openCodeLifecycleMode, openCodeLifecycleModel: selectedOpenCodeModel, openCodeReviewModel: selectedOpenCodeReviewModel } =
    await prepareDesktopProofMode(questionUiMode || startupDiagnosticMode ? 'team-ui' : mode, () => fixture.root, () => processFixtureBashCommand(fixture));
  conversationModel = model; mixedModels = selectedMixedModels;
  codexResumeModel = selectedCodexResumeModel;
  openCodeLifecycleModel = selectedOpenCodeModel; openCodeReviewModel = selectedOpenCodeReviewModel;
  capturedMcpModel = selectedCapturedMcpModel;
  const nativeInputs = mixedMode || codexResumeMode ? await captureDesktopCodexNativeInputs(process.env.LEGACY_DESKTOP_CODEX_PATH!) : [];
  const pnpm = await realpath(process.env.LEGACY_DESKTOP_PNPM_PATH ?? '/opt/homebrew/bin/pnpm');
  const baseFixture: Awaited<ReturnType<typeof prepareDesktopProofFixture>> = questionUiMode ? await prepareDesktopBackendFixture(repo, {
    seedUiTask: true, pnpmEntry: pnpm, nativeClaude: { path: process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
      sha256: 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f', modelUrl: questionModel!.url },
  }) : await prepareDesktopProofFixture(repo, mode, pnpm, {
    processUiMode, controlledProcessMode, processReadbackMode, nativeReviewMode, nativeReviewReadbackMode, nativeReviewContinuationMode, readbackMode, reviewReadbackMode, reviewUiMode, legacyImportMode, uiMode,
    launchDialogMode, createConfigMode, nativeStopMode, approvalUiMode, codexResumeMode, openCodeLifecycleMode, ...(capturedMcpModel ? { capturedMcpNonce: capturedMcpModel.nonce } : {}), ...(packed ? { candidateRuntime: packed.runtime } : {}), modelUrl: capturedMcpModel?.url ?? openCodeReviewModel?.url ?? openCodeLifecycleModel?.url ?? codexResumeModel?.url ?? conversationModel?.url ?? mixedModels?.claude.url,
  });
  controlledProcess = baseFixture.controlledProcess;
  const processReadbackSource = processReadbackMode ? await verifyNativeProcessReadbackSource(baseFixture.root, object(JSON.parse(await readFile(join(baseFixture.root, 'desktop-backend-receipt.json'), 'utf8')))) : undefined;
  if (mixedModels) await mixedModels.retainEvidenceAt(baseFixture.root);
  let fixture = questionUiMode ? await prepareDesktopCodexQuestionFixture(baseFixture, { executable: process.env.LEGACY_DESKTOP_CODEX_PATH!, model: questionModel! }) : mixedMode ? await prepareDesktopMixedNativeFixture(baseFixture, {
    models: selectedMixedModels!, codexPath: process.env.LEGACY_DESKTOP_CODEX_PATH!, openCodePath: process.env.LEGACY_DESKTOP_OPENCODE_PATH!,
    ...(process.env.LEGACY_DESKTOP_OPENCODE_GENERATION === 'v2' ? {
      openCodeV2: { bunPath: process.env.OPENCODE_V2_EMBEDDED_BUN!,
        bunSha256: process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256!,
        engineDirectory: process.env.OPENCODE_V2_EMBEDDED_GRAPH!,
        processCustody: {
          directory: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_DIRECTORY!,
          manifestSha256: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_MANIFEST_SHA256!,
        } },
    } : {}),
    openCodeEndpoint: await reserveMixedOpenCodeEndpoint(),
    openCodeManagementEndpoint: await reserveMixedOpenCodeEndpoint(),
  }) : baseFixture;
  const oversizedCommentSeed = mode === 'task-board-cross-team-ui'
    ? await prepareDesktopOversizedCommentUiFixture(fixture.root, fixture.uiSeed!)
    : undefined;
  if (startupDiagnosticMode || mixedMode) Object.assign(fixture.appEnvironment, { LEGACY_DESKTOP_STARTUP_DIAGNOSTICS: '1' });
  const activitySource = baseFixture.activitySource;
  const checkpointUpgrade = baseFixture.claudeCheckpointUpgrade;
  const require = createRequire(import.meta.url);
  if (!packed && (questionUiMode || processUiMode || nativeReviewMode || nativeStopMode || readbackMode || launchDialogMode || createConfigMode || legacyImportMode))
    await verifyDesktopNativeStopArtifact(repo);
  const cdpLibrary = require('../e2e/comment-notification/cdp.mjs') as CdpLibrary;
  assert.equal(typeof cdpLibrary.CdpClient.connect, 'function');
  const pnpmSha256 = await fileDigest(pnpm);
  const selectedNode = await realpath(process.execPath);
  assert.equal(selectedNode, fixture.node, 'harness runs with the captured standalone Node');
  for (const [actual, expected] of [
    [fixture.pins.nodeSha256, process.env.LEGACY_DESKTOP_NODE_SHA256],
    [fixture.pins.hostEntrySha256, process.env.LEGACY_DESKTOP_HOST_ENTRY_SHA256],
    [pnpmSha256, process.env.LEGACY_DESKTOP_PNPM_SHA256],
    [fixture.pins.corepackPackageSha256, process.env.LEGACY_DESKTOP_COREPACK_PACKAGE_SHA256],
    [fixture.pins.corepackLibrarySha256, process.env.LEGACY_DESKTOP_COREPACK_LIBRARY_SHA256],
  ]) {
    assert.match(expected ?? '', /^[a-f0-9]{64}$/);
    assert.equal(actual, expected);
  }
  let electron: string;
  if (packed) electron = packed.executable;
  else {
    // Preserve existing dev-only dependency checks; packed runs capture actual output instead.
    const electronPackage = require.resolve('electron/package.json');
    const electronRoot = resolve(electronPackage, '..');
    const electronRelative = (await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim();
    assert.equal(electronRelative, process.platform === 'linux' ? 'electron' : 'Electron.app/Contents/MacOS/Electron');
    electron = await realpath(join(electronRoot, 'dist', electronRelative));
  }
  assert.ok((await stat(electron)).isFile());
  const evidence = await desktopProofEvidence({
    mode,
    fixture,
    pnpm,
    pnpmSha256,
    electron,
    smokePath: import.meta.filename,
    conversationMode,
    nativeStopMode,
    uiMode,
    conversationModel,
    codexResumeModel,
    openCodeLifecycleModel, openCodeReviewModel, capturedMcpModel,
  });
  if (checkpointUpgrade) evidence.claudeCheckpointUpgrade = checkpointUpgrade.proof;
  if (capturedMcpUiMode) evidence.scope = 'Original Launch member MCP policies, selected external server and app-only isolation, actual native permission and tool effect, all-member Stop and saved UI readback; finite localhost inference only';
  if (scheduleUiMode) evidence.scope = 'Original Schedule controls, actual finite Claude and task-first native Bash/MCP, Stop, history and reload; localhost inference only';
  if (donorSavedOnly) evidence.scope = 'Exact donor UI saves genuine settings/roster, ordinary Quit and absence, then current original import/dialog/reload; zero native business input';
  if (quitScenario === 'pending-open') {
    evidence.scope = 'Actual native provider open pending, zero inputs, guarded existing Quit API and physical cleanup; explicit TEST setup';
    evidence.excluded = (evidence.excluded as string[]).filter(value => value !== 'pending provider-open');
  }
  if (questionUiMode) {
    evidence.scope = 'Actual Codex app-server finite MCP elicitation through original Composer/Question Sheet, accept and deny, canonical reply and original Stop; explicit TEST setup, localhost inference';
    evidence.excluded = ['vendor model/auth qualification', 'ordinary Launch dialog', 'full M06/M07/M08', 'Stage2'];
  }
  if (oversizedCommentSeed) evidence.oversizedCommentSeed = oversizedCommentSeed;
  if (packed) {
    evidence.packedCandidate = packed;
    object(evidence.pins).providerArchiveSha256 = packed.runtime.providerArtifacts.find(row => row.name === '@agent-teams/provider-implementations')!.sha256;
  }
  if (packedRelaunchMode) evidence.requestedProofMode = 'packed-app-relaunch-ui';
  if (processReadbackSource) {
    evidence.nativeProcessReadbackSource = processReadbackSource;
    evidence.scope = 'Separate original M19 cold UI continuation only: no model server, native allocation, input, launch or crash replay; original pre-app INCOMPLETE/HOLD retained';
  }
  const selectedSourceHashes = await captureDesktopSourceHashes(repo, desktopProofSources);
  evidence.selectedSourceHashesBeforeApp = selectedSourceHashes;
  if (nativeInputs.length) evidence.selectedNativeInputHashesBeforeApp = nativeInputs;
  const artifacts = desktopReadbackArtifacts({ readbackMode, nativeReviewContinuationMode, nativeReviewReadbackMode, reviewReadbackMode });
  const receiptPath = join(fixture.root, artifacts.receipt);
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ phase: 'prepared', receipt: receiptPath }));
  if (donorSavedOnly || (legacyImportMode && process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH === '1')) {
    try {
      assert.ok(conversationModel);
      if (donorSavedOnly) await produceDesktopDonorSavedTeam({ fixture, model: conversationModel, cdpLibrary, evidence });
      else await produceDesktopCurrentStoppedTeam({ repo, fixture, model: conversationModel, cdpLibrary, evidence });
      await verifyDesktopSourceFreeze(repo, desktopProofSources, selectedSourceHashes, evidence);
    } catch (error) {
      evidence.status = 'INCOMPLETE';
      evidence.failure = error instanceof Error ? error.message.slice(0, 4000) : 'original source producer failed';
      await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      throw error;
    }
  }
  if (controlledProcess) {
    evidence.controlledProcessColdUi = controlledProcess.proof;
    await controlledProcess.start();
  }
  await qualifyPreparedProcessRegistration({ enabled: processUiMode && !processReadbackMode, fixture, model: processModel, evidence, receiptPath,
    verifySourceFreeze: () => verifyDesktopSourceFreeze(repo, desktopProofSources, selectedSourceHashes, evidence) });
  const log = createWriteStream(
    join(fixture.root, artifacts.appLog),
    { mode: 0o600 }
  );
  const mcpBuilderEntry = !packed && process.platform === 'linux'
    ? await realpath(join(repo, 'mcp-server/node_modules/tsup/dist/cli-default.js')).catch(() => undefined)
    : undefined;
  // Invoke the pinned pnpm JS entry through selected Node: no /usr/bin/env
  // shebang exec transition can invalidate the captured leader identity.
  const invocation = packed ? [packed.executable, `--remote-debugging-port=${selectedCdpPort}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])] : [fixture.node, pnpm, 'dev:mcp', '--remoteDebuggingPort', String(selectedCdpPort), ...(process.platform === 'linux' ? ['--noSandbox'] : [])];
  let app = spawn(invocation[0]!, invocation.slice(1), {
    cwd: packed ? fixture.root : repo,
    env: packed ? { ...fixture.appEnvironment, NODE_ENV: 'production', PATH: join(fixture.root, 'bin') + ':/usr/bin:/bin' } : fixture.appEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let group = app.pid ?? 0;
  const appEpochHandles = [app];
  let spawnError = false;
  app.once('error', () => {
    spawnError = true;
  });
  app.stdout.pipe(log, { end: false });
  app.stderr.pipe(log, { end: false });
  let appIdentity = '';
  let cdp: CdpPort | undefined;
  let hostPid: number | undefined;
  let quitRequested = false;
  let finishMixedSettings: (() => Promise<void>) | undefined;
  const restartSameProfile = async (selection: Pick<Parameters<typeof restartCapturedDesktopApp>[0],
    'model' | 'provider' | 'boundary' | 'createdHandleId' | 'afterOriginalSettingsQuit'>) => {
    assert.ok(cdp && !packed && selection.model);
    return restartCapturedDesktopApp({
      app, cdp, group, fixture, repo, mode, evidence, cdpLibrary, ...selection,
      ...(checkpointUpgrade ? { checkpointUpgrade } : {}),
      markQuitRequested: () => { quitRequested = true; },
      adoptRenderer: (next, nextHostPid) => { cdp = next; if (nextHostPid !== undefined) hostPid = nextHostPid; },
      spawnNext: (nextFixture) => {
        if (nextFixture !== fixture) {
          assert.ok(checkpointUpgrade && fixture === checkpointUpgrade.original &&
            nextFixture === checkpointUpgrade.successor);
          fixture = nextFixture;
        }
        app = spawn(invocation[0]!, invocation.slice(1), { cwd: repo, env: fixture.appEnvironment,
          stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        appEpochHandles.push(app); group = app.pid ?? 0; spawnError = false; appIdentity = '';
        hostPid = undefined; quitRequested = false;
        app.once('error', () => { spawnError = true; });
        app.stdout.pipe(log, { end: false }); app.stderr.pipe(log, { end: false });
        assert.ok(group > 0);
        appIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='],
          { encoding: 'utf8', timeout: 3000 }).trim();
        return { app, group, identity: appIdentity, invocation, spawnError: () => spawnError };
      },
    });
  };
  try {
    assert.ok(group > 0, 'captured invocation has a process identity');
    appIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    evidence.app = {
      pid: app.pid,
      processGroup: group,
      identity: appIdentity,
      invocation,
    };
    const { cdp: connected, target, startupStarted, startupBudgetMs } = await connectCapturedDesktopApp({ app, group, spawnError: () => spawnError, packed, cdpLibrary, evidence });
    cdp = connected;
    if (startupDiagnosticMode) {
      await observeDesktopStartup(cdp, { root: fixture.root, url: String(target.url), remainingStartupMs: startupBudgetMs - (performance.now() - startupStarted), assertOwnedRenderer: () => assertOwnedCdpListener(group), evidence });
      await requestObservedDesktopClose(cdp, { assertOwnedRenderer: () => assertOwnedCdpListener(group),
        onAttempt: () => { quitRequested = true; }, listenerPresent: () => processTable().some(row => row.pid === evidence.cdpListener),
        evidence, key: 'startupDiagnosticClose' });
      return; // Existing finally retains raw diagnostics and exact captured process cleanup.
    }
    if (uiMode)
      await attachRendererDiagnostics(cdp, String(target.url), evidence, {
        remainingMs: startupBudgetMs - (performance.now() - startupStarted),
        assertOwnedRenderer: () => assertOwnedCdpListener(group),
      });
    if (questionUiMode)
      await waitDesktopCodexQuestionRenderer(cdp, { url: String(target.url),
        remainingStartupMs: startupBudgetMs - (performance.now() - startupStarted),
        assertOwnedRenderer: () => assertOwnedCdpListener(group), evidence });
    await verifyCapturedDesktopBinding({ cdp, group, mode, fixture, evidence, repo, packed,
      remainingStartupMs: startupBudgetMs - (performance.now() - startupStarted) });
    const coldMetadata = ['native-readback-ui', 'native-quit-readback-ui'].includes(mode)
      ? await captureDesktopOpenCodeV2ColdMetadata(cdp, { root: fixture.root, node: fixture.node, hostEntry: fixture.hostEntry,
        group, evidence, assertOwnedRenderer: () => assertOwnedCdpListener(group) }) : undefined;
    if (coldMetadata) hostPid = coldMetadata.hostPid;
    if (['codex-account-read', 'codex-account-auth'].includes(mode)) {
      const readyUntil = Date.now() + 60000;
      let initial: Record<string, unknown> | undefined;
      while (Date.now() < readyUntil) {
        assertOwnedCdpListener(group);
        try {
          initial = object(
            await bounded(
              cdp.evaluate('window.electronAPI.getCodexAccountSnapshot()'),
              20000,
              'read account IPC readiness'
            )
          );
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/No handler registered for ['"]codexAccount:getSnapshot/.test(error.message)
          )
            throw error;
          // The missing handler proves this read was not dispatched. No mutation is retried.
          await tick();
        }
      }
      assert.ok(initial, 'Codex account handler becomes ready before any auth mutation');
      evidence.codexInitialAccount = {
        managedAccount: initial.managedAccount,
        appServerState: initial.appServerState,
      };
    }
    let nativeChildren: ProcessIdentity[] = [];
    if (conversationMode) await runDesktopHostRoutingProof(cdp, fixture, evidence);
    if (questionUiMode) {
      const setup = await prepareDesktopCodexQuestionLaunch({ cdp, fixture, group, evidence, executable: process.env.LEGACY_DESKTOP_CODEX_PATH! });
      nativeChildren = setup.nativeChildren; hostPid = setup.hostPid;
    }
    if (nativeStopMode) {
      const setup = await prepareDesktopNativeStop({
        cdp,
        fixture,
        group,
        evidence,
        executable: openCodeLifecycleMode ? process.env.OPENCODE_V2_EMBEDDED_BUN! : process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
        ...(openCodeLifecycleMode ? { provider: 'opencode' as const } : {}),
        manualPermissions: approvalUiMode,
        ...(quitScenario === 'pending-open' ? { returnAt: 'opening' as const } : {}),
      });
      nativeChildren = setup.nativeChildren;
      hostPid = setup.hostPid;
    }
    if (questionUiMode) {
      assert.ok(fixture.uiSeed && questionModel);
      await runDesktopCodexQuestionUiSmoke(cdp, { root: fixture.root, seed: fixture.uiSeed, evidence, model: questionModel,
        assertOwnedRenderer: () => assertOwnedCdpListener(group), assertNativeAbsent: () => {
          const table = processTable(); assert.ok(nativeChildren.every(child => !table.some(row => row.pid === child.pid)), 'captured Codex native child absent after original Stop');
        } });
    } else if (activitySource) {
      await runDesktopActivityUiSmoke(cdp, {root:fixture.root, source:activitySource, teamName:activitySource.teamName, memberName:activitySource.memberName, memberId:activitySource.memberId, handleId:fixture.handleId, evidence, assertOwnedRenderer:()=>assertOwnedCdpListener(group), assertNoNativeChildren:phase=>assertNoNativeHostChildren(group,fixture,phase)});
    } else if (processUiMode || controlledProcessMode) {
      hostPid = await qualifyColdProcessUi(cdp, { fixture, evidence, group, processReadbackMode, processReadbackSource,
        controlledSource: controlledProcess?.source, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (await runDesktopNativeQuitMode(cdp, {mode, root: fixture.root, seed: fixture.uiSeed, evidence, model: openCodeLifecycleModel ?? conversationModel, coldMetadata, assertOwnedRenderer: () => assertOwnedCdpListener(group)})) {
      // Exact Quit/readback witnesses are finalized below before fallback cleanup.
    } else if (nativeReviewMode) {
      await runDesktopNativeReview(cdp, { fixture, evidence, model: conversationModel, openCodeReviewModel,
        readback: nativeReviewReadbackMode, continuation: nativeReviewContinuationMode, group, onHostObserved: pid => { hostPid = pid; }, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (legacyImportMode) {
      assert.ok(conversationModel);
      const importOptions = {
        fixture, evidence, model: conversationModel, electron,
        assertOwnedRenderer: () => assertOwnedCdpListener(group),
        observeOwnedHost: () => {
          const hosts = groupMembers(group).filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
          assert.equal(hosts.length, 1, 'one actual selected standalone Host after import');
          hostPid = hosts[0]!.pid;
          evidence.hostChildAfterImport = { ...hosts[0], command: `${fixture.node} ${fixture.hostEntry}`, observedBeforeShutdown: true };
        },
      };
      if (donorSavedOnly) await runDesktopDonorSavedImportUi(cdp, importOptions);
      else await runDesktopStoppedImportUiSmoke(cdp, importOptions);
    } else if (approvalUiMode) {
      assert.ok(fixture.uiSeed && conversationModel);
      await runDesktopApprovalUiSmoke(cdp, {root: fixture.root, seed: fixture.uiSeed, evidence, model: conversationModel,
        assertOwnedRenderer: () => assertOwnedCdpListener(group), assertNativeAbsent: () => {
          const table=processTable();assert.ok(nativeChildren.every(child=>!table.some(row=>row.pid===child.pid)),'captured native child absent after original Stop');
        }});
    } else if (mode === 'skills-ui') {
      await runDesktopSkillsUiSmoke(cdp, { root: fixture.root, evidence, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (mode === 'native-extensions-ui') {
      await runDesktopNativeExtensionsUiSmoke(cdp, { root: fixture.root, evidence, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (taskBoardUiMode) {
      assert.ok(fixture.uiSeed);
      await runDesktopOfflineTaskBoardUiSmoke(cdp, { root: fixture.root, repo, handleId: fixture.handleId,
        seed: fixture.uiSeed, evidence, assertOwnedRenderer: () => assertOwnedCdpListener(group) }, mode);
      if (mode === 'task-board-cross-team-ui')
        await runDesktopF08ReadTimingProof(cdp, { root: fixture.root, handleId: fixture.handleId,
          seed: fixture.uiSeed, evidence, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
      if (mode === 'task-board-ui' || mode === 'task-board-cross-team-ui')
        await runDesktopTaskTrashRestoreUiSmoke(cdp, { root: fixture.root, repo, handleId: fixture.handleId,
          seed: fixture.uiSeed, evidence, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (reviewUiMode) {
      assert.ok(fixture.uiSeed);
      await runDesktopReviewUiSmoke(cdp, {
        root: fixture.root, seed: fixture.uiSeed, readback: reviewReadbackMode, evidence,
        assertOwnedRenderer: () => assertOwnedCdpListener(group),
      });
    } else if (mixedMode) {
      assert.ok(mixedModels);
      const mixed = await runDesktopMixedCreateLaunchUiSmoke(cdp, {
        fixture, models: mixedModels, capturedGroup: () => group, evidence,
        assertOwnedRenderer: () => assertOwnedCdpListener(group),
        restartSameProfile: (createdHandleId, afterOriginalSettingsQuit) => restartSameProfile({
          model: mixedModels!.claude, provider: 'claude', boundary: 'settings-saved-before-launch',
          createdHandleId, afterOriginalSettingsQuit,
        }),
      });
      finishMixedSettings = mixed.finishSettings;
    } else if (createConfigMode) {
      await runDesktopCreateUiSmoke(cdp, { fixture, evidence, model: conversationModel, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (scheduleUiMode) {
      assert.ok(conversationModel && 'scheduleRequests' in conversationModel);
      await runDesktopScheduleUiProof(cdp, { fixture, model: conversationModel, evidence,
        capturedGroup: () => group, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (capturedMcpUiMode) {
      assert.ok(capturedMcpModel);
      await runDesktopCapturedMcpUiProof(cdp, { fixture, model: capturedMcpModel, group, evidence,
        assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (launchDialogMode) {
      assert.ok(fixture.uiSeed && (conversationModel || codexResumeModel || openCodeLifecycleModel));
      await runDesktopLaunchUiSmoke(cdp, {
        ...(checkpointUpgrade ? { currentFixture: () => fixture } : {}),
        fixture, seed: fixture.uiSeed, evidence, ...(conversationModel ? { model: conversationModel } : {}),
        ...(codexResumeModel ? { codexResumeModel } : {}),
        ...(openCodeLifecycleModel ? { openCodeModel: openCodeLifecycleModel } : {}),
        capturedGroup: () => group,
        assertOwnedRenderer: () => assertOwnedCdpListener(group),
        ...(mode === 'native-resume-ui' || extensionsUiMode ? { restartSameProfile: () =>
          restartSameProfile({ model: openCodeLifecycleModel ?? codexResumeModel ?? conversationModel!,
            provider: openCodeLifecycleMode ? 'opencode' : codexResumeMode ? 'codex' : 'claude',
            boundary: extensionsUiMode ? 'extensions-before-launch' : 'resume-after-stop' }) } : {}),
      });
    } else if (readbackMode) {
      assert.ok(fixture.uiSeed);
      await runDesktopNativeReadback(cdp, {
        root: fixture.root,
        seed: fixture.uiSeed,
        evidence,
        assertOwnedRenderer: () => assertOwnedCdpListener(group),
        metadataProcessCount: coldMetadata?.metadataProcessCount ?? 0,
        assertNoNativeChildren: () => {
          if (coldMetadata) return coldMetadata.assertNoRuntimeChildren();
          const table = processTable();
          const hosts = table.filter(
            (row) =>
              row.pgid === group && command(row.pid) === `${fixture.node} ${fixture.hostEntry}`
          );
          assert.equal(hosts.length, 1);
          assert.equal(
            table.filter((row) => row.ppid === hosts[0]!.pid).length,
            0,
            'no Native process allocated during saved-state readback'
          );
        },
      });
    } else if (uiMode) {
      assert.ok(fixture.uiSeed, 'UI mode requires canonical offline seed');
      await (conversationMode ? runDesktopComposerUiSmoke : runDesktopTeamUiSmoke)(cdp, {
        root: fixture.root,
        repo,
        seed: fixture.uiSeed,
        assertOwnedRenderer: () => {
          assertOwnedCdpListener(group);
        },
        evidence,
        ...(conversationModel ? { model: conversationModel } : {}),
        ...(conversationMode && openCodeLifecycleModel ? { openCodeModel: openCodeLifecycleModel } : {}),
        ...(nativeStopMode
          ? {
              nativeStop: {
                assertNativeAbsent: () => {
                  const table = processTable();
                  assert.ok(
                    nativeChildren.every((child) => !table.some((row) => row.pid === child.pid)),
                    'captured native child is physically absent after ordinary Stop'
                  );
                },
              },
            }
          : {}),
      });
    } else if (['codex-account-read', 'codex-account-auth'].includes(mode)) {
      await runDesktopCodexAccountProof(cdp, {mode, fixture, evidence, assertOwnedRenderer: () => assertOwnedCdpListener(group)});
    } else {
      await runDesktopBackendBridgeProof(cdp, {
        handleId: fixture.handleId,
        root: fixture.root,
        evidence,
        assertOwnedRenderer: () => {
          assertOwnedCdpListener(group);
        },
      });
    }
    const children = groupMembers(group);
    const hosts = children.filter(
      (row) => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`
    );
    assert.equal(hosts.length, 1, 'one actual selected standalone Host process');
    hostPid = hosts[0]!.pid;
    evidence.hostChild = {
      ...hosts[0],
      command: `${fixture.node} ${fixture.hostEntry}`,
      observedBeforeShutdown: true,
    };
    const sentinel = (await readFile(fixture.sentinelLog, 'utf8').catch(error => { if (packed && error?.code === 'ENOENT') return ''; throw error; }))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => object(JSON.parse(line) as unknown));
    if (!packed) assert.ok(sentinel.length > 0, 'dev:mcp performed finite sentinel version preflight');
    assert.ok(
      sentinel.every(permittedSentinelObservation),
      'no agent invocation through legacy sentinels is permitted'
    );
    evidence.sentinel = sentinel;
    evidence.preQuitSentinelCount = sentinel.length;
    await capturePendingDesktopNativeQuit(fixture.root, evidence, openCodeLifecycleModel ?? conversationModel);
    quitRequested = true;
    // API diagnostic shutdown, explicitly not a human UI control interaction.
    if (packedRelaunchMode) {
      assert.ok(packed); const originalCdp = cdp; cdp = undefined; // No generic failure-Quit or stale renderer reuse after the one relaunch intent.
      const inputsBefore = conversationModel?.observations.length;
      await observePackedAppRelaunch({ app, cdp: originalCdp, group, hostPid, packed, fixture, evidence, repo, cdpLibrary });
      object(evidence.packedAppRelaunch).nativeInputObservations = { before: inputsBefore, after: conversationModel?.observations.length };
      assert.equal(conversationModel?.observations.length, inputsBefore, 'app relaunch cannot send another native input');
      assert.deepEqual(conversationModel?.failures, []);
    } else await cdp.evaluate('window.electronAPI.windowControls.close()').catch(() => undefined);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && processTable().some((row) => row.pid === hostPid)) await tick();
    assert.equal(
      processTable().some((row) => row.pid === hostPid),
      false,
      'captured standalone Host retired during guarded app Quit'
    );
    await observeDesktopMetadataClose(fixture.root, evidence);
    assertCapturedDesktopMetadataAbsent(evidence);
    await verifyDesktopNativeQuitAfterShutdown(mode, fixture.root, evidence, nativeChildren, openCodeLifecycleModel ?? conversationModel, group);
    if (activitySource) await finalizeDesktopActivityReadback(evidence, activitySource, () => assert.equal(processTable().some(row => row.pid === hostPid), false));
    if (finishMixedSettings) await finishMixedSettings();
    if (checkpointUpgrade) await checkpointUpgrade.finish();
    evidence.status = 'PASS';
  } catch (error) {
    evidence.failureSource = projectDesktopHarnessFailure(error, repo, desktopProofSources);
    const listenerFailure = readOwnedCdpListenerFailure(error, {
      node: fixture.node, hostEntry: fixture.hostEntry, ...(mcpBuilderEntry ? { mcpBuilderEntry } : {}),
    });
    if (listenerFailure) {
      evidence.cdpListenerFailure = listenerFailure;
      try {
        const line = 'TEST_CDP_LISTENER_FAILURE ' + JSON.stringify(listenerFailure);
        console.log(Buffer.byteLength(line, 'utf8') <= 32 * 1024 ? line :
          'TEST_CDP_LISTENER_FAILURE {"scope":"original-linux-lsof-test-cdp","unavailable":"over-limit"}');
      } catch { /* Diagnostic failure never replaces the original listener assertion. */ }
    }
    evidence.failure =
      error instanceof Error ? error.message.slice(0, 4000) : 'unclassified harness failure';
    const metadataFailure = readDesktopMetadataLineageFailure(error);
    if (metadataFailure) evidence.metadataObservationFailure = metadataFailure;
    if (uiMode && cdp) {
      try {
        assertOwnedCdpListener(group);
        try {
          evidence.rendererFailureSnapshot = await bounded(
            readRendererFailureSnapshot(cdp),
            4000,
            'read renderer startup snapshot'
          );
        } catch {
          evidence.rendererFailureSnapshot = { unavailable: true };
        }
        const screenshot = object(
          await bounded(
            cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
            5000,
            'failure screenshot'
          )
        );
        assert.equal(typeof screenshot.data, 'string');
        const screenshotPath = join(
          fixture.root,
          artifacts.failureScreenshot
        );
        await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'), {
          mode: 0o600,
        });
        evidence.failureScreenshot = {
          path: screenshotPath,
          sha256: await fileDigest(screenshotPath),
        };
      } catch (captureError) {
        evidence.failureScreenshotUnavailable =
          captureError instanceof Error ? captureError.message.slice(0, 1000) : 'unavailable';
      }
    }
    if ((nativeStopMode || questionUiMode) && evidence.nativeSetup) {
      try {
        evidence.nativeBeforeFailureQuit = captureDesktopNativeStopPresence(evidence.nativeSetup);
      } catch {
        evidence.nativeBeforeFailureQuit = { unavailable: true };
      }
    }
    if (cdp && !quitRequested) {
      try {
        await requestObservedDesktopClose(cdp, { assertOwnedRenderer: () => assertOwnedCdpListener(group),
          onAttempt: () => { quitRequested = true; }, listenerPresent: () => processTable().some(row => row.pid === evidence.cdpListener),
          evidence, key: 'failureQuit' });
      } catch {
        evidence.failureQuit = {
          attempted: false,
          reason: 'Owned CDP authority unavailable; no unrelated window was closed',
        };
      }
    }

    throw error;
  } finally {
    evidence.quitRequested = quitRequested;
    await verifyDesktopSourceFreeze(repo, desktopProofSources, selectedSourceHashes, evidence);
    if (cdp) await bounded(cdp.close(), 3000, 'disconnect test renderer').catch(() => undefined);
    const { remaining, cleanupFailure, capturedHostAbsent, hostPid: cleanedHostPid } =
      await cleanupCapturedDesktopApp({ app, group, fixture, evidence, appIdentity, hostPid, packedRelaunchMode });
    hostPid = cleanedHostPid;
    const coldBoundary = evidence.coldResumeBoundary ?? evidence.coldExtensionBoundary ?? evidence.coldSettingsBoundary;
    if (coldBoundary && object(coldBoundary).secondEpoch) object(coldBoundary).secondCleanup = {
      processGroup: group, remaining, appExitCode: app.exitCode, appSignalCode: app.signalCode, capturedHostAbsent,
      ...(cleanupFailure ? { cleanupFailure } : {}),
    };
    evidence.cleanup = {
      ...(coldBoundary ? { scope: object(coldBoundary).secondEpoch ? 'second captured app epoch; firstCleanup retained separately' : 'original epoch; second spawn refused' } : {}),
      processGroup: group,
      remaining,
      appExitCode: app.exitCode,
      appSignalCode: app.signalCode,
      ...(cleanupFailure ? { cleanupFailure } : {}),
      capturedHostObserved: hostPid !== undefined,
      capturedHostAbsent,
      hostExitCode: controlledProcessMode
        ? 'controlled cold Host app shutdown; no provider Runtime allocation; first standalone Host separately observed exit0/null'
        : processUiMode
        ? 'cold Host app shutdown only; intentionally crashed original Host/SDK native custody remains separate HOLD, no cleanup claim'
        : nativeStopMode || launchDialogMode || createConfigMode
        ? 'not exposed by main-owned transport; consult per-flow native custody and physical child observations'
        : readbackMode
          ? 'saved Runtime readback; consult per-flow custody and allocation evidence'
          : 'not exposed by main-owned transport; no separate Host exit code recorded',
    };
    if (cleanupFailure || remaining === null || remaining.length) evidence.status = 'INCOMPLETE';
    try {
      const census = (await readFile(fixture.sentinelLog, 'utf8').catch(error => { if (packed && error?.code === 'ENOENT') return ''; throw error; }))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => object(JSON.parse(line) as unknown));
      const preQuitCount =
        typeof evidence.preQuitSentinelCount === 'number' ? evidence.preQuitSentinelCount : null;
      if (packed && census.some(row => !permittedSentinelObservation(row))) evidence.status = 'INCOMPLETE';
      evidence.finalSentinelCensus = {
        invocations: census,
        preQuitCount,
        postQuitOrCleanupInvocations: preQuitCount === null ? null : census.slice(preQuitCount),
        refusedInvocations: census.filter((row) => row.allowed !== true),
        qualification: packed ? 'All legacy executable calls refuse, including version discovery. Only nonessential version attempts and the isolated shell-environment fixture are admitted observations; any agent/control fallback before or after Quit makes this packed proof incomplete.' :
          'Sentinels refuse nonversion commands without launching providers. Post-Quit/cleanup refusals are retained legacy maintenance gaps; they do not prove native execution or full fork-free/P5 qualification.',
      };
    } catch (error) {
      evidence.sentinelCensusFailure =
        error instanceof Error
          ? error.message.slice(0, 1000)
          : 'unclassified sentinel census failure';
      evidence.status = 'INCOMPLETE';
    }
    // Preserve the receipt even if the identity guard refused cleanup. Detach the
    // log sink before closing it while an unconfirmed captured child remains live.
    for (const captured of appEpochHandles) {
      captured.stdout.unpipe(log); captured.stderr.unpipe(log);
      captured.stdout.resume(); captured.stderr.resume();
    }
    await bounded(new Promise<void>((done) => log.end(done)), 3000, 'close harness log').catch(
      (error: unknown) => {
        evidence.logCleanupFailure =
          error instanceof Error ? error.message : 'unclassified log cleanup failure';
        evidence.status = 'INCOMPLETE';
      }
    );
    if (packed) await verifyDesktopPackedFreeze(
      { path: packedCapturePath!, sha256: process.env.LEGACY_DESKTOP_PACKED_CAPTURE_SHA256! }, packed, evidence);
    if (controlledProcess) {
      try {
        await controlledProcess.cleanup();
        assert.equal(controlledProcess.proof.status, 'PASS');
      } catch (error) {
        evidence.controlledProcessCleanupFailure = error instanceof Error ? error.message : String(error);
        evidence.status = 'INCOMPLETE';
      }
    }
    await verifyDesktopNativeFreeze(nativeInputs, evidence);
    await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: evidence.status, receipt: receiptPath,
      ...(evidence.status !== 'PASS' && evidence.failureSource
        ? { failureSource: evidence.failureSource } : {}),
      ...(mixedMode && evidence.status !== 'PASS'
        ? { mixedSettingsFailure: projectDesktopMixedSettingsFailure(evidence) } : {}),
    }));
    if (packed) assert.equal(evidence.status, 'PASS', 'packed candidate proof incomplete; inspect the retained receipt before any retry');
    if (controlledProcessMode) assert.equal(evidence.status, 'PASS', 'controlled process cold UI proof incomplete; original evidence retained');
    if (scheduleUiMode) assert.equal(evidence.status, 'PASS', 'original schedule UI proof incomplete; inspect its retained receipt');
    if (capturedMcpUiMode) assert.equal(evidence.status, 'PASS', 'original MCP UI proof incomplete; inspect its retained receipt');
    assert.ok(
      !cleanupFailure && remaining !== null && remaining.length === 0,
      'captured group cleanup unconfirmed; receipt retains debt and no further signal is authorized'
    );
  }
  if (mode === 'task-board-cross-team-ui') {
    assert.equal(evidence.status, 'PASS', 'original Taskboard proof and cleanup must finish before owner continuation');
    return { fixture, repo, invocation, cdpLibrary, evidence, receiptPath, frozenSources: desktopProofSources, selectedSourceHashes };
  }
}

let originalFailure: unknown;
try {
  const ownerContinuation = await main();
  if (ownerContinuation) await runDesktopOwnerRoutingContinuation(ownerContinuation);
} catch (error) {
  originalFailure = error;
  throw error;
} finally {
  try { await controlledProcess?.cleanup(); } catch (error) { if (!originalFailure) throw error; }
  await questionModel?.close();
  await (capturedMcpModel ?? openCodeReviewModel ?? openCodeLifecycleModel ?? codexResumeModel ?? conversationModel)?.close();
  await mixedModels?.close();
}
