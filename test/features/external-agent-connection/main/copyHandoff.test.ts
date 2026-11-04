import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ExternalAgentCopyHandoffService } from '@features/external-agent-connection/main/ExternalAgentCopyHandoff';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isolateCopyEnvironment, parseCopyConfig } from '../../../../mcp-server/src/copyHandoff';

import type { ConnectionInfoV1 } from '@features/external-agent-connection/contracts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = '11111111-1111-4111-8111-111111111111';
let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function setup() {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-copy-handoff-')));
  await chmod(directory, 0o700);
  const root = path.join(directory, 'claude');
  const userData = path.join(directory, 'profile');
  await mkdir(root, { mode: 0o700 });
  await mkdir(userData, { mode: 0o700 });
  const authDirectory = path.join(root, 'local-http-auth');
  await mkdir(authDirectory, { mode: 0o700 });
  const authReference = path.join(authDirectory, `api-${uuid}.ref.json`);
  await writeFile(authReference, '{}', { mode: 0o600 });
  await writeFile(path.join(directory, 'copyHandoff.js'), '// synthetic bootstrap');
  const controlUrl = 'http://127.0.0.1:43002';
  vi.stubEnv('CLAUDE_TEAM_CONTROL_URL', controlUrl);
  vi.stubEnv('CLAUDE_TEAM_CONTROL_AUTH_REF', authReference);
  vi.stubEnv('CLAUDE_TEAM_CONTROL_AUTH_TOKEN', 'SENTINEL_DO_NOT_EXPORT_BEARER_0123456789');
  const connection: ConnectionInfoV1 = {
    schemaVersion: 1,
    context: { appInstanceId: uuid, dataRootFingerprint: hash(root), connectionGeneration: 1 },
    profileFingerprint: hash(userData),
    appVersion: 'test',
    observedAt: '2026-11-01T00:00:00Z',
    mcp: {
      status: 'ready',
      transport: 'httpStream',
      url: 'http://127.0.0.1:43001/mcp',
      generation: 1,
    },
    control: { status: 'ready' },
    cdp: {
      status: 'disabled',
      httpOrigin: null,
      browserWsUrl: null,
      rendererTargetId: null,
      rendererWsUrl: null,
      targetGeneration: 0,
    },
    capabilities: { draftCreation: true, rendererControl: false },
    errorCode: null,
    reason: null,
    recovery: null,
  };
  const request = {
    expectedContext: { ...connection.context },
    expectedProfileFingerprint: connection.profileFingerprint,
  };
  const service = new ExternalAgentCopyHandoffService({
    userDataPath: userData,
    getRoot: () => root,
    getControlUrl: () => controlUrl,
    getConnectionInfo: async () => connection,
    withExpectedContext: async (_expected, operation) => operation(),
    resolveLaunch: async () => ({
      command: process.execPath,
      args: [path.join(directory!, 'index.js')],
      env: { OPENAI_API_KEY: 'SENTINEL_PROVIDER_KEY' },
    }),
  });
  return { service, request, root, connection, authReference };
}

describe('authenticated Copy Prompt handoff', () => {
  it('reuses a private reference-only config; retiring deletes only its own selector', async () => {
    const { service, request, authReference } = await setup();
    const result = await service.prepare(request);
    const again = await service.prepare(request);
    expect(again.registration).toEqual(result.registration);
    const file = result.registration.args[2];
    const bytes = await readFile(file, 'utf8');
    expect(bytes).toContain(authReference);
    expect(JSON.stringify(result) + bytes).not.toContain('SENTINEL');
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    const config = parseCopyConfig(JSON.parse(bytes), file);
    expect(config.context).toEqual(request.expectedContext);
    await service.retire();
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(authReference, 'utf8')).toBe('{}');
  });

  it('fails closed without an exact managed auth ref and rejects a stale epoch', async () => {
    const { service, request, connection } = await setup();
    await expect(service.prepare({ ...request, expectedContext: { ...request.expectedContext, connectionGeneration: 0 } })).rejects.toThrow('request is unavailable');
    await expect(service.prepare({ ...request, token: 'SENTINEL' } as typeof request)).rejects.toThrow('request is unavailable');
    vi.stubEnv('CLAUDE_TEAM_CONTROL_AUTH_REF', '/foreign/reference.json');
    await expect(service.prepare(request)).rejects.toThrow('authentication is unavailable');
    connection.context.connectionGeneration++;
    await expect(service.prepare(request)).rejects.toThrow('App connection changed');
  });

  it('keeps an already copied config on rejected preparation, then replaces it for an admitted new epoch', async () => {
    const { service, request, connection, authReference } = await setup();
    const first = await service.prepare(request);
    const oldFile = first.registration.args[2];
    connection.context.connectionGeneration++;
    await expect(service.prepare(request)).rejects.toThrow('App connection changed');
    expect((await lstat(oldFile)).isFile()).toBe(true);
    const next = await service.prepare({ ...request, expectedContext: { ...connection.context } });
    expect(next.registration.args[2]).not.toBe(oldFile);
    await expect(lstat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(authReference)).isFile()).toBe(true);
    await service.shutdown();
    await expect(
      service.prepare({ ...request, expectedContext: connection.context })
    ).rejects.toThrow('unavailable');
  });

  it('does not export or pin an inherited bearer when it rotates with the same stable reference', async () => {
    const { service, request } = await setup();
    const first = await service.prepare(request);
    vi.stubEnv(
      'CLAUDE_TEAM_CONTROL_AUTH_TOKEN',
      'ROTATED_SENTINEL_DO_NOT_EXPORT_BEARER_0123456789'
    );
    const second = await service.prepare(request);
    expect(second.registration).toEqual(first.registration);
    expect(await readFile(second.registration.args[2], 'utf8')).not.toContain('SENTINEL');
  });

  it('clears inherited provider, HTTP bearer and Node injection settings before MCP import', async () => {
    const { service, request } = await setup();
    const result = await service.prepare(request);
    const file = result.registration.args[2];
    const config = parseCopyConfig(JSON.parse(await readFile(file, 'utf8')), file);
    const env = {
      OPENAI_API_KEY: 'secret',
      NODE_OPTIONS: '--import malicious',
      CLAUDE_TEAM_CONTROL_AUTH_TOKEN: 'secret',
      AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN: 'secret',
      AGENT_TEAMS_MCP_TRANSPORT: 'httpStream',
      HOME: '/home/test',
      PATH: '/untrusted',
    };
    isolateCopyEnvironment(env, config);
    expect(env).toEqual({
      HOME: '/home/test',
      AGENT_TEAMS_BOUND_CONTROL_URL: config.controlUrl,
      AGENT_TEAMS_BOUND_CONTEXT_JSON: JSON.stringify(config.context),
      AGENT_TEAMS_MCP_CLAUDE_DIR: config.root,
      CLAUDE_TEAM_CONTROL_AUTH_REF: config.authReference,
    });
  });

  it('rejects token fields, foreign profile/root/reference and a credentialed URL', async () => {
    const { service, request } = await setup();
    const result = await service.prepare(request);
    const file = result.registration.args[2];
    const config = JSON.parse(await readFile(file, 'utf8'));
    for (const patch of [
      { token: 'secret' },
      { profileFingerprint: 'foreign' },
      { root: '/another/root' },
      { authReference: '/foreign/ref.json' },
      { controlUrl: 'http://secret@127.0.0.1:43002' },
    ]) {
      expect(() => parseCopyConfig({ ...config, ...patch }, file)).toThrow();
    }
  });
});
