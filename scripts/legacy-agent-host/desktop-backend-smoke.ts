import { runDesktopOwnerRoutingContinuation } from './desktop-owner-routing-ui-smoke.ts';
import type { DesktopOwnerRoutingContinuation } from './desktop-owner-routing-ui-smoke.ts';
import { verifyNativeProcessReadbackSource } from './desktop-native-process-readback.ts';
import { checkpoint } from './desktop-resume-records.ts';
import { connectCapturedDesktopApp, observePackedAppRelaunch, verifyCapturedDesktopBinding } from './desktop-captured-app.ts';
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
import assert from 'node:assert/strict';
import { runDesktopNativeQuitMode, verifyDesktopNativeQuitAfterShutdown, capturePendingDesktopNativeQuit } from './desktop-native-quit-ui-smoke.ts';
import { prepareDesktopMixedNativeFixture, reserveMixedOpenCodeEndpoint } from './desktop-mixed-native-fixture.ts';
import { runDesktopMixedCreateLaunchUiSmoke } from './desktop-mixed-create-launch-ui-smoke.ts';
import type { DesktopMixedModels } from './desktop-mixed-native-fixture.ts';
import { desktopProofEvidence } from './desktop-proof-evidence.ts';
import { runDesktopNativeReview } from './desktop-native-review-compose.ts';
import { desktopReadbackArtifacts, runDesktopNativeReadback } from './desktop-readback-fixture.ts';
import { prepareDesktopProofFixture } from './desktop-proof-fixture.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';
import { verifyDesktopSourceFreeze } from './desktop-source-freeze.ts';
import { runDesktopF08ReadTimingProof, runDesktopHostRoutingProof } from './desktop-host-routing-proof.ts';
import { startDesktopCodexQuestionModel } from './desktop-codex-question-model.ts';
import { prepareDesktopCodexQuestionFixture, prepareDesktopCodexQuestionLaunch, waitDesktopCodexQuestionRenderer } from './desktop-codex-question-fixture.ts';
import { runDesktopCodexQuestionUiSmoke } from './desktop-codex-question-ui-smoke.ts';
import { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { runDesktopApprovalUiSmoke } from './desktop-approval-ui-smoke.ts';
import { runDesktopSkillsUiSmoke } from './desktop-skills-ui-smoke.ts';
import { runDesktopOfflineTaskBoardUiSmoke } from './desktop-task-board-cross-team-ui-smoke.ts';
import { runDesktopTaskTrashRestoreUiSmoke } from './desktop-task-trash-ui-smoke.ts';
import { runDesktopComposerUiSmoke } from './desktop-composer-ui-smoke.ts';
import { prepareDesktopProofMode } from './desktop-proof-mode.ts';
import { runDesktopLaunchUiSmoke } from './desktop-launch-ui-smoke.ts';
import { runDesktopCreateUiSmoke } from './desktop-create-launch-ui-smoke.ts';
import { runDesktopReviewUiSmoke } from './desktop-review-ui-smoke.ts';
import { runDesktopStoppedImportUiSmoke } from './desktop-stopped-import-ui-smoke.ts';
import { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import { spawn, execFileSync } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  attachRendererDiagnostics,
  readRendererFailureSnapshot,
  runDesktopTeamUiSmoke,
} from './desktop-team-ui-smoke.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import {
  assertOwnedCdpListener,
  command,
  groupMembers,
  portOccupied,
  processTable,
  settledGroupMembers,
  observeOriginalAppReap,
  selectedCdpPort,
} from './desktop-backend-observations.ts';
import type { ProcessIdentity } from './desktop-backend-observations.ts';
import {
  captureDesktopNativeStopPresence,
  prepareDesktopNativeStop,
  verifyDesktopNativeStopArtifact,
  readDesktopNativeStopSessions,
} from './desktop-native-stop-fixture.ts';
import { runDesktopBackendBridgeProof } from './desktop-backend-bridge-proof.ts';

let questionModel: Awaited<ReturnType<typeof startDesktopCodexQuestionModel>> | undefined;
let mixedModels: DesktopMixedModels | undefined;
let conversationModel: Awaited<ReturnType<typeof startNativeTeamModel>> | undefined;
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
  assert.equal(
    process.env.LEGACY_DESKTOP_BACKEND_GO,
    '1',
    'root must authorize actual pnpm dev:mcp launch'
  );
  assert.equal(process.platform, 'darwin', 'this captured process evidence uses macOS ps/lsof');
  assert.equal(
    await portOccupied(),
    false,
    'Selected CDP port is occupied; refuse without attaching to or stopping another app'
  );
  const repo = resolve(import.meta.dirname, '../..');
  const packedRelaunchMode = process.env.LEGACY_DESKTOP_PROOF_MODE === 'packed-app-relaunch-ui';
  const mode = packedRelaunchMode ? 'native-launch-ui' : process.env.LEGACY_DESKTOP_PROOF_MODE ?? 'bridge-diagnostics';
  const quitScenario = process.env.LEGACY_DESKTOP_QUIT_SCENARIO;
  assert.ok(quitScenario === undefined || (mode === 'native-quit-ui' && quitScenario === 'pending-open'), 'explicit TEST Quit scenario');
  const startupDiagnosticMode = mode === 'startup-diagnostic-ui';
  const questionUiMode = mode === 'codex-question-ui';
  if (questionUiMode) questionModel = await startDesktopCodexQuestionModel();
  const packedCapturePath = process.env.LEGACY_DESKTOP_PACKED_CAPTURE_PATH;
  const packed = packedCapturePath ? await readCapturedCandidateElectron({ path: packedCapturePath, sha256: process.env.LEGACY_DESKTOP_PACKED_CAPTURE_SHA256! }) : undefined;
  const permittedSentinelObservation = (row: Record<string, unknown>) => (mode === 'skills-ui' && isSkillsMetadataRefusal(row)) || (!packed ? row.allowed === true : row.executable === 'shell-env' ? row.allowed === true : row.allowed === false && row.argc === 1 && Array.isArray(row.flags) && row.flags.length === 1 && row.flags[0] === '--version');
  if (packed) assert.equal(mode, 'native-launch-ui', 'one bounded packed workflow reuses the original native Launch proof');
  if (packedRelaunchMode) assert.ok(packed, 'automatic app relaunch is an explicit captured packed scope');
  const { mixedMode, mixedModels: selectedMixedModels, processUiMode, processReadbackMode, processModel, nativeReviewMode, nativeReviewReadbackMode, nativeReviewContinuationMode, readbackMode, reviewUiMode, reviewReadbackMode, legacyImportMode, conversationMode, taskBoardUiMode, approvalUiMode, nativeStopMode, uiMode, launchDialogMode, createConfigMode, model } =
    await prepareDesktopProofMode(questionUiMode || startupDiagnosticMode ? 'team-ui' : mode, () => fixture.root, () => processFixtureBashCommand(fixture));
  conversationModel = model; mixedModels = selectedMixedModels;
  const pnpm = await realpath(process.env.LEGACY_DESKTOP_PNPM_PATH ?? '/opt/homebrew/bin/pnpm');
  const baseFixture: Awaited<ReturnType<typeof prepareDesktopProofFixture>> = questionUiMode ? await prepareDesktopBackendFixture(repo, {
    seedUiTask: true, pnpmEntry: pnpm, nativeClaude: { path: process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
      sha256: 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f', modelUrl: questionModel!.url },
  }) : await prepareDesktopProofFixture(repo, mode, pnpm, {
    processUiMode, processReadbackMode, nativeReviewMode, nativeReviewReadbackMode, nativeReviewContinuationMode, readbackMode, reviewReadbackMode, reviewUiMode, legacyImportMode, uiMode,
    launchDialogMode, createConfigMode, nativeStopMode, approvalUiMode, ...(packed ? { candidateRuntime: packed.runtime } : {}), modelUrl: conversationModel?.url ?? mixedModels?.claude.url,
  });
  const processReadbackSource = processReadbackMode ? await verifyNativeProcessReadbackSource(baseFixture.root, object(JSON.parse(await readFile(join(baseFixture.root, 'desktop-backend-receipt.json'), 'utf8')))) : undefined;
  if (mixedModels) await mixedModels.retainEvidenceAt(baseFixture.root);
  const fixture = questionUiMode ? await prepareDesktopCodexQuestionFixture(baseFixture, { executable: process.env.LEGACY_DESKTOP_CODEX_PATH!, model: questionModel! }) : mixedMode ? await prepareDesktopMixedNativeFixture(baseFixture, {
    models: selectedMixedModels!, codexPath: process.env.LEGACY_DESKTOP_CODEX_PATH!, openCodePath: process.env.LEGACY_DESKTOP_OPENCODE_PATH!,
    openCodeEndpoint: await reserveMixedOpenCodeEndpoint(),
    openCodeManagementEndpoint: await reserveMixedOpenCodeEndpoint(),
  }) : baseFixture;
  if (startupDiagnosticMode || mixedMode) Object.assign(fixture.appEnvironment, { LEGACY_DESKTOP_STARTUP_DIAGNOSTICS: '1' });
  const activitySource = baseFixture.activitySource;
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
    assert.equal(electronRelative, 'Electron.app/Contents/MacOS/Electron');
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
  });
  if (quitScenario === 'pending-open') {
    evidence.scope = 'Actual native provider open pending, zero inputs, guarded existing Quit API and physical cleanup; explicit TEST setup';
    evidence.excluded = (evidence.excluded as string[]).filter(value => value !== 'pending provider-open');
  }
  if (questionUiMode) {
    evidence.scope = 'Actual Codex app-server finite MCP elicitation through original Composer/Question Sheet, accept and deny, canonical reply and original Stop; explicit TEST setup, localhost inference';
    evidence.excluded = ['vendor model/auth qualification', 'ordinary Launch dialog', 'full M06/M07/M08', 'Stage2'];
  }
  if (packed) {
    evidence.packedCandidate = packed;
    object(evidence.pins).providerArchiveSha256 = packed.runtime.providerArtifacts.find(row => row.name === '@agent-teams/provider-implementations')!.sha256;
  }
  if (packedRelaunchMode) evidence.requestedProofMode = 'packed-app-relaunch-ui';
  if (processReadbackSource) {
    evidence.nativeProcessReadbackSource = processReadbackSource;
    evidence.scope = 'Separate original M19 cold UI continuation only: no model server, native allocation, input, launch or crash replay; original pre-app INCOMPLETE/HOLD retained';
  }
  const frozenSources = desktopProofSources;
  const selectedSourceHashes = await Promise.all(
    frozenSources.map(async (path) => ({ path, sha256: await fileDigest(join(repo, path)) }))
  );
  evidence.selectedSourceHashesBeforeApp = selectedSourceHashes;
  const artifacts = desktopReadbackArtifacts({ readbackMode, nativeReviewContinuationMode, nativeReviewReadbackMode, reviewReadbackMode });
  const receiptPath = join(fixture.root, artifacts.receipt);
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ phase: 'prepared', receipt: receiptPath }));
  await qualifyPreparedProcessRegistration({ enabled: processUiMode && !processReadbackMode, fixture, model: processModel, evidence, receiptPath,
    verifySourceFreeze: () => verifyDesktopSourceFreeze(repo, frozenSources, selectedSourceHashes, evidence) });
  const log = createWriteStream(
    join(fixture.root, artifacts.appLog),
    { mode: 0o600 }
  );
  // Invoke the pinned pnpm JS entry through selected Node: no /usr/bin/env
  // shebang exec transition can invalidate the captured leader identity.
  const invocation = packed ? [packed.executable, `--remote-debugging-port=${selectedCdpPort}`] : [fixture.node, pnpm, 'dev:mcp', '--remoteDebuggingPort', String(selectedCdpPort)];
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
        executable: process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
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
    } else if (processUiMode) {
      hostPid = await qualifyColdProcessUi(cdp, { fixture, evidence, group, processReadbackMode, processReadbackSource, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (await runDesktopNativeQuitMode(cdp, {mode, root: fixture.root, seed: fixture.uiSeed, evidence, model: conversationModel, assertOwnedRenderer: () => assertOwnedCdpListener(group)})) {
      // Exact Quit/readback witnesses are finalized below before fallback cleanup.
    } else if (nativeReviewMode) {
      await runDesktopNativeReview(cdp, { fixture, evidence, model: conversationModel,
        readback: nativeReviewReadbackMode, continuation: nativeReviewContinuationMode, group, onHostObserved: pid => { hostPid = pid; }, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (legacyImportMode) {
      assert.ok(conversationModel);
      await runDesktopStoppedImportUiSmoke(cdp, {
        fixture, evidence, model: conversationModel, electron,
        assertOwnedRenderer: () => assertOwnedCdpListener(group),
        observeOwnedHost: () => {
          const hosts = groupMembers(group).filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
          assert.equal(hosts.length, 1, 'one actual selected standalone Host after import');
          hostPid = hosts[0]!.pid;
          evidence.hostChildAfterImport = { ...hosts[0], command: `${fixture.node} ${fixture.hostEntry}`, observedBeforeShutdown: true };
        },
      });
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
      await runDesktopMixedCreateLaunchUiSmoke(cdp, { fixture, models: mixedModels, appGroup: group, evidence, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (createConfigMode) {
      await runDesktopCreateUiSmoke(cdp, { fixture, evidence, model: conversationModel, assertOwnedRenderer: () => assertOwnedCdpListener(group) });
    } else if (launchDialogMode) {
      assert.ok(fixture.uiSeed && conversationModel);
      await runDesktopLaunchUiSmoke(cdp, {
        fixture, seed: fixture.uiSeed, evidence, model: conversationModel,
        assertOwnedRenderer: () => assertOwnedCdpListener(group),
        ...(mode === 'native-resume-ui' ? { restartAfterStop: async () => {
          assert.ok(cdp && !packed && conversationModel);
          const originalApp = app, originalGroup = group;
          const hosts = groupMembers(group).filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
          assert.equal(hosts.length, 1, 'capture original Host before guarded cold Resume Quit');
          const originalHost = hosts[0]!; hostPid = originalHost.pid;
          const proof: Record<string, unknown> = { status: 'INCOMPLETE',
            scope: 'Guarded app Quit and captured same-profile cold startup before explicit Resume',
            firstEpoch: { app: evidence.app, startup: evidence.startup, startupOutcome: evidence.startupOutcome,
              rendererTarget: evidence.rendererTarget, compiledBundleHashesAfterStartup: evidence.compiledBundleHashesAfterStartup,
              discovery: evidence.discovery, homePathProof: evidence.homePathProof, host: originalHost } };
          evidence.coldResumeBoundary = proof;
          const stopped = await readDesktopNativeStopSessions(fixture.root);
          assert.ok(stopped.length > 0 && stopped.every(row => row.phase === 'closed' && row.custody === 'released'));
          const sourceSessions = stopped.filter(row => Array.isArray(row.inputs) && row.inputs.length === 1);
          assert.equal(sourceSessions.length, 1);
          const originalCheckpoint = await checkpoint(fixture.root, sourceSessions[0]!);
          proof.beforeQuitCheckpoint = { reference: originalCheckpoint.payload.reference,
            payloadFileSha256: originalCheckpoint.payloadFileSha256, historySha256: originalCheckpoint.historySha256 };
          // The next dev startup rebuilds dist. Retain this epoch's actual bytes first.
          const bundleDirectory = join(fixture.root, 'cold-resume-epoch1-bundles');
          const bundlePins = evidence.compiledBundleHashesAfterStartup;
          assert.ok(Array.isArray(bundlePins) && bundlePins.length > 0 && bundlePins.length <= 4096);
          for (const raw of bundlePins) {
            const pin = object(raw), relative = String(pin.path), sha = String(pin.sha256);
            assert.ok(!relative.startsWith('/') && !relative.split('/').includes('..'));
            assert.match(relative, /\.(?:cjs|js)$/); assert.match(sha, /^[a-f0-9]{64}$/);
            const source = join(repo, 'dist-electron', relative), target = join(bundleDirectory, relative);
            assert.equal(await fileDigest(source), sha);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await copyFile(source, target, constants.COPYFILE_EXCL);
            assert.equal(await fileDigest(target), sha); assert.equal(await fileDigest(source), sha);
          }
          proof.epoch1BundleSnapshot = { directory: bundleDirectory, files: bundlePins };
          assert.equal(conversationModel.observations.length, 8);
          assertOwnedCdpListener(group);
          quitRequested = true; // Fence the one original public Quit before its uncertain reply.
          const quitObservation: Record<string, unknown> = { attempted: true }; proof.firstQuit = quitObservation;
          try {
            await bounded(cdp.evaluate('window.electronAPI.windowControls.close()'), 3000, 'original cold Resume Quit');
            quitObservation.reply = 'acknowledged';
          } catch (error) {
            quitObservation.reply = 'unconfirmed';
            quitObservation.reason = /timed out/i.test(String(error)) ? 'timeout' : 'closed-or-rejected';
          }
          const until = Date.now() + 30_000;
          while (Date.now() < until && (originalApp.exitCode === null || groupMembers(originalGroup).length)) await tick();
          const remaining = groupMembers(originalGroup);
          const hostAbsent = !processTable().some(row => row.pid === originalHost.pid);
          const writerReleased = await lstat(join(fixture.root, 'hoststore/.legacy-agent-host-writer.lock'))
            .then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return true; throw error; });
          proof.firstCleanup = { appExitCode: originalApp.exitCode, appSignalCode: originalApp.signalCode,
            remaining, capturedHostAbsent: hostAbsent, writerLockReleased: writerReleased };
          assert.equal(originalApp.exitCode, 0, 'original captured app exits normally before second spawn');
          assert.equal(originalApp.signalCode, null);
          assert.deepEqual(remaining, [], 'no group cleanup fallback before cold Resume');
          assert.equal(hostAbsent, true); assert.equal(writerReleased, true);
          const postQuit = await readDesktopNativeStopSessions(fixture.root);
          const definition = object((object(JSON.parse(await readFile(fixture.profilePath, 'utf8'))).teams as unknown[])[0]);
          const descriptorMember = object((definition.members as unknown[]).find(value => object(value).memberId === object(sourceSessions[0]!.binding).memberId));
          const { teamName: _descriptorTeamName, ...descriptorBinding } = object(descriptorMember.delivery);
          // Original stopped sessions stay immutable; Quit may seal the never-opened descriptor.
          for (const original of stopped) {
            const matches = postQuit.filter(session => isDeepStrictEqual(session.binding, original.binding));
            assert.equal(matches.length, 1); assert.deepEqual(matches[0], original);
          }
          const added = postQuit.filter(session => !stopped.some(original => isDeepStrictEqual(session.binding, original.binding)));
          assert.ok(added.length <= 1, 'only one exact static descriptor tombstone may be added');
          for (const tombstone of added) {
            assert.deepEqual(tombstone.binding, descriptorBinding);
            assert.equal(tombstone.phase, 'closed'); assert.equal(tombstone.custody, 'released'); assert.equal(tombstone.sealed, true);
            assert.deepEqual(tombstone.inputs, []); assert.deepEqual(tombstone.interactions, []);
            assert.equal(tombstone.config, null); assert.equal(tombstone.openFingerprint, null); assert.equal(tombstone.nativeReady, false);
          }
          assert.equal(conversationModel.observations.length, 8, 'Quit cannot release another native input');
          await bounded(cdp.close(), 3000, 'disconnect original cold Resume renderer'); cdp = undefined;
          assert.equal(await portOccupied(), false);
          for (const [path, sha] of [[fixture.node, fixture.pins.nodeSha256], [fixture.hostEntry, fixture.pins.hostEntrySha256],
            [fixture.profilePath, fixture.pins.profileSha256], [fixture.descriptorPath, fixture.pins.descriptorSha256]])
            assert.equal(await fileDigest(path!), sha, 'same captured fixture pin before cold startup');
          const second: Record<string, unknown> = { status: 'INCOMPLETE' }; proof.secondEpoch = second;
          app = spawn(invocation[0]!, invocation.slice(1), { cwd: repo, env: fixture.appEnvironment,
            stdio: ['ignore', 'pipe', 'pipe'], detached: true });
          appEpochHandles.push(app); group = app.pid ?? 0; spawnError = false; appIdentity = ''; hostPid = undefined; quitRequested = false;
          app.once('error', () => { spawnError = true; }); app.stdout.pipe(log, { end: false }); app.stderr.pipe(log, { end: false });
          assert.ok(group > 0 && group !== originalGroup);
          appIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='], { encoding: 'utf8', timeout: 3000 }).trim();
          second.app = { pid: app.pid, processGroup: group, identity: appIdentity, invocation };
          const connected = await connectCapturedDesktopApp({ app, group, spawnError: () => spawnError, packed: undefined, cdpLibrary, evidence: second });
          cdp = connected.cdp;
          await attachRendererDiagnostics(cdp, String(connected.target.url), second, {
            remainingMs: connected.startupBudgetMs - (performance.now() - connected.startupStarted),
            assertOwnedRenderer: () => assertOwnedCdpListener(group) });
          await verifyCapturedDesktopBinding({ cdp, group, mode, fixture, evidence: second, repo, packed: undefined });
          const currentHosts = groupMembers(group).filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
          assert.equal(currentHosts.length, 1, 'one new standalone Host after cold discovery');
          assert.notEqual(currentHosts[0]!.pid, originalHost.pid); hostPid = currentHosts[0]!.pid; second.host = currentHosts[0];
          assert.deepEqual(await readDesktopNativeStopSessions(fixture.root), postQuit);
          const coldCheckpoint = await checkpoint(fixture.root, sourceSessions[0]!);
          assert.equal(coldCheckpoint.payloadFileSha256, originalCheckpoint.payloadFileSha256);
          assert.equal(coldCheckpoint.historySha256, originalCheckpoint.historySha256, 'same native history after cold Host startup');
          second.checkpointAndHistoryUnchanged = true;
          assert.equal(conversationModel.observations.length, 8, 'cold startup cannot release a prompt');
          assert.deepEqual(conversationModel.failures, []);
          second.status = 'PASS'; proof.status = 'PASS'; return cdp;
        } } : {}),
      });
    } else if (readbackMode) {
      assert.ok(fixture.uiSeed);
      await runDesktopNativeReadback(cdp, {
        root: fixture.root,
        seed: fixture.uiSeed,
        evidence,
        assertOwnedRenderer: () => assertOwnedCdpListener(group),
        assertNoNativeChildren: () => {
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
    await capturePendingDesktopNativeQuit(fixture.root, evidence, conversationModel);
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
    await verifyDesktopNativeQuitAfterShutdown(mode, fixture.root, evidence, nativeChildren, conversationModel, group);
    if (activitySource) await finalizeDesktopActivityReadback(evidence, activitySource, () => assert.equal(processTable().some(row => row.pid === hostPid), false));
    evidence.status = 'PASS';
  } catch (error) {
    evidence.failure =
      error instanceof Error ? error.message.slice(0, 4000) : 'unclassified harness failure';
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
    await verifyDesktopSourceFreeze(repo, frozenSources, selectedSourceHashes, evidence);
    if (cdp) await bounded(cdp.close(), 3000, 'disconnect test renderer').catch(() => undefined);
    let remaining: ProcessIdentity[] | null = null;
    let cleanupFailure: string | undefined;
    let capturedHostAbsent: boolean | null = null;
    try {
      // Yield for ChildProcess exit/reaping before inspecting a just-closed dev wrapper.
      await tick();
      const observationDeadline = Date.now() + 3000;
      remaining = group > 0 ? await settledGroupMembers(group, observationDeadline) : [];
      evidence.beforeHarnessCleanup = remaining;
      if (hostPid === undefined) {
        const hosts = remaining.filter(
          (row) => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`
        );
        if (hosts.length === 1) {
          hostPid = hosts[0]!.pid;
          evidence.hostChildOnFailure = {
            ...hosts[0],
            command: `${fixture.node} ${fixture.hostEntry}`,
            observedBeforeHarnessCleanup: true,
          };
        }
      }
      if (remaining.length) {
        assert.ok(!packedRelaunchMode, 'observer-only app relaunch keeps UNKNOWN debt; no old-group signal or retry');
        // A numeric PGID alone never authorizes signaling after its leader exits.
        assert.ok(
          appIdentity && remaining.some((row) => row.pid === group),
          'captured leader absent; retain cleanup debt without signaling'
        );
        const observedIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='], {
          encoding: 'utf8', timeout: 3000,
        }).trim();
        if (observedIdentity !== appIdentity && hostPid !== undefined) {
          const reaped = await observeOriginalAppReap({ child: app, group, hostPid,
            initialMembers: remaining, expectedIdentity: appIdentity, observedIdentity,
            deadline: observationDeadline });
          evidence.originalAppReap = reaped;
          if (reaped.settled) remaining = reaped.remaining!;
        }
        if (remaining.length) {
          assert.equal(observedIdentity, appIdentity, 'captured invocation identity remains current');
          try {
            process.kill(-group, 'SIGTERM');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline && (remaining = groupMembers(group)).length) await tick();
        }
      }
      capturedHostAbsent =
        hostPid === undefined ? null : !processTable().some((row) => row.pid === hostPid);
    } catch (error) {
      cleanupFailure =
        error instanceof Error ? error.message.slice(0, 4000) : 'unclassified cleanup failure';
    }
    if (evidence.coldResumeBoundary && object(evidence.coldResumeBoundary).secondEpoch) object(evidence.coldResumeBoundary).secondCleanup = {
      processGroup: group, remaining, appExitCode: app.exitCode, appSignalCode: app.signalCode, capturedHostAbsent,
      ...(cleanupFailure ? { cleanupFailure } : {}),
    };
    evidence.cleanup = {
      ...(evidence.coldResumeBoundary ? { scope: object(evidence.coldResumeBoundary).secondEpoch ? 'second captured app epoch; firstCleanup retained separately' : 'original epoch; second spawn refused' } : {}),
      processGroup: group,
      remaining,
      appExitCode: app.exitCode,
      appSignalCode: app.signalCode,
      ...(cleanupFailure ? { cleanupFailure } : {}),
      capturedHostObserved: hostPid !== undefined,
      capturedHostAbsent,
      hostExitCode: processUiMode
        ? 'cold Host app shutdown only; intentionally crashed original Host/SDK native custody remains separate HOLD, no cleanup claim'
        : nativeStopMode || launchDialogMode || createConfigMode
        ? 'not exposed by main-owned transport; consult per-flow native custody and physical child observations'
        : readbackMode
          ? 'saved closed Runtime readback; no new provider session allocated'
          : 'not exposed by main-owned transport; no provider sessions were configured',
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
    if (packed) {
      try {
        const after = await readCapturedCandidateElectron({ path: packedCapturePath!, sha256: process.env.LEGACY_DESKTOP_PACKED_CAPTURE_SHA256! });
        assert.deepEqual(after, packed, 'actual candidate resources remain exact after UI/Stop/Quit cleanup');
        evidence.packedCandidateVerifiedAfterCleanup = true;
      } catch (error) {
        evidence.packedCandidateVerificationFailure = error instanceof Error ? error.message.slice(0, 1000) : 'candidate changed';
        evidence.status = 'INCOMPLETE';
      }
    }
    await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: evidence.status, receipt: receiptPath }));
    if (packed) assert.equal(evidence.status, 'PASS', 'packed candidate proof incomplete; inspect the retained receipt before any retry');
    assert.ok(
      !cleanupFailure && remaining !== null && remaining.length === 0,
      'captured group cleanup unconfirmed; receipt retains debt and no further signal is authorized'
    );
  }
  if (mode === 'task-board-cross-team-ui') {
    assert.equal(evidence.status, 'PASS', 'original Taskboard proof and cleanup must finish before owner continuation');
    return { fixture, repo, invocation, cdpLibrary, evidence, receiptPath, frozenSources, selectedSourceHashes };
  }
}

try {
  const ownerContinuation = await main();
  if (ownerContinuation) await runDesktopOwnerRoutingContinuation(ownerContinuation);
} finally {
  await questionModel?.close();
  await conversationModel?.close();
  await mixedModels?.close();
}
