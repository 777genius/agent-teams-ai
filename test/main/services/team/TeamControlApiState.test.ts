import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('@main/utils/pathDecoder', () => ({ getClaudeBasePath: () => state.root }));
const envKeys = [
  'CLAUDE_TEAM_CONTROL_URL',
  'CLAUDE_TEAM_CONTROL_AUTH_TOKEN',
  'CLAUDE_TEAM_CONTROL_AUTH_REF',
];
let previous: Array<string | undefined>;
let root: string;
const token = 'a'.repeat(64);

beforeEach(async () => {
  previous = envKeys.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'api-publication-')));
  state.root = root;
  vi.resetModules();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  envKeys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
});
const discovery = () => path.join(state.root, 'team-control-api.json');

it('publishes private token-free discovery and revokes the environment synchronously on clear', async () => {
  const api = await import('@main/services/team/TeamControlApiState');
  await api.writeTeamControlApiState('http://127.0.0.1:3456', token);
  const raw = await readFile(discovery(), 'utf8');
  expect(raw).not.toContain(token);
  const reference = JSON.parse(raw);
  const authority = JSON.parse(await readFile(reference.descriptorPath, 'utf8'));
  expect(authority).toMatchObject({ service: 'api', token, baseUrl: 'http://127.0.0.1:3456' });
  expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_REF).toBeTruthy();
  const clearing = api.clearTeamControlApiState();
  expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
  expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_TOKEN).toBeUndefined();
  await clearing;
  await expect(readFile(discovery())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves another independently instantiated publisher when the older instance stops', async () => {
  const first = await import('@main/services/team/TeamControlApiState');
  await first.writeTeamControlApiState('http://127.0.0.1:3456', token);
  vi.resetModules();
  const second = await import('@main/services/team/TeamControlApiState');
  await second.writeTeamControlApiState('http://127.0.0.1:3457', 'b'.repeat(64));
  const current = await readFile(discovery(), 'utf8');
  await first.clearTeamControlApiState();
  expect(await readFile(discovery(), 'utf8')).toBe(current);
  const reference = JSON.parse(current);
  expect(JSON.parse(await readFile(reference.descriptorPath, 'utf8')).token).toBe('b'.repeat(64));
  await second.clearTeamControlApiState();
});

it('serializes write/clear and clear/write without publishing a stopped generation', async () => {
  const api = await import('@main/services/team/TeamControlApiState');
  await Promise.all([
    api.writeTeamControlApiState('http://127.0.0.1:3456', token),
    api.clearTeamControlApiState(),
  ]);
  await expect(readFile(discovery())).rejects.toMatchObject({ code: 'ENOENT' });
  await Promise.all([
    api.clearTeamControlApiState(),
    api.writeTeamControlApiState('http://127.0.0.1:3457', token),
  ]);
  expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBe('http://127.0.0.1:3457');
  await api.clearTeamControlApiState();
});
