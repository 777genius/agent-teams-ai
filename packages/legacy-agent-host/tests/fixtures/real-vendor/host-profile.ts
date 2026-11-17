import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { assertAccountNamespaces } from '../../../dist/composition/assertAccountNamespaces.js';
import { fileHash } from '../native-host.ts';

import type { TeamHostProfile } from '../../../dist/composition/TeamHost.js';
import type { RealTarget } from './discovery.ts';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export interface RealMember {
  readonly name: string;
  readonly memberId: string;
  readonly role: 'lead' | 'member';
}

const LIMITS = {
  queuedInputs: 2,
  inputBytes: 8192,
  outputBytes: 1_000_000,
  outputEvents: 1500,
  pendingInteractions: 2,
  timeoutMs: 120_000,
} as const;
const INSTRUCTION = (name: string) =>
  `You are ${name}. Answer in at most two short sentences. Do not use tools for simple questions.`;

/** Claude: real account (keychain auth needs HOME/USER/LOGNAME); Codex: isolated CODEX_HOME + copied auth. */
const codexConfig = (model: string, base: string) => `model = ${JSON.stringify(model)}
model_reasoning_effort = "low"
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[analytics]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
[features]
code_mode = false
apps = false
plugins = false
shell_snapshot = false
skip_host_skill_discovery = true
multi_agent = false
[shell_environment_policy]
inherit = "none"
set = { HOME = ${JSON.stringify(join(base, 'home'))}, TMPDIR = ${JSON.stringify(join(base, 'tmp'))}, PATH = "/usr/bin:/bin" }
`;

export async function buildRealRuntimeMember(
  target: RealTarget,
  member: RealMember,
  ids: { namespace: string; teamId: string },
  root: string,
  node: string
) {
  const base = join(root, member.name);
  const common = {
    teamId: ids.teamId,
    memberId: member.memberId,
    principalId: `${member.name}-session`,
    sessionId: `TEST-session-${member.name}-${ids.namespace}`,
    generation: 1,
    configRevision: `TEST-real-${target.vendor}`,
    model: target.model,
    accountBinding: `TEST-real-owner-${target.vendor}-${digest(base).slice(0, 16)}`,
    executable: { path: target.binary, sha256: target.sha256 },
    limits: LIMITS,
  };
  if (target.vendor === 'claude') {
    const workspace = join(base, 'workspace');
    await mkdir(join(base, 'tmp'), { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const user = process.env.USER ?? process.env.LOGNAME;
    if (!user) throw new Error('USER is required for Claude keychain authentication');
    return {
      ...common,
      provider: 'claude' as const,
      cwd: workspace,
      configNamespace: 'native-default',
      environment: {
        HOME: homedir(),
        USER: user,
        LOGNAME: user,
        TMPDIR: join(base, 'tmp'),
        PATH: `${dirname(node)}:/usr/bin:/bin`,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        DISABLE_AUTOUPDATER: '1',
        NO_COLOR: '1',
        TERM: 'dumb',
        // Claude gates suggestions behind an account/time dependent rollout flag. The proof is about our
        // pipeline, not Anthropic's rollout, so force it on; REAL_CLAUDE_NATURAL_SUGGESTIONS=1 keeps the
        // vendor's own behaviour (which can legitimately offer nothing).
        ...(process.env.REAL_CLAUDE_NATURAL_SUGGESTIONS
          ? {}
          : { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'true' }),
      },
      // Suggestions need Claude's prompt cache: full claude_code preset plus at least one tool.
      // Read-only tools keep the account's real config from mutating anything.
      nativeTools: ['Read', 'Grep', 'Glob'],
      autoAllowedTools: ['Read', 'Grep', 'Glob'],
      nativeOptions: { projectInstructions: { append: INSTRUCTION(member.name) } },
    };
  }
  for (const directory of [
    'home',
    'codex-home',
    'tmp',
    'workspace',
    'xdg-config',
    'xdg-data',
    'xdg-cache',
  ])
    await mkdir(join(base, directory), { recursive: true, mode: 0o700 });
  await copyFile(target.authSource!, join(base, 'codex-home/auth.json'));
  await writeFile(join(base, 'codex-home/config.toml'), codexConfig(target.model, base), {
    mode: 0o600,
  });
  return {
    ...common,
    provider: 'codex' as const,
    protocolRevision: target.version,
    cwd: join(base, 'workspace'),
    environment: {
      HOME: join(base, 'home'),
      CODEX_HOME: join(base, 'codex-home'),
      TMPDIR: join(base, 'tmp'),
      XDG_CONFIG_HOME: join(base, 'xdg-config'),
      XDG_DATA_HOME: join(base, 'xdg-data'),
      XDG_CACHE_HOME: join(base, 'xdg-cache'),
      PATH: `${dirname(node)}:/usr/bin:/bin`,
      SHELL: '/bin/sh',
    },
    nativeOptions: {
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      developerInstructions: INSTRUCTION(member.name),
    },
  };
}

/** One captured Host profile for the vendor, with the human principal allowed to DM each member. */
export async function buildRealHostProfile(
  target: RealTarget,
  root: string,
  members: readonly RealMember[]
) {
  const node = await realpath(process.execPath);
  const entry = await realpath(new URL('../../../dist/cli.js', import.meta.url).pathname);
  const namespace = randomUUID();
  const ids = { namespace, teamId: `TEST-team-${namespace}` };
  const runtime = [];
  for (const member of members)
    runtime.push(await buildRealRuntimeMember(target, member, ids, root, node));
  assertAccountNamespaces(runtime as never);
  const owner = {
    ownerId: `TEST-owner-${namespace}`,
    revision: 'TEST-revision',
    storageRoot: join(root, 'store'),
    profileId: `TEST-profile-${namespace}`,
    protocolVersion: 1 as const,
    buildId: `TEST-real-${target.vendor}`,
    nodeSha256: await fileHash(node),
    hostEntrySha256: await fileHash(entry),
  };
  const scope = {
    projectId: `TEST-project-${namespace}`,
    workspaceId: `TEST-workspace-${namespace}`,
    teamId: ids.teamId,
    runId: `TEST-run-${namespace}`,
    memberId: 'human',
    generation: '1',
  };
  const binding = {
    backendId: owner.ownerId,
    teamId: scope.teamId,
    teamName: `test-real-${target.vendor}`,
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    owner,
    principalId: 'human',
    promptSuggestions: { enabled: true },
    teams: [
      {
        scope,
        binding,
        members: members.map((member) => ({
          ...member,
          delivery: { ...binding, runId: scope.runId, memberId: member.memberId, generation: '1' },
        })),
        grants: [
          {
            principalId: 'human',
            memberName: 'user',
            permissions: ['read', 'message.write', 'task.write', 'admin'],
          },
          ...members.map((member) => ({
            principalId: `${member.name}-session`,
            memberName: member.name,
            permissions: ['read', 'message.write', 'task.write'] as (
              | 'read'
              | 'message.write'
              | 'task.write'
            )[],
          })),
        ],
      },
    ],
    runtime: { members: runtime as never },
  };
  const serialized = JSON.stringify(profile);
  const profilePath = join(root, 'profile.json');
  await writeFile(profilePath, serialized, { mode: 0o600, flag: 'wx' });
  const envelope = (payload: unknown, commandId = `TEST-${randomUUID()}`) => ({
    commandId,
    binding: { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope },
    payload,
  });
  return {
    node,
    entry,
    profilePath,
    profileHash: digest(serialized),
    envelope,
    owner,
    scope,
    namespace,
  };
}
