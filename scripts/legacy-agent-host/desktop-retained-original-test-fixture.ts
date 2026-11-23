import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const source = join(import.meta.dirname, '../../tools/owned-process-broker/fixtures/retainedLegacyBootstrapPeer.mjs');
export const prompt = 'TEST_RETAINED_ORIGINAL_SOLO_ONE';
// Generated TEST input, checked byte-for-byte against the real Main builder by the cross-layer test.
export const deferredPrompt = readFileSync(new URL('../../tools/owned-process-broker/fixtures/retainedLegacyHydrationPrompt.txt', import.meta.url), 'utf8');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Synthetic protocol inputs only; these unit fixtures never claim an original Main release. */
export async function fixture(t: { after(cleanup: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['home', 'tmp', 'workspace', 'userData', 'claude', 'claude/teams/test-retained-original', 'claude/tasks/test-retained-original'])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const prefix = 'agent-teams-bootstrap-' + sha(join(root, 'userData')).slice(0, 16) + '-';
  const specDirectory = await mkdtemp(join(root, 'tmp', prefix)); await chmod(specDirectory, 0o700);
  const promptDirectory = await mkdtemp(join(root, 'tmp/agent-teams-bootstrap-prompt-')); await chmod(promptDirectory, 0o700);
  const team = join(root, 'claude/teams/test-retained-original'), specPath = join(specDirectory, 'bootstrap.json');
  const markerPath = join(specDirectory, '.agent-teams-bootstrap-owner.json'), promptPath = join(promptDirectory, randomUUID() + '.txt');
  const runId = randomUUID();
  const spec = { version: 1, runId, mode: 'launch', initiator: { kind: 'app', source: 'claude_team_agent_teams_orchestrator' },
    team: { name: 'test-retained-original', cwd: join(root, 'workspace') }, lead: {}, members: [], ui: { emitStructuredEvents: true } };
  const meta = { version: 1, cwd: join(root, 'workspace'), model: 'claude-sonnet-4-6', providerId: 'anthropic', skipPermissions: false, prompt };
  for (const [path, value, mode] of [
    [specPath, spec, 0o600],
    [markerPath, { version: 1, kind: 'agent-teams-bootstrap', ownerPid: process.pid, specFile: 'bootstrap.json' }, 0o600],
    [join(team, 'team.meta.json'), meta, 0o644], [join(team, 'members.meta.json'), { version: 1, members: [] }, 0o644],
    [join(root, 'userData/mcp.json'), { mcpServers: {} }, 0o644],
  ] as const) await writeFile(path, JSON.stringify(value), { mode, flag: 'wx' });
  await writeFile(promptPath, deferredPrompt, { mode: 0o600, flag: 'wx' });
  const config = { name: 'test-retained-original', description: 'TEST archive only', createdAt: 1,
    _backupIdentityId: 'TEST-archive-identity', leadAgentId: 'team-lead@test-retained-original',
    leadSessionId: 'TEST-unqualified-archive-session', projectPath: join(root, 'workspace'),
    projectPathHistory: [join(root, 'workspace')], members: [{ agentId: 'team-lead@test-retained-original',
      name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic', model: 'claude-sonnet-4-6', joinedAt: 1, cwd: join(root, 'workspace') }] };
  await writeFile(join(team, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  const descriptorPath = join(root, 'desktop-descriptor.json');
  await writeFile(descriptorPath, '{}', { mode: 0o600, flag: 'wx' });
  const seed = { version: 1, sourceKind: 'TEST-legacy-archive-without-native-release', teamName: 'test-retained-original',
    workspace: join(root, 'workspace'), config, hostDescriptor: { path: descriptorPath, sha256: sha('{}') } };
  const seedBytes = JSON.stringify(seed, null, 2), seedPath = join(root, 'retained-original-archive.json');
  await writeFile(seedPath, seedBytes, { mode: 0o600, flag: 'wx' });
  const env = { HOME: join(root, 'home'), CLAUDE_ROOT: join(root, 'claude'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
    TMPDIR: join(root, 'tmp'), PATH: dirname(process.execPath) + ':/usr/bin:/bin',
    TEST_RETAINED_BOOTSTRAP: 'archive-solo-v1', TEST_RETAINED_BOOTSTRAP_ROOT: root, TEST_RETAINED_BOOTSTRAP_VERSION: '0.0.158',
    TEST_RETAINED_BOOTSTRAP_REPO: root, TEST_RETAINED_BOOTSTRAP_ARCHIVE_SHA256: sha(seedBytes),
    AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: descriptorPath, AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: sha('{}') };
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'user,project,local', '--mcp-config', join(root, 'userData/mcp.json'), '--team-bootstrap-spec', specPath,
    '--team-bootstrap-user-prompt-file', promptPath, '--disallowedTools', 'Agent', '--permission-mode', 'default',
    '--permission-prompt-tool', 'stdio', '--model', 'claude-sonnet-4-6'];
  const run = (selectedArgs = args, selectedEnv: NodeJS.ProcessEnv = env, cwd = join(root, 'workspace')) =>
    spawnSync(process.execPath, [source, ...selectedArgs], { env: selectedEnv, cwd, encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024 });
  return { root, team, specPath, markerPath, promptPath, seedPath, descriptorPath, config, runId, spec, meta, env, args, run };
}

