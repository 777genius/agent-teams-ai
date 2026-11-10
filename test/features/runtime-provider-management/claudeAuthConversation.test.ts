// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAuthConversation } from '../../../packages/legacy-agent-host/src/adapters/providers/ClaudeAuthConversation';
import {
  parseClaudeAuthStatus,
  readClaudeAuthorizationUrl,
} from '../../../packages/legacy-agent-host/src/adapters/providers/claudeAuthStatus';
import { storedManagementCommandSchema } from '../../../packages/legacy-agent-host/src/management/commandRecords';
import { ManagementResourceFence } from '../../../packages/legacy-agent-host/src/management/ManagementResourceFence';
import { OAuthOperationOwner } from '../../../packages/legacy-agent-host/src/management/OAuthOperationOwner';

import type { CapturedProcessPort } from '../../../packages/legacy-agent-host/src/adapters/providers/CapturedProcess';
import type { StoredManagementCommand } from '../../../packages/legacy-agent-host/src/management/commandRecords';
import type { ClaudeManagementProfile } from '../../../packages/legacy-agent-host/src/management/profile';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const turn = () => new Promise<void>((done) => setImmediate(done));
async function until(check: () => boolean) {
  for (let i = 0; i < 30 && !check(); i++) await turn();
  expect(check()).toBe(true);
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-claude-auth-')));
  const home = join(root, 'home'),
    config = join(root, 'config'),
    cwd = join(root, 'project');
  for (const path of [home, config, cwd]) mkdirSync(path);
  const profile: ClaudeManagementProfile = {
    provider: 'claude',
    sdkRevision: '0.3.305',
    profileId: 'TEST-claude',
    configRevision: 'TEST-revision',
    accountBinding: 'TEST-account',
    configNamespace: 'custom-directory',
    executable: { path: join(root, 'TEST-no-native-executable'), sha256: 'a'.repeat(64) },
    cwd,
    environment: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: '/TEST/no-native-path' },
    timeoutMs: 1000,
  };
  let current = true,
    loggedIn = false,
    closed = false,
    closeCalls = 0;
  const launches: {
    args: string[];
    child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
    input: string[];
  }[] = [];
  const processPort: CapturedProcessPort = {
    launch(request) {
      expect(current && !closed).toBe(true);
      expect(request.command).toBe(profile.executable.path);
      expect(request.cwd).toBe(cwd);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
      });
      const input: string[] = [];
      child.stdin.on('data', (chunk: Buffer) => input.push(chunk.toString()));
      launches.push({ args: request.args, child, input });
      if (request.args[1] === 'status')
        queueMicrotask(() => {
          child.stdout.write(
            JSON.stringify({
              loggedIn,
              authMethod: loggedIn ? 'claude.ai' : 'none',
              apiProvider: 'firstParty',
              configDirectory: config,
            })
          );
          child.emit('close', loggedIn ? 0 : 1);
        });
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    seal() {
      closed = true;
    },
    isRunning: () => !closed,
    async confirmStopped() {
      closeCalls++;
      for (const row of launches) row.child.emit('close', null);
      return true;
    },
  };
  let conversation: ClaudeAuthConversation | undefined;
  const records = new Map<string, StoredManagementCommand>();
  const owner = new OAuthOperationOwner({
    store: {
      read: (id) => records.get(id),
      list: () => records.values(),
      write: (record) => {
        records.set(record.commandId, storedManagementCommandSchema.parse(structuredClone(record)));
      },
    },
    fence: new ManagementResourceFence([]),
    assertWriter() {
      if (!current) throw new Error('TEST original owner revoked');
    },
    select: () => ({
      profileId: profile.profileId,
      configRevision: profile.configRevision,
      selectionDigest: 'b'.repeat(64),
      resourceId: 'c'.repeat(64),
    }),
    prepare: () => {
      conversation = new ClaudeAuthConversation(
        profile,
        () => current,
        () => processPort
      );
      return conversation;
    },
  });
  const scope = {
    operationId: 'TEST-original-auth',
    profileId: profile.profileId,
    configRevision: profile.configRevision,
  };
  const start = () => owner.start({ ...scope, providerId: 'anthropic', methodIndex: 0 });
  const login = () => launches.find((row) => row.args[1] === 'login')!;
  cleanups.push(async () => {
    current = true;
    await Promise.allSettled([owner.close()]);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    profile,
    owner,
    records,
    scope,
    start,
    launches,
    login,
    processPort,
    closeCalls: () => closeCalls,
    revoke: () => {
      current = false;
    },
    authorize: async () => {
      start();
      await until(() => !!login());
      login().child.stdout.write(
        "Opening browser to sign in…\nIf the browser didn't open, visit: https://TEST.invalid/authorize?state=TEST-original\nPaste code here if prompted > "
      );
      await until(() => owner.read(scope)?.phase === 'waiting-for-code');
    },
    finish: () => {
      loggedIn = true;
      login().child.emit('close', 0);
    },
    setAuthenticated: (value: boolean) => {
      loggedIn = value;
    },
    conversation: () => conversation!,
  };
}

describe('captured official Claude sign-in', () => {
  it('admits before allocation, uses exact native commands, and completes a manual code under its original command', async () => {
    const f = fixture();
    await f.authorize();
    expect(f.launches.map((row) => row.args)).toEqual([
      ['auth', 'status', '--json'],
      ['auth', 'login', '--claudeai'],
    ]);
    expect(f.owner.authorization(f.scope)).toMatchObject({ browserOwner: 'native' });
    expect(
      f.owner.complete({
        ...f.scope,
        commandId: 'TEST-original-code',
        code: 'TEST-code#TEST-original',
      }).phase
    ).toBe('completing');
    expect(f.login().input).toEqual(['TEST-code#TEST-original\n']);
    f.finish();
    await until(() => f.owner.read(f.scope)?.phase === 'completed');
    expect(
      (() => {
        const row = f.records.get(f.scope.operationId);
        return row?.kind === 'oauth' ? row.completionCommandId : undefined;
      })()
    ).toBe('TEST-original-code');
    expect(JSON.stringify([...f.records.values()])).not.toContain('TEST-code');
    expect(f.closeCalls()).toBe(1);
  });

  it('settles browser completion without requiring an empty code or a second native sign-in', async () => {
    const f = fixture();
    await f.authorize();
    f.finish();
    await until(() => f.owner.read(f.scope)?.phase === 'completed');
    expect(
      (() => {
        const row = f.records.get(f.scope.operationId);
        return row?.kind === 'oauth' ? row.completionCommandId : undefined;
      })()
    ).toMatch(/^native:[a-f0-9]{64}$/u);
    expect(f.login().input).toEqual([]);
    f.start();
    expect(f.launches.filter((row) => row.args[1] === 'login')).toHaveLength(1);
  });

  it('cancel fences a late native success and never launches a replacement status or login', async () => {
    const f = fixture();
    await f.authorize();
    expect((await f.owner.cancel(f.scope)).phase).toBe('cancelled');
    f.finish();
    await turn();
    expect(f.owner.read(f.scope)?.phase).toBe('cancelled');
    expect(f.launches).toHaveLength(2);
    expect(f.owner.authorization(f.scope)).toBeNull();
  });

  it('revocation and config-directory replacement cannot grant or write a code', async () => {
    const f = fixture();
    await f.authorize();
    renameSync(f.config, `${f.config}-original`);
    mkdirSync(f.config);
    await expect(
      f.conversation().complete('TEST-code#TEST-original', new AbortController().signal)
    ).rejects.toThrow();
    f.revoke();
    f.finish();
    await turn();
    expect(f.login().input).toEqual([]);
    expect(f.records.get(f.scope.operationId)?.phase).not.toBe('completed');
  });

  it('refuses environment-managed auth before even reading native credentials', async () => {
    const f = fixture();
    const conversation = new ClaudeAuthConversation(
      {
        ...f.profile,
        environment: { ...f.profile.environment, ANTHROPIC_API_KEY: 'TEST-private' },
      },
      () => true,
      () => f.processPort
    );
    await expect(conversation.authorize(undefined, new AbortController().signal)).rejects.toThrow();
    expect(f.launches).toEqual([]);
    await conversation.close();
  });

  it('signs out using only the original captured native command and confirms that namespace afterward', async () => {
    const f = fixture();
    f.setAuthenticated(true);
    const conversation = new ClaudeAuthConversation(
      f.profile,
      () => true,
      () => f.processPort
    );
    const result = conversation.forget(new AbortController().signal);
    await until(() => f.launches.some((row) => row.args[1] === 'logout'));
    f.setAuthenticated(false);
    f.launches.find((row) => row.args[1] === 'logout')!.child.emit('close', 0);
    expect(await result).toBe(true);
    expect(f.launches.map((row) => row.args)).toEqual([
      ['auth', 'status', '--json'],
      ['auth', 'logout'],
      ['auth', 'status', '--json'],
    ]);
    expect(f.closeCalls()).toBe(1);
  });

  it('refuses a status from another namespace or a contradictory authentication/exit result', () => {
    const f = fixture();
    const status = {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      configDirectory: f.config,
    };
    expect(parseClaudeAuthStatus(JSON.stringify(status), 0, f.config)).toMatchObject({
      loggedIn: true,
    });
    expect(() =>
      parseClaudeAuthStatus(
        JSON.stringify({ ...status, configDirectory: f.profile.cwd }),
        0,
        f.config
      )
    ).toThrow();
    expect(() => parseClaudeAuthStatus(JSON.stringify(status), 1, f.config)).toThrow();
    expect(() =>
      parseClaudeAuthStatus(JSON.stringify({ ...status, apiProvider: 'gateway' }), 0, f.config)
    ).toThrow();
  });
});

it('recognizes only the native sign-in prompt through styling without forwarding terminal control output', () => {
  const url = 'https://TEST.invalid/authorize?state=TEST-original';
  expect(
    readClaudeAuthorizationUrl(
      `\u001b[32mIf the browser didn't open, visit: \u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\u001b[0m`
    )
  ).toBe('https://test.invalid/authorize?state=TEST-original');
  expect(readClaudeAuthorizationUrl(`Diagnostic reference: ${url}`)).toBeUndefined();
  expect(() =>
    readClaudeAuthorizationUrl('Sign in at: https://user:secret@TEST.invalid/auth')
  ).toThrow();
});

it('records only an allowlisted private cleanup refusal while retaining the original held result', async () => {
  const f = fixture();
  f.processPort.confirmStopped = async () => false;
  const lines: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
  try {
    const conversation = new ClaudeAuthConversation(f.profile, () => true, () => f.processPort);
    await expect(conversation.read(new AbortController().signal)).rejects.toMatchObject({ code: 'held' });
    expect(f.launches.map(row => row.args)).toEqual([['auth', 'status', '--json']]);
    const prefix = 'legacy-agent-host: claude-management ';
    const retained = lines.filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
    expect(retained).toEqual([{ profileHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      namespaceHash: expect.stringMatching(/^[a-f0-9]{64}$/), commandHash: null, stage: 'auth-cleanup', code: 'cleanup-unconfirmed' }]);
    expect(JSON.stringify(retained)).not.toContain(f.root);
    expect(JSON.stringify(retained)).not.toContain(f.profile.profileId);
  } finally { stderr.mockRestore(); }
});
