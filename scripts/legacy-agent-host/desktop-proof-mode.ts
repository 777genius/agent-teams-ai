import assert from 'node:assert/strict';
import { startProcessModel } from './desktop-native-process-model.ts';
import { readProcessServices } from './desktop-native-process-fixture.ts';
import { startDesktopMixedModels } from './desktop-mixed-native-fixture.ts';
import { startDesktopApprovalModel } from './desktop-approval-model.ts';
import { startNativeReviewModel } from './desktop-native-review-model.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  startNativeTeamModel,
  record,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

/** TEST proof composition only; original modes retain their inference/setup semantics. */
export async function prepareDesktopProofMode(
  mode: string,
  fixtureRoot: () => string,
  processBashCommand?: () => string
) {
  assert.ok(
    [
      'native-process-ui',
      'native-extensions-ui',
      'native-activity-readback-ui',
      'bridge-diagnostics',
      'team-ui',
      'skills-ui',
      'task-board-ui',
      'task-board-cross-team-ui',
      'cross-team-ui',
      'approval-ui',
      'native-stop-ui',
      'native-quit-ui',
      'native-quit-readback-ui',
      'native-conversation-ui',
      'native-readback-ui',
      'codex-account-read',
      'codex-account-auth',
      'native-launch-ui',
      'native-relaunch-ui',
      'native-resume-ui',
      'create-config-ui',
      'native-create-ui',
      'native-mixed-create-launch-ui',
      'review-ui',
      'review-readback-ui',
      'stopped-import-ui',
      'native-review-ui',
      'native-review-readback-ui',
      'native-review-continuation-ui',
    ].includes(mode),
    'explicit known proof mode'
  );
  const mixedMode = mode === 'native-mixed-create-launch-ui';
  const processUiMode = mode === 'native-process-ui';
  if (processUiMode) {
    assert.equal(
      process.env.LEGACY_M19_PROVIDER_UI_GO,
      '1',
      'explicit native process registration/UI Stop GO'
    );
    assert.equal(
      process.env.LEGACY_M19_ORIGINAL_HOST_CRASH_GO,
      '1',
      'explicit original held Host ChildProcess SIGKILL GO'
    );
  }
  const processModel = processUiMode
    ? await startProcessModel({
        bashCommand: () => {
          assert.ok(processBashCommand, 'original prepared process fixture command');
          return processBashCommand();
        },
        async services() {
          for (const end = Date.now() + 10_000; Date.now() < end; ) {
            try {
              return await readProcessServices(fixtureRoot());
            } catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
                throw error;
            }
            await delay(25); // Original background publication only; never rerun Bash.
          }
          throw new Error('Original finite service publication exhausted; no replay');
        },
        async serviceLifecycle(role) {
          const text = readFileSync(
            join(fixtureRoot(), 'workspace', `process-${role}-lifecycle.ndjson`),
            'utf8'
          );
          assert.ok(Buffer.byteLength(text) <= 8192, 'finite original service lifecycle');
          return text
            .trim()
            .split('\n')
            .map((line) => record(JSON.parse(line)));
        },
      })
    : undefined;
  const nativeReviewContinuationMode = mode === 'native-review-continuation-ui';
  const nativeReviewMode =
    mode === 'native-review-ui' ||
    mode === 'native-review-readback-ui' ||
    nativeReviewContinuationMode;
  const nativeReviewReadbackMode =
    mode === 'native-review-readback-ui' || nativeReviewContinuationMode;
  const readbackMode =
    mode === 'native-readback-ui' ||
    mode === 'native-quit-readback-ui' ||
    mode === 'native-activity-readback-ui';
  const reviewUiMode = mode === 'review-ui' || mode === 'review-readback-ui';
  const reviewReadbackMode = mode === 'review-readback-ui';
  const legacyImportMode = mode === 'stopped-import-ui';
  const taskBoardUiMode = ['task-board-ui', 'task-board-cross-team-ui', 'cross-team-ui'].includes(
    mode
  );
  const approvalUiMode = mode === 'approval-ui';
  const conversationMode = mode === 'native-conversation-ui';
  const chatAttachments = process.env.LEGACY_DESKTOP_CHAT_ATTACHMENTS === '1';
  const groupChats = process.env.LEGACY_DESKTOP_GROUP_CHATS === '1';
  if (groupChats) {
    assert.equal(mode, 'native-conversation-ui');
    assert.equal(chatAttachments, false, 'one scoped native conversation scenario');
  }
  if (chatAttachments)
    assert.equal(
      mode,
      'native-conversation-ui',
      'attachment scenario extends existing native conversation only'
    );
  const relaunchMode = mode === 'native-relaunch-ui';
  const resumeMode = mode === 'native-resume-ui';
  const launchDialogMode =
    mode === 'native-launch-ui' ||
    relaunchMode ||
    resumeMode ||
    (nativeReviewMode && !nativeReviewReadbackMode);
  const createConfigMode = mode === 'create-config-ui' || mode === 'native-create-ui' || mixedMode;
  const createLaunchMode = mode === 'native-create-ui';
  const nativeStopMode =
    mode === 'native-stop-ui' || mode === 'native-quit-ui' || conversationMode || approvalUiMode;
  const uiMode =
    mode === 'native-extensions-ui' ||
    mode === 'skills-ui' ||
    processUiMode ||
    mode === 'team-ui' ||
    taskBoardUiMode ||
    nativeReviewMode ||
    legacyImportMode ||
    reviewUiMode ||
    nativeStopMode ||
    readbackMode ||
    launchDialogMode ||
    createConfigMode ||
    createLaunchMode;
  const mixedModels = mixedMode ? await startDesktopMixedModels(fixtureRoot) : undefined;
  const model = processUiMode
    ? processModel
    : mode === 'native-quit-ui'
      ? await startNativeTeamModel({
          requireVisibleReply: true,
          uiGeneratedMessageIds: true,
          holdInitialTurnResponse: true,
        })
      : approvalUiMode
        ? await startDesktopApprovalModel({
            workspace: () => join(fixtureRoot(), 'workspace'),
          })
        : nativeReviewMode && !nativeReviewReadbackMode
          ? await startNativeReviewModel({
              workspace: () => join(fixtureRoot(), 'workspace'),
              principalId: () => {
                const state = record(
                  JSON.parse(
                    readFileSync(
                      join(
                        fixtureRoot(),
                        'hoststore/teams/test-desktop-backend/.host-owner/state.json'
                      ),
                      'utf8'
                    )
                  )
                );
                assert.ok(
                  Array.isArray(state.runtimeCaptures) && state.runtimeCaptures.length === 1
                );
                const capture = record(state.runtimeCaptures[0]);
                assert.ok(Array.isArray(capture.members) && capture.members.length === 1);
                const member = record(capture.members[0]);
                assert.equal(member.memberId, 'alice-id');
                assert.ok(
                  typeof member.principalId === 'string' && member.principalId.startsWith('agent:')
                );
                return member.principalId;
              },
            })
          : legacyImportMode
            ? await startNativeTeamModel({ allowModelProbes: true })
            : conversationMode
              ? await startNativeTeamModel({
                  requireVisibleReply: true,
                  uiGeneratedMessageIds: true,
                  ...(chatAttachments ? { chatAttachments: true } : {}),
                  ...(groupChats ? { groupChats: true } : {}),
                })
              : launchDialogMode || createLaunchMode
                ? await startNativeTeamModel({
                    allowModelProbes: true,
                    ...(resumeMode
                      ? { uiGeneratedMessageIds: true, captureHistoryMarkers: true }
                      : {}),
                    ...(createLaunchMode ? { memberName: 'team-lead' as const } : {}),
                    principalId: () => {
                      const state = record(
                        JSON.parse(
                          readFileSync(
                            join(
                              fixtureRoot(),
                              `hoststore/teams/${createLaunchMode ? 'test-created-native' : 'test-desktop-backend'}/.host-owner/state.json`
                            ),
                            'utf8'
                          )
                        )
                      );
                      assert.ok(Array.isArray(state.runtimeCaptures));
                      const captures = state.runtimeCaptures;
                      assert.ok(
                        captures.length === 1 || (relaunchMode && captures.length === 2),
                        'explicit native capture budget'
                      );
                      if (captures.length === 2) {
                        const sessionsRoot = join(fixtureRoot(), 'hoststore/runtime-sessions');
                        const namespaces = readdirSync(sessionsRoot, {
                          withFileTypes: true,
                        });
                        assert.ok(
                          namespaces.length <= 16 &&
                            namespaces.every(
                              (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)
                            )
                        );
                        const sessions = namespaces.flatMap((namespace) => {
                          const directory = join(sessionsRoot, namespace.name);
                          const entries = readdirSync(directory, {
                            withFileTypes: true,
                          });
                          assert.ok(entries.length <= 512);
                          const files = entries.filter((entry) =>
                            /^[a-f0-9]{64}\.json$/.test(entry.name)
                          );
                          assert.ok(files.length <= 256 && files.every((entry) => entry.isFile()));
                          return files.map((entry) =>
                            record(JSON.parse(readFileSync(join(directory, entry.name), 'utf8')))
                          );
                        });
                        const original = sessions.filter(
                          (session) =>
                            record(session.binding).runId === record(captures[0]).launchId
                        );
                        assert.equal(
                          original.length,
                          1,
                          'exact original runtime before second native receipt'
                        );
                        assert.equal(original[0]!.phase, 'closed');
                        assert.equal(original[0]!.custody, 'released');
                      }
                      const capture = record(captures.at(-1));
                      assert.ok(Array.isArray(capture.members) && capture.members.length === 1);
                      const member = record(capture.members[0]);
                      if (!createLaunchMode) assert.equal(member.memberId, 'alice-id');
                      assert.equal(typeof member.principalId, 'string');
                      assert.ok(String(member.principalId).startsWith('agent:'));
                      return String(member.principalId);
                    },
                  })
                : undefined;
  return {
    mixedMode,
    mixedModels,
    processUiMode,
    processModel,
    nativeReviewMode,
    nativeReviewReadbackMode,
    nativeReviewContinuationMode,
    readbackMode,
    reviewUiMode,
    reviewReadbackMode,
    legacyImportMode,
    conversationMode,
    taskBoardUiMode,
    approvalUiMode,
    launchDialogMode,
    createConfigMode,
    createLaunchMode,
    nativeStopMode,
    uiMode,
    model,
  };
}
