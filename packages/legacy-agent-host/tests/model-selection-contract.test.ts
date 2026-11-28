import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { captureRuntimeSource, compileRuntimeCapture } from '../dist/composition/runtimeCaptureSource.js';
import { applyLaunchConfiguration } from '../dist/composition/launchConfiguration.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { teamModelProbeSelectionSchema } from '../dist/composition/teamLaunchModelProbe.js';
import { scheduledRunInputSchema } from '../dist/composition/scheduledRunContracts.js';
import { ClaudeManagementCoordinator } from '../dist/composition/ClaudeManagementCoordinator.js';
import { CodexManagementCoordinator } from '../dist/composition/CodexManagementCoordinator.js';
import { claudeManagementProfileSchema, codexManagementProfileSchema } from '../dist/management/profile.js';
import { storedCredentialCommandSchema } from '../dist/management/commandRecords.js';
import { advanceOpenCodeV2Credential, openCodeV2CredentialProgressSchema } from '../dist/management/openCodeV2CredentialRecord.js';
import { createTeamLaunchPreparationSnapshotSchema } from '../dist/team-registry/createLaunchContracts.js';
import { opencodeV2ModelProbeProfile } from './fixtures/opencode-v2-model-probe-profile.ts';
import { projectTeamFixture, openProjectTeamFixture } from './projectTeamFixture.ts';

test('credential verification retains the complete qualified model through durable completion and cold read', t => {
  const f = projectTeamFixture(t), providerId = 'p'.repeat(180), modelId = providerId + '/' + 'm'.repeat(160);
  const hash = 'a'.repeat(64);
  const progress = openCodeV2CredentialProgressSchema.parse({ phase: 'probe-intent', integrationId: 'TEST-integration',
    nativeNamespace: hash, beforeAuthDigest: hash, credentialId: 'cred_TEST', authDigest: hash,
    authWitnessKdf: { version: 1, salt: 'a'.repeat(32) },
    verification: { commandId: 'TEST-verify', modelId } });
  const completed = advanceOpenCodeV2Credential(progress, { ...progress, phase: 'probe-completed',
    verification: { ...progress.verification!, ok: true } });
  assert.ok(completed);
  const saved = storedCredentialCommandSchema.parse({ schemaVersion: 1, commandId: 'TEST-connect',
    profileId: 'TEST-profile', configRevision: 'TEST-revision', providerId,
    fingerprint: hash, selectionDigest: hash, resourceId: hash, resourceHeld: false,
    kind: 'credential.set', phase: 'completed', finishedAtMs: 1, openCodeV2: completed });
  new FileManagementCommandStore(f.root).write(saved);
  const cold = new FileManagementCommandStore(f.root).read(saved.commandId);
  assert.equal(cold?.kind, 'credential.set');
  if (cold?.kind !== 'credential.set') throw Error('Wrong credential receipt');
  assert.equal(cold.openCodeV2?.verification?.modelId, modelId);
});

test('Claude and Codex model probes keep the native component limit before target or process preparation', () => {
  const cwd = resolve('TEST-probe-workspace');
  const common = { profileId: 'TEST-profile', configRevision: 'TEST-revision', accountBinding: 'TEST-account',
    cwd, timeoutMs: 1000, executable: { path: resolve('TEST-inert-executable'), sha256: 'a'.repeat(64) },
    environment: { HOME: cwd, CLAUDE_CONFIG_DIR: cwd, CODEX_HOME: cwd, PATH: cwd } };
  const claude = new ClaudeManagementCoordinator([claudeManagementProfileSchema.parse({ ...common,
    provider: 'claude', sdkRevision: '0.3.305', configNamespace: 'custom-directory' })], () => {});
  const codex = new CodexManagementCoordinator([codexManagementProfileSchema.parse({ ...common,
    provider: 'codex', protocolRevision: '0.169.0' })], () => {});
  for (const [providerId, coordinator] of [['anthropic', claude], ['codex', codex]] as const) {
    let targets = 0;
    coordinator.target = () => { targets++; throw new Error('Unexpected native target preparation'); };
    assert.throws(() => coordinator.prepareProbe({ commandId: 'TEST-command', profileId: common.profileId,
      configRevision: common.configRevision, providerId, modelId: 'p'.repeat(180) + '/' + 'm'.repeat(160) }, () => true), { code: 'invalid' });
    assert.equal(targets, 0);
  }
});

test('a long qualified V2 selection survives saved cold restore, explicit project preparation and relaunch compilation', t => {
  const f = projectTeamFixture(t), providerId = 'p'.repeat(256), nativeModel = 'm'.repeat(256);
  const model = providerId + '/' + nativeModel;
  const logical = f.create('TEST-long-model', 'per_project', { cwd: '', providerId: 'opencode', model }).record;
  f.close();
  const cold = openProjectTeamFixture(f.root);
  try {
    assert.equal(cold.teams.get(logical.teamId)!.connection.readRoster().savedSettings!.model, model);
    cold.prepare(logical, 'TEST-project', cold.project);
    const child = cold.child(logical), team = cold.teams.get(child.teamId)!;
    const template = runtimeMemberProfileSchema.parse({ ...opencodeV2ModelProbeProfile(cold.project, nativeModel),
      nativeOptions: { providerId, agent: 'build' } });
    if (template.provider !== 'opencode') throw Error('Wrong provider template');
    const profile = { ...cold.profile, runtime: { members: [], providerTemplates: [template] } };
    const source = captureRuntimeSource(profile, team, 'TEST-capture', 'TEST-roster', team.connection.readRoster(), { deferMcp: true });
    const compiled = compileRuntimeCapture(profile, team, JSON.parse(JSON.stringify(source)));
    for (const selected of compiled.profiles) {
      assert.equal(selected.provider, 'opencode');
      if (selected.provider !== 'opencode') throw Error('Wrong provider');
      assert.equal(selected.nativeOptions.providerId, providerId);
      assert.equal(selected.model, nativeModel);
      assert.equal(selected.cwd, cold.project);
    }
    const probe = { launchId: 'TEST-launch', rosterRevision: 'a'.repeat(64), memberId: 'lead', model };
    assert.deepEqual(teamModelProbeSelectionSchema.parse(probe), probe);
    assert.equal(createTeamLaunchPreparationSnapshotSchema.parse({
      preparationId: 'TEST-preparation', draftDigest: 'a'.repeat(64), ready: false,
      probes: [{ memberName: 'team-lead', commandId: 'TEST-probe', model,
        phase: 'not-started', ok: false, expiresAt: 0 }],
    }).probes[0]!.model, model);
    assert.equal(runtimeMemberProfileSchema.safeParse({ ...template, model }).success, false,
      'a UI alias never raises the native model ID limit');
    const { nativeGeneration: _generation, embedded: _embedded, ...legacy } = template;
    const v1 = runtimeMemberProfileSchema.parse({ ...legacy, protocolRevision: '1.19.4' });
    assert.throws(() => applyLaunchConfiguration(v1, { model }), { reason: 'launch-option-unsupported' });
    for (const providerId of ['anthropic', 'codex', 'opencode']) {
      assert.equal(scheduledRunInputSchema.safeParse({ runId: 'TEST-run', scheduleId: 'TEST-schedule',
        expectedRosterRevision: 'a'.repeat(64), config: { cwd: cold.project, prompt: 'TEST', providerId, model } }).success, false,
      'unsupported Schedule/provider choices cannot adopt the V2 model allowance');
    }
  } finally { cold.close(); }
});
