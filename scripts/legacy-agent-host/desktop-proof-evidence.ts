import { desktopNativeProviderArtifact } from './desktop-native-stop-fixture.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { prepareDesktopProofFixture } from './desktop-proof-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import type { startCodexModel } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
export async function desktopProofEvidence(options: {
  mode: string;
  fixture: Awaited<ReturnType<typeof prepareDesktopProofFixture>>;
  pnpm: string;
  pnpmSha256: string;
  electron: string;
  smokePath: string;
  conversationMode: boolean;
  nativeStopMode: boolean;
  uiMode: boolean;
  conversationModel?: Awaited<ReturnType<typeof startNativeTeamModel>> | undefined;
  codexResumeModel?: Awaited<ReturnType<typeof startCodexModel>> | undefined;
}): Promise<Record<string, unknown>> {
  const {
    mode,
    fixture,
    pnpm,
    pnpmSha256,
    electron,
    conversationMode,
    nativeStopMode,
    uiMode,
    conversationModel,
    codexResumeModel,
  } = options;
  const resumeEvidence: Record<string, unknown> = {};
  if (mode === 'native-resume-ui') {
    const provider = codexResumeModel ? 'codex' : 'claude';
    const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8'));
    const members = profile.runtime?.members;
    assert.ok(Array.isArray(members) && members.length === 1);
    const member = members[0];
    assert.equal(member.memberId, 'alice-id'); assert.equal(member.provider, provider);
    if (codexResumeModel) {
      assert.ok(fixture.codexResume);
      assert.deepEqual(member.capturedMcpServers, {});
      assert.match(String(member.capturedMcpCatalog?.digest), /^[a-f0-9]{64}$/);
      assert.equal(member.model, fixture.codexResume.model);
      resumeEvidence.codexResumeCatalog = fixture.codexResume;
    }
    resumeEvidence.resumeProvider = provider;
    resumeEvidence.resumeNativeProfile = { provider, memberId: member.memberId, model: member.model,
      executableSha256: member.executable?.sha256,
      ...(codexResumeModel ? { managedMcp: true, catalogDigest: member.capturedMcpCatalog.digest } : {}) };
  }
  return {
    status: 'INCOMPLETE',
    mode,
    ...resumeEvidence,
    ...(codexResumeModel ? { model: {
      observations: codexResumeModel.observations, probes: codexResumeModel.probes,
      failures: codexResumeModel.failures,
      inference: 'Local scripted model only; actual native Codex app-server executes all tools',
    } } : {}),
    ...(conversationModel
      ? {
          model: {
            observations: conversationModel.observations,
            ...(conversationModel.nativeMemberObservations ? { nativeMemberObservations: conversationModel.nativeMemberObservations } : {}),
            probes: conversationModel.probes,
            unexpectedNoToolsRequests: conversationModel.unexpectedNoToolsRequests,
            failures: conversationModel.failures,
            inference: 'Local scripted model only; actual native Claude executes all tools',
          },
        }
      : {}),
    scope:
      mode === 'native-process-ui'
        ? 'Actual native Bash/private MCP registration and original Host crash/cold reconnect; visible original row with no Stop if absent, or one original-ref Stop if same-live; Runtime custody stays HOLD, no native cleanup or natural-expiry claim'
        : mode === 'native-activity-readback-ui'
          ? 'Original Member Logs/Stats and reload from exact retained native child proof; original profile/store unchanged through Host close, zero native replay'
          : mode === 'native-mixed-create-launch-ui'
            ? 'Original Create save-only three-provider roster, saved Launch model checks and native capture, original Composer messages/MCP/Bash/replies for three providers, Stop and reload; localhost inference only'
            : mode === 'native-quit-ui'
              ? 'Original Composer twice, one real native inference held and one durably queued input, original guarded Quit via semantic public UI API; no human menu click or Stop'
              : mode === 'native-quit-readback-ui'
                ? 'Exact retained profile next startup after original app/Host/native exit and lock release; original sealed inputs and product data unchanged, no new native allocation'
                : mode === 'cross-team-ui'
                  ? 'Existing same-Host cross-Team selector/Send/Reply/reload only; independent canonical product effects, no Task board/review replay, native execution or full M05 claim'
                  : mode === 'task-board-cross-team-ui'
                    ? 'Existing offline Task board/dependency/assignment/drag/review-change-fix-approve controls followed by same-Host cross-Team selector/Send/Reply/reload in the same app; canonical product effects only, no native execution or full M05 claim'
                    : mode === 'approval-ui'
                      ? 'Existing technical permission/question Sheet through actual SDK/CLI, captured private preview, per-request Allow/Deny/answers and one original approval preference synchronization; explicit TEST setup launch and localhost scripted inference'
                      : mode === 'native-review-continuation-ui'
                        ? 'Two source epochs: original native Task capture/initial review Undo failure preserved, then existing original review Undo/Redo/history/reload; no native replay or allocation'
                        : mode === 'native-review-ui' || mode === 'native-review-readback-ui'
                          ? 'Actual foreground Read/Edit after original Task Start, canonical native capture proof, original Changes hunk decisions, Stop, renderer reload and separate Host restart; narrow qualified file effects, no global M13 claim'
                          : mode === 'stopped-import-ui'
                            ? process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH === '1'
                              ? 'Synthetic stopped legacy solo records with real captured source-owned TEST child Stop publication; original Main/Host import and fresh actual SDK/CLI Launch/task/Bash/reply/Stop/reload, no old provider inference'
                              : 'Original never-launched configured legacy Team Launch action → Main/Host detached import → canonical saved Launch dialog, close without Submit and renderer reload; optional local SDK model probe only, no native Team input'
                            : mode === 'review-ui' || mode === 'review-readback-ui'
                              ? 'Original Task Changes UI through captured Main/Host review transport with synthetic canonical ledger, real dirty filesystem, history and saved-state readback; no native M13 capture qualification'
                              : mode === 'native-create-ui'
                                ? 'Original CreateTeamDialog controls through scoped private template/model preflight, durable Host registry/capture, actual Claude SDK localhost MCP/Bash/reply, Stop and renderer reload'
                                : mode === 'create-config-ui'
                                  ? 'Original CreateTeamDialog save-only controls through Main/Host registry, canonical Team navigation, product readback and real renderer reload; no native agent launch'
                                  : mode === 'native-resume-ui'
                                    ? 'Original Launch/Stop/reload/explicit Resume checkpoint/Composer Send/Stop controls, same product launch with a new technical generation, exact retained native history and actual SDK localhost inference'
                                    : mode === 'native-relaunch-ui'
                                      ? 'Two fresh runs of the same captured Host Team via original Launch/Stop/reload/Launch controls, distinct native conversations and retained product Task/replies; actual SDK localhost inference'
                                      : mode === 'native-launch-ui'
                                        ? 'Original LaunchTeamDialog controls through saved Team capture/standalone Host/actual Claude SDK and local inference, native MCP/Bash, Stop and settings readback after reload'
                                        : mode === 'native-readback-ui'
                                          ? 'Ordinary UI readback from exact retained TEST profile/store after app restart; zero new Native launch/restore/message/tool commands'
                                          : conversationMode
                                            ? process.env.LEGACY_DESKTOP_GROUP_CHATS === '1'
                                              ? 'Existing Group chat Create/directed Send/native group MCP source/ACK/reply, human reaction/archive/renderer reload/restore and ordinary Stop of both captured SDK actors; TEST localhost inference only'
                                              : 'Ordinary Desktop Composer/Send and visible native MCP replies, actual Claude SDK/CLI/Bash/tasks, second input continuity and ordinary Stop before Quit'
                                            : nativeStopMode
                                              ? 'Ordinary Desktop Task and Stop controls against actual Claude SDK/CLI via standalone Host; explicit TEST API setup launch, no model inputs'
                                              : uiMode
                                                ? 'Ordinary Desktop Task UI controls through renderer adapter/main/Host/Team filesystem'
                                                : [
                                                      'codex-account-read',
                                                      'codex-account-auth',
                                                    ].includes(mode)
                                                  ? 'Codex account/quota Desktop API through preload/Main/Host/D/native TEST profile'
                                                  : 'Desktop preload agentBackend API bridge diagnostics; actual main/Host/Team filesystem path',
    excluded:
      mode === 'native-process-ui'
        ? [
            'vendor model qualification',
            'whole process tree stop',
            'provider Runtime/native-root cleanup qualification',
            'PID/group signal fallback',
            'automatic uncertain stop retry',
            'full P4/P8',
            'full fork-free/P5 sentinel qualification',
            'legacy maintenance cutover',
          ]
        : [
            ...(uiMode ? [] : ['user control signoff']),
            ...(conversationMode ||
            (mode === 'stopped-import-ui' &&
              process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH === '1') ||
            [
              'native-launch-ui',
              'native-relaunch-ui',
              'native-resume-ui',
              'native-create-ui',
              'native-review-ui',
              'approval-ui',
              'native-quit-ui',
              'native-process-ui',
              'native-mixed-create-launch-ui',
            ].includes(mode)
              ? ['vendor model qualification']
              : nativeStopMode
                ? ['native inference']
                : ['provider sessions', 'native agents']),
            ...(['native-quit-ui', 'native-quit-readback-ui'].includes(mode)
              ? [
                  'automatic app.relaunch',
                  'pending provider-open',
                  'human macOS menu/window click',
                  'Stage2',
                ]
              : []),
            ...((mode === 'stopped-import-ui' &&
              process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH === '1') ||
            [
              'native-launch-ui',
              'native-relaunch-ui',
              'native-resume-ui',
              'native-create-ui',
              'native-mixed-create-launch-ui',
              'native-review-ui',
            ].includes(mode)
              ? []
              : ['Desktop team launch']),
            'full P4/P8',
            'full fork-free/P5 sentinel qualification',
            'legacy maintenance cutover',
          ],
    root: fixture.root,
    pins: {
      ...fixture.pins,
      providerArchiveSha256: await fileDigest(
        join(import.meta.dirname, '../../' + desktopNativeProviderArtifact.path)
      ),
      pnpmSha256,
      electronSha256: await fileDigest(electron),
      smokeSourceSha256: await fileDigest(options.smokePath),
      fixtureSourceSha256: await fileDigest(
        join(import.meta.dirname, 'desktop-backend-fixture.ts')
      ),
      uiSourceSha256: await fileDigest(join(import.meta.dirname, 'desktop-team-ui-smoke.ts')),
    },
    paths: {
      node: fixture.node,
      hostEntry: fixture.hostEntry,
      pnpm,
      descriptor: fixture.descriptorPath,
      profile: fixture.profilePath,
    },
    packageManager: fixture.packageManager,
    operations: [] as unknown[],
  };
}
