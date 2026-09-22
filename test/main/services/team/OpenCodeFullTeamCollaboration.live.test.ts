// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import { assertOpenCodeSmokeCleanup } from './assertOpenCodeSmokeCleanup';
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
  relayMetadata,
  successfulTools,
} from './openCodeMixedTeamEvidence';
import { createMixedHarness as createHarness } from './openCodeMixedTeamHarness';

import type { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import type { TeamProvisioningProgress } from '../../../../src/shared/types';

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
      await fs.mkdir(claudeRoot);
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
      const observed: Partial<Record<Member, ReturnType<typeof transcriptMetadata>>> = {};
      async function observe(member: Member) {
        if (!harness) return;
        observed[member] = transcriptMetadata(
          await getRuntimeTranscript({
            bridgeClient: harness.bridgeClient,
            teamName,
            memberName: member,
            projectPath,
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
              'Never delegate or install packages. Do not modify files until assigned a board task.',
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

        await checkpoint('assigned-work');
        const taskService = new TeamDataService();
        const reader = new TeamTaskReader();
        const aliceNonce = randomUUID();
        const bobNonce = randomUUID();
        const taskBase = [
          `Work only in ${projectPath}; do not delegate or install packages.`,
          'Use bash to execute the verification command. Complete this assigned task with task_complete only after success.',
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
            `Run node -e 'const {sum}=require("./sum.cjs"); const a=require("node:assert/strict"); a.equal(sum([2,-5,7]),4); a.equal(sum([]),0); a.throws(()=>sum([NaN]),TypeError); console.log("ALICE_EXEC:${aliceNonce}")'`,
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
            `At the end print BOB_EXEC:${bobNonce}. Run node sum.test.cjs using bash.`,
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
        const toolProofs: JsonRecord[] = [];
        for (const member of members) {
          const transcript = await getRuntimeTranscript({
            bridgeClient,
            teamName,
            memberName: member,
            projectPath,
          });
          const calls = successfulTools(transcript);
          assertTranscriptModel(transcript, model);
          assertTranscriptSession(transcript, snapshot.members[member].runtimeSessionId);
          const marker = member === 'alice' ? `ALICE_EXEC:${aliceNonce}` : `BOB_EXEC:${bobNonce}`;
          expect(hasExecution(calls, marker)).toBe(true);
          const taskId = member === 'alice' ? aliceTask.id : bobTask.id;
          expect(hasTaskCompletion(calls, teamName, taskId, member)).toBe(true);
          const peerNonce = member === 'alice' ? bobNonce : aliceNonce;
          const peer = member === 'alice' ? 'bob' : 'alice';
          expect(hasMessage(calls, teamName, member, peer, `ACK:${peerNonce}`)).toBe(true);
          expect(
            hasMessage(calls, teamName, member, peer,
              `CHALLENGE:${member === 'alice' ? aliceNonce : bobNonce}`)
          ).toBe(true);
          toolProofs.push({
            member,
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
        await checkpoint('parallel-work-after-relaunch');
        const followups = await Promise.all(
          members.map(async (member) => {
            const nonce = randomUUID();
            const file = `relaunch-${member}.txt`;
            const marker = `RELAUNCH_EXEC:${member}:${nonce}`;
            const task = await taskService.createTask(teamName, {
              subject: `Fresh ${member} verification after relaunch`,
              owner: member,
              startImmediately: true,
              prompt: [
                `Work only in ${projectPath}. Do not delegate or install anything.`,
                `Own only ${file}. Run node sum.test.cjs with bash to verify the existing implementation.`,
                `Then run node -e 'console.log("${marker}")' with bash.`,
                `If both commands succeed, write ${file} containing exactly ${marker} and one newline.`,
                'Then complete this assigned task with task_complete.',
              ].join('\n'),
            });
            return { member, task, marker, file };
          })
        );
        proof.relaunchTasks = followups.map(({ member, task }) => ({
          owner: member,
          taskId: task.id,
        }));
        await checkpoint('parallel-relaunch-tasks-submitted');
        await Promise.all(followups.map(({ member }) => submitTaskOnce(svc, teamName, member)));
        await Promise.all(
          followups.map(async ({ member, task, marker, file }) => {
            await completed(reader, teamName, task.id, member, () => observe(member));
            await exactFile(projectPath, file, `${marker}\n`);
            const transcript = await getRuntimeTranscript({
              bridgeClient,
              teamName,
              memberName: member,
              projectPath,
            });
            assertTranscriptModel(transcript, model);
            assertTranscriptSession(transcript, relaunched.members[member].runtimeSessionId);
            const calls = successfulTools(transcript);
            expect(hasExecution(calls, marker)).toBe(true);
            expect(hasTaskCompletion(calls, teamName, task.id, member)).toBe(true);
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
        await finalizeProof(() => checkpoint(phase), () => setClaudeBasePathOverride(null));
      }
      if (cleanupFailure)
        throw new Error('Owned host cleanup not confirmed; failed state retained');
    },
    25 * 60_000
  );
});

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

async function stopped(svc: TeamProvisioningService, teamName: string, runId: string): Promise<void> {
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
