import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { TeamLaunchError } from '../dist/team-launch/contracts.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import {
  prepareCapturedRuntimeMcpRecipes,
  loadCapturedRuntimeMcpRecipe,
  capturedRuntimeMcpReferencesSchema,
} from '../dist/composition/capturedRuntimeMcpRecipes.js';
import { capturedMcpSourceCurrent } from '../dist/mcp-catalog/capturedSource.js';
import { captureRuntimeMcp } from '../dist/composition/captureRuntimeMcp.js';
import type { ClaudeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { CodexMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { CodexConfiguredMcpCatalog } from '@agent-teams/provider-implementations/codex';

const isHeld = (error: unknown) =>
  error instanceof TeamLaunchError &&
  error.code === 'hold' &&
  error.reason === 'capture-runtime-mcp-recipe';
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'TEST-codex-mcp-artifact-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const store = new TeamOwnerStore(root, 'TEST-catalog');
  const profile: CodexMemberProfile = {
    provider: 'codex',
    cwd,
    environment: { HOME: root, CODEX_HOME: root, PATH: '/usr/bin:/bin' },
    executable: { path: '/TEST/codex', sha256: 'a'.repeat(64) },
    teamId: 'TEST-team',
    memberId: 'TEST-member',
    principalId: 'TEST-principal',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-config',
    model: 'TEST-model',
    accountBinding: 'TEST-account',
    protocolRevision: '0.162.0',
    nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' },
    limits: {
      queuedInputs: 1,
      inputBytes: 4096,
      outputBytes: 8192,
      outputEvents: 128,
      pendingInteractions: 2,
      timeoutMs: 1000,
    },
  };
  const catalog: CodexConfiguredMcpCatalog = {
    digest: 'b'.repeat(64),
    servers: [
      {
        name: 'TEST-plugin',
        enabled: true,
        transport: { type: 'stdio', command: '/TEST/private-command' },
      },
    ],
  };
  return {
    root,
    store,
    profile,
    catalog,
    file: join(
      store.directory,
      `launches/mcp-recipes/${runtimeDigest(['TEST-command', profile.memberId])}.json`
    ),
    withAuthority: <T>(action: () => T) => store.fenced(action),
  };
}

test('actual private launch artifact keeps original native census while source references contain digest only', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  let reads = 0;
  const options = {
    store: f.store,
    commandId: 'TEST-command',
    baseRecipes: [f.profile],
    selectedRecipes: [{ ...f.profile, capturedMcpServers: {} }],
    assertCurrent() {},
    withAuthority: f.withAuthority,
    readCatalog: async () => {
      reads++;
      return f.catalog;
    },
  };
  const refs = await prepareCapturedRuntimeMcpRecipes(options);
  assert.equal(reads, 1);
  assert.equal(refs.length, 1);
  assert.deepEqual(Object.keys(refs[0]!).sort(), ['digest', 'memberId']);
  assert(!JSON.stringify(refs).includes('private-command'));
  assert.deepEqual(loadCapturedRuntimeMcpRecipe(f.store, 'TEST-command', f.profile, refs[0]!), {
    ...f.profile,
    capturedMcpServers: {},
    capturedMcpCatalog: f.catalog,
  });
  const original = readFileSync(f.file, 'utf8');
  assert.deepEqual(
    await prepareCapturedRuntimeMcpRecipes({
      ...options,
      readCatalog: async () => {
        throw new Error('must not replace original');
      },
    }),
    refs
  );
  assert.equal(readFileSync(f.file, 'utf8'), original);
  assert.equal(readdirSync(join(f.store.directory, 'launches/mcp-recipes')).length, 1);
});

test('changed original profile, missing or changed artifact and mismatching reference HOLD without replacement', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const options = {
    store: f.store,
    commandId: 'TEST-command',
    baseRecipes: [f.profile],
    selectedRecipes: [{ ...f.profile, capturedMcpServers: {} }],
    assertCurrent() {},
    withAuthority: f.withAuthority,
    readCatalog: async () => f.catalog,
  };
  const [ref] = await prepareCapturedRuntimeMcpRecipes(options);
  assert(ref);
  const original = readFileSync(f.file, 'utf8');
  assert.throws(
    () =>
      loadCapturedRuntimeMcpRecipe(
        f.store,
        'TEST-command',
        { ...f.profile, model: 'TEST-changed' },
        ref
      ),
    isHeld
  );
  assert.throws(
    () =>
      loadCapturedRuntimeMcpRecipe(f.store, 'TEST-command', f.profile, {
        ...ref,
        digest: 'c'.repeat(64),
      }),
    isHeld
  );
  const corrupt = JSON.parse(original);
  corrupt.overlay.capturedMcpCatalog.digest = 'd'.repeat(64);
  writeFileSync(f.file, JSON.stringify(corrupt));
  assert.throws(
    () => loadCapturedRuntimeMcpRecipe(f.store, 'TEST-command', f.profile, ref),
    isHeld
  );
  unlinkSync(f.file);
  assert.throws(
    () => loadCapturedRuntimeMcpRecipe(f.store, 'TEST-command', f.profile, ref),
    isHeld
  );
  assert.deepEqual(readdirSync(join(f.store.directory, 'launches/mcp-recipes')), []);
});

test('revocation during metadata read publishes no artifact or replacement intent', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  let current = true,
    reads = 0;
  await assert.rejects(
    prepareCapturedRuntimeMcpRecipes({
      store: f.store,
      commandId: 'TEST-command',
      baseRecipes: [f.profile],
      selectedRecipes: [{ ...f.profile, capturedMcpServers: {} }],
      assertCurrent() {
        if (!current) throw new Error('TEST-revoked');
      },
      withAuthority: f.withAuthority,
      readCatalog: async () => {
        reads++;
        current = false;
        return f.catalog;
      },
    }),
    /TEST-revoked/u
  );
  assert.equal(reads, 1);
  assert(!readdirSync(f.store.directory).includes('launches'));
});

test('symbolic private catalog never becomes adopted input and digest refs reject duplicate members', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const [ref] = await prepareCapturedRuntimeMcpRecipes({
    store: f.store,
    commandId: 'TEST-command',
    baseRecipes: [f.profile],
    selectedRecipes: [{ ...f.profile, capturedMcpServers: {} }],
    assertCurrent() {},
    withAuthority: f.withAuthority,
    readCatalog: async () => f.catalog,
  });
  assert(ref);
  const bytes = readFileSync(f.file);
  const target = join(f.root, 'TEST-foreign.json');
  writeFileSync(target, bytes);
  unlinkSync(f.file);
  symlinkSync(target, f.file);
  assert.throws(() => loadCapturedRuntimeMcpRecipe(f.store, 'TEST-command', f.profile, ref));
  assert.deepEqual(readFileSync(target), bytes);
  assert.equal(capturedRuntimeMcpReferencesSchema.safeParse([ref, ref]).success, false);
});

test('historical private recipe survives real catalog edit while current admission holds and a new explicit command captures new bytes', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const config = join(f.root, 'TEST-claude.json');
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        'TEST-original': { command: '/TEST/original', env: { TEST_SECRET: 'retained-private' } },
      },
    })
  );
  const { nativeOptions: _codexOptions, protocolRevision: _codexVersion, ...common } = f.profile;
  const base: ClaudeMemberProfile = {
    ...common,
    provider: 'claude',
    nativeTools: [],
    autoAllowedTools: [],
    mcpCatalogSource: { claudeConfigPath: config },
  };
  const select = () =>
    captureRuntimeMcp({
      recipes: [base],
      savedCwd: base.cwd,
      members: [{ role: 'lead', settings: {} }],
    });
  const first = await prepareCapturedRuntimeMcpRecipes({
    store: f.store,
    commandId: 'TEST-original-command',
    baseRecipes: [base],
    selectedRecipes: select(),
    assertCurrent() {},
    withAuthority: f.withAuthority,
  });
  const historical = loadCapturedRuntimeMcpRecipe(
    f.store,
    'TEST-original-command',
    base,
    first[0]!
  );
  assert(capturedMcpSourceCurrent(historical));
  const originalPath = join(
    f.store.directory,
    `launches/mcp-recipes/${runtimeDigest(['TEST-original-command', base.memberId])}.json`
  );
  const originalBytes = readFileSync(originalPath);
  writeFileSync(config, JSON.stringify({ mcpServers: { 'TEST-new': { command: '/TEST/new' } } }));
  const reopened = loadCapturedRuntimeMcpRecipe(f.store, 'TEST-original-command', base, first[0]!);
  assert.deepEqual(reopened, historical);
  assert(!capturedMcpSourceCurrent(reopened));
  const next = await prepareCapturedRuntimeMcpRecipes({
    store: f.store,
    commandId: 'TEST-next-command',
    baseRecipes: [base],
    selectedRecipes: select(),
    assertCurrent() {},
    withAuthority: f.withAuthority,
  });
  const fresh = loadCapturedRuntimeMcpRecipe(f.store, 'TEST-next-command', base, next[0]!);
  assert(capturedMcpSourceCurrent(fresh));
  assert.deepEqual(Object.keys(fresh.capturedMcpServers!), ['TEST-new']);
  assert.deepEqual(readFileSync(originalPath), originalBytes);
  assert.equal(readdirSync(join(f.store.directory, 'launches/mcp-recipes')).length, 2);
  assert(!JSON.stringify(first).includes('retained-private'));
  assert(!JSON.stringify(first).includes(config));
});

test('only finite MCP overlay may differ from the trusted base; provider and cwd are not artifact authority', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await assert.rejects(
    prepareCapturedRuntimeMcpRecipes({
      store: f.store,
      commandId: 'TEST-command',
      baseRecipes: [f.profile],
      selectedRecipes: [{ ...f.profile, model: 'FOREIGN', capturedMcpServers: {} }],
      assertCurrent() {},
      withAuthority: f.withAuthority,
      readCatalog: async () => {
        throw new Error('must not read');
      },
    }),
    isHeld
  );
  assert(!readdirSync(f.store.directory).includes('launches'));
});
