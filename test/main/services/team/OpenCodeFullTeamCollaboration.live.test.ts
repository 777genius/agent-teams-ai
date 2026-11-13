// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { getOpenCodeLaneScopedRuntimeFilePath } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import { getTeamsBasePath, setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import { assertOpenCodeSmokeCleanup } from './assertOpenCodeSmokeCleanup';
import { type FullPeerObservation,type FullPeerTarget, settleFullTeamPeers } from './openCodeFullPeerSettlement';
import {
  classifyFailure,
  cleanupMetadata,
  ownedRegistryMetadata,
  snapshotMetadata,
  transcriptMetadata,
} from './openCodeFullTeamProofDiagnostics';
import {
  getRuntimeTranscript,
  waitForMemberInboxMessage,
  waitForOpenCodeLanesStopped,
  waitUntil,
} from './openCodeLiveTestHarness';
import {
  assertOwnedSmokeEnvironment,
  assertStoppedSnapshot,
  assertTranscriptModel,
  assertTranscriptSession,
  finalizeProof,
  hasExecution,
  hasMessage,
  hasTaskCompletion,
  hasTaskComment,
  relayMetadata,
  successfulTools,
} from './openCodeMixedTeamEvidence';
import { createMixedHarness as createHarness } from './openCodeMixedTeamHarness';
import {
  classifyTeamTranscriptGeneration,
  hasV2CommandInvocationWithOuterMarker,
  hasV2Message,
  hasV2TaskCompletion,
  hasV2TaskComment,
  readV2TeamInvocationEvidence,
} from './openCodeV2TeamEvidence';

import type { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import type {
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
} from '../../../../src/shared/types';
import type { OpenCodeOriginalTranscriptBinding } from './openCodeLiveTestHarness';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_FULL_TEAM === '1'
    ? describe
    : describe.skip;
const members = ['alice', 'bob'] as const;
type Member = (typeof members)[number];
type JsonRecord = Record<string, unknown>;

liveDescribe('OpenCode full paid team collaboration', () => {
  it(
    'executes cooperative board work, semantic peer replies, and fresh work after relaunch',
    async () => {
      await assertOwnedSmokeEnvironment(process.env, 'FULL');
      const projectPath = requiredEnv('OPENCODE_E2E_PROJECT_PATH');
      const model = requiredEnv('OPENCODE_E2E_MODEL');
      const proofDirectory = requiredEnv('OPENCODE_E2E_PROOF_DIRECTORY');
      expect(projectPath).toBe(requiredEnv('OPENCODE_E2E_OWNED_PROJECT_PATH'));
      expect(path.isAbsolute(projectPath)).toBe(true);
      expect(await fs.realpath(projectPath)).not.toBe(await fs.realpath(process.cwd()));
      const tempDir = await fs.mkdtemp(path.join(requiredEnv('TMPDIR'), 'full-team-state-'));
      const claudeRoot = path.join(tempDir, '.claude');
      await fs.mkdir(claudeRoot, { mode: 0o700 });
      setClaudeBasePathOverride(claudeRoot);
      const teamName = `full-team-${randomUUID()}`;
      const proof: JsonRecord = {
        schemaVersion: 1,
        status: 'running',
        model,
        teamName,
        transport: 'service-api-submit-once',
        startedAt: new Date().toISOString(),
        cleanupConfirmed: false,
      };
      const progress: TeamProvisioningProgress[] = [];
      let phase = 'setup';
      let cleanupFailure = false;
      let pendingProofWrite = Promise.resolve();
      async function checkpoint(nextPhase: string) {
        phase = nextPhase;
        proof.phase = phase;
        proof.updatedAt = new Date().toISOString();
        const json = `${JSON.stringify(proof, null, 2)}\n`;
        pendingProofWrite = pendingProofWrite
          .catch(() => undefined)
          .then(async () => {
            const temporary = path.join(proofDirectory, 'proof.json.tmp');
            await fs.writeFile(temporary, json, { mode: 0o600 });
            await fs.rename(temporary, path.join(proofDirectory, 'proof.json'));
          });
        await pendingProofWrite;
      }
      let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
      let activeTranscript: { runId: string; snapshot: TeamAgentRuntimeSnapshot } | undefined;
      let peerTargets: FullPeerTarget[] = [];
      let peerSettlementAttempted = false;
      async function settlePeers() {
        if (!activeTranscript || peerTargets.length !== 4) return;
        peerSettlementAttempted = true;
        const binding = activeTranscript;
        const laneIds = [...new Set(members.map(member => binding.snapshot.members[member].laneId))];
        proof.peerSettlement = await settleFullTeamPeers({
          teamName, runId: binding.runId, targets: peerTargets, timeoutMs: 120_000,
          read: async () => {
            const rows = (await Promise.all(members.map(async member =>
              JSON.parse(await fs.readFile(path.join(getTeamsBasePath(), teamName, "inboxes", `${member}.json`), "utf8")) as FullPeerObservation["rows"]))).flat();
            const receipts = (await Promise.all(laneIds.map(async laneId => {
              if (!laneId) throw new Error("Missing owned lane");
              const ledger = JSON.parse(await fs.readFile(getOpenCodeLaneScopedRuntimeFilePath({
                teamsBasePath: getTeamsBasePath(), teamName, laneId,
                fileName: "opencode-prompt-delivery-ledger.json",
              }), "utf8")) as { schemaVersion: number; data: FullPeerObservation["receipts"] };
              if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.data)) throw new Error("Invalid owned ledger");
              return ledger.data;
            }))).flat();
            return { rows, receipts };
          },
        });
        await checkpoint(phase);
      }
      const observed: Partial<Record<Member, ReturnType<typeof transcriptMetadata>>> = {};
      async function observe(member: Member) {
        if (!harness || !activeTranscript) return;
        observed[member] = transcriptMetadata(
          await getRuntimeTranscript({
            bridgeClient: harness.bridgeClient,
            teamName,
            memberName: member,
            projectPath,
            originalBinding: transcriptBinding(
              activeTranscript.runId,
              activeTranscript.snapshot,
              member
            ),
          })
        );
        proof.memberRuntime = observed;
        await checkpoint(phase);
        if (observed[member]?.terminalAborted) throw new Error('MessageAbortedError');
      }
      async function captureRuntime() {
        if (!harness) return;
        const tasks = await new TeamTaskReader().getTasks(teamName).catch(() => []);
        proof.observedTasks = tasks
          .slice(0, 12)
          .map(({ id, owner, status }) => ({ id, owner, status }));
        proof.runtimeBeforeCleanup = snapshotMetadata(
          await harness.svc.getTeamAgentRuntimeSnapshot(teamName).catch(() => null),
          model
        );
        proof.registryBeforeCleanup = await ownedRegistryMetadata(
          requiredEnv('CLAUDE_MULTIMODEL_DATA_HOME'),
          projectPath
        );
        await Promise.all(members.map((member) => observe(member).catch(() => undefined)));
      }
      try {
        // Hosted Linux may not provide a usable system Node. Use the actual
        // test runner's Node inside this disposable project, without granting
        // the team access to an unrelated host installation.
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        const nodeCommand = process.platform === 'linux'
          ? quote(path.join(projectPath, '.TEST-node-runtime')) : 'node';
        const testScriptCommand = process.platform === 'linux'
          ? quote(path.join(projectPath, 'sum.test.cjs')) : 'sum.test.cjs';
        if (process.platform === 'linux') {
          const nodeSource = await fs.realpath(process.execPath);
          const sourceStat = await fs.lstat(nodeSource);
          expect(sourceStat.isFile()).toBe(true);
          await fs.access(nodeSource, constants.X_OK);
          const nodeFixture = path.join(projectPath, '.TEST-node-runtime');
          await fs.copyFile(nodeSource, nodeFixture, constants.COPYFILE_EXCL);
          await fs.chmod(nodeFixture, 0o700);
        }
        harness = await createHarness(tempDir, claudeRoot);
        const { svc, bridgeClient } = harness;
        // Neither host nor setup writes these agent-owned artifacts.
        for (const file of [
          'sum.cjs',
          'sum.test.cjs',
          'alice-result.txt',
          'bob-result.txt',
          'relaunch-alice.txt',
          'relaunch-bob.txt',
        ]) {
          await expect(fs.lstat(path.join(projectPath, file))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        await checkpoint('initial-launch');
        const { runId } = await svc.createTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            model,
            skipPermissions: true,
            prompt: [
              `This is a disposable test project. Work only inside ${projectPath}.`,
              'Do not spawn agents or install packages. Lead may create board tasks for existing members when requested. Do not modify files until assigned a board task.',
              'When a peer message starts CHALLENGE:, use the team message tool to reply to its sender',
              'with ACK: followed by exactly the token after CHALLENGE:. Do not reply to ACK messages.',
              'Peer messages are independent of your board task; do not wait or sleep for them.',
            ].join('\n'),
            members: members.map((name) => ({
              name,
              role: name === 'alice' ? 'Developer' : 'Reviewer',
              providerId: 'opencode',
              model,
            })),
          },
          (event) => progress.push(event)
        );
        await ready(progress);
        const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
        expect(snapshot.runId).toBe(runId);
        for (const member of members) {
          expect(snapshot.members[member]).toMatchObject({
            alive: true,
            providerId: 'opencode',
            runtimeModel: model,
            historicalBootstrapConfirmed: true,
          });
          expect(snapshot.members[member].runtimeSessionId).toBeTruthy();
        }
        expect(snapshot.members.alice.runtimeSessionId).not.toBe(
          snapshot.members.bob.runtimeSessionId
        );
        proof.runId = runId;
        proof.initialSessions = Object.fromEntries(
          members.map((name) => [name, snapshot.members[name].runtimeSessionId])
        );
        activeTranscript = { runId, snapshot };

        await checkpoint('assigned-work');
        const taskService = new TeamDataService();
        const reader = new TeamTaskReader();
        await checkpoint('lead-assigned-work');
        const leadSubject = `Lead assignment ${randomUUID()}`;
        const leadMarker = `LEAD_ASSIGNED:${randomUUID()}`;
        const leadRequest = await taskService.sendMessage(teamName, {
          member: 'team-lead', from: 'user',
          text: [
            'Use agent-teams_task_create exactly once to create a board task; do not perform it yourself.',
            `Set subject to exactly ${leadSubject}, owner to alice, createdBy to team-lead, and startImmediately to true.`,
            `Set prompt to: Do not edit files. Add one task comment containing exactly ${leadMarker}. Then complete this task with task_complete.`,
            'Do not create any other tasks or send follow-up messages.',
          ].join('\n'),
        });
        proof.leadAssignmentRequestId = leadRequest.messageId;
        await svc.relayInboxFileToLiveRecipient(teamName, 'team-lead');
        let leadTaskId: string | undefined;
        let leadTaskSubmitted = false;
        await waitUntil(async () => {
          const matches = (await reader.getTasks(teamName)).filter(task => task.subject === leadSubject);
          expect(matches.length).toBeLessThanOrEqual(1);
          const task = matches[0];
          if (!task) return false;
          expect(task.createdBy).toBe('team-lead');
          expect(task.owner).toBe('alice');
          leadTaskId = task.id;
          if (!leadTaskSubmitted) {
            leadTaskSubmitted = true;
            await submitTaskOnce(svc, teamName, 'alice');
          }
          return task.status === 'completed' && task.comments?.some(comment =>
            comment.author === 'alice' && comment.text === leadMarker) === true;
        }, 300_000, 2_000);
        const leadRuntime = snapshot.members['team-lead'];
        expect(leadRuntime).toMatchObject({ alive: true, runtimeModel: model });
        const leadTranscript = await getRuntimeTranscript({
          bridgeClient, teamName, memberName: 'team-lead', projectPath,
          originalBinding: { runId, laneId: leadRuntime.laneId ?? '',
            runtimeSessionId: leadRuntime.runtimeSessionId ?? '' },
        });
        assertTranscriptModel(leadTranscript, model);
        assertTranscriptSession(leadTranscript, leadRuntime.runtimeSessionId);
        // Actor/from fields in the board are caller-controlled. Require matching
        // completed tool invocations in Alice's original bound runtime, not only
        // rows that the lead could write while impersonating Alice.
        const assignedTaskId = leadTaskId;
        if (!assignedTaskId) throw new Error('Lead-assigned task ID unavailable');
        const assignedTask = (await reader.getTasks(teamName)).find(
          (task) => task.id === assignedTaskId
        );
        const aliceAssignedTranscript = await getRuntimeTranscript({
          bridgeClient, teamName, memberName: 'alice', projectPath,
          originalBinding: transcriptBinding(runId, snapshot, 'alice'),
        });
        assertTranscriptModel(aliceAssignedTranscript, model);
        assertTranscriptSession(aliceAssignedTranscript, snapshot.members.alice.runtimeSessionId);
        const aliceV2Evidence =
          classifyTeamTranscriptGeneration(aliceAssignedTranscript) === 'v2'
            ? readV2TeamInvocationEvidence(aliceAssignedTranscript, {
                teamName, memberName: 'alice', selectedModel: model,
                ...transcriptBinding(runId, snapshot, 'alice'),
              })
            : null;
        const aliceV1Calls = aliceV2Evidence ? [] : successfulTools(aliceAssignedTranscript);
        expect(
          aliceV2Evidence
            ? hasV2TaskCompletion(aliceV2Evidence, { taskId: assignedTaskId }, assignedTask) &&
              hasV2TaskComment(aliceV2Evidence, {
                taskId: assignedTaskId, text: leadMarker,
              }, assignedTask)
            : hasTaskCompletion(aliceV1Calls, teamName, assignedTaskId, 'alice') &&
              hasTaskComment(aliceV1Calls, teamName, assignedTaskId, 'alice', leadMarker)
        ).toBe(true);
        proof.leadAssignedTask = { id: assignedTaskId, owner: 'alice', createdBy: 'team-lead',
          completed: true, ownerCommentConfirmed: true, aliceRuntimeProof: true };

        const aliceNonce = randomUUID();
        const bobNonce = randomUUID();
        const aliceCommand = `${nodeCommand} -e 'const {sum}=require("./sum.cjs"); const a=require("node:assert/strict"); a.equal(sum([2,-5,7]),4); a.equal(sum([]),0); a.throws(()=>sum([NaN]),TypeError); console.log("ALICE_EXEC:${aliceNonce}")'`;
        const bobCommand = `${nodeCommand} ${testScriptCommand}`;
        const taskBase = [
          `Work only in ${projectPath}; do not delegate or install packages.`,
          'Use bash to execute the supplied verification command verbatim in the project directory. Do not prepend cd or append commands.',
          `Set the bash tool's workdir field to exactly ${projectPath}.`,
          'Complete this assigned task with task_complete only after success.',
          'Do not modify peer-owned files. Never sleep or poll for messages.',
          'For any CHALLENGE:token peer message, send its sender exactly ACK:token using agent-teams_message_send. Never respond to ACK messages.',
        ];
        const aliceTask = await taskService.createTask(teamName, {
          subject: 'Implement sum and execute edge cases',
          owner: 'alice',
          startImmediately: true,
          prompt: [
            ...taskBase,
            'Own only sum.cjs and alice-result.txt. Implement sum(values) returning the sum of finite numbers.',
            'Throw TypeError for non-arrays or any non-finite/non-number element. Empty input returns 0.',
            'Export with module.exports = { sum }.',
            `Run exactly: ${aliceCommand}`,
            `After successful execution write alice-result.txt containing exactly ALICE_EXEC:${aliceNonce} and one newline.`,
            `Send bob the exact team message CHALLENGE:${aliceNonce} using agent-teams_message_send.`,
          ].join('\n'),
        });
        proof.aliceTask = { id: aliceTask.id, owner: 'alice', status: 'submitted' };
        await checkpoint('alice-task-submitted');
        await submitTaskOnce(svc, teamName, 'alice');
        await completed(reader, teamName, aliceTask.id, 'alice', () => observe('alice'));
        proof.aliceTask = { id: aliceTask.id, owner: 'alice', status: 'completed' };
        await checkpoint('alice-task-completed');
        await exactFile(projectPath, 'alice-result.txt', `ALICE_EXEC:${aliceNonce}\n`);
        const bobTask = await taskService.createTask(teamName, {
          subject: 'Independently test and review sum',
          owner: 'bob',
          startImmediately: true,
          prompt: [
            ...taskBase,
            'Own only sum.test.cjs and bob-result.txt. Read sum.cjs but do not change it.',
            'Create sum.test.cjs using node:assert/strict. Test sum([2,-5,7])===4 and sum([])===0;',
            'also test sum([1.5,2.5])===4, sum([-2,-3])===-5, and TypeError for null, [NaN], [Infinity], and ["1"].',
            `At the end print BOB_EXEC:${bobNonce}. Run exactly: ${bobCommand}`,
            `After it passes write bob-result.txt containing exactly BOB_EXEC:${bobNonce} and one newline.`,
            `Send alice the exact team message CHALLENGE:${bobNonce} using agent-teams_message_send.`,
          ].join('\n'),
        });
        proof.bobTask = { id: bobTask.id, owner: 'bob', status: 'submitted' };
        await checkpoint('bob-task-submitted');
        await submitTaskOnce(svc, teamName, 'bob');
        await completed(reader, teamName, bobTask.id, 'bob', () => observe('bob'));
        proof.bobTask = { id: bobTask.id, owner: 'bob', status: 'completed' };
        await checkpoint('bob-task-completed');
        await exactFile(projectPath, 'bob-result.txt', `BOB_EXEC:${bobNonce}\n`);
        await exactRegularFile(projectPath, 'sum.cjs');
        await exactRegularFile(projectPath, 'sum.test.cjs');
        await verifyImplementation(projectPath);
        proof.independentAssertionsPassed = true;

        await checkpoint('peer-challenge-responses');
        // Each nonce is only in its sender's assignment, never in the recipient's task/prompt.
        const challenges = await Promise.all([
          waitForMemberInboxMessage(teamName, 'bob', 'alice', `CHALLENGE:${aliceNonce}`, 120_000),
          waitForMemberInboxMessage(teamName, 'alice', 'bob', `CHALLENGE:${bobNonce}`, 120_000),
        ]);
        proof.peerRelayResults = await Promise.all(
          challenges.map((message, index) =>
            submitPeerOnce(svc, teamName, index === 0 ? 'bob' : 'alice', message.messageId)
          )
        );
        await checkpoint('peer-challenge-responses');
        const acknowledgements = await Promise.all([
          waitForMemberInboxMessage(teamName, 'alice', 'bob', `ACK:${aliceNonce}`, 180_000),
          waitForMemberInboxMessage(teamName, 'bob', 'alice', `ACK:${bobNonce}`, 180_000),
        ]);
        expect(challenges.map(({ text }) => text)).toEqual([
          `CHALLENGE:${aliceNonce}`,
          `CHALLENGE:${bobNonce}`,
        ]);
        expect(acknowledgements.map(({ text }) => text)).toEqual([
          `ACK:${aliceNonce}`,
          `ACK:${bobNonce}`,
        ]);
        peerTargets = [...challenges, ...acknowledgements].map(message => {
          if (!message.from || !message.to || !message.text) throw new Error('Incomplete peer identity');
          const recipient = snapshot.members[message.to];
          if (!recipient?.laneId || !recipient.runtimeSessionId) throw new Error('Missing peer runtime binding');
          return { messageId: message.messageId, from: message.from, to: message.to, text: message.text,
            laneId: recipient.laneId, runtimeSessionId: recipient.runtimeSessionId };
        });
        // This headless harness has no desktop inbox watcher. Submit each ACK once;
        // the settlement observer below performs no delivery or retry effects.
        proof.peerAckRelayResults = await Promise.all(acknowledgements.map(message =>
          submitPeerOnce(svc, teamName, message.to as Member, message.messageId)));
        await checkpoint('peer-read-settlement');
        await settlePeers();
        expect((proof.peerSettlement as { settled: boolean }).settled).toBe(true);
        const toolProofs: JsonRecord[] = [];
        for (const member of members) {
          const transcript = await getRuntimeTranscript({
            bridgeClient,
            teamName,
            memberName: member,
            projectPath,
            originalBinding: transcriptBinding(runId, snapshot, member),
          });
          const calls = successfulTools(transcript);
          assertTranscriptModel(transcript, model);
          assertTranscriptSession(transcript, snapshot.members[member].runtimeSessionId);
          const v2Evidence =
            classifyTeamTranscriptGeneration(transcript) === 'v2'
              ? readV2TeamInvocationEvidence(transcript, {
                  teamName,
                  memberName: member,
                  selectedModel: model,
                  ...transcriptBinding(runId, snapshot, member),
                })
              : null;
          const marker = member === 'alice' ? `ALICE_EXEC:${aliceNonce}` : `BOB_EXEC:${bobNonce}`;
          expect(
            v2Evidence
              ? hasV2CommandInvocationWithOuterMarker(v2Evidence, {
                  command: member === 'alice' ? aliceCommand : bobCommand,
                  workdir: projectPath,
                  marker,
                })
              : hasExecution(calls, marker)
          ).toBe(true);
          const taskId = member === 'alice' ? aliceTask.id : bobTask.id;
          const actualTask = (await reader.getTasks(teamName)).find((task) => task.id === taskId);
          expect(
            v2Evidence
              ? hasV2TaskCompletion(v2Evidence, { taskId }, actualTask)
              : hasTaskCompletion(calls, teamName, taskId, member)
          ).toBe(true);
          const peerNonce = member === 'alice' ? bobNonce : aliceNonce;
          const peer = member === 'alice' ? 'bob' : 'alice';
          const reply = `ACK:${peerNonce}`;
          expect(
            v2Evidence
              ? hasV2Message(
                  v2Evidence,
                  { to: peer, text: reply },
                  acknowledgements.find(
                    (message) =>
                      message.from === member && message.to === peer && message.text === reply
                  )
                )
              : hasMessage(calls, teamName, member, peer, reply)
          ).toBe(true);
          const challenge = `CHALLENGE:${member === 'alice' ? aliceNonce : bobNonce}`;
          expect(
            v2Evidence
              ? hasV2Message(
                  v2Evidence,
                  { to: peer, text: challenge },
                  challenges.find(
                    (message) =>
                      message.from === member && message.to === peer && message.text === challenge
                  )
                )
              : hasMessage(calls, teamName, member, peer, challenge)
          ).toBe(true);
          toolProofs.push({
            member,
            evidencePolicy: v2Evidence
              ? 'v2_invocation_outer_output_and_durable_effect'
              : 'v1_native_pair',
            ...(v2Evidence ? { nestedChildResultSynthesized: false } : {}),
            executionConfirmed: true,
            taskCompletionConfirmed: true,
            peerResponseConfirmed: true,
            executionMarker: marker,
            peerResponse: `ACK:${peerNonce}`,
          });
        }
        proof.tasks = [aliceTask, bobTask].map(({ id, owner }) => ({
          id,
          owner,
          status: 'completed',
        }));
        proof.peerMessages = [...challenges, ...acknowledgements].map(
          ({ messageId, from, to, text }) => ({
            messageId,
            from,
            to,
            // Store only the expected nonce form, never arbitrary model text.
            token: text?.match(/(?:CHALLENGE|ACK):[a-f0-9-]{36}/)?.[0],
          })
        );
        proof.toolProofs = toolProofs;
        proof.files = await fileHashes(projectPath, [
          'sum.cjs',
          'sum.test.cjs',
          'alice-result.txt',
          'bob-result.txt',
        ]);

        await checkpoint('stop-before-relaunch');
        await stopped(svc, teamName, runId);
        proof.initialStopConfirmed = true;
        await checkpoint('relaunch');
        const relaunchProgress: TeamProvisioningProgress[] = [];
        const relaunch = await svc.launchTeam(
          { teamName, cwd: projectPath, providerId: 'opencode', model, skipPermissions: true },
          (event) => relaunchProgress.push(event)
        );
        await ready(relaunchProgress);
        expect(relaunch.runId).not.toBe(runId);
        const relaunched = await svc.getTeamAgentRuntimeSnapshot(teamName);
        expect(relaunched.runId).toBe(relaunch.runId);
        expect(
          new Set(members.map((member) => relaunched.members[member]?.runtimeSessionId)).size
        ).toBe(2);
        for (const member of members) {
          expect(relaunched.members[member]).toMatchObject({ alive: true, runtimeModel: model });
          expect(relaunched.members[member].runtimeSessionId).toBeTruthy();
          expect(relaunched.members[member].runtimeSessionId).not.toBe(
            snapshot.members[member].runtimeSessionId
          );
        }
        activeTranscript = { runId: relaunch.runId, snapshot: relaunched };
        await checkpoint('parallel-work-after-relaunch');
        const followups = await Promise.all(
          members.map(async (member) => {
            const nonce = randomUUID();
            const file = `relaunch-${member}.txt`;
            const marker = `RELAUNCH_EXEC:${member}:${nonce}`;
            const command = `${nodeCommand} ${testScriptCommand} && ${nodeCommand} -e 'console.log("${marker}")'`;
            const task = await taskService.createTask(teamName, {
              subject: `Fresh ${member} verification after relaunch`,
              owner: member,
              startImmediately: true,
              prompt: [
                `Work only in ${projectPath}. Do not delegate or install anything.`,
                `Own only ${file}. Set the bash tool's workdir field to exactly ${projectPath}. Execute this command verbatim; do not prepend cd or append commands: ${command}`,
                `If both commands succeed, write ${file} containing exactly ${marker} and one newline.`,
                'Then complete this assigned task with task_complete.',
              ].join('\n'),
            });
            return { member, task, marker, file, command };
          })
        );
        proof.relaunchTasks = followups.map(({ member, task }) => ({
          owner: member,
          taskId: task.id,
        }));
        await checkpoint('parallel-relaunch-tasks-submitted');
        await Promise.all(followups.map(({ member }) => submitTaskOnce(svc, teamName, member)));
        await Promise.all(
          followups.map(async ({ member, task, marker, file, command }) => {
            await completed(reader, teamName, task.id, member, () => observe(member));
            await exactFile(projectPath, file, `${marker}\n`);
            const transcript = await getRuntimeTranscript({
              bridgeClient,
              teamName,
              memberName: member,
              projectPath,
              originalBinding: transcriptBinding(relaunch.runId, relaunched, member),
            });
            assertTranscriptModel(transcript, model);
            assertTranscriptSession(transcript, relaunched.members[member].runtimeSessionId);
            const calls = successfulTools(transcript);
            const v2Evidence =
              classifyTeamTranscriptGeneration(transcript) === 'v2'
                ? readV2TeamInvocationEvidence(transcript, {
                    teamName,
                    memberName: member,
                    selectedModel: model,
                    ...transcriptBinding(relaunch.runId, relaunched, member),
                  })
                : null;
            expect(
              v2Evidence
                ? hasV2CommandInvocationWithOuterMarker(v2Evidence, {
                    command,
                    workdir: projectPath,
                    marker,
                  })
                : hasExecution(calls, marker)
            ).toBe(true);
            const actualTask = (await reader.getTasks(teamName)).find(
              (value) => value.id === task.id
            );
            expect(
              v2Evidence
                ? hasV2TaskCompletion(v2Evidence, { taskId: task.id }, actualTask)
                : hasTaskCompletion(calls, teamName, task.id, member)
            ).toBe(true);
          })
        );
        await verifyImplementation(projectPath);
        proof.relaunch = {
          runId: relaunch.runId,
          tasks: followups.map(({ member, task, marker }) => ({
            owner: member,
            taskId: task.id,
            status: 'completed',
            executionMarker: marker,
          })),
          files: await fileHashes(
            projectPath,
            followups.map(({ file }) => file)
          ),
        };
        await checkpoint('final-stop');
        await stopped(svc, teamName, relaunch.runId);
        proof.finalStopConfirmed = true;
        proof.status = 'passed';
      } catch (error) {
        proof.failure = { phase, classification: classifyFailure(error) };
        // Raw bridge/provider errors can contain credentials; retain raw state, expose phase only.
        proof.status = 'failed';
        throw new Error(
          `OpenCode full team proof failed during ${phase}; owned state retained at ${tempDir}`
        );
      } finally {
        if (harness) {
          // Preserve the original assertion failure, but observe all known peer receipts before Stop.
          if (!peerSettlementAttempted && peerTargets.length === 4) await settlePeers().catch(() => {
            proof.peerSettlement = { settled: false, unavailable: true };
          });
          await captureRuntime().catch((error) => {
            proof.captureFailure = classifyFailure(error);
          });
          await harness.svc.stopTeam(teamName).catch((error) => {
            proof.stopFailure = classifyFailure(error);
            cleanupFailure = true;
          });
          try {
            const cleanup = await harness.readiness.cleanupOpenCodeHosts({
              reason: 'full-team-e2e-owned-cleanup',
              mode: 'force',
              projectPath,
              staleAgeMs: null,
              leaseStaleAgeMs: null,
            });
            proof.cleanupResult = cleanupMetadata(cleanup, projectPath);
            assertOpenCodeSmokeCleanup(cleanup, projectPath);
            proof.cleanupConfirmed = !cleanupFailure;
          } catch (error) {
            proof.cleanupFailure = classifyFailure(error);
            cleanupFailure = true;
          }
          await harness.close().catch((error) => {
            proof.controlApiCloseFailure = classifyFailure(error);
            cleanupFailure = true;
          });
        }
        proof.registryAfterCleanup = await ownedRegistryMetadata(
          requiredEnv('CLAUDE_MULTIMODEL_DATA_HOME'),
          projectPath
        );
        if (cleanupFailure) {
          proof.cleanupConfirmed = false;
          proof.status = 'failed';
        }
        proof.phase = phase;
        proof.finishedAt = new Date().toISOString();
        await finalizeProof(
          () => checkpoint(phase),
          () => setClaudeBasePathOverride(null)
        );
      }
      if (cleanupFailure)
        throw new Error('Owned host cleanup not confirmed; failed state retained');
    },
    25 * 60_000
  );
});

function transcriptBinding(
  runId: string,
  snapshot: TeamAgentRuntimeSnapshot,
  member: Member
): OpenCodeOriginalTranscriptBinding {
  expect(snapshot.runId).toBe(runId);
  return {
    runId,
    laneId: snapshot.members[member]?.laneId ?? '',
    runtimeSessionId: snapshot.members[member]?.runtimeSessionId ?? '',
  };
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Run scripts/prove-opencode-full-team.mjs: missing ${key}`);
  return value;
}

async function ready(events: TeamProvisioningProgress[]): Promise<void> {
  await waitUntil(
    async () => {
      if (events.at(-1)?.state === 'failed') throw new Error('Provisioning failed');
      return events.at(-1)?.state === 'ready';
    },
    300_000,
    2_000
  );
}

async function completed(
  reader: TeamTaskReader,
  teamName: string,
  taskId: string,
  owner: Member,
  observe: () => Promise<void>
): Promise<void> {
  await waitUntil(
    async () => {
      const task = (await reader.getTasks(teamName)).find(({ id }) => id === taskId);
      if (task?.status !== 'completed') {
        await observe();
        return false;
      }
      expect(task.owner).toBe(owner);
      return true;
    },
    300_000,
    5_000
  );
}

async function submitTaskOnce(
  svc: TeamProvisioningService,
  teamName: string,
  member: Member
): Promise<void> {
  // A bridge timeout can follow acceptance. Submit once, then let durable task/tool
  // observations decide the outcome; never resubmit an uncertain paid prompt.
  await svc.relayInboxFileToLiveRecipient(teamName, member).catch(() => undefined);
}

async function submitPeerOnce(
  svc: TeamProvisioningService,
  teamName: string,
  member: Member,
  messageId: string
): Promise<unknown> {
  const result = await svc
    .relayOpenCodeMemberInboxMessages(teamName, member, {
      onlyMessageId: messageId,
      source: 'manual',
    })
    .catch((error: unknown) => ({ error: classifyFailure(error) }));
  return { member, messageId, ...relayMetadata(result) };
}

async function stopped(
  svc: TeamProvisioningService,
  teamName: string,
  runId: string
): Promise<void> {
  await svc.stopTeam(teamName);
  await waitForOpenCodeLanesStopped(teamName);
  const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
  assertStoppedSnapshot(snapshot, runId, members);
}

async function verifyImplementation(projectPath: string): Promise<void> {
  // Independent fixed assertions execute generated code with Node permissions restricted
  // to reading this disposable project, without child-process or filesystem-write permissions.
  const script = [
    'const a=require("node:assert/strict"), {sum}=require("./sum.cjs");',
    'for(const [values,want] of [[[],0],[[2,-5,7],4],[[1.5,2.5],4],[[-2,-3],-5]]) a.equal(sum(values),want);',
    'for(const invalid of [null,[NaN],[Infinity],["1"]]) a.throws(()=>sum(invalid),TypeError);',
  ].join('');
  await promisify(execFile)(
    process.execPath,
    ['--permission', `--allow-fs-read=${await fs.realpath(projectPath)}`, '-e', script],
    { cwd: projectPath, env: { HOME: requiredEnv('HOME') }, timeout: 10_000, maxBuffer: 4096 }
  );
}

async function exactRegularFile(projectPath: string, file: string): Promise<Buffer> {
  expect((await fs.lstat(path.join(projectPath, file))).isFile()).toBe(true);
  return fs.readFile(path.join(projectPath, file));
}
async function exactFile(projectPath: string, file: string, expected: string): Promise<void> {
  expect((await exactRegularFile(projectPath, file)).toString('utf8')).toBe(expected);
}
async function fileHashes(projectPath: string, files: string[]): Promise<JsonRecord[]> {
  return Promise.all(
    files.map(async (file) => ({
      file,
      sha256: createHash('sha256')
        .update(await exactRegularFile(projectPath, file))
        .digest('hex'),
    }))
  );
}

// These run offline even when the paid scenario is disabled.
describe('full team tool evidence acceptance', () => {
  const use = { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'echo proof' } };
  const result = {
    type: 'tool_result',
    toolUseId: 'call-1',
    status: 'completed',
    contentText: 'proof',
    isError: false,
  };
  function transcript(role: string, contentBlocks: unknown[]) {
    return { data: { messages: [{ role, contentBlocks }] } };
  }
  it('accepts only a successful completed assistant call/result pair', () => {
    expect(successfulTools(transcript('assistant', [use, result]))).toEqual([
      { name: 'bash', input: { command: 'echo proof' }, output: 'proof' },
    ]);
  });
  it('rejects injected user text, mismatched results, running calls and tool errors', () => {
    expect(successfulTools(transcript('user', [use, result]))).toEqual([]);
    expect(
      successfulTools(
        transcript('assistant', [{ type: 'text', text: JSON.stringify([use, result]) }])
      )
    ).toEqual([]);
    expect(
      successfulTools(transcript('assistant', [use, { ...result, toolUseId: 'other' }]))
    ).toEqual([]);
    expect(
      successfulTools(transcript('assistant', [use, { ...result, status: 'running' }]))
    ).toEqual([]);
    expect(successfulTools(transcript('assistant', [use, { ...result, isError: true }]))).toEqual(
      []
    );
  });
  it('rejects actual assistant inference on a different model', () => {
    const evidence = {
      data: {
        messages: [{ role: 'assistant', providerId: 'selected', modelId: 'fallback' }],
      },
    };
    expect(() => assertTranscriptModel(evidence, 'selected/requested')).toThrow();
    expect(() => assertTranscriptModel(evidence, 'selected/fallback')).not.toThrow();
  });
});
