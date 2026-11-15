import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { assertAccountNamespaces } from '../../packages/legacy-agent-host/dist/composition/assertAccountNamespaces.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import { startCodexSuggestionModel } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/suggestion-model.ts';
import {
  createCodexSuggestionProfile,
  readCodexSuggestionInputs,
} from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/suggestion-config.ts';
import {
  desktopBackendEnvironment,
  digest,
  fileDigest,
  prepareDesktopBackendFixture,
} from './desktop-backend-fixture.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
export interface SuggestionActor {
  key: string;
  provider: 'claude' | 'codex';
  role: 'lead' | 'member';
  memberId: string;
  name: 'team-lead' | 'alice';
  team: 'a' | 'b';
  principalId: string;
  turns: readonly string[];
  suggestion: string;
  claude?: Awaited<ReturnType<typeof startNativeTeamModel>>;
  codex?: Awaited<ReturnType<typeof startCodexSuggestionModel>>;
}
export interface SuggestionTeam {
  key: 'a' | 'b';
  teamId: string;
  teamName: string;
  runId: string;
  handleId: string;
  seed: { taskId: string; subject: string; commandId: string };
}

/** Explicit suggestion-only variant; the ordinary mixed fixture stays on Codex 0.162. */
export async function startDesktopNativeNextPromptMixedModels() {
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, 'native-next-prompt-mixed-ui');
  assert.equal(
    process.env.LEGACY_DESKTOP_NATIVE_NEXT_PROMPT_UI,
    undefined,
    'the existing single-Claude scenario is a separate run'
  );
  const pins = await readCodexSuggestionInputs();
  const actors: SuggestionActor[] = [];
  try {
    for (const [team, provider, role] of [
      ['a', 'claude', 'lead'],
      ['a', 'codex', 'member'],
      ['b', 'codex', 'lead'],
      ['b', 'claude', 'member'],
    ] as const) {
      const label = role === 'lead' ? 'lead' : 'peer';
      const key = `${provider}-${label}`;
      const principalId = `TEST-suggestion-${key}-principal`;
      const turns =
        provider === 'claude'
          ? ['NATIVE_TEAM_ONE', 'NATIVE_TEAM_TWO']
          : [
              `TEST_SUGGEST_CODEX_${label.toUpperCase()}_ONE`,
              `TEST_SUGGEST_CODEX_${label.toUpperCase()}_TWO`,
            ];
      const suggestion =
        provider === 'claude'
          ? 'Review the completed tests and open a PR'
          : `Review the completed Codex ${label} tests.`;
      const actor: SuggestionActor = {
        key,
        provider,
        role,
        team,
        principalId,
        turns,
        suggestion,
        memberId: role === 'lead' ? 'lead-id' : 'alice-id',
        name: role === 'lead' ? 'team-lead' : 'alice',
      };
      if (provider === 'claude')
        actor.claude = await startNativeTeamModel({
          requireVisibleReply: true,
          uiGeneratedMessageIds: true,
          nativeNextPromptUi: true,
          nativeNextPromptDirectUi: true,
          memberName: actor.name,
          principalId: () => principalId,
        });
      else
        actor.codex = await startCodexSuggestionModel({
          sources: [
            ...turns.map((marker) => ({ marker, owner: key, suggestion })),
            ...(role === 'member'
              ? ['RECIPIENT', 'TEAM'].map((boundary) => ({
                  marker: `TEST_SUGGEST_CODEX_PEER_ISOLATION_${boundary}`,
                  owner: key,
                  suggestion: `Check the isolated Codex ${boundary.toLowerCase()} result.`,
                  hold: 'suggestion' as const,
                }))
              : []),
          ],
        });
      actors.push(actor);
    }
    return {
      actors,
      pins,
      async close() {
        for (const actor of actors) await (actor.claude ?? actor.codex)!.close();
      },
    };
  } catch (error) {
    for (const actor of actors) await (actor.claude ?? actor.codex)!.close();
    throw error;
  }
}

export type SuggestionModels = Awaited<ReturnType<typeof startDesktopNativeNextPromptMixedModels>>;

export function addDesktopSuggestionEvidence(evidence: Row, models: SuggestionModels) {
  evidence.scope =
    'Actual Claude and Codex 0.169 native follow-up in lead/peer roles across two reversed mixed teams, original Main/Composer acceptance and late-event isolation, physical Stop; explicit TEST setup, localhost inference';
  evidence.excluded = [
    'vendor model/auth qualification',
    'ordinary Launch dialog',
    'OpenCode suggestions',
  ];
  evidence.suggestionModels = models.actors.map((actor) => ({
    actor: actor.key,
    provider: actor.provider,
    ...(actor.claude
      ? { observations: actor.claude.observations, suggestions: actor.claude.suggestionRequests }
      : { requests: actor.codex!.requests }),
    failures: (actor.claude ?? actor.codex)!.failures,
  }));
}

/** Canonical offline TEST seed before the original Host, Main and renderer exist. */
export async function prepareDesktopNativeNextPromptMixedFixture(
  repo: string,
  pnpmEntry: string,
  models: SuggestionModels
) {
  const base = await prepareDesktopBackendFixture(repo, {
    pnpmEntry,
    seedUiPreferences: true,
    nativeClaude: {
      path: process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
      sha256: 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f',
      modelUrl: models.actors.find((actor) => actor.claude)!.claude!.url,
    },
  });
  assert.equal(await fileDigest(base.profilePath), base.pins.profileSha256);
  assert.equal(await fileDigest(base.descriptorPath), base.pins.descriptorSha256);
  const profile = JSON.parse(await readFile(base.profilePath, 'utf8')) as TeamHostProfile;
  const originalTeam = profile.teams[0]!;
  const originalClaude = profile.runtime!.members[0]!;
  assert.equal(originalClaude.provider, 'claude');
  if (originalClaude.provider !== 'claude') throw new Error('Expected captured Claude recipe');
  profile.teams = [];
  profile.runtime = { members: [] };
  const teams: SuggestionTeam[] = [];
  for (const key of ['a', 'b'] as const) {
    const teamId = `TEST-suggestion-team-${key}`;
    const teamName = `test-suggestion-${key}`;
    const runId = `${originalTeam.scope.runId}-${key}`;
    const binding = { ...originalTeam.binding, teamId, teamName };
    const selected = models.actors.filter((actor) => actor.team === key);
    const members = selected.map((actor) => ({
      memberId: actor.memberId,
      name: actor.name,
      role: actor.role,
      delivery: { ...binding, runId, memberId: actor.memberId, generation: '1' },
    }));
    profile.teams.push({
      scope: { ...originalTeam.scope, teamId, runId },
      binding,
      members,
      grants: [
        originalTeam.grants[0]!,
        ...selected.map((actor) => ({
          principalId: actor.principalId,
          memberName: actor.name,
          permissions: ['read', 'task.write', 'message.write'] as Array<
            'read' | 'task.write' | 'message.write'
          >,
        })),
      ],
    });
    for (const actor of selected) {
      const root = join(base.root, `native-${actor.key}`);
      if (actor.codex)
        profile.runtime.members.push(
          await createCodexSuggestionProfile({
            root,
            node: base.node,
            modelUrl: actor.codex.url,
            executable: models.pins.executable,
            teamId,
            memberId: actor.memberId,
            principalId: actor.principalId,
            sessionId: `TEST-suggestion-${actor.key}-session`,
          })
        );
      else {
        for (const name of ['home', 'config', 'tmp', 'workspace'])
          await mkdir(join(root, name), { recursive: true, mode: 0o700 });
        profile.runtime.members.push({
          ...originalClaude,
          teamId,
          memberId: actor.memberId,
          principalId: actor.principalId,
          sessionId: `TEST-suggestion-${actor.key}-session`,
          accountBinding: `TEST-no-vendor-auth-${digest(root)}`,
          cwd: join(root, 'workspace'),
          environment: {
            ...originalClaude.environment,
            HOME: join(root, 'home'),
            CLAUDE_CONFIG_DIR: join(root, 'config'),
            TMPDIR: join(root, 'tmp'),
            ANTHROPIC_BASE_URL: actor.claude!.url,
          },
        });
      }
    }
    teams.push({
      key,
      teamId,
      teamName,
      runId,
      handleId: key === 'a' ? base.handleId : `${base.handleId}-reversed`,
      seed: {
        taskId: '',
        subject: `TEST native suggestion team ${key}`,
        commandId: `TEST-suggestion-seed-${key}`,
      },
    });
  }
  assertAccountNamespaces([
    ...profile.runtime.members,
    ...(profile.runtime.providerTemplates ?? []),
    ...(profile.management ?? []),
  ]);
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  try {
    for (const team of teams) {
      lease.assertCurrent();
      const selected = profile.teams.find((item) => item.binding.teamId === team.teamId)!;
      const owner = createFilesystemTeamOwner({
        root: profile.owner.storageRoot,
        binding: selected.binding,
        members: selected.members,
        grants: selected.grants,
      });
      const connected = owner.connect(profile.principalId);
      const receipt = connected.execute({
        commandId: team.seed.commandId,
        operation: 'task.create',
        payload: { subject: team.seed.subject },
      });
      assert.equal(receipt.phase, 'completed');
      const tasks = connected.listTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]!.subject, team.seed.subject);
      team.seed.taskId = tasks[0]!.id;
      await writeFile(
        join(base.root, `suggestion-seed-${team.key}.json`),
        JSON.stringify(receipt),
        { mode: 0o600, flag: 'wx' }
      );
    }
  } finally {
    lease.release();
  }
  const configPath = join(base.root, 'claude/agent-teams-config.json');
  const config = row(JSON.parse(await readFile(configPath, 'utf8')));
  row(config.general).nativeNextPromptSuggestionsEnabled = true;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const profileBytes = JSON.stringify(profile);
  await writeFile(base.profilePath, profileBytes, { mode: 0o600 });
  readTeamHostProfile(base.profilePath, digest(profileBytes));
  const descriptor = row(JSON.parse(await readFile(base.descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.handles) && descriptor.handles.length === 1);
  const originalHandle = row(descriptor.handles[0]);
  descriptor.handles = teams.map((team) => ({
    ...originalHandle,
    handleId: team.handleId,
    label: `TEST suggestion team ${team.key}`,
    scope: profile.teams.find((item) => item.binding.teamId === team.teamId)!.scope,
    members: models.actors
      .filter((actor) => actor.team === team.key)
      .map((actor) => ({ memberId: actor.memberId, label: actor.name })),
  }));
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  row(row(row(descriptor.owners[0]).profile).env).LEGACY_AGENT_HOST_PROFILE_SHA256 =
    digest(profileBytes);
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(base.descriptorPath, descriptorBytes, { mode: 0o600 });
  return {
    ...base,
    suggestionTeams: teams,
    uiSeed: teams[0]!.seed,
    appEnvironment: desktopBackendEnvironment(
      base.root,
      base.node,
      base.descriptorPath,
      digest(descriptorBytes)
    ),
    pins: {
      ...base.pins,
      profileSha256: digest(profileBytes),
      descriptorSha256: digest(descriptorBytes),
      suggestionOptInConfigSha256: await fileDigest(configPath),
      codexExecutableSha256: models.pins.executable.sha256,
      codexCandidateManifestSha256: models.pins.manifestSha256,
    },
  };
}

export type SuggestionFixture = Awaited<
  ReturnType<typeof prepareDesktopNativeNextPromptMixedFixture>
>;
