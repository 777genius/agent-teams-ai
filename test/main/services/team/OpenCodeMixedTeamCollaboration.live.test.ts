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
import { createMixedHarness } from './openCodeMixedTeamHarness';

import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_MIXED_TEAM === '1'
    ? describe
    : describe.skip;
const names = ['zai-one', 'zai-two', 'grok-one', 'grok-two'];
function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Run prove-opencode-mixed-team.mjs; missing ${key}`);
  return value;
}

liveDescribe('OpenCode mixed provider paid team collaboration', () => {
  it(
    'proves four independent tasks, cross-provider challenge replies and confirmed stop',
    async () => {
      await assertOwnedSmokeEnvironment(process.env, 'MIXED');
      const projectPath = required('OPENCODE_E2E_PROJECT_PATH');
      expect(projectPath).toBe(required('OPENCODE_E2E_OWNED_PROJECT_PATH'));
      expect(path.isAbsolute(projectPath)).toBe(true);
      expect(await fs.realpath(projectPath)).not.toBe(await fs.realpath(process.cwd()));
      const models = [required('OPENCODE_E2E_ZAI_MODEL'), required('OPENCODE_E2E_SUPERGROK_MODEL')];
      const members = names.map((name, index) => ({
        name,
        model: models[index < 2 ? 0 : 1],
        peer: names[(index + 2) % 4],
        // Fresh inboxes isolate runs; the index guarantees distinct, short peer tokens.
        nonce: `${index + 1}-${randomUUID().slice(0, 8)}`,
      }));
      const tempDir = await fs.mkdtemp(path.join(required('TMPDIR'), 'mixed-team-state-'));
      const claudeRoot = path.join(tempDir, '.claude');
      await fs.mkdir(claudeRoot);
      setClaudeBasePathOverride(claudeRoot);
      const teamName = `mixed-team-${randomUUID()}`;
      const proof: Record<string, unknown> = {
        schemaVersion: 1,
        status: 'running',
        models,
        teamName,
        transport: 'service-api-submit-once',
        startedAt: new Date().toISOString(),
        cleanupConfirmed: false,
      };
      let phase = 'setup';
      let harness: Awaited<ReturnType<typeof createMixedHarness>> | undefined;
      let failed = false;
      async function checkpoint(next: string) {
        phase = next;
        proof.phase = phase;
        proof.updatedAt = new Date().toISOString();
        const file = path.join(required('OPENCODE_E2E_PROOF_DIRECTORY'), 'proof.json');
        await fs.writeFile(`${file}.tmp`, JSON.stringify(proof, null, 2), { mode: 0o600 });
        await fs.rename(`${file}.tmp`, file);
      }
      try {
        harness = await createMixedHarness(tempDir, claudeRoot);
        const { svc, bridgeClient } = harness;
        const progress: TeamProvisioningProgress[] = [];
        await checkpoint('launch');
        const { runId } = await svc.createTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            model: models[0],
            skipPermissions: true,
            prompt: `Work only in disposable ${projectPath}. Never delegate or install packages. Only change files assigned by board task. On CHALLENGE:token, reply to its sender exactly ACK:token using agent-teams_message_send. Never respond to ACK. Do not sleep or poll for peers.`,
            members: members.map(({ name, model }) => ({
              name,
              model,
              providerId: 'opencode',
              role: 'Developer',
            })),
          },
          (event) => {
            progress.push(event);
            proof.provisioning = {
              state: [
                'validating',
                'spawning',
                'configuring',
                'assembling',
                'finalizing',
                'verifying',
                'ready',
                'disconnected',
                'failed',
                'cancelled',
              ].includes(event.state)
                ? event.state
                : 'unknown',
              error: event.error ? classifyFailure(event.error) : null,
              diagnostics: (event.launchDiagnostics ?? []).map((item) => ({
                member: names.includes(item.memberName ?? '') ? item.memberName : null,
                code: [
                  'spawn_accepted',
                  'runtime_process_detected',
                  'runtime_process_candidate',
                  'tmux_shell_only',
                  'runtime_not_found',
                  'permission_pending',
                  'bootstrap_confirmed',
                  'bootstrap_stalled',
                  'workspace_trust_preflight',
                  'stale_runtime_event_rejected',
                  'process_table_unavailable',
                ].includes(item.code)
                  ? item.code
                  : 'unknown',
              })),
            };
          }
        );
        await waitUntil(
          async () => {
            await checkpoint('launch');
            if (progress.at(-1)?.state === 'failed') throw new Error('Provisioning failed');
            return progress.at(-1)?.state === 'ready';
          },
          300_000,
          2_000
        );
        const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
        expect(snapshot.runId).toBe(runId);
        for (const member of members) {
          expect(snapshot.members[member.name]).toMatchObject({
            alive: true,
            providerId: 'opencode',
            runtimeModel: member.model,
            historicalBootstrapConfirmed: true,
          });
          expect(snapshot.members[member.name].runtimeSessionId).toBeTruthy();
        }
        expect(
          new Set(members.map(({ name }) => snapshot.members[name].runtimeSessionId)).size
        ).toBe(4);
        proof.runId = runId;
        proof.sessions = members.map(({ name, model }) => ({
          name,
          model,
          sessionId: snapshot.members[name].runtimeSessionId,
        }));
        await checkpoint('tasks');
        const taskService = new TeamDataService();
        const reader = new TeamTaskReader();
        const tasks: ((typeof members)[number] & {
          taskId: string;
          file: string;
          marker: string;
        })[] = [];
        for (const member of members) {
          const file = `${member.name}.cjs`;
          await expect(fs.lstat(path.join(projectPath, file))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          const marker = `EXEC:${member.name}:${member.nonce}`;
          // TeamDataService.createTaskWithOutcome explicitly sets createdBy: 'user'.
          // CreateTaskRequest intentionally has no actor override (unlike raw MCP task_create).
          const task = await taskService.createTask(teamName, {
            subject: `Implement and verify ${member.name} sum`,
            owner: member.name,
            startImmediately: true,
            prompt: [
              `Work only inside ${projectPath}. Own only ${file}. Never delegate, install packages, modify peer files, sleep or poll.`,
              `Implement ${file} exporting sum(values) via module.exports={sum}. Empty input returns 0. Reject non-array inputs and non-finite/non-number elements with TypeError.`,
              `Use bash to run node -e 'const a=require("node:assert/strict"),{sum}=require("./${file}");a.equal(sum([]),0);a.equal(sum([2,-5,7]),4);a.throws(()=>sum([NaN]),TypeError);console.log("${marker}")'`,
              `Send ${member.peer} exactly CHALLENGE:${member.nonce} using agent-teams_message_send.`,
              'Complete this assigned task with task_complete only after verification succeeds. On any CHALLENGE:token message, send its sender exactly ACK:token with agent-teams_message_send. Never reply to ACK.',
            ].join('\n'),
          });
          expect(task.createdBy).toBe('user');
          tasks.push({ ...member, taskId: task.id, file, marker });
        }
        proof.tasks = tasks.map(({ name, taskId }) => ({ owner: name, taskId }));
        await checkpoint('tasks-submitted');
        // Once per recipient. Timeout can mean accepted: never resubmit an uncertain paid turn.
        const taskRelays = await Promise.all(
          members.map(async ({ name }) => {
            try {
              return {
                member: name,
                ...relayMetadata(await svc.relayInboxFileToLiveRecipient(teamName, name)),
              };
            } catch (error) {
              return { member: name, error: classifyFailure(error), terminalFailure: false };
            }
          })
        );
        proof.taskRelays = taskRelays;
        await checkpoint('task-delivery-observation');
        if (taskRelays.some((result) => result.terminalFailure))
          throw new Error('Terminal task delivery failure');
        await waitUntil(
          async () => {
            const board = await reader.getTasks(teamName);
            return tasks.every(({ taskId, name }) =>
              board.some(
                (task) => task.id === taskId && task.owner === name && task.status === 'completed'
              )
            );
          },
          360_000,
          5_000
        );
        await checkpoint('cross-provider-challenges');
        const challenges = await Promise.all(
          tasks.map(async (task) => {
            const message = await waitForMemberInboxMessage(
              teamName,
              task.peer,
              task.name,
              `CHALLENGE:${task.nonce}`,
              120_000
            );
            expect(message.text).toBe(`CHALLENGE:${task.nonce}`);
            return { task, message };
          })
        );
        const peerRelays = await Promise.all(
          challenges.map(async ({ task, message }) => {
            try {
              return {
                member: task.peer,
                ...relayMetadata(
                  await svc.relayOpenCodeMemberInboxMessages(teamName, task.peer, {
                    onlyMessageId: message.messageId,
                    source: 'manual',
                  })
                ),
              };
            } catch (error) {
              return { member: task.peer, error: classifyFailure(error), terminalFailure: false };
            }
          })
        );
        proof.peerRelays = peerRelays;
        await checkpoint('peer-delivery-observation');
        if (peerRelays.some((result) => result.terminalFailure))
          throw new Error('Terminal peer delivery failure');
        const acknowledgements = await Promise.all(
          tasks.map(async (task) => {
            const message = await waitForMemberInboxMessage(
              teamName,
              task.name,
              task.peer,
              `ACK:${task.nonce}`,
              180_000
            );
            expect(message.text).toBe(`ACK:${task.nonce}`);
            return { from: task.peer, to: task.name, token: `ACK:${task.nonce}` };
          })
        );
        proof.peerAcknowledgements = acknowledgements;
        await checkpoint('canonical-evidence');
        const evidence = [];
        for (const task of tasks) {
          const transcript = await getRuntimeTranscript({
            bridgeClient,
            teamName,
            memberName: task.name,
            projectPath,
          });
          assertTranscriptModel(transcript, task.model);
          assertTranscriptSession(transcript, snapshot.members[task.name].runtimeSessionId);
          const tools = successfulTools(transcript);
          expect(hasExecution(tools, task.marker)).toBe(true);
          expect(hasTaskCompletion(tools, teamName, task.taskId, task.name)).toBe(true);
          const peer = tasks.find(({ name }) => name === task.peer)!;
          expect(
            hasMessage(tools, teamName, task.name, task.peer, `CHALLENGE:${task.nonce}`)
          ).toBe(true);
          expect(hasMessage(tools, teamName, task.name, task.peer, `ACK:${peer.nonce}`)).toBe(true);
          expect((await fs.lstat(path.join(projectPath, task.file))).isFile()).toBe(true);
          const script = `const a=require('node:assert/strict'),{sum}=require('./${task.file}');for(const [v,n] of [[[],0],[[2,-5,7],4],[[1.5,2.5],4],[[-2,-3],-5]])a.equal(sum(v),n);for(const v of [null,[NaN],[Infinity],['1']])a.throws(()=>sum(v),TypeError);`;
          await promisify(execFile)(
            process.execPath,
            ['--permission', `--allow-fs-read=${await fs.realpath(projectPath)}`, '-e', script],
            { cwd: projectPath, env: { HOME: required('HOME') }, timeout: 10_000, maxBuffer: 4096 }
          );
          evidence.push({
            member: task.name,
            model: task.model,
            taskId: task.taskId,
            status: 'completed',
            executionMarker: task.marker,
            sha256: createHash('sha256')
              .update(await fs.readFile(path.join(projectPath, task.file)))
              .digest('hex'),
          });
        }
        proof.evidence = evidence;
        proof.independentAssertionsPassed = true;
        await checkpoint('stop');
        await svc.stopTeam(teamName);
        await waitForOpenCodeLanesStopped(teamName);
        const stopped = await svc.getTeamAgentRuntimeSnapshot(teamName);
        assertStoppedSnapshot(stopped, runId, names);
        proof.finalStopConfirmed = true;
        proof.status = 'passed';
      } catch (error) {
        failed = true;
        proof.status = 'failed';
        proof.failure = { phase, classification: classifyFailure(error) };
      } finally {
        if (harness) {
          const { svc, readiness, bridgeClient } = harness;
          proof.runtime = await Promise.all(
            members.map(async ({ name }) => ({
              name,
              transcript: transcriptMetadata(
                await getRuntimeTranscript({
                  bridgeClient,
                  teamName,
                  memberName: name,
                  projectPath,
                }).catch(() => null)
              ),
            }))
          );
          try {
            await svc.stopTeam(teamName);
            await waitForOpenCodeLanesStopped(teamName);
            const cleanup = await readiness.cleanupOpenCodeHosts({
              reason: 'mixed-team-e2e-owned-cleanup',
              mode: 'force',
              projectPath,
              staleAgeMs: null,
              leaseStaleAgeMs: null,
            });
            proof.cleanup = cleanupMetadata(cleanup, projectPath);
            assertOpenCodeSmokeCleanup(cleanup, projectPath);
            proof.cleanupConfirmed = true;
          } catch (error) {
            failed = true;
            proof.cleanupFailure = classifyFailure(error);
          }
          await harness.close().catch((error) => {
            failed = true;
            proof.closeFailure = classifyFailure(error);
          });
        }
        proof.registryAfterCleanup = await ownedRegistryMetadata(
          required('CLAUDE_MULTIMODEL_DATA_HOME'),
          projectPath
        );
        if (failed) proof.status = 'failed';
        proof.finishedAt = new Date().toISOString();
        await finalizeProof(() => checkpoint(phase), () => setClaudeBasePathOverride(null));
      }
      if (failed)
        throw new Error(
          `Mixed provider proof failed during ${phase}; inspect sanitized proof and retained owned state`
        );
    },
    22 * 60_000
  );
});
