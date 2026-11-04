// @vitest-environment node
// Regressions named below must be observable at a real fixture socket, never real providers or projects.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
  realpath,
  access,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  ControlAuthModule,
  ControlAuthority,
  ControlContext,
} from '../src/internal/controlApiAuthTypes';
const require = createRequire(import.meta.url);
const auth = require('../src/internal/controlApiAuth.cts') as ControlAuthModule;
const runtime = require('../src/internal/runtime.js') as {
  listTeams(context: ControlContext, flags?: Record<string, unknown>): Promise<unknown>;
  runtimeBootstrapCheckin(
    context: ControlContext & { teamName: string },
    flags?: Record<string, unknown>
  ): Promise<unknown>;
};
let root: string, apps: FastifyInstance[];
let savedEnvironment: Record<string, string | undefined>;
const environmentKeys = [
  'CLAUDE_TEAM_CONTROL_AUTH_REF',
  'CLAUDE_TEAM_CONTROL_EXTERNAL_AUTH_REF',
  'CLAUDE_TEAM_CONTROL_URL',
  'CLAUDE_TEAM_CONTROL_AUTH_TOKEN',
];
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'controller-api-auth-')));
  apps = [];
  savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
});
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await rm(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function fixture(baseUrl: string): ControlAuthority {
  return {
    schemaVersion: 1,
    service: 'api',
    profileScope: createHash('sha256').update(root).digest('hex'),
    instanceId: randomUUID(),
    generation: randomUUID(),
    baseUrl,
    token: randomBytes(32).toString('hex'),
  };
}
async function publish(current: ControlAuthority) {
  const directory = path.join(root, 'local-http-auth');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const descriptorPath = path.join(
    directory,
    `api-${current.instanceId}-${current.generation}.json`
  );
  await writeFile(descriptorPath, JSON.stringify(current), { mode: 0o600 });
  const reference = {
    schemaVersion: 1,
    service: 'api',
    profileScope: current.profileScope,
    instanceId: current.instanceId,
    generation: current.generation,
    descriptorPath,
  };
  await writeFile(path.join(root, 'team-control-api.json'), JSON.stringify(reference), {
    mode: 0o600,
  });
  const instanceRef = path.join(directory, `api-${current.instanceId}.ref.json`);
  await writeFile(instanceRef, JSON.stringify(reference), { mode: 0o600 });
  return instanceRef;
}
async function listener(register: (app: FastifyInstance) => void) {
  const app = Fastify();
  apps.push(app);
  register(app);
  return { app, baseUrl: await app.listen({ host: '127.0.0.1', port: 0 }) };
}

it('never sends the app bearer to a user-provided foreign endpoint or foreign redirect', async () => {
  let foreignEffects = 0,
    localEffects = 0;
  const foreign = await listener((app) =>
    app.get('/api/teams', () => {
      foreignEffects++;
      return [];
    })
  );
  const local = await listener((app) =>
    app.get('/api/teams', (_request, reply) => {
      localEffects++;
      return reply.redirect(foreign.baseUrl + '/api/teams');
    })
  );
  await publish(fixture(local.baseUrl));
  await expect(
    runtime.listTeams({ claudeDir: root }, { controlUrl: foreign.baseUrl })
  ).rejects.toThrow('does not match');
  expect(foreignEffects).toBe(0);
  await expect(runtime.listTeams({ claudeDir: root })).rejects.toThrow();
  expect(localEffects).toBe(1);
  expect(foreignEffects).toBe(0);
});

it('refreshes GET only once on 401 after a committed generation change', async () => {
  let current: ControlAuthority,
    calls = 0;
  const local = await listener((app) =>
    app.get('/api/teams', async (request, reply) => {
      calls++;
      if (calls === 1) {
        current = { ...current, token: randomBytes(32).toString('hex'), generation: randomUUID() };
        await publish(current);
        return reply.code(401).send({ error: 'expired' });
      }
      expect(request.headers.authorization).toBe(`Bearer ${current.token}`);
      return [{ name: 'synthetic' }];
    })
  );
  current = fixture(local.baseUrl);
  await publish(current);
  expect(await runtime.listTeams({ claudeDir: root })).toEqual([{ name: 'synthetic' }]);
  expect(calls).toBe(2);
});

it('bounds rejection without generation change and never replays a mutation after uncertain delivery', async () => {
  let reads = 0,
    writes = 0;
  const local = await listener((app) => {
    app.get('/api/teams', (_request, reply) => {
      reads++;
      return reply.code(401).send({ error: 'expired' });
    });
    app.post('/api/teams/synthetic/opencode/runtime/bootstrap-checkin', (request, reply) => {
      writes++;
      reply.hijack();
      request.raw.socket.destroy();
    });
  });
  await publish(fixture(local.baseUrl));
  await expect(runtime.listTeams({ claudeDir: root })).rejects.toThrow('expired');
  expect(reads).toBe(1);
  await expect(
    runtime.runtimeBootstrapCheckin(
      { claudeDir: root, teamName: 'synthetic' },
      { memberName: 'lead' }
    )
  ).rejects.toThrow();
  expect(writes).toBe(1);
});

it('401 on a mutation makes exactly one request even when the descriptor changes', async () => {
  let current: ControlAuthority,
    calls = 0;
  const local = await listener((app) =>
    app.post('/api/fixture', async (_request, reply) => {
      calls++;
      current = { ...current, generation: randomUUID() };
      await publish(current);
      return reply.code(401).send({ error: 'expired' });
    })
  );
  current = fixture(local.baseUrl);
  await publish(current);
  const source = auth.resolveControlAuthorities({ claudeDir: root })[0];
  expect(
    (await auth.authenticatedControlFetch(source, '/api/fixture', { method: 'POST', body: {} }))
      .status
  ).toBe(401);
  expect(calls).toBe(1);
});

it('accepts an explicit trusted external pair from a private reference, without borrowing the app key', async () => {
  let received: string | undefined;
  const external = await listener((app) =>
    app.get('/api/teams', (request) => {
      received = request.headers.authorization;
      return [];
    })
  );
  const externalAuthority = fixture(external.baseUrl);
  const directory = path.join(root, 'local-http-auth');
  await mkdir(directory, { mode: 0o700 });
  const reference = path.join(directory, `external-${externalAuthority.instanceId}.json`);
  await writeFile(reference, JSON.stringify(externalAuthority), { mode: 0o600 });
  process.env.CLAUDE_TEAM_CONTROL_EXTERNAL_AUTH_REF = reference;
  expect(await runtime.listTeams({ claudeDir: root }, { controlUrl: external.baseUrl })).toEqual(
    []
  );
  expect(received).toBe(`Bearer ${externalAuthority.token}`);
});

it('rejects legacy discovery, foreign profile/instance references and nonprivate files before HTTP effects', async () => {
  const current = fixture('http://127.0.0.1:12345');
  const reference = await publish(current);
  const context = { claudeDir: root };
  await writeFile(
    path.join(root, 'team-control-api.json'),
    JSON.stringify({ baseUrl: current.baseUrl })
  );
  expect(() => auth.resolveControlAuthorities(context)).toThrow('authentication is required');
  process.env.CLAUDE_TEAM_CONTROL_AUTH_REF = reference;
  const descriptorPath = path.join(
    root,
    'local-http-auth',
    `api-${current.instanceId}-${current.generation}.json`
  );
  await writeFile(descriptorPath, JSON.stringify({ ...current, profileScope: 'foreign' }));
  expect(() => auth.resolveControlAuthorities(context)).toThrow('Invalid');
  await publish(current);
  await chmod(descriptorPath, 0o644);
  expect(() => auth.resolveControlAuthorities(context)).toThrow('Unsafe');
  await chmod(descriptorPath, 0o600);
  await writeFile(
    reference,
    JSON.stringify({ ...JSON.parse(await readFile(reference, 'utf8')), instanceId: randomUUID() })
  );
  expect(() => auth.resolveControlAuthorities(context)).toThrow('Invalid');
});

it('rejects symlinked authority files and profile roots rather than following a credential outside its boundary', async () => {
  const current = fixture('http://127.0.0.1:12345');
  const reference = await publish(current);
  const destination = path.join(root, 'elsewhere.json');
  await writeFile(destination, JSON.stringify(current), { mode: 0o600 });
  const descriptorPath = path.join(
    root,
    'local-http-auth',
    `api-${current.instanceId}-${current.generation}.json`
  );
  await rm(descriptorPath);
  await symlink(destination, descriptorPath);
  process.env.CLAUDE_TEAM_CONTROL_AUTH_REF = reference;
  expect(() => auth.resolveControlAuthorities({ claudeDir: root })).toThrow('Unsafe');
  const alias = path.join(root, 'linked-profile');
  await symlink(root, alias);
  expect(() => auth.resolveControlAuthorities({ claudeDir: alias })).toThrow('Unsafe');
});

it('pairs configured credentials only with their own endpoint and accepts existing token formats', async () => {
  let localCalls = 0;
  let foreignCalls = 0;
  const token = 'existing-configured-control-token-0123456789';
  const local = await listener((app) =>
    app.get('/api/teams', (request) => {
      localCalls++;
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      return [];
    })
  );
  const foreign = await listener((app) =>
    app.get('/api/teams', () => {
      foreignCalls++;
      return [];
    })
  );
  process.env.CLAUDE_TEAM_CONTROL_URL = local.baseUrl;
  process.env.CLAUDE_TEAM_CONTROL_AUTH_TOKEN = token;
  await expect(
    runtime.listTeams({ claudeDir: root }, { controlUrl: foreign.baseUrl })
  ).rejects.toThrow();
  expect(foreignCalls).toBe(0);
  expect(localCalls).toBe(0);
  expect(await runtime.listTeams({ claudeDir: root }, { controlUrl: local.baseUrl })).toEqual([]);
  expect(localCalls).toBe(1);
});

it('resolves an explicit matching endpoint from its descriptor before making the first request', async () => {
  let calls = 0;
  const local = await listener((app) =>
    app.get('/api/teams', (request) => {
      calls++;
      expect(request.headers.authorization).toBe(
        'Bearer existing-configured-control-token-0123456789'
      );
      return [];
    })
  );
  await publish({
    ...fixture(local.baseUrl),
    token: 'existing-configured-control-token-0123456789',
  });
  expect(await runtime.listTeams({ claudeDir: root }, { controlUrl: local.baseUrl })).toEqual([]);
  expect(calls).toBe(1);
});

it('does not queue an uncertain work-sync mutation for later replay', async () => {
  const workSync = require('../src/internal/workSync.js') as {
    memberWorkSyncReport(context: unknown, flags: unknown): Promise<unknown>;
  };
  const teamDir = path.join(root, 'teams', 'synthetic');
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: 'synthetic',
      members: [{ name: 'lead', role: 'team-lead' }],
    })
  );
  let calls = 0;
  const local = await listener((app) =>
    app.post('/api/teams/synthetic/member-work-sync/report', (request, reply) => {
      calls++;
      reply.hijack();
      request.raw.socket.destroy();
    })
  );
  await publish(fixture(local.baseUrl));
  await expect(
    workSync.memberWorkSyncReport(
      { claudeDir: root, teamName: 'synthetic', paths: { teamDir } },
      {
        memberName: 'lead',
        state: 'caught_up',
        agendaFingerprint: 'fixture',
        reportToken: 'fixture',
      }
    )
  ).rejects.toThrow();
  expect(calls).toBe(1);
  await expect(
    access(path.join(teamDir, '.member-work-sync', 'pending-reports.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not accept credentials supplied as controller tool or CLI flags', async () => {
  let calls = 0;
  const foreign = await listener((app) =>
    app.get('/api/teams', () => {
      calls++;
      return [];
    })
  );
  for (const field of ['controlAuthToken', 'control-auth-token']) {
    await expect(
      runtime.listTeams(
        { claudeDir: root },
        {
          controlUrl: foreign.baseUrl,
          [field]: 'forbidden-tool-argument-secret-0123456789',
        }
      )
    ).rejects.toThrow();
  }
  expect(calls).toBe(0);
});
